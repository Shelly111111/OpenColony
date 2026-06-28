/**
 * Worker集群管理层
 * 使用ClaudeUnifiedPtyManager管理PTY会话，实现多harness调用
 * 参照 main.ts 的方案：每个任务创建独立的Manager实例
 */

import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import {
  WorkerInstance,
  WorkerType,
  SubTask,
  WorkerOutput,
  SchedulerConfig
} from "./types";


const { ClaudeUnifiedPtyManager } = require('../../claude-multi-runner/manager');

// Worker日志根目录
const WORKER_LOG_ROOT = path.resolve(__dirname, "../worker-logs");

export class WorkerManager {
  private config: SchedulerConfig;
  private workers: Map<string, WorkerInstance> = new Map();
  private nextSessionId: number = 1;

  constructor(config: SchedulerConfig) {
    this.config = config;

    // 确保日志根目录存在
    if (!fs.existsSync(WORKER_LOG_ROOT)) {
      fs.mkdirSync(WORKER_LOG_ROOT, { recursive: true });
    }
  }

  /**
   * 执行单个子任务
   */
  async executeSubTask(subTask: SubTask, traceId: string, logDir?: string): Promise<WorkerOutput> {
    console.log(`[WorkerManager] 分配子任务 ${subTask.id} 到Worker，类型: ${subTask.workerType}`);

    // 创建Worker实例
    const worker = await this.createWorker(subTask.workerType, logDir);
    worker.currentTaskId = subTask.id;
    worker.status = "busy";

    // 使用Worker自己的日志文件（一个Worker一个日志文件）
    const logFile = worker.logFile || path.join(logDir || this.createLogDirectory(traceId), `WorkerManager_${worker.id}.log`);
    worker.logFile = logFile;

    try {
      // 执行任务（使用PTY Claude CLI）
      const result = await this.runTaskWithPty(worker, subTask, traceId, logFile);

      console.log(`[WorkerManager] 子任务 ${subTask.id} 执行完成，状态: ${result.status}`);

      return result;

    } catch (error) {
      console.error(`[WorkerManager] 子任务 ${subTask.id} 执行异常:`, error);
      return {
        status: "fail",
        data: null,
        confidence: 0,
        source_agent: worker.type,
        trace_id: traceId,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      // 重置Worker状态
      worker.status = "idle";
      worker.currentTaskId = undefined;
      worker.lastUsedAt = new Date();
    }
  }

  /**
   * 使用PTY Claude CLI执行任务
   * 参照 main.ts 的方案：每个任务创建独立的 ClaudeUnifiedPtyManager
   */
  private async runTaskWithPty(
    worker: WorkerInstance,
    subTask: SubTask,
    traceId: string,
    logFile: string
  ): Promise<WorkerOutput> {
    const sessionId = this.nextSessionId++;

    // 写入日志
    this.writeLog(logFile, `=== Worker ${worker.id} 开始任务 ===`);
    this.writeLog(logFile, `任务ID: ${subTask.id}`);
    this.writeLog(logFile, `任务名称: ${subTask.name}`);
    this.writeLog(logFile, `Worker类型: ${worker.type}`);
    this.writeLog(logFile, `会话ID: ${sessionId}`);
    this.writeLog(logFile, `TraceID: ${traceId}`);

    try {
      // 确保 Git Bash 路径已设置（防止 PTY 使用 CMD）
      if (!process.env.CLAUDE_CODE_GIT_BASH_PATH) {
        const gitBashPath = 'D:\\Git\\bin\\bash.exe';
        if (require('fs').existsSync(gitBashPath)) {
          process.env.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
          this.writeLog(logFile, `[PTY] 设置 Git Bash 路径: ${gitBashPath}`);
        }
      }

      // 创建独立的PTY管理器（参照 main.ts）
      const terminalCount = 1; // 每个任务只启动1个终端
      const manager = new ClaudeUnifiedPtyManager(terminalCount);

      // 设置SIGINT处理
      const sigintHandler = () => {
        console.log("\n\x1b[33m正在终止终端...\x1b[0m");
        manager.killAll();
        process.exit(0);
      };
      process.on("SIGINT", sigintHandler);

      this.writeLog(logFile, `[PTY] 初始化PTY管理器...`);
      console.log(`[WorkerManager] Worker ${worker.id} 初始化PTY管理器...`);

      await manager.initialize();

      // 准备命令：提取核心prompt（去掉多余的任务描述格式）
      const rawCommand = this.extractCommand(subTask.command);
      // 格式化命令以适应PTY输入（将多行转换为单行）
      const command = this.formatCommandForPty(rawCommand);
      this.writeLog(logFile, `[PTY] 执行命令: ${command.substring(0, 200)}...`);

      // 执行命令（参照 main.ts 的 runAll 模式）
      this.writeLog(logFile, `[PTY] 开始执行命令...`);
      console.log(`[WorkerManager] Worker ${worker.id} 执行PTY命令...`);

      await manager.runAll([command]);

      // 读取输出（从claude-logs目录）
      this.writeLog(logFile, `[PTY] 执行完成，读取输出...`);
      const output = this.readOutputFromClaudeLogs(sessionId, logFile);

      // 清理：移除SIGINT处理器
      process.removeListener("SIGINT", sigintHandler);

      // 关闭管理器
      manager.killAll();

      this.writeLog(logFile, `[PTY] 输出长度: ${output.length}`);
      this.writeLog(logFile, `[PTY] 输出内容:\n${output.substring(0, 2000)}...`);

      // 解析输出为标准格式
      const parsedOutput = this.parseWorkerOutput(output, worker, traceId);

      this.writeLog(logFile, `[RESULT] 解析后的状态: ${parsedOutput.status}`);
      this.writeLog(logFile, `[RESULT] 置信度: ${parsedOutput.confidence}`);
      this.writeLog(logFile, `=== 任务结束 ===`);

      return parsedOutput;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[WorkerManager] PTY任务执行异常:`, error);
      this.writeLog(logFile, `[ERROR] PTY任务执行异常: ${errorMsg}`);

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
   * 从子任务的command中提取核心prompt
   * 去掉格式标记，但保留任务名称和描述等关键内容
   */
  private extractCommand(fullCommand: string): string {
    // 如果包含 "请执行以下任务"，则提取后面的内容
    const match = fullCommand.match(/请执行以下任务：([\s\S]*)/);
    if (match) {
      const content = match[1];

      // 提取关键字段：- 任务名称：xxx 和 - 任务描述：xxx
      const nameMatch = content.match(/- 任务名称：(.+)/);
      const descMatch = content.match(/- 任务描述：(.+)/);

      // 提取原始需求（去掉 ## 开头的标题行）
      const originalRequestLines = content.split('\n')
        .filter(line => {
          const trimmed = line.trim();
          // 去掉标题行
          if (trimmed.startsWith('##')) return false;
          // 去掉任务信息标题下的字段名行（已单独提取）
          if (trimmed.startsWith('- 任务名称：')) return false;
          if (trimmed.startsWith('- 任务描述：')) return false;
          return true;
        })
        .join('\n')
        .trim();

      // 重新组装：任务名称 + 任务描述 + 原始需求
      const parts: string[] = [];
      if (nameMatch) {
        parts.push(`任务：${nameMatch[1].trim()}`);
      }
      if (descMatch) {
        parts.push(`描述：${descMatch[1].trim()}`);
      }
      if (originalRequestLines) {
        parts.push(originalRequestLines);
      }

      const result = parts.join('\n\n');
      return result || fullCommand;
    }
    return fullCommand;
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
  private readOutputFromClaudeLogs(sessionId: number, logFile: string): string {
    try {
      // Claude的日志在 claude-logs 目录下
      const claudeLogsDir = path.join(process.cwd(), 'claude-logs');
      if (!fs.existsSync(claudeLogsDir)) {
        this.writeLog(logFile, `[WARN] claude-logs 目录不存在`);
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
        this.writeLog(logFile, `[WARN] 未找到日志文件`);
        return '';
      }

      const latestLog = logFiles[0];
      const content = fs.readFileSync(latestLog, 'utf-8');

      this.writeLog(logFile, `[PTY] 从日志文件读取输出: ${latestLog}`);
      this.writeLog(logFile, `[PTY] 输出长度: ${content.length}`);

      return content;

    } catch (error) {
      this.writeLog(logFile, `[ERROR] 读取输出失败: ${error}`);
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
      console.log(`[WorkerManager] 创建日志目录: ${fullPath}`);
    }

    return fullPath;
  }

  /**
   * 创建Worker实例
   */
  private async createWorker(workerType: WorkerType, logDir?: string): Promise<WorkerInstance> {
    // 查找空闲Worker
    for (const worker of this.workers.values()) {
      if (worker.status === "idle" && worker.type === workerType) {
        console.log(`[WorkerManager] 复用现有Worker ${worker.id}，类型: ${workerType}`);
        return worker;
      }
    }

    // 创建新Worker
    const workerId = uuidv4();

    const worker: WorkerInstance = {
      id: workerId,
      type: workerType,
      status: "idle",
      createdAt: new Date()
    };

    // 为新Worker创建日志文件（一个Worker一个日志文件）
    if (logDir) {
      const logFileName = `WorkerManager_${workerId}.log`;
      worker.logFile = path.join(logDir, logFileName);
      this.writeLog(worker.logFile, `[WorkerManager] 创建Worker ${workerId}，类型: ${workerType}`);
    }

    this.workers.set(workerId, worker);
    console.log(`[WorkerManager] 创建新Worker ${workerId}，类型: ${workerType}`);

    return worker;
  }

  /**
   * 解析Worker输出为标准格式
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
        if (parsed.passed !== undefined && worker.type === WorkerType.REVIEW) {
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
        console.warn(`[WorkerManager] JSON解析失败，使用原始内容:`, e);
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
          trace_id: traceId,
          error: parsed.error
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
   * 写入日志
   */
  private writeLog(logFile: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logLine, 'utf-8');
  }

  /**
   * 关闭所有Worker
   */
  async shutdown(): Promise<void> {
    console.log(`[WorkerManager] 正在关闭 ${this.workers.size} 个Worker...`);

    // 关闭所有PTY管理器
    for (const worker of this.workers.values()) {
      // 每个worker有自己的manager，但这里统一清理
    }

    this.workers.clear();
    console.log(`[WorkerManager] 所有Worker已关闭`);
  }
}
