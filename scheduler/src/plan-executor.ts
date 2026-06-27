/**
 * Plan-Executor规划层
 * 负责任务拆分、DAG构建、任务分发与执行
 */

import { v4 as uuidv4 } from "uuid";
import PQueue from "p-queue";
import {
  MainTask,
  SubTask,
  DAG,
  DAGNode,
  PlanOutput,
  TaskStatus,
  WorkerType,
  TaskPriority,
  WorkerOutput,
  SchedulerConfig,
  LLMPlanResponse,
  LLMPlanSubTask
} from "./types";
import { WorkerManager } from "./worker-manager";
import { getLLMClient } from "./llm-client";

export class PlanExecutor {
  private config: SchedulerConfig;
  private executionQueues: Map<string, PQueue> = new Map();

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /**
   * 写入PlanExecutor日志（写入Master统一日志文件）
   */
  private writePlanLog(masterLogFile: string | undefined, message: string): void {
    if (!masterLogFile) return;

    const fs = require('fs');
    const logLine = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(masterLogFile, logLine, 'utf-8');
  }

  /**
   * 规划任务，拆分子任务并构建DAG
   */
  async planTask(task: MainTask): Promise<PlanOutput> {
    console.log(`[PlanExecutor] 开始规划任务 ${task.id}`);

    // 调用LLM进行任务拆分
    const subTasks = await this.splitTaskIntoSubTasksWithLLM(task);
    console.log(`[PlanExecutor] 拆分为 ${subTasks.length} 个子任务`);

    // 构建DAG
    const dag = await this.buildDAG(subTasks);
    console.log(`[PlanExecutor] DAG构建完成，包含 ${dag.nodes.size} 个节点，${dag.edges.size} 条边`);

    // 估算执行时间
    const estimatedDuration = this.estimateDuration(subTasks);

    return {
      subTasks,
      dag,
      estimatedDuration,
      requiredWorkers: this.calculateRequiredWorkers(dag)
    };
  }

