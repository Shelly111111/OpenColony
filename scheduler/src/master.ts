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
  WorkerInstance,
  LoopStatus,
  LoopEvaluation,
  LoopStatusCode,
  LoopContext
} from "./types";
import { PlanExecutor } from "./plan-executor";
import { WorkerManager } from "./worker-manager";
import { ArbitrationEngine } from "./arbitration-engine";
import { ClaudeLink } from "./claude-link";
import { getLLMClient } from "./llm-client";
import { log, setLogDb } from "./logger";
import { MessageDB } from "./message-db";
import { getMemoryStore } from "./memory-store";

export class MasterScheduler {
  private config: SchedulerConfig;
  private planExecutor: PlanExecutor;
  private workerManager: WorkerManager;
  private arbitrationEngine: ArbitrationEngine;
  private tasks: Map<string, MainTask> = new Map();
  private logDb: MessageDB;
  // 循环调度相关
  private forceCancelledTraceIds: Set<string> = new Set();  // 被强制终止的 traceId 集合
  private loopContexts: Map<string, LoopContext> = new Map(); // 各任务的循环上下文

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = {
      maxWorkers: config.maxWorkers || 3,
      defaultMaxRetries: config.defaultMaxRetries || 3,
      defaultTimeoutMs: config.defaultTimeoutMs || 30 * 60 * 1000, // 30分钟
      arbitrationMode: config.arbitrationMode || ArbitrationMode.CONFIDENCE_VOTE,
      workerTypes: config.workerTypes || ['general_agent'],
      runMode: config.runMode || 'pty', // 添加 runMode，默认 pty
      maxLoopRounds: config.maxLoopRounds || 5,
      loopConfidenceThreshold: config.loopConfidenceThreshold || 0.8,
    };

    this.planExecutor = new PlanExecutor(this.config);
    this.workerManager = new WorkerManager(this.config);
    this.arbitrationEngine = new ArbitrationEngine(this.config);

