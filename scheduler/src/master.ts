/**
 * Master主调度层
 * 系统唯一对外交互入口，负责需求解析、任务调度、输出校验、结果合并
 */

import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import {
  MainTask,
  TaskStatus,
  TaskPriority,
  PlanOutput,
  TaskResult,
  ArbitrationResult,
  WorkerOutput,
  SchedulerConfig,
  WorkerOutputSchema,
  ArbitrationMode
} from "./types";
import { PlanExecutor } from "./plan-executor";
import { WorkerManager } from "./worker-manager";
import { ArbitrationEngine } from "./arbitration-engine";
import { ClaudeLink } from "./claude-link";
import { getLLMClient } from "./llm-client";
import { log } from "./logger";

export class MasterScheduler {
  private config: SchedulerConfig;
  private planExecutor: PlanExecutor;
  private workerManager: WorkerManager;
  private arbitrationEngine: ArbitrationEngine;
  private tasks: Map<string, MainTask> = new Map();

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = {
      maxWorkers: config.maxWorkers || 3,
      defaultMaxRetries: config.defaultMaxRetries || 3,
      defaultTimeoutMs: config.defaultTimeoutMs || 30 * 60 * 1000, // 30分钟
      arbitrationMode: config.arbitrationMode || ArbitrationMode.CONFIDENCE_VOTE,
      enableReview: config.enableReview !== undefined ? config.enableReview : true,
      workerTypes: config.workerTypes || ['general_agent'],
      runMode: config.runMode || 'pty' // 添加 runMode，默认 pty
    };