  /**
   * 执行DAG任务
   */
  async executeDAG(task: MainTask, workerManager: WorkerManager): Promise<WorkerOutput[]> {
    console.log(`[PlanExecutor] 开始执行DAG任务 ${task.id}`);

    // 写入PlanExecutor日志（使用Master统一日志文件）
    this.writePlanLog(task.masterLogFile, `[PlanExecutor] 开始执行DAG任务 ${task.id}`);
    this.writePlanLog(task.masterLogFile, `[PlanExecutor] 子任务数量: ${task.subTasks.size}`);

    const executionQueue = new PQueue({ concurrency: this.config.maxWorkers });
    this.executionQueues.set(task.id, executionQueue);

    const results: WorkerOutput[] = [];
    const completedTasks = new Set<string>();
    const executingTasks = new Set<string>();
    const allTaskIds = Array.from(task.subTasks.keys());

    // 执行单个任务的函数
    const executeSingleTask = async (subTask: SubTask): Promise<void> => {
      // 防止重复执行
      if (executingTasks.has(subTask.id) || completedTasks.has(subTask.id)) {
        return;
      }
      executingTasks.add(subTask.id);

      try {
        subTask.status = TaskStatus.RUNNING;
        subTask.startedAt = new Date();

        console.log(`[PlanExecutor] 开始执行子任务 ${subTask.id}: ${subTask.name}`);
        this.writePlanLog(task.masterLogFile, `[PlanExecutor] 开始执行子任务 ${subTask.id}: ${subTask.name}`);

        const output = await workerManager.executeSubTask(subTask, task.traceId, task.logDir);
        subTask.output = output;
        subTask.status = output.status === "fail" ? TaskStatus.FAILED : TaskStatus.COMPLETED;
        subTask.completedAt = new Date();

        this.writePlanLog(task.masterLogFile, `[PlanExecutor] 子任务 ${subTask.id} 执行完成，状态: ${output.status}`);

        results.push(output);

        if (output.status === "fail" && subTask.retryCount < subTask.maxRetries) {
          // 重试逻辑
          console.log(`[PlanExecutor] 子任务 ${subTask.id} 失败，重试 ${subTask.retryCount + 1}/${subTask.maxRetries}`);
          subTask.retryCount++;
          subTask.status = TaskStatus.RETRYING;
          await this.delay(1000 * Math.pow(2, subTask.retryCount)); // 指数退避
          executingTasks.delete(subTask.id);
          return executeSingleTask(subTask);
        }

      } catch (error) {
        console.error(`[PlanExecutor] 子任务 ${subTask.id} 执行异常:`, error);
        subTask.status = TaskStatus.FAILED;
        subTask.error = error instanceof Error ? error.message : String(error);
        subTask.completedAt = new Date();

        // 降级策略：失败的任务如果不是关键路径，继续执行其他任务
        if (!this.isCriticalPathTask(subTask, task.dag)) {
          console.warn(`[PlanExecutor] 子任务 ${subTask.id} 不在关键路径，继续执行其他任务`);
        } else {
          throw error;
        }
      } finally {
        completedTasks.add(subTask.id);
        executingTasks.delete(subTask.id);
      }
    };

    // 检查依赖是否满足
    const areDependenciesMet = (subTask: SubTask): boolean => {
      return subTask.dependencies.every(depId => completedTasks.has(depId));
    };

    // 主循环：持续寻找可执行的任务直到全部完成或失败
    while (completedTasks.size < allTaskIds.length) {
      // 找出所有可以执行的任务（PENDING状态且依赖已满足）
      const readyTasks = Array.from(task.subTasks.values()).filter(
        st => st.status === TaskStatus.PENDING &&
              !executingTasks.has(st.id) &&
              areDependenciesMet(st)
      );

      if (readyTasks.length === 0 && executingTasks.size === 0) {
        // 没有可执行的任务且没有在执行的任务，说明有循环依赖或其他问题
        console.warn(`[PlanExecutor] 没有可执行的任务，退出。已完成: ${completedTasks.size}/${allTaskIds.length}`);
        break;
      }

      // 启动所有就绪的任务
      for (const task of readyTasks) {
        executionQueue.add(() => executeSingleTask(task));
      }

      // 短暂等待后继续检查
      await this.delay(100);
    }

    // 等待队列中的所有任务完成
    await executionQueue.onIdle();
    this.executionQueues.delete(task.id);

    console.log(`[PlanExecutor] DAG执行完成，共完成 ${completedTasks.size} 个子任务`);
    this.writePlanLog(task.masterLogFile, `[PlanExecutor] DAG执行完成，共完成 ${completedTasks.size} 个子任务`);
    return results;
  }

  /**
   * 停止任务执行
   */
  async stopExecution(task: MainTask): Promise<void> {
    const executionQueue = this.executionQueues.get(task.id);
    if (executionQueue) {
      executionQueue.pause();
      executionQueue.clear();
      this.executionQueues.delete(task.id);
    }

    // 标记所有运行中的任务为失败
    for (const subTask of task.subTasks.values()) {
      if (subTask.status === TaskStatus.RUNNING || subTask.status === TaskStatus.RETRYING) {
        subTask.status = TaskStatus.FAILED;
        subTask.error = "任务被手动终止";
      }
    }
  }