    // 初始化日志数据库并注入到 logger
    this.logDb = new MessageDB();
    setLogDb(this.logDb);
  }

  /**
   * 提交用户请求，启动循环调度执行
   *
   * 循环调度流程（V1.5核心）：
   * Round N:
   *   1. Master 整理需求（含前轮执行反馈）
   *   2. Plan 拆解 + Execute DAG
   *   3. Arbitrate 合并结果
   *   4. 评审：结果置信度是否满足阈值？
   *      ├─ 满足 → 输出最终结果，结束循环
   *      └─ 不满足 → 整理反馈，进入下轮
   */
  async submitRequest(userRequest: string, options: {
    name?: string;
    description?: string;
    priority?: TaskPriority;
    constraints?: string[];
    deliveryStandards?: string[];
    projectId?: string;
  } = {}): Promise<TaskResult> {
    const traceId = uuidv4();
    const startTime = Date.now();
    const maxLoopRounds = this.config.maxLoopRounds || 5;
    const confidenceThreshold = this.config.loopConfidenceThreshold || 0.8;

    // 检查LLM状态
    getLLMClient(); // 确保LLM客户端已初始化
    log({ prefix: 'Master', message: '使用真实LLM模式（循环调度）' });

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

      // 创建统一的Master日志文件
      const masterLogFile = path.join(logDir, `Master_${traceId}.log`);
      task.masterLogFile = masterLogFile;

      log({ logFile: masterLogFile, prefix: 'Master', message: `已创建任务 ${task.id}，TraceID: ${traceId}`, traceId, taskId: task.id });
      log({ logFile: masterLogFile, prefix: 'Master', message: `用户需求: ${userRequest}`, traceId, taskId: task.id });
      log({ logFile: masterLogFile, prefix: 'Master', message: `循环调度: 最大${maxLoopRounds}轮, 置信度阈值${confidenceThreshold}`, traceId, taskId: task.id });

      // 初始化循环上下文
      const loopContext: LoopContext = {
        roundNumber: 0,
        maxRounds: maxLoopRounds,
        previousResults: [],
        status: LoopStatus.RUNNING,
      };
      this.loopContexts.set(traceId, loopContext);

      // ===== 循环调度主体 =====
      let finalOutput: any = null;
      let finalConfidence = 0;
      let lastValidOutputs: WorkerOutput[] = [];

      for (let round = 1; round <= maxLoopRounds; round++) {
        // 检查是否被强制终止
        if (this.forceCancelledTraceIds.has(traceId)) {
          loopContext.status = LoopStatus.FORCE_CANCELLED;
          log({ logFile: masterLogFile, prefix: 'Master', message: `[状态码 8004] 用户强制终止任务`, traceId, taskId: task.id });
          break;
        }

        loopContext.roundNumber = round;
        log({ logFile: masterLogFile, prefix: 'Master', message: `[状态码 8001] 进入第 ${round}/${maxLoopRounds} 轮循环调度`, traceId, taskId: task.id });

        // 2. 如果非首轮，整理前轮反馈注入任务
        if (round > 1) {
          this.injectLoopFeedback(task, loopContext, masterLogFile, traceId);
        }

        // 3. 调用Plan模块拆分任务，构建DAG
        task.status = TaskStatus.RUNNING;
        task.startedAt = task.startedAt || new Date();

        const planOutput = await this.planExecutor.planTask(task);
        task.subTasks = new Map(planOutput.subTasks.map(st => [st.id, st]));
        task.dag = planOutput.dag;

        log({ logFile: masterLogFile, prefix: 'Master', message: `第${round}轮任务拆分完成，共 ${planOutput.subTasks.length} 个子任务`, traceId, taskId: task.id });

        // 4. 执行任务DAG
        const executionResults = await this.planExecutor.executeDAG(task, this.workerManager);

        // 再次检查强制终止（执行过程中可能被取消）
        if (this.forceCancelledTraceIds.has(traceId)) {
          loopContext.status = LoopStatus.FORCE_CANCELLED;
          log({ logFile: masterLogFile, prefix: 'Master', message: `[状态码 8004] 执行中被用户强制终止`, traceId, taskId: task.id });
          // 仍使用已完成的子任务结果
          const validPartial = this.validateOutputs(executionResults, masterLogFile, traceId, task.id);
          if (validPartial.length > 0) {
            const partialArb = await this.arbitrationEngine.arbitrate(validPartial, task);
            finalOutput = partialArb.finalOutput;
            finalConfidence = partialArb.confidence ?? 0.5;
          }
          break;
        }

        // 5. 校验所有Worker输出
        log({ logFile: masterLogFile, prefix: 'Master', message: `第${round}轮执行完成，开始校验输出`, traceId, taskId: task.id });
        const validOutputs = this.validateOutputs(executionResults, masterLogFile, traceId, task.id);
        lastValidOutputs = validOutputs;

        if (validOutputs.length === 0) {
          log({ logFile: masterLogFile, prefix: 'Master', message: `第${round}轮所有子任务执行失败，无有效输出`, traceId, taskId: task.id, level: 'warn' });
          if (round === maxLoopRounds) {
            throw new Error("所有轮次执行均失败，无有效输出");
          }
          // 记录本轮失败，继续下一轮
          loopContext.previousResults.push({
            round,
            outputSummary: '本轮所有子任务执行失败',
            evaluation: {
              satisfied: false,
              confidence: 0,
              reason: '所有子任务执行失败',
              suggestions: '请调整任务拆分策略或降低任务复杂度',
              roundNumber: round,
            },
          });
          continue;
        }

        // 6. 仲裁冲突，合并结果
        log({ logFile: masterLogFile, prefix: 'Master', message: `开始仲裁合并 ${validOutputs.length} 个有效输出`, traceId, taskId: task.id, silent: true });
        const arbitrationResult = await this.arbitrationEngine.arbitrate(validOutputs, task, { logFile: masterLogFile, traceId, taskId: task.id });

        if (!arbitrationResult.resolved) {
          throw new Error(`仲裁失败: ${arbitrationResult.conflicts?.join(', ')}`);
        }

        finalOutput = arbitrationResult.finalOutput;
        finalConfidence = arbitrationResult.confidence ?? 0.5;

        // 7. 循环评审：评估结果是否满足交付标准
        const evaluation = await this.arbitrationEngine.evaluateLoopResult(task, arbitrationResult, round, { logFile: masterLogFile, traceId, taskId: task.id });
        loopContext.previousResults.push({
          round,
          outputSummary: typeof finalOutput === 'string' ? finalOutput.substring(0, 200) : JSON.stringify(finalOutput).substring(0, 200),
          evaluation,
        });

        log({ logFile: masterLogFile, prefix: 'Master', message: `第${round}轮评审: satisfied=${evaluation.satisfied}, confidence=${evaluation.confidence.toFixed(2)}, threshold=${confidenceThreshold}`, traceId, taskId: task.id });

        // 判断是否跳出循环：satisfied=true 且 confidence >= threshold
        if (evaluation.satisfied && evaluation.confidence >= confidenceThreshold) {
          loopContext.status = LoopStatus.SATISFIED;
          // 使用提取后的干净输出替代原始输出
          if (evaluation.finalOutput !== undefined) {
            finalOutput = evaluation.finalOutput;
          }
          log({ logFile: masterLogFile, prefix: 'Master', message: `评审通过！置信度 ${evaluation.confidence.toFixed(2)} >= ${confidenceThreshold}，跳出循环`, traceId, taskId: task.id });
          break;
        }

        // 未通过评审
        log({ logFile: masterLogFile, prefix: 'Master', message: `[状态码 8002] 评审未通过: satisfied=${evaluation.satisfied}, confidence=${evaluation.confidence.toFixed(2)} < threshold=${confidenceThreshold}`, traceId, taskId: task.id });
        log({ logFile: masterLogFile, prefix: 'Master', message: `[诊断] 评审未通过原因: ${evaluation.reason}`, traceId, taskId: task.id });
        log({ logFile: masterLogFile, prefix: 'Master', message: `[诊断] 修正建议: ${evaluation.suggestions}`, traceId, taskId: task.id });

        if (round === maxLoopRounds) {
          loopContext.status = LoopStatus.MAX_ROUNDS_REACHED;
          log({ logFile: masterLogFile, prefix: 'Master', message: `[状态码 8003] 达到最大循环轮次 ${maxLoopRounds}，输出当前最优结果`, traceId, taskId: task.id });
        }
      }

      // ===== 循环结束，生成最终结果 =====
      const wasForceCancelled = loopContext.status === LoopStatus.FORCE_CANCELLED;
      task.output = finalOutput;
      task.status = wasForceCancelled ? TaskStatus.FAILED : TaskStatus.COMPLETED;
      task.completedAt = new Date();

      const duration = (Date.now() - startTime) / 1000;
      const loopSummary = this.buildLoopSummary(loopContext);
      log({ logFile: masterLogFile, prefix: 'Master', message: `任务 ${task.id} 执行完成，耗时 ${duration} 秒\n${loopSummary}`, traceId, taskId: task.id });

      // 写入记忆
      this.persistTaskMemory(task, lastValidOutputs, duration, options.projectId, masterLogFile, traceId);

      // 清理循环上下文
      this.forceCancelledTraceIds.delete(traceId);
      this.loopContexts.delete(traceId);

      return {
        success: !wasForceCancelled,
        data: finalOutput,
        traceId,
        duration
      };

    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      const task = this.tasks.get(traceId);
      log({ logFile: task?.masterLogFile, prefix: 'Master', message: `任务执行失败: ${error}`, level: 'error', traceId, taskId: task?.id });

      // 清理
      this.forceCancelledTraceIds.delete(traceId);
      this.loopContexts.delete(traceId);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        traceId,
        duration
      };
    }
  }

  /**
   * 将前轮反馈注入到任务中，供下轮 Plan 拆解时使用
   */
  private injectLoopFeedback(task: MainTask, loopContext: LoopContext, masterLogFile?: string, traceId?: string): void {
    const lastResult = loopContext.previousResults[loopContext.previousResults.length - 1];
    if (!lastResult) return;

    const feedback = [
      `\n\n## 前轮执行反馈（第 ${lastResult.round} 轮）`,
      `评审结果: ${lastResult.evaluation.satisfied ? '通过' : '未通过'}`,
      `置信度: ${lastResult.evaluation.confidence.toFixed(2)}`,
      lastResult.evaluation.reason ? `未达标原因: ${lastResult.evaluation.reason}` : '',
      lastResult.evaluation.suggestions ? `修正建议: ${lastResult.evaluation.suggestions}` : '',
      `前轮执行结果摘要: ${lastResult.outputSummary}`,
    ].filter(Boolean).join('\n');

    // 将反馈附加到用户需求后面，Plan拆解时会读取 userRequest
    task.userRequest = task.userRequest.split('\n\n## 前轮执行反馈')[0] + feedback;

    log({ logFile: masterLogFile, prefix: 'Master', message: `已注入第${lastResult.round}轮反馈到任务需求中`, traceId, taskId: task.id });
  }

  /**
   * 构建循环调度摘要
   */
  private buildLoopSummary(loopContext: LoopContext): string {
    const lines = [
      `循环调度摘要:`,
      `  总轮次: ${loopContext.roundNumber}/${loopContext.maxRounds}`,
      `  最终状态: ${loopContext.status}`,
    ];

    for (const prev of loopContext.previousResults) {
      lines.push(`  第${prev.round}轮: confidence=${prev.evaluation.confidence.toFixed(2)}, satisfied=${prev.evaluation.satisfied}`);
      if (prev.evaluation.reason) {
        lines.push(`    原因: ${prev.evaluation.reason.substring(0, 100)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 强制终止指定任务
   */
  forceCancel(traceId: string): boolean {
    if (!this.tasks.has(traceId) && !this.loopContexts.has(traceId)) {
      return false;
    }
    this.forceCancelledTraceIds.add(traceId);
    // 同时尝试终止 PlanExecutor 中的执行
    const task = this.tasks.get(traceId);
    if (task) {
      this.planExecutor.stopExecution(task);
    }
    log({ prefix: 'Master', message: `任务 ${traceId} 已被标记为强制终止` });
    return true;
  }

  /**
   * 写入任务记忆（L1 经验 + L3 画像）
   */
  private async persistTaskMemory(
    task: MainTask,
    validOutputs: WorkerOutput[],
    durationSeconds: number,
    projectId: string | undefined,
    masterLogFile?: string,
    traceId?: string
  ): Promise<void> {
    try {
      const memoryStore = getMemoryStore();
      const pId = projectId || '__global__';

      // L1: 写入任务经验
      const subTasksArr = Array.from(task.subTasks.values());
      const subTasksJson = JSON.stringify(subTasksArr.map(st => ({
        name: st.name,
        description: st.description,
        workerType: st.workerType,
        dependencies: st.dependencies,
        skill: st.skill,
        status: st.status,
      })));

      // 用 LLM 生成最终输出摘要（200字以内）
      let finalOutputSummary: string | undefined;
      try {
        const llm = getLLMClient();
        const outputData = typeof task.output === 'string' ? task.output : JSON.stringify(task.output, null, 2);
        const summaryResp = await llm.ask(
          `请用200字以内精炼概括以下任务执行结果的核心要点：\n\n${outputData.substring(0, 2000)}`,
          { systemPrompt: "你是一个摘要生成器，只输出摘要文本，不加任何前缀。", temperature: 0.3, maxTokens: 300 }
        );
        if (summaryResp.success && summaryResp.content) {
          finalOutputSummary = summaryResp.content.trim();
        }
      } catch (e) {
        log({ logFile: masterLogFile, prefix: 'Master', message: `生成输出摘要失败: ${e}`, level: 'warn', traceId });
      }

      const dagLayers = this.countDagLayers(task);
      const workerTypes = [...new Set(subTasksArr.map(st => st.workerType))].join(',');

      memoryStore.insertTaskExperience({
        projectId: pId,
        userRequest: task.userRequest,
        condensedRequest: task.condensedRequest,
        subTasksJson,
        dagLayers,
        workerTypes,
        status: task.status === TaskStatus.COMPLETED ? 'success' : 'partial',
        finalOutputSummary,
        confidence: validOutputs.length > 0
          ? validOutputs.reduce((sum, o) => sum + o.confidence, 0) / validOutputs.length
          : 0,
        durationSeconds,
        traceId,
      });

      log({ logFile: masterLogFile, prefix: 'Master', message: `L1 任务经验已写入 (项目: ${pId})`, traceId });

      // L3: 更新 Worker 画像
      for (const subTask of subTasksArr) {
        if (subTask.output) {
          memoryStore.updateWorkerProfile(subTask.workerType, {
            success: subTask.output.status === 'success',
            confidence: subTask.output.confidence,
            durationSeconds: subTask.startedAt && subTask.completedAt
              ? (subTask.completedAt.getTime() - subTask.startedAt.getTime()) / 1000
              : 0,
            skillId: subTask.skill,
          });
        }
      }

      log({ logFile: masterLogFile, prefix: 'Master', message: `L3 Worker 画像已更新`, traceId });

      // L2: 自动提取项目知识（仅成功任务）
      if (task.status === TaskStatus.COMPLETED && finalOutputSummary) {
        this.autoExtractProjectKnowledge(task, pId, masterLogFile, traceId);
      }
    } catch (error) {
      log({ logFile: masterLogFile, prefix: 'Master', message: `写入记忆失败: ${error}`, level: 'warn', traceId });
    }
  }

  /**
   * 自动提取项目知识（任务成功后由 LLM 从执行过程中提取）
   */
  private async autoExtractProjectKnowledge(
    task: MainTask,
    projectId: string,
    masterLogFile?: string,
    traceId?: string
  ): Promise<void> {
    try {
      const llm = getLLMClient();
      const subTasksArr = Array.from(task.subTasks.values());
      const executionSummary = subTasksArr
        .filter(st => st.output?.status === 'success')
        .map(st => `- ${st.name} (${st.workerType}): ${typeof st.output!.data === 'string' ? st.output!.data.substring(0, 200) : JSON.stringify(st.output!.data).substring(0, 200)}`)
        .join('\n');

      if (!executionSummary) return;

      const resp = await llm.askForJSON<{
        knowledge: Array<{ category: string; title: string; content: string }>;
      }>(
        `根据以下任务执行过程，提取1-3条项目级别的知识点（技术栈、约定、架构等）。
如果提取不到有价值的知识，返回空数组。

任务: ${task.userRequest}

执行过程:
${executionSummary}

返回JSON格式:
{
  "knowledge": [
    {"category": "tech_stack|convention|structure|preference", "title": "标题", "content": "内容"}
  ]
}`,
        { systemPrompt: "你是项目知识提取器，只返回JSON。", temperature: 0.3, maxTokens: 500 }
      );

      if (resp.success && resp.data && resp.data.knowledge.length > 0) {
        const memoryStore = getMemoryStore();
        for (const k of resp.data.knowledge) {
          const validCategories = ['convention', 'tech_stack', 'structure', 'preference'];
          const category = validCategories.includes(k.category) ? k.category : 'convention';
          memoryStore.insertProjectKnowledge({
            projectId,
            category: category as any,
            title: k.title,
            content: k.content,
            source: 'auto_extracted',
          });
        }
        log({ logFile: masterLogFile, prefix: 'Master', message: `L2 自动提取 ${resp.data.knowledge.length} 条项目知识`, traceId });
      }
    } catch (error) {
      log({ logFile: masterLogFile, prefix: 'Master', message: `自动提取项目知识失败: ${error}`, level: 'warn', traceId });
    }
  }

  /**
   * 计算 DAG 层数
   */
  private countDagLayers(task: MainTask): number {
    const subTasks = Array.from(task.subTasks.values());
    if (subTasks.length === 0) return 0;

    // 计算每个节点的深度
    const depthMap = new Map<string, number>();
    const calcDepth = (id: string): number => {
      if (depthMap.has(id)) return depthMap.get(id)!;
      const st = task.subTasks.get(id);
      if (!st || st.dependencies.length === 0) {
        depthMap.set(id, 0);
        return 0;
      }
      const maxDepDepth = Math.max(...st.dependencies.map(depId => calcDepth(depId)));
      const depth = maxDepDepth + 1;
      depthMap.set(id, depth);
      return depth;
    };

    subTasks.forEach(st => calcDepth(st.id));
    return Math.max(...depthMap.values()) + 1;
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
      traceId,
      projectId: (options as any).projectId,
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

    const messageIds: string[] = [];
    for (const worker of activeWorkers) {
      const message = await claudeLink.sendMessage(fromWorkerId, worker.id, request.content, {
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

    const messageIds: string[] = [];
    for (const worker of workers) {
      const message = await claudeLink.sendMessage(fromWorkerId, worker.id, request.content, {
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
      const message = await claudeLink.sendMessage(fromWorkerId, worker.id, request.content, {
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

    const message = await claudeLink.sendMessage(fromWorkerId, routeDecision.targetWorkerId, request.content, {
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
