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
  ArbitrationMode,
  InjectionRequest,
  InjectionResult,
  InjectionRoute,
  InjectionTiming,
  InjectionStatus,
  RouteDetail,
  MessagePriority,
  WorkerInstance
} from "./types";
import { PlanExecutor } from "./plan-executor";
import { WorkerManager } from "./worker-manager";
import { ArbitrationEngine } from "./arbitration-engine";
import { ClaudeLink } from "./claude-link";
import { getLLMClient } from "./llm-client";
import { log, setLogDb } from "./logger";
import { MessageDB } from "./message-db";

export class MasterScheduler {
  private config: SchedulerConfig;
  private planExecutor: PlanExecutor;
  private workerManager: WorkerManager;
  private arbitrationEngine: ArbitrationEngine;
  private tasks: Map<string, MainTask> = new Map();
  private logDb: MessageDB;

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

    // 初始化日志数据库并注入到 logger
    this.logDb = new MessageDB();
    setLogDb(this.logDb);
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

      log({ logFile: masterLogFile, prefix: 'Master', message: `已创建任务 ${task.id}，TraceID: ${traceId}`, traceId, taskId: task.id });
      log({ logFile: masterLogFile, prefix: 'Master', message: `用户需求: ${userRequest}`, traceId, taskId: task.id });
      log({ logFile: masterLogFile, prefix: 'Master', message: `日志目录: ${logDir}`, traceId, taskId: task.id });

      // 2. 调用Plan模块拆分任务，构建DAG
      task.status = TaskStatus.RUNNING;
      task.startedAt = new Date();

      const planOutput = await this.planExecutor.planTask(task);
      task.subTasks = new Map(planOutput.subTasks.map(st => [st.id, st]));
      task.dag = planOutput.dag;

      log({ logFile: masterLogFile, prefix: 'Master', message: `任务拆分完成，共 ${planOutput.subTasks.length} 个子任务`, traceId, taskId: task.id });

      // 3. 执行任务DAG
      const executionResults = await this.planExecutor.executeDAG(task, this.workerManager);

      // 4. 校验所有Worker输出
      log({ logFile: masterLogFile, prefix: 'Master', message: `任务执行完成，开始校验输出`, traceId, taskId: task.id });
      const validOutputs = this.validateOutputs(executionResults, masterLogFile, traceId, task.id);

      if (validOutputs.length === 0) {
        throw new Error("所有子任务执行失败，无有效输出");
      }

      // 5. 仲裁冲突，合并结果
      log({ logFile: masterLogFile, prefix: 'Master', message: `开始仲裁合并 ${validOutputs.length} 个有效输出`, traceId, taskId: task.id });
      const arbitrationResult = await this.arbitrationEngine.arbitrate(validOutputs, task);

      if (!arbitrationResult.resolved) {
        if (arbitrationResult.requiresUserInput) {
          log({ logFile: masterLogFile, prefix: 'Master', message: `需要用户输入: ${arbitrationResult.userPrompt}`, traceId, taskId: task.id });
        }
        throw new Error(`仲裁失败: ${arbitrationResult.conflicts?.join(', ')}`);
      }