  /**
   * 使用LLM拆分主任务为子任务
   */
  private async splitTaskIntoSubTasksWithLLM(task: MainTask): Promise<SubTask[]> {
    console.log(`[PlanExecutor] 使用LLM进行任务拆分...`);

    const llm = getLLMClient();

    const systemPrompt = `你是一个任务规划专家，负责将复杂的任务拆分为可执行的子任务。

请根据用户的需求，将任务拆分为一系列子任务，每个子任务应该：
1. 有清晰的名称和描述
2. 指定适合的执行Agent类型
3. 定义正确的依赖关系

可用的Agent类型：
- general_agent：通用任务，需求分析、方案设计等
- code_agent：代码实现、测试等编程相关任务
- review_agent：代码评审、结果验证等
- data_agent：数据分析、处理等
- viz_agent：数据可视化等

请返回JSON格式，格式如下：
{
  "subTasks": [
    {
      "name": "任务名称",
      "description": "详细任务描述",
      "workerType": "general_agent",
      "dependencies": [0]  // 依赖的子任务索引，从0开始，空数组表示无依赖
    }
  ],
  "estimatedDuration": 1800,  // 预估总时间（秒）
  "reasoning": "拆分思路说明"
}

只返回JSON，不要包含其他文本。`;

    const userPrompt = `请将以下任务拆分为子任务：

任务名称：${task.name}
任务描述：${task.description}
用户需求：${task.userRequest}
约束条件：${task.constraints.length > 0 ? task.constraints.join('; ') : '无'}
交付标准：${task.deliveryStandards.length > 0 ? task.deliveryStandards.join('; ') : '无'}`;

    const response = await llm.askForJSON<LLMPlanResponse>(userPrompt, {
      systemPrompt,
      temperature: 0.3
    });

    if (!response.success || !response.data) {
      console.warn(`[PlanExecutor] LLM任务拆分失败，使用备用方案:`, response.error);
      return this.getFallbackSubTasks(task);
    }

    console.log(`[PlanExecutor] LLM任务拆分成功，获得 ${response.data.subTasks.length} 个子任务`);
    if (response.data.reasoning) {
      console.log(`[PlanExecutor] 拆分思路: ${response.data.reasoning}`);
    }

    // 将LLM返回的格式转换为内部格式
    const llmSubTasks = response.data.subTasks;
    const subTasks: SubTask[] = [];
    const indexToIdMap = new Map<number, string>();

    // 第一遍：创建子任务并建立索引映射
    for (let i = 0; i < llmSubTasks.length; i++) {
      const llmSubTask = llmSubTasks[i];
      const subTaskId = uuidv4();
      indexToIdMap.set(i, subTaskId);

      // 验证并转换workerType
      let workerType: WorkerType;
      if (Object.values(WorkerType).includes(llmSubTask.workerType as WorkerType)) {
        workerType = llmSubTask.workerType as WorkerType;
      } else {
        console.warn(`[PlanExecutor] 未知的workerType: ${llmSubTask.workerType}，使用general_agent`);
        workerType = WorkerType.GENERAL;
      }

      subTasks.push({
        id: subTaskId,
        parentTaskId: task.id,
        name: llmSubTask.name,
        description: llmSubTask.description,
        workerType,
        priority: TaskPriority.P1,
        status: TaskStatus.PENDING,
        dependencies: [],  // 暂时留空，第二遍填充
        command: this.buildCommandForSubTask(llmSubTask, task),
        retryCount: 0,
        maxRetries: this.config.defaultMaxRetries,
        createdAt: new Date()
      });
    }

    // 第二遍：填充依赖关系
    for (let i = 0; i < llmSubTasks.length; i++) {
      const llmSubTask = llmSubTasks[i];
      const subTask = subTasks[i];

      subTask.dependencies = llmSubTask.dependencies
        .map(depIndex => indexToIdMap.get(depIndex))
        .filter((id): id is string => id !== undefined);
    }

    return subTasks;
  }

  /**
   * 为子任务构建执行命令
   * 包含精简的用户需求
   */
  private buildCommandForSubTask(llmSubTask: LLMPlanSubTask, parentTask: MainTask): string {
    // 精简用户需求：提取关键信息
    const condensedRequest = this.condenseUserRequest(parentTask.userRequest);

    return `请执行以下任务：

## 任务信息
- 任务名称：${llmSubTask.name}
- 任务描述：${llmSubTask.description}

## 原始需求（精简）
${condensedRequest}

## 执行要求
1. 请基于当前项目的实际情况来分析和执行任务
2. 如果需要读取文件，请明确指定文件路径
3. 你的输出必须具体且有针对性，不能给出通用建议
4. 请给出完整的执行结果，包含具体的代码或方案

请开始执行任务。`;
  }

