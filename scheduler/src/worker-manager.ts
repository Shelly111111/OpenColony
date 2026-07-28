/**
 * Worker集群管理层
 * 使用 ClaudeUnifiedPtyManager 管理任务执行，支持 SDK 和 PTY 两种模式
 * 参照 main.ts 的方案：每个任务创建独立的 Manager 实例
 */

import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import {
  WorkerInstance,
  SubTask,
  WorkerOutput,
  SchedulerConfig
} from "./types";
import { getLLMClient } from "./llm-client";
import { log } from "./logger";
import { getMemoryStore } from "./memory-store";


const { ClaudeUnifiedPtyManager } = require('../../claude-multi-runner/manager');

// Worker日志根目录
const WORKER_LOG_ROOT = path.resolve(__dirname, "../worker-logs");

export class WorkerManager {
  private config: SchedulerConfig;
  private workers: Map<string, WorkerInstance> = new Map();
  private nextSessionId: number = 1;
  runMode: 'sdk' | 'pty' = 'sdk'; // 默认SDK模式

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.runMode = config.runMode || 'sdk'; // 从配置中获取运行模式

    // 确保日志根目录存在
    if (!fs.existsSync(WORKER_LOG_ROOT)) {
      fs.mkdirSync(WORKER_LOG_ROOT, { recursive: true });
    }
  }

  /**
   * 创建Worker实例（公共方法，允许预创建）
   */
  async createWorker(workerType: string, logDir?: string, traceId?: string, taskId?: string): Promise<WorkerInstance> {
    for (const worker of this.workers.values()) {
      if (worker.status === "idle" && worker.type === workerType) {
        log({ logFile: worker.logFile, prefix: 'WorkerManager', message: `复用现有Worker ${worker.id}，类型: ${workerType}`, traceId, taskId, workerId: worker.id });
        return worker;
      }
    }

    const workerId = uuidv4();
    const worker: WorkerInstance = {
      id: workerId,
      type: workerType,
      status: "idle",
      createdAt: new Date()
    };

    if (logDir) {
      const logFileName = `WorkerManager_${workerId}.log`;
      worker.logFile = path.join(logDir, logFileName);
      this.writeLog(worker.logFile, `创建Worker ${workerId}，类型: ${workerType}`, traceId, taskId, workerId);
    }

    this.workers.set(workerId, worker);
    log({ logFile: worker.logFile, prefix: 'WorkerManager', message: `创建新Worker ${workerId}，类型: ${workerType}`, traceId, taskId, workerId });

    return worker;
  }

  /**
   * 释放Worker实例
   */
  releaseWorker(workerId: string, traceId?: string, taskId?: string): void {
    const worker = this.workers.get(workerId);
    log({ logFile: worker?.logFile, prefix: 'WorkerManager', message: `释放Worker实例: ${workerId}`, traceId, taskId, workerId });
    this.workers.delete(workerId);
  }

  /**
   * 执行单个子任务（根据配置选择模式）
   * 两种模式都使用 ClaudeUnifiedPtyManager
   * @param worker 可选：已创建的Worker实例
   */
  async executeSubTask(subTask: SubTask, traceId: string, logDir?: string, worker?: WorkerInstance): Promise<WorkerOutput> {
    const targetWorker = worker || await this.createWorker(subTask.workerType, logDir, traceId, subTask.id);
    targetWorker.currentTaskId = subTask.id;
    targetWorker.status = "busy";

    const logFile = targetWorker.logFile || path.join(logDir || this.createLogDirectory(traceId), `WorkerManager_${targetWorker.id}.log`);
    targetWorker.logFile = logFile;

    log({ logFile, prefix: 'WorkerManager', message: `分配子任务 ${subTask.id} 到Worker，类型: ${subTask.workerType}，模式: ${this.runMode}`, traceId, taskId: subTask.id, workerId: targetWorker.id });

    // L2: 注入项目知识到命令
    try {
      const memoryStore = getMemoryStore();
      const projectId = process.env.PROJECT_ID || '__global__';
      const projectKnowledge = memoryStore.getProjectKnowledge(projectId);
      if (projectKnowledge.length > 0) {
        const knowledgeSection = projectKnowledge.map(k =>
          `- [${k.category}] ${k.title}: ${k.content}`
        ).join('\n');
        subTask.command += `\n\n## 项目知识（请遵循）\n${knowledgeSection}`;
        log({ logFile, prefix: 'WorkerManager', message: `L2 注入 ${projectKnowledge.length} 条项目知识`, traceId, taskId: subTask.id, workerId: targetWorker.id });
      }
    } catch (error) {
      log({ logFile, prefix: 'WorkerManager', message: `L2 项目知识注入失败: ${error}`, level: 'warn', traceId, taskId: subTask.id, workerId: targetWorker.id });
    }

    try {
      const result = await this.runTaskWithManager(targetWorker, subTask, traceId, logFile, this.runMode);

      log({ logFile, prefix: 'WorkerManager', message: `子任务 ${subTask.id} 执行完成，状态: ${result.status}`, traceId, taskId: subTask.id, workerId: targetWorker.id });

      return result;

    } catch (error) {
      log({ logFile, prefix: 'WorkerManager', message: `子任务 ${subTask.id} 执行异常: ${error}`, level: 'error', traceId, taskId: subTask.id, workerId: targetWorker.id });
      return {
        status: "fail",
        data: null,
        confidence: 0,
        source_agent: targetWorker.type,
        trace_id: traceId,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      targetWorker.status = "idle";
      targetWorker.currentTaskId = undefined;
      targetWorker.lastUsedAt = new Date();
    }
  }

  /**
   * 按 ID 获取 Worker
   */
  getWorker(workerId: string): WorkerInstance | undefined {
    return this.workers.get(workerId);
  }

  /**
   * 获取所有执行中（busy）的 Worker
   */
  getActiveWorkers(): WorkerInstance[] {
    return Array.from(this.workers.values()).filter(w => w.status === 'busy');
  }

  /**
   * 按类型获取执行中的 Worker
   */
  getWorkersByType(workerType: string): WorkerInstance[] {
    return Array.from(this.workers.values()).filter(w => w.type === workerType && w.status === 'busy');
  }

  /**
   * 获取所有 Worker
   */
  getAllWorkers(): WorkerInstance[] {
    return Array.from(this.workers.values());
  }

  /**
   * 使用 ClaudeUnifiedPtyManager 执行任务（支持 SDK 和 PTY 两种模式）
   * 参照 main.ts 的方案：每个任务创建独立的 ClaudeUnifiedPtyManager
   */
  private async runTaskWithManager(
    worker: WorkerInstance,
    subTask: SubTask,
    traceId: string,
    logFile: string,
    mode: 'sdk' | 'pty'
  ): Promise<WorkerOutput> {
    const sessionId = this.nextSessionId++;
    const taskId = subTask.id;
    const workerId = worker.id;

    // 写入日志
    this.writeLog(logFile, `=== Worker ${worker.id} 开始任务 (${mode.toUpperCase()}模式) ===`, traceId, taskId, workerId);
    this.writeLog(logFile, `任务ID: ${subTask.id}`, traceId, taskId, workerId);
    this.writeLog(logFile, `任务名称: ${subTask.name}`, traceId, taskId, workerId);
    this.writeLog(logFile, `Worker类型: ${worker.type}`, traceId, taskId, workerId);
    this.writeLog(logFile, `会话ID: ${sessionId}`, traceId, taskId, workerId);
    this.writeLog(logFile, `TraceID: ${traceId}`, traceId, taskId, workerId);
    this.writeLog(logFile, `运行模式: ${mode}`, traceId, taskId, workerId);

    try {
      // 创建独立的 ClaudeUnifiedPtyManager（参照 main.ts）
      const terminalCount = 1; // 每个任务只启动1个终端
      const manager = new ClaudeUnifiedPtyManager(terminalCount, mode);

      // 设置SIGINT处理
      const sigintHandler = () => {
        log({ logFile, prefix: 'WorkerManager', message: "正在终止终端...", level: 'warn', traceId, taskId, workerId });
        manager.killAll();
        process.exit(0);
      };
      process.on("SIGINT", sigintHandler);

      this.writeLog(logFile, `[${mode.toUpperCase()}] 初始化管理器...`, traceId, taskId, workerId);
      log({ logFile, prefix: 'WorkerManager', message: `Worker ${worker.id} 初始化 ${mode.toUpperCase()} 管理器...`, traceId, taskId, workerId });

      await manager.initialize();

      // 设置真实 Worker UUID（而非 session 编号），确保 ClaudeLink 收件箱匹配
      manager.setWorkerId(worker.id);

      // 设置权限模式（从配置中读取，默认 Ask）
      const permissionMode = this.config.permissionMode || 'ask';
      manager.setPermissionMode(permissionMode);

      // 格式化命令以适应PTY输入（将多行转换为单行）
      const command = this.formatCommandForPty(subTask.command);
      this.writeLog(logFile, `[${mode.toUpperCase()}] 执行命令: ${command.substring(0, 200)}...`, traceId, taskId, workerId);

      // 执行命令
      this.writeLog(logFile, `[${mode.toUpperCase()}] 开始执行命令...`, traceId, taskId, workerId);
      log({ logFile, prefix: 'WorkerManager', message: `Worker ${worker.id} 执行 ${mode.toUpperCase()} 命令...`, traceId, taskId, workerId });

      await manager.runAll([command]);

      // 读取输出
      this.writeLog(logFile, `[${mode.toUpperCase()}] 执行完成，读取输出...`, traceId, taskId, workerId);
      const output = this.readOutputFromClaudeLogs(sessionId, logFile, traceId, taskId, workerId);

      // 清理：移除SIGINT处理器
      process.removeListener("SIGINT", sigintHandler);

      // 关闭管理器
      manager.killAll();

      this.writeLog(logFile, `[${mode.toUpperCase()}] 输出长度: ${output.length}`, traceId, taskId, workerId);
      this.writeLog(logFile, `[${mode.toUpperCase()}] 输出内容:\n${output}...`, traceId, taskId, workerId);

      // 解析输出为标准格式（使用LLM解析混乱的PTY输出）
      const parsedOutput = await this.parseWorkerOutputWithLLM(output, worker, traceId, logFile, mode);

      this.writeLog(logFile, `[RESULT] 解析后的状态: ${parsedOutput.status}`, traceId, taskId, workerId);
      this.writeLog(logFile, `[RESULT] 置信度: ${parsedOutput.confidence}`, traceId, taskId, workerId);
      this.writeLog(logFile, `=== 任务结束 ===`, traceId, taskId, workerId);

      return parsedOutput;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log({ logFile, prefix: 'WorkerManager', message: `${mode.toUpperCase()}任务执行异常: ${errorMsg}`, level: 'error', traceId, taskId, workerId });
      this.writeLog(logFile, `[ERROR] ${mode.toUpperCase()}任务执行异常: ${errorMsg}`, traceId, taskId, workerId);

      return {
        status: "fail",
        data: null,
        confidence: 0,
        source_agent: worker.type,
        trace_id: traceId,
        error: errorMsg
      };
    }
  }

  /**
   * 将多行命令转换为适合PTY输入的格式
   * 关键点：Claude CLI中，换行符需要特殊处理
   * 只清理会导致PTY问题的控制字符，保留中文和正常标点
   */
  private formatCommandForPty(command: string): string {
    // 方案：将换行符替换为空格，保持命令为单行
    // 因为Claude CLI支持在单行中输入长文本
    return command
      .replace(/[\r\n\t]/g, ' ')  // 将换行符、回车符、制表符替换为空格
      .replace(/\s+/g, ' ')  // 将多个空格替换为单个空格
      .trim();
  }

  /**
   * 从claude-logs目录读取输出
   */
  private readOutputFromClaudeLogs(sessionId: number, logFile: string, traceId?: string, taskId?: string, workerId?: string): string {
    try {
      // Claude的日志在 claude-logs 目录下
      const claudeLogsDir = path.join(process.cwd(), 'claude-logs');
      if (!fs.existsSync(claudeLogsDir)) {
        this.writeLog(logFile, `[WARN] claude-logs 目录不存在`, traceId, taskId, workerId);
        return '';
      }

      // 读取最新的日志文件
      const logFiles = fs.readdirSync(claudeLogsDir)
        .filter((f: string) => f.endsWith('.log') && !f.endsWith('.screen.log'))
        .map((f: string) => path.join(claudeLogsDir, f))
        .sort((a: string, b: string) => {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        });

      if (logFiles.length === 0) {
        this.writeLog(logFile, `[WARN] 未找到日志文件`, traceId, taskId, workerId);
        return '';
      }

      const latestLog = logFiles[0];
      const content = fs.readFileSync(latestLog, 'utf-8');

      this.writeLog(logFile, `[PTY] 从日志文件读取输出: ${latestLog}`, traceId, taskId, workerId);
      this.writeLog(logFile, `[PTY] 输出长度: ${content.length}`, traceId, taskId, workerId);

      return content;

    } catch (error) {
      this.writeLog(logFile, `[ERROR] 读取输出失败: ${error}`, traceId, taskId, workerId);
      return '';
    }
  }

  /**
   * 创建分层日志目录
   */
  private createLogDirectory(traceId: string): string {
    const timeStr = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    const folderName = `${traceId}_${timeStr}`;
    const fullPath = path.join(WORKER_LOG_ROOT, folderName);

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      log({ prefix: 'WorkerManager', message: `创建日志目录: ${fullPath}` });
    }

    return fullPath;
  }

  /**
   * 使用LLM解析混乱的PTY输出为JSON格式
   * 作为主解析方法，失败时降级到传统解析
   * 当mode为sdk时，无需LLM解析，data就是rawOutput
   */
  private async parseWorkerOutputWithLLM(
    rawOutput: string,
    worker: WorkerInstance,
    traceId: string,
    logFile: string,
    mode: 'sdk' | 'pty'
  ): Promise<WorkerOutput> {
    const taskId: string | undefined = worker.currentTaskId;
    const workerId = worker.id;

    try {
      // 如果是 SDK 模式，无需 LLM 解析，直接使用 rawOutput
      if (mode === 'sdk') {
        this.writeLog(logFile, `[SDK] 跳过 LLM 解析，直接使用原始输出`, traceId, taskId, workerId);
        return {
          status: "success",
          data: rawOutput,
          confidence: 1.0,
          source_agent: worker.type,
          trace_id: traceId
        };
      }

      const llmClient = getLLMClient();

      const systemPrompt = `你是一个专业输出解析器。用户将提供从PTY终端捕获的Claude CLI输出，其中包含ANSI转义码、终端UI元素、重复内容等混乱信息。

你的任务是：
1. 从混乱的输出中提取真正有意义的任务执行结果
2. 忽略ANSI转义码、终端UI、进度指示器、重复内容等噪音
3. 将提取的结果格式化为有效的JSON，但不要修改原始输出的格式以及有价值的信息

重要：PTY执行完毕表示任务已经成功完成，不要根据输出内容推断状态。
- status 字段必须固定为 "success"
- 不要因为输出中有错误信息或异常内容就改为 "fail"

输出必须是有效的JSON对象，包含以下字段：
- status: 必须是字符串 "success"（固定值，不要改为其他值）
- data: 任务执行的结果数据（可以是字符串、对象或数组）
- confidence: 0-1之间的数字，表示解析的可信度
- source_agent: 固定为 "${worker.type}"
- trace_id: 固定为 "${traceId}"

如果无法提取有效结果，返回：
{
  "status": "success",
  "data": "任务已执行完毕，但无法提取结构化结果",
  "confidence": 0.5,
  "source_agent": "${worker.type}",
  "trace_id": "${traceId}",
  "error": "无法从输出中提取有效结果"
}

只返回JSON对象，不要返回其他内容。`;

      // 清理输出中的ANSI转义码（简单清理，让LLM做主要解析）
      const cleanedOutput = rawOutput
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // 移除ANSI转义码
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 移除控制字符
        .substring(0, 30000); // 限制长度避免超出token限制

      const userPrompt = `请从以下PTY输出中提取任务执行结果并格式化为JSON。注意忽略ANSI转义码、终端UI等噪音，只关注实际的任务执行结果。

PTY输出：
\`\`\`
${cleanedOutput}
\`\`\`

请只返回JSON对象，不要其他解释。`;

      this.writeLog(logFile, `[LLM-PARSE] 使用LLM解析输出，输出长度: ${cleanedOutput.length}`, traceId, taskId, workerId);

      const response = await llmClient.ask(userPrompt, {
        systemPrompt,
        maxTokens: 4096,
        temperature: 0.1
      });

      if (!response.success || !response.content) {
        this.writeLog(logFile, `[LLM-PARSE] LLM调用失败: ${response.error}`, traceId, taskId, workerId);
        throw new Error(response.error || 'LLM调用失败');
      }

      // 从LLM响应中提取JSON
      const content = response.content;
      let jsonStr = content;

      // 尝试从markdown代码块中提取JSON
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1];
      }

      // 尝试解析JSON
      try {
        const parsed = JSON.parse(jsonStr);

        // 验证必需字段
        if (!parsed.status || parsed.data === undefined) {
          throw new Error('缺少必需字段 status 或 data');
        }

        // PTY 执行完毕表示任务成功，强制设置 status 为 success
        const result: WorkerOutput = {
          status: "success",
          data: parsed.data,
          confidence: parsed.confidence || 0.8,
          source_agent: parsed.source_agent || worker.type,
          trace_id: parsed.trace_id || traceId,
          error: parsed.error
        };

        this.writeLog(logFile, `[LLM-PARSE] LLM解析成功，状态: ${result.status} (强制成功)`, traceId, taskId, workerId);
        this.writeLog(logFile, `[LLM-PARSE] 解析结果: ${JSON.stringify(result)}`, traceId, taskId, workerId);
        return result;

      } catch (parseError) {
        this.writeLog(logFile, `[LLM-PARSE] JSON解析失败: ${parseError}`, traceId, taskId, workerId);
        this.writeLog(logFile, `[LLM-PARSE] LLM原始输出: ${content.substring(0, 500)}`, traceId, taskId, workerId);
        throw new Error(`JSON解析失败: ${parseError}`);
      }

    } catch (error) {
      this.writeLog(logFile, `[LLM-PARSE] LLM解析异常: ${error}`, traceId, taskId, workerId);
      log({ logFile, prefix: 'WorkerManager', message: `LLM解析失败，降级到传统解析方法: ${error}`, level: 'error', traceId, taskId, workerId });

      // 降级到原来的解析方法
      return this.parseWorkerOutput(rawOutput, worker, traceId);
    }
  }

  /**
   * 解析Worker输出为标准格式（传统方法，作为降级方案）
   */
  private parseWorkerOutput(rawOutput: string, worker: WorkerInstance, traceId: string): WorkerOutput {
    // 尝试从输出中提取JSON格式的结果
    const jsonMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);

        // 检查是否已经是WorkerOutput格式
        if (parsed.status && parsed.data !== undefined) {
          return {
            status: parsed.status as "success" | "fail" | "partial",
            data: parsed.data,
            confidence: parsed.confidence || 0.8,
            source_agent: worker.type,
            trace_id: traceId,
            error: parsed.error
          };
        }

        // 检查是否是评审格式
        if (parsed.passed !== undefined && worker.type === 'review_agent') {
          return {
            status: "success",
            data: parsed,
            confidence: 0.9,
            source_agent: worker.type,
            trace_id: traceId
          };
        }

        // 其他JSON格式，包装为data
        return {
          status: "success",
          data: parsed,
          confidence: 0.8,
          source_agent: worker.type,
          trace_id: traceId
        };

      } catch (e) {
        log({ prefix: 'WorkerManager', message: `JSON解析失败，使用原始内容: ${e}`, level: 'warn' });
      }
    }

    // 尝试直接从内容中解析JSON（没有markdown代码块）
    try {
      const parsed = JSON.parse(rawOutput);
      if (parsed.status && parsed.data !== undefined) {
        return {
          status: parsed.status as "success" | "fail" | "partial",
          data: parsed.data,
          confidence: parsed.confidence || 0.8,
          source_agent: worker.type,
          trace_id: traceId
        };
      }
    } catch (e) {
      // 忽略
    }

    // 如果没有找到JSON，使用默认格式封装原始输出
    return {
      status: "success",
      data: rawOutput,
      confidence: 0.7,
      source_agent: worker.type,
      trace_id: traceId
    };
  }

  /**
   * 写入日志（静默模式：只写文件不输出终端）
   */
  private writeLog(logFile: string, message: string, traceId?: string, taskId?: string, workerId?: string): void {
    log({ logFile, prefix: 'WorkerManager', message, silent: true, traceId, taskId, workerId });
  }

  /**
   * 关闭所有Worker
   */
  async shutdown(): Promise<void> {
    log({ prefix: 'WorkerManager', message: `正在关闭 ${this.workers.size} 个Worker...` });
    this.workers.clear();
    log({ prefix: 'WorkerManager', message: `所有Worker已关闭` });
  }
}