      // 6. 如果启用评审，调用独立评审Agent二次校验
      let finalOutput = arbitrationResult.finalOutput;
      if (this.config.enableReview) {
        log({ logFile: masterLogFile, prefix: 'Master', message: `启动独立评审Agent校验结果`, traceId, taskId: task.id });
        const reviewResult = await this.performReviewWithLLM(finalOutput, task, masterLogFile);

        if (!reviewResult.passed) {
          log({ logFile: masterLogFile, prefix: 'Master', message: `评审未通过: ${reviewResult.feedback}`, level: 'warn', traceId, taskId: task.id });
          log({ logFile: masterLogFile, prefix: 'Master', message: `将尝试根据评审意见改进...`, level: 'warn', traceId, taskId: task.id });

          // 可以在这里添加改进逻辑
        } else {
          log({ logFile: masterLogFile, prefix: 'Master', message: `评审通过`, traceId, taskId: task.id });
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
      log({ logFile: masterLogFile, prefix: 'Master', message: `任务 ${task.id} 执行完成，耗时 ${duration} 秒`, traceId, taskId: task.id });

      return {
        success: true,
        data: task.output,
        traceId,
        duration
      };

    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      const task = this.tasks.get(traceId);
      log({ logFile: task?.masterLogFile, prefix: 'Master', message: `任务执行失败: ${error}`, level: 'error', traceId, taskId: task?.id });

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
  private validateOutputs(outputs: WorkerOutput[], masterLogFile?: string, traceId?: string, taskId?: string): WorkerOutput[] {
    return outputs.filter(output => {
      const result = WorkerOutputSchema.safeParse(output);
      if (!result.success) {
        log({ logFile: masterLogFile, prefix: 'Master', message: `输出校验失败: ${result.error.message}`, level: 'warn', traceId, taskId });
        return false;
      }
      return output.status !== "fail" || output.confidence > 0.5;
    });
  }

  /**
   * 使用LLM执行独立评审
   */
  private async performReviewWithLLM(output: any, task: MainTask, masterLogFile?: string): Promise<{
    passed: boolean;
    feedback: string;
    issues?: string[];
    suggestions?: string[];
  }> {
    log({ logFile: masterLogFile, prefix: 'Master', message: `调用LLM进行评审...`, traceId: task.traceId, taskId: task.id });

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
      log({ logFile: masterLogFile, prefix: 'Master', message: `评审LLM调用失败，默认通过: ${response.error}`, level: 'warn', traceId: task.traceId, taskId: task.id });
      return {
        passed: true,
        feedback: '评审过程出现问题，默认通过。错误: ' + response.error
      };
    }

    log({ logFile: masterLogFile, prefix: 'Master', message: `评审完成，结果: ${response.data.passed ? '通过' : '未通过'}, 评分: ${response.data.score || 'N/A'}`, traceId: task.traceId, taskId: task.id });
    log({ logFile: masterLogFile, prefix: 'Master', message: `评审反馈: ${response.data.feedback}`, traceId: task.traceId, taskId: task.id });

    return response.data;
  }

  /**
   * 接收用户补充信息，路由至目标Worker（V1.5核心功能）
   *
   * 支持三种路由模式：
   * - 定向路由：用户明确指定Worker（通过targetWorkerId或targetWorkerType）
   * - 智能路由：Master通过LLM分析信息内容，自动路由到最相关Worker
   * - 全局广播：信息对所有Worker有效
   *
   * 支持三种注入时机：
   * - 立即注入：Worker下轮ReAct循环检查inbox时获取（默认）
   * - 强制中断：标记为HIGH优先级，Worker优先处理
   * - 等待注入：当前操作完成后注入
   *
   * 返回状态码：
   * - 6001: 补充信息已路由送达
   * - 6002: 补充信息需用户澄清目标
   * - 6003: 补充信息无法送达
   */
  async injectSupplementaryInfo(request: InjectionRequest): Promise<InjectionResult> {
    const claudeLink = ClaudeLink.getInstance();
    const timing = request.timing || (request.urgent ? InjectionTiming.INTERRUPT : InjectionTiming.IMMEDIATE);
    const fromWorkerId = 'master';

    log({ prefix: 'Master', message: `收到补充信息注入请求: route=${request.route || 'auto'}, timing=${timing}, content="${request.content.slice(0, 80)}..."` });

    // 1. 确定路由模式
    let route: InjectionRoute;
    if (request.route) {
      route = request.route;
    } else if (request.targetWorkerId || request.targetWorkerType) {
      route = InjectionRoute.DIRECTED;
    } else {
      route = InjectionRoute.SMART;
    }

    // 2. 根据路由模式分发
    switch (route) {
      case InjectionRoute.DIRECTED:
        return await this.routeDirected(request, timing, fromWorkerId);
      case InjectionRoute.BROADCAST:
        return await this.routeBroadcast(request, timing, fromWorkerId);
      case InjectionRoute.SMART:
      default:
        return await this.routeSmart(request, timing, fromWorkerId);
    }
  }

  /**
   * 定向路由：用户明确指定Worker
   */
  private async routeDirected(
    request: InjectionRequest,
    timing: InjectionTiming,
    fromWorkerId: string
  ): Promise<InjectionResult> {
    const claudeLink = ClaudeLink.getInstance();
    let targetWorkers: WorkerInstance[] = [];

    if (request.targetWorkerId) {
      // 按 Worker ID 从 workerManager 查询
      const worker = this.workerManager.getWorker(request.targetWorkerId);
      if (worker) targetWorkers.push(worker);
    } else if (request.targetWorkerType) {
      // 按 Worker 类型查询
      targetWorkers = this.workerManager.getWorkersByType(request.targetWorkerType);
    }

    if (targetWorkers.length === 0) {
      // 找不到目标Worker，返回需澄清
      const candidates = this.workerManager.getActiveWorkers();
      return {
        status: InjectionStatus.NEEDS_CLARIFICATION,
        statusCode: 6002,
        route: InjectionRoute.DIRECTED,
        routeDetail: {
          targetWorkerIds: [],
          reason: `未找到目标Worker: ${request.targetWorkerId || request.targetWorkerType}`,
        },
        messageIds: [],
        candidates,
      };
    }

    // 检查Worker是否已完成
    const activeWorkers = targetWorkers.filter(w => w.status === 'busy');
    if (activeWorkers.length === 0) {
      return {
        status: InjectionStatus.UNDELIVERABLE,
        statusCode: 6003,
        route: InjectionRoute.DIRECTED,
        routeDetail: {
          targetWorkerIds: targetWorkers.map(w => w.id),
          reason: '目标Worker已完成当前任务',
        },
        messageIds: [],
        error: '该Worker已完成，是否重新执行？',
      };
    }

    const priority = timing === InjectionTiming.INTERRUPT ? MessagePriority.HIGH : MessagePriority.NORMAL;
    const messageIds: string[] = [];
    for (const worker of activeWorkers) {
      const message = await claudeLink.sendMessage(fromWorkerId, worker.id, request.content, priority, {
        type: 'supplementary_info',
        traceId: request.traceId,
        timing,
        urgent: request.urgent || false,
      });
      messageIds.push(message.id);
    }

    log({ prefix: 'Master', message: `定向路由完成: 送达 ${activeWorkers.length} 个Worker, 消息ID: ${messageIds.join(', ')}` });

    return {
      status: InjectionStatus.DELIVERED,
      statusCode: 6001,
      route: InjectionRoute.DIRECTED,
      routeDetail: {
        targetWorkerIds: activeWorkers.map(w => w.id),
        reason: `用户定向指定: ${request.targetWorkerId || request.targetWorkerType}`,
      },
      messageIds,
    };
  }

  /**
   * 全局广播：信息对所有Worker有效
   */
  private async routeBroadcast(
    request: InjectionRequest,
    timing: InjectionTiming,
    fromWorkerId: string
  ): Promise<InjectionResult> {
    const claudeLink = ClaudeLink.getInstance();
    // 从 workerManager 获取所有活跃Worker
    const workers = this.workerManager.getActiveWorkers();

    if (workers.length === 0) {
      return {
        status: InjectionStatus.NEEDS_CLARIFICATION,
        statusCode: 6002,
        route: InjectionRoute.BROADCAST,
        routeDetail: {
          targetWorkerIds: [],
          reason: '当前没有执行中的Worker',
        },
        messageIds: [],
        candidates: [],
      };
    }

    const priority = timing === InjectionTiming.INTERRUPT ? MessagePriority.HIGH : MessagePriority.NORMAL;
    const messageIds: string[] = [];
    for (const worker of workers) {
      const message = await claudeLink.sendMessage(fromWorkerId, worker.id, request.content, priority, {
        type: 'supplementary_info',
        traceId: request.traceId,
        timing,
        urgent: request.urgent || false,
      });
      messageIds.push(message.id);
    }

    log({ prefix: 'Master', message: `全局广播完成: 送达 ${workers.length} 个Worker` });

    return {
      status: InjectionStatus.DELIVERED,
      statusCode: 6001,
      route: InjectionRoute.BROADCAST,
      routeDetail: {
        targetWorkerIds: workers.map(w => w.id),
        reason: '全局广播：信息对所有Worker有效',
      },
      messageIds,
    };
  }

  /**
   * 智能路由：Master通过LLM分析信息内容，自动路由到最相关Worker
   */
  private async routeSmart(
    request: InjectionRequest,
    timing: InjectionTiming,
    fromWorkerId: string
  ): Promise<InjectionResult> {
    const claudeLink = ClaudeLink.getInstance();
    // 从 workerManager 获取所有活跃Worker
    const workers = this.workerManager.getActiveWorkers();

    if (workers.length === 0) {
      return {
        status: InjectionStatus.NEEDS_CLARIFICATION,
        statusCode: 6002,
        route: InjectionRoute.SMART,
        routeDetail: {
          targetWorkerIds: [],
          reason: '当前没有执行中的Worker',
        },
        messageIds: [],
        candidates: [],
      };
    }

    // 如果只有一个活跃Worker，直接路由
    if (workers.length === 1) {
      const worker = workers[0];
      const priority = timing === InjectionTiming.INTERRUPT ? MessagePriority.HIGH : MessagePriority.NORMAL;
      const message = await claudeLink.sendMessage(fromWorkerId, worker.id, request.content, priority, {
        type: 'supplementary_info',
        traceId: request.traceId,
        timing,
        urgent: request.urgent || false,
      });

      return {
        status: InjectionStatus.DELIVERED,
        statusCode: 6001,
        route: InjectionRoute.SMART,
        routeDetail: {
          targetWorkerIds: [worker.id],
          reason: `唯一活跃Worker: ${worker.type}`,
          confidence: 1.0,
        },
        messageIds: [message.id],
      };
    }

    // 多个Worker时，使用LLM智能路由
    const routeDecision = await this.smartRouteWithLLM(request.content, workers);

    if (!routeDecision.targetWorkerId) {
      // LLM无法确定目标，返回需澄清
      return {
        status: InjectionStatus.NEEDS_CLARIFICATION,
        statusCode: 6002,
        route: InjectionRoute.SMART,
        routeDetail: {
          targetWorkerIds: [],
          reason: routeDecision.reason,
          confidence: routeDecision.confidence,
          keywordMatches: routeDecision.keywordMatches,
        },
        messageIds: [],
        candidates: workers,
      };
    }

    const priority = timing === InjectionTiming.INTERRUPT ? MessagePriority.HIGH : MessagePriority.NORMAL;
    const message = await claudeLink.sendMessage(fromWorkerId, routeDecision.targetWorkerId, request.content, priority, {
      type: 'supplementary_info',
      traceId: request.traceId,
      timing,
      urgent: request.urgent || false,
    });

    log({ prefix: 'Master', message: `智能路由完成: 目标=${routeDecision.targetWorkerId}, 置信度=${routeDecision.confidence}, 依据=${routeDecision.reason}` });

    return {
      status: InjectionStatus.DELIVERED,
      statusCode: 6001,
      route: InjectionRoute.SMART,
      routeDetail: {
        targetWorkerIds: [routeDecision.targetWorkerId],
        reason: routeDecision.reason,
        confidence: routeDecision.confidence,
        keywordMatches: routeDecision.keywordMatches,
      },
      messageIds: [message.id],
    };
  }

  /**
   * 使用LLM进行智能路由决策
   */
  private async smartRouteWithLLM(
    content: string,
    workers: WorkerInstance[]
  ): Promise<{ targetWorkerId: string | null; reason: string; confidence: number; keywordMatches?: string[] }> {
    const llm = getLLMClient();

    const workerList = workers.map((w, i) => ({
      index: i,
      id: w.id,
      type: w.type,
      currentTaskId: w.currentTaskId || 'unknown',
    }));

    const systemPrompt = `你是Master调度器的智能路由助手。用户在任务执行中提交了补充信息，你需要判断这条信息应该路由给哪个Worker。

可用的Worker列表：
${JSON.stringify(workerList, null, 2)}

Worker类型说明：
- code_agent: 代码编写、重构、修复
- data_agent: 数据处理、数据库设计、数据分析
- viz_agent: 可视化、图表生成
- review_agent: 代码审查、质量检查
- general_agent: 通用任务、文档编写

请根据补充信息内容和Worker类型/任务，选择最相关的Worker。

返回JSON格式：
{
  "target_index": 0,  // Worker在列表中的索引，-1表示无法确定
  "confidence": 0.92,  // 0-1之间的置信度
  "reason": "决策依据",
  "keyword_matches": ["关键词1", "关键词2"]
}`;

    const userPrompt = `补充信息内容: "${content}"\n\n请判断应该路由给哪个Worker。`;

    try {
      const response = await llm.askForJSON<{
        target_index: number;
        confidence: number;
        reason: string;
        keyword_matches?: string[];
      }>(userPrompt, { systemPrompt, temperature: 0.3 });

      if (!response.success || !response.data) {
        log({ prefix: 'Master', message: `智能路由LLM调用失败: ${response.error}, 回退到首个Worker`, level: 'warn' });
        return {
          targetWorkerId: workers[0].id,
          reason: 'LLM调用失败，回退到首个活跃Worker',
          confidence: 0.5,
        };
      }

      const targetIndex = response.data.target_index;
      if (targetIndex < 0 || targetIndex >= workers.length) {
        return {
          targetWorkerId: null,
          reason: response.data.reason || 'LLM无法确定目标Worker',
          confidence: response.data.confidence || 0,
          keywordMatches: response.data.keyword_matches,
        };
      }

      return {
        targetWorkerId: workers[targetIndex].id,
        reason: response.data.reason,
        confidence: response.data.confidence,
        keywordMatches: response.data.keyword_matches,
      };
    } catch (error) {
      log({ prefix: 'Master', message: `智能路由异常: ${error}, 回退到首个Worker`, level: 'warn' });
      return {
        targetWorkerId: workers[0].id,
        reason: '路由异常，回退到首个活跃Worker',
        confidence: 0.5,
      };
    }
  }

  /**
   * 关闭调度器，释放所有资源
   */
  async shutdown(): Promise<void> {
    log({ prefix: 'Master', message: `正在关闭调度器...` });
    await this.workerManager.shutdown();
    ClaudeLink.getInstance().shutdown();
    log({ prefix: 'Master', message: `调度器已关闭` });
    // 关闭日志数据库
    setLogDb(null);
    this.logDb.close();
  }
}