  /**
   * 精简用户需求：提取关键信息，避免prompt过长
   */
  private condenseUserRequest(fullRequest: string): string {
    // 如果需求较短，直接返回
    if (fullRequest.length <= 500) {
      return fullRequest;
    }

    // 否则提取前300字符作为摘要，并添加提示
    const summary = fullRequest.substring(0, 300);
    return `${summary}...\n\n[需求摘要] 这是一个与OpenColony项目相关的任务，请结合项目实际情况执行。`;
  }

  /**
   * 备用方案：硬编码的任务拆分
   */
  private getFallbackSubTasks(task: MainTask): SubTask[] {
    console.log(`[PlanExecutor] 使用备用任务拆分方案`);

    const subTasks: SubTask[] = [];

    // 1. 需求分析任务
    subTasks.push(this.createSubTask(
      task.id,
      '需求分析',
      `分析用户需求：${task.userRequest}，明确目标、边界和约束条件`,
      WorkerType.GENERAL,
      []
    ));

    // 2. 方案设计任务
    subTasks.push(this.createSubTask(
      task.id,
      '方案设计',
      '根据需求分析结果，设计具体的实现方案和技术选型',
      WorkerType.GENERAL,
      [subTasks[0].id]
    ));

    // 3. 代码实现任务
    subTasks.push(this.createSubTask(
      task.id,
      '代码实现',
      '根据设计方案编写具体的实现代码',
      WorkerType.CODE,
      [subTasks[1].id]
    ));

    // 4. 测试验证任务
    subTasks.push(this.createSubTask(
      task.id,
      '测试验证',
      '对实现的代码进行测试，验证功能正确性和性能',
      WorkerType.CODE,
      [subTasks[2].id]
    ));

    // 如果启用评审，添加评审任务
    if (this.config.enableReview) {
      subTasks.push(this.createSubTask(
        task.id,
        '代码评审',
        '评审实现的代码质量、安全性和可维护性',
        WorkerType.REVIEW,
        [subTasks[2].id]
      ));
    }

    return subTasks;
  }

  /**
   * 构建DAG图
   */
  private async buildDAG(subTasks: SubTask[]): Promise<DAG> {
    const nodes: Map<string, DAGNode> = new Map();
    const edges: Map<string, string[]> = new Map();

    for (const subTask of subTasks) {
      // 创建节点
      nodes.set(subTask.id, {
        id: subTask.id,
        name: subTask.name,
        dependencies: subTask.dependencies,
        subTaskId: subTask.id
      });

      // 构建边：依赖 -> 当前任务
      for (const depId of subTask.dependencies) {
        if (!edges.has(depId)) {
          edges.set(depId, []);
        }
        edges.get(depId)!.push(subTask.id);
      }
    }

    return { nodes, edges };
  }

  /**
   * 估算任务执行时间
   */
  private estimateDuration(subTasks: SubTask[]): number {
    // 每个任务平均300秒
    return subTasks.length * 300;
  }

  /**
   * 计算所需Worker数量
   */
  private calculateRequiredWorkers(dag: DAG): number {
    // 计算DAG的最大宽度（同一层最多的节点数）
    // 简化实现：返回配置的最大Worker数
    return this.config.maxWorkers;
  }

  /**
   * 创建子任务
   */
  private createSubTask(
    parentTaskId: string,
    name: string,
    description: string,
    workerType: WorkerType,
    dependencies: string[]
  ): SubTask {
    return {
      id: uuidv4(),
      parentTaskId,
      name,
      description,
      workerType,
      priority: TaskPriority.P1,
      status: TaskStatus.PENDING,
      dependencies,
      command: description,
      retryCount: 0,
      maxRetries: this.config.defaultMaxRetries,
      createdAt: new Date()
    };
  }

  /**
   * 判断任务是否在关键路径上
   */
  private isCriticalPathTask(subTask: SubTask, dag: DAG): boolean {
    // 简化实现：所有任务都在关键路径上
    return true;
  }

  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