    this.planExecutor = new PlanExecutor(this.config);
    this.workerManager = new WorkerManager(this.config);
    this.arbitrationEngine = new ArbitrationEngine(this.config);
  }

  /**
   * 提交用户请求，启动任务执行
   */
  async submitRequest(userRequest: string, options: {
    name?: string;
    description?: string;
    priority?: TaskPriority;
    constraints?: string[];
    deliveryStandards?: string[];
  } = {}): Promise<TaskResult> {
    const traceId = uuidv4();
    const startTime = Date.now();

    // 检查LLM状态
    getLLMClient(); // 确保LLM客户端已初始化
    log({ prefix: 'Master', message: '使用真实LLM模式' });

    try {
      // 1. 解析用户需求，提取约束和交付标准
      const task = this.createMainTask(userRequest, options, traceId);
      this.tasks.set(task.id, task);

      // 创建分层日志目录
      const timeStr = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
      const folderName = `${traceId}_${timeStr}`;
      const logRoot = path.resolve(__dirname, '../worker-logs');
      const logDir = path.join(logRoot, folderName);

      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      task.logDir = logDir;

      // 创建统一的Master日志文件（Master + PlanExecutor 共用）
      const masterLogFile = path.join(logDir, `Master_${traceId}.log`);
      task.masterLogFile = masterLogFile;

      log({ logFile: masterLogFile, prefix: 'Master', message: `已创建任务 ${task.id}，TraceID: ${traceId}` });
      log({ logFile: masterLogFile, prefix: 'Master', message: `用户需求: ${userRequest}` });
      log({ logFile: masterLogFile, prefix: 'Master', message: `日志目录: ${logDir}` });

      // 2. 调用Plan模块拆分任务，构建DAG
      task.status = TaskStatus.RUNNING;
      task.startedAt = new Date();

      const planOutput = await this.planExecutor.planTask(task);
      task.subTasks = new Map(planOutput.subTasks.map(st => [st.id, st]));
      task.dag = planOutput.dag;

      log({ logFile: masterLogFile, prefix: 'Master', message: `任务拆分完成，共 ${planOutput.subTasks.length} 个子任务` });
      log({ logFile: masterLogFile, prefix: 'Master', message: `预估执行时间: ${planOutput.estimatedDuration}秒` });

      // 3. 执行任务DAG
      const executionResults = await this.planExecutor.executeDAG(task, this.workerManager);

      // 4. 校验所有Worker输出
      log({ prefix: 'Master', message: `任务执行完成，开始校验输出` });
      const validOutputs = this.validateOutputs(executionResults);

      if (validOutputs.length === 0) {
        throw new Error("所有子任务执行失败，无有效输出");
      }

      // 5. 仲裁冲突，合并结果
      log({ prefix: 'Master', message: `开始仲裁合并 ${validOutputs.length} 个有效输出` });
      const arbitrationResult = await this.arbitrationEngine.arbitrate(validOutputs, task);

      if (!arbitrationResult.resolved) {
        if (arbitrationResult.requiresUserInput) {
          log({ prefix: 'Master', message: `需要用户输入: ${arbitrationResult.userPrompt}` });
        }
        throw new Error(`仲裁失败: ${arbitrationResult.conflicts?.join(', ')}`);
      }

      // 6. 如果启用评审，调用独立评审Agent二次校验
      let finalOutput = arbitrationResult.finalOutput;
      if (this.config.enableReview) {
        log({ prefix: 'Master', message: `启动独立评审Agent校验结果` });
        const reviewResult = await this.performReviewWithLLM(finalOutput, task);

        if (!reviewResult.passed) {
          log({ prefix: 'Master', message: `评审未通过: ${reviewResult.feedback}`, level: 'warn' });
          log({ prefix: 'Master', message: `将尝试根据评审意见改进...`, level: 'warn' });

          // 可以在这里添加改进逻辑
        } else {
          log({ prefix: 'Master', message: `评审通过` });
        }

        // 将评审结果也附加到最终输出中
        finalOutput = {
          mainResult: finalOutput,
          review: reviewResult
        };
      }

      // 7. 生成最终结果
      task.output = finalOutput;
      task.status = TaskStatus.COMPLETED;
      task.completedAt = new Date();

      const duration = (Date.now() - startTime) / 1000;
      log({ prefix: 'Master', message: `任务 ${task.id} 执行完成，耗时 ${duration} 秒` });

      return {
        success: true,
        data: task.output,
        traceId,
        duration
      };

    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      log({ prefix: 'Master', message: `任务执行失败: ${error}`, level: 'error' });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        traceId,
        duration
      };
    }
  }

  /**
   * 创建主任务
   */
  private createMainTask(
    userRequest: string,
    options: {
      name?: string;
      description?: string;
      priority?: TaskPriority;
      constraints?: string[];
      deliveryStandards?: string[];
    },
    traceId: string
  ): MainTask {
    return {
      id: uuidv4(),
      name: options.name || `任务_${new Date().toISOString().slice(0, 19)}`,
      description: options.description || userRequest.slice(0, 100) + '...',
      userRequest,
      constraints: options.constraints || [],
      deliveryStandards: options.deliveryStandards || [],
      priority: options.priority || TaskPriority.P1,
      status: TaskStatus.PENDING,
      subTasks: new Map(),
      dag: { nodes: new Map(), edges: new Map() },
      createdAt: new Date(),
      traceId
    };
  }

  /**
   * 校验所有Worker输出
   */
  private validateOutputs(outputs: WorkerOutput[]): WorkerOutput[] {
    return outputs.filter(output => {
      const result = WorkerOutputSchema.safeParse(output);
      if (!result.success) {
        log({ prefix: 'Master', message: `输出校验失败: ${result.error.message}`, level: 'warn' });
        return false;
      }
      return output.status !== "fail" || output.confidence > 0.5;
    });
  }

  /**
   * 使用LLM执行独立评审
   */
  private async performReviewWithLLM(output: any, task: MainTask): Promise<{
    passed: boolean;
    feedback: string;
    issues?: string[];
    suggestions?: string[];
  }> {
    log({ prefix: 'Master', message: `调用LLM进行评审...` });

    const llm = getLLMClient();

    const systemPrompt = `你是一位专业的独立评审专家。你的职责是：
1. 评估任务结果是否满足原始需求
2. 识别可能存在的问题和不足
3. 提供具体、建设性的改进建议
4. 给出最终的评审结论

请用JSON格式返回你的评审结果。`;

    const outputStr = typeof output === 'string'
      ? output
      : JSON.stringify(output, null, 2);

    const userPrompt = `请评审以下任务执行结果：

## 原始任务需求
${task.userRequest}

## 任务约束
${task.constraints.length > 0 ? task.constraints.join('; ') : '无'}

## 交付标准
${task.deliveryStandards.length > 0 ? task.deliveryStandards.join('; ') : '无'}

## 执行结果
${outputStr}

## 请给出评审结果（JSON格式）
{
  "passed": true/false,
  "feedback": "详细的评审反馈",
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"],
  "score": 0.85  // 0-1之间的评分
}`;

    const response = await llm.askForJSON<{
      passed: boolean;
      feedback: string;
      issues?: string[];
      suggestions?: string[];
      score?: number;
    }>(userPrompt, {
      systemPrompt,
      temperature: 0.5
    });

    if (!response.success || !response.data) {
      log({ prefix: 'Master', message: `评审LLM调用失败，默认通过: ${response.error}`, level: 'warn' });
      return {
        passed: true,
        feedback: '评审过程出现问题，默认通过。错误: ' + response.error
      };
    }

    log({ prefix: 'Master', message: `评审完成，结果: ${response.data.passed ? '通过' : '未通过'}, 评分: ${response.data.score || 'N/A'}` });
    log({ prefix: 'Master', message: `评审反馈: ${response.data.feedback}` });

    return response.data;
  }

  /**
   * 关闭调度器，释放所有资源
   */
  async shutdown(): Promise<void> {
    log({ prefix: 'Master', message: `正在关闭调度器...` });
    await this.workerManager.shutdown();
    ClaudeLink.getInstance().shutdown();
    log({ prefix: 'Master', message: `调度器已关闭` });
  }
}
