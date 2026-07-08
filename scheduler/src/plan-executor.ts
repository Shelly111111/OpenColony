/**
 * Plan-Executor规划层
 * 负责任务拆分、DAG构建、任务分发与执行
 * 支持同层任务同步/异步执行控制
 * 支持多层任务参数传递（上层输出传递到下层输入）
 */

import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import PQueue from "p-queue";
import {
  MainTask,
  SubTask,
  DAG,
  DAGNode,
  PlanOutput,
  TaskStatus,
  TaskPriority,
  WorkerOutput,
  SchedulerConfig,
  LLMPlanResponse,
  LLMPlanSubTask
} from "./types";
import { WorkerManager } from "./worker-manager";
import { getLLMClient } from "./llm-client";
import { RoleManager } from "./role-manager";
import { log } from "./logger";
import { loadSettings, AppSettings } from "./config/settings";

export class PlanExecutor {
  private config: SchedulerConfig;
  private executionQueues: Map<string, PQueue> = new Map();
  private roleManager: RoleManager;
  private settings: AppSettings;
  private taskOutputs: Map<string, WorkerOutput> = new Map(); // 存储任务输出，用于参数传递

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.roleManager = new RoleManager();
    this.settings = loadSettings(); // 加载设置
  }

  /**
   * 写入PlanExecutor日志（写入Master统一日志文件）
   */
  private writePlanLog(masterLogFile: string | undefined, message: string): void {
    if (!masterLogFile) return;
    log({ logFile: masterLogFile, message, silent: true });
  }

  /**
   * 规划任务，拆分子任务并构建DAG
   */
  async planTask(task: MainTask): Promise<PlanOutput> {
    log({ message: `[PlanExecutor] 开始规划任务 ${task.id}` });

    // 调用LLM进行任务拆分
    const subTasks = await this.splitTaskIntoSubTasksWithLLM(task);
    log({ message: `[PlanExecutor] 拆分为 ${subTasks.length} 个子任务` });

    // 构建DAG
    const dag = await this.buildDAG(subTasks);
    log({ message: `[PlanExecutor] DAG构建完成，包含 ${dag.nodes.size} 个节点，${dag.edges.size} 条边` });

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
   * 执行DAG任务（增强版）
   * 支持分层执行和参数传递
   */
  async executeDAG(task: MainTask, workerManager: WorkerManager): Promise<WorkerOutput[]> {
    log({ message: `[PlanExecutor] 开始执行DAG任务 ${task.id}` });
    this.writePlanLog(task.masterLogFile, `[PlanExecutor] 开始执行DAG任务 ${task.id}`);
    this.writePlanLog(task.masterLogFile, `[PlanExecutor] 子任务数量: ${task.subTasks.size}`);

    // 清空任务输出缓存
    this.taskOutputs.clear();

    const results: WorkerOutput[] = [];
    const completedTasks = new Set<string>();
    const executingTasks = new Set<string>();

    // 拓扑排序并分层
    const layers = this.topologicalSortAndLayer(task);

    // 按层执行任务
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      log({
        message: `[PlanExecutor] 执行第 ${layer.level + 1}/${layers.length} 层任务，共 ${layer.taskIds.length} 个任务，执行方式: ${this.settings.taskExecution.sameLayerAsync ? '异步' : '同步'}`,
      });
      this.writePlanLog(
        task.masterLogFile,
        `[PlanExecutor] 执行第 ${layer.level + 1}/${layers.length} 层任务，共 ${layer.taskIds.length} 个任务`
      );

      // 获取当前层的任务
      const layerTasks = layer.taskIds
        .map(taskId => task.subTasks.get(taskId))
        .filter((st): st is SubTask => st !== undefined);

      // 根据设置决定同层任务的执行方式
      if (this.settings.taskExecution.sameLayerAsync) {
        // 异步并行执行
        log({ message: `[PlanExecutor] 同层任务异步并行执行` });
        await this.executeLayerAsync(layerTasks, task, workerManager, completedTasks, executingTasks, results);
      } else {
        // 同步串行执行
        log({ message: `[PlanExecutor] 同层任务同步串行执行` });
        await this.executeLayerSync(layerTasks, task, workerManager, completedTasks, executingTasks, results);
      }

      log({ message: `[PlanExecutor] 第 ${layer.level + 1} 层任务执行完成` });
      this.writePlanLog(task.masterLogFile, `[PlanExecutor] 第 ${layer.level + 1} 层任务执行完成`);
    }

    log({ message: `[PlanExecutor] DAG执行完成，共完成 ${completedTasks.size} 个子任务` });
    this.writePlanLog(task.masterLogFile, `[PlanExecutor] DAG执行完成，共完成 ${completedTasks.size} 个子任务`);
    return results;
  }

  /**
   * 异步并行执行一层任务
   */
  private async executeLayerAsync(
    layerTasks: SubTask[],
    task: MainTask,
    workerManager: WorkerManager,
    completedTasks: Set<string>,
    executingTasks: Set<string>,
    results: WorkerOutput[]
  ): Promise<void> {
    const maxConcurrency = this.settings.taskExecution.maxConcurrency;

    if (layerTasks.length <= maxConcurrency) {
      // 并发数不超过限制，直接并行执行
      await Promise.all(
        layerTasks.map(async (subTask) => {
          await this.executeSingleTaskWithParamPassing(subTask, task, workerManager);
          completedTasks.add(subTask.id);
          if (subTask.output) {
            results.push(subTask.output);
          }
        })
      );
    } else {
      // 超过并发限制，分批执行
      for (let i = 0; i < layerTasks.length; i += maxConcurrency) {
        const batch = layerTasks.slice(i, i + maxConcurrency);
        await Promise.all(
          batch.map(async (subTask) => {
            await this.executeSingleTaskWithParamPassing(subTask, task, workerManager);
            completedTasks.add(subTask.id);
            if (subTask.output) {
              results.push(subTask.output);
            }
          })
        );
      }
    }
  }

  /**
   * 同步串行执行一层任务
   */
  private async executeLayerSync(
    layerTasks: SubTask[],
    task: MainTask,
    workerManager: WorkerManager,
    completedTasks: Set<string>,
    executingTasks: Set<string>,
    results: WorkerOutput[]
  ): Promise<void> {
    for (const subTask of layerTasks) {
      await this.executeSingleTaskWithParamPassing(subTask, task, workerManager);
      completedTasks.add(subTask.id);
      if (subTask.output) {
        results.push(subTask.output);
      }
    }
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
   * 拓扑排序并分层
   * 将任务按依赖关系分成多个层级
   * 返回按层级分好的任务列表（第0层是最上层，没有依赖的任务）
   */
  private topologicalSortAndLayer(task: MainTask): Array<{ level: number; taskIds: string[] }> {
    const subTasks = Array.from(task.subTasks.values());
    const dag = task.dag;

    // 构建入度表
    const inDegree = new Map<string, number>();
    subTasks.forEach(st => inDegree.set(st.id, 0));

    // 计算入度
    dag.edges.forEach((targets, source) => {
      targets.forEach(target => {
        inDegree.set(target, (inDegree.get(target) || 0) + 1);
      });
    });

    // BFS分层（Kahn算法变种）
    const layers: Array<{ level: number; taskIds: string[] }> = [];
    const visited = new Set<string>();
    let currentLayer: string[] = [];

    // 找到所有入度为0的任务（最上层）
    subTasks.forEach(st => {
      if ((inDegree.get(st.id) || 0) === 0) {
        currentLayer.push(st.id);
      }
    });

    let level = 0;
    while (currentLayer.length > 0) {
      // 记录当前层
      layers.push({
        level,
        taskIds: [...currentLayer],
      });

      // 处理当前层的每个任务
      const nextLayer: string[] = [];
      for (const taskId of currentLayer) {
        visited.add(taskId);
        const downstreamTasks = dag.edges.get(taskId) || [];
        for (const downstreamTaskId of downstreamTasks) {
          // 减少入度
          const newDegree = (inDegree.get(downstreamTaskId) || 0) - 1;
          inDegree.set(downstreamTaskId, newDegree);

          // 如果入度变为0，加入下一层
          if (newDegree === 0 && !visited.has(downstreamTaskId)) {
            nextLayer.push(downstreamTaskId);
          }
        }
      }

      currentLayer = nextLayer;
      level++;
    }

    // 检查是否有环
    if (visited.size !== subTasks.length) {
      throw new Error('DAG中存在循环依赖！');
    }

    log({ message: `[PlanExecutor] 拓扑排序完成，共 ${layers.length} 层` });
    layers.forEach(layer => {
      const taskNames = layer.taskIds.map(id => {
        const st = task.subTasks.get(id);
        return st ? st.name : id;
      });
      log({
        message: `  第${layer.level + 1}层: ${taskNames.join(', ')} (${this.settings.taskExecution.sameLayerAsync ? '异步' : '同步'})`,
      });
    });

    return layers;
  }

  /**
   * 执行单个任务（增强版，支持参数传递）
   * 注意：此方法假设依赖已经满足（由分层执行逻辑保证）
   */
  private async executeSingleTaskWithParamPassing(
    subTask: SubTask,
    task: MainTask,
    workerManager: WorkerManager
  ): Promise<void> {
    try {
      subTask.status = TaskStatus.RUNNING;
      subTask.startedAt = new Date();

      log({ message: `[PlanExecutor] 开始执行子任务 ${subTask.id}: ${subTask.name}` });
      this.writePlanLog(task.masterLogFile, `[PlanExecutor] 开始执行子任务 ${subTask.id}: ${subTask.name}`);

      // 在执行前，构建包含依赖任务输出的命令
      if (subTask.dependencies.length > 0) {
        const enhancedCommand = this.buildEnhancedCommand(subTask, task);
        subTask.command = enhancedCommand;
      }

      const output = await workerManager.executeSubTask(subTask, task.traceId, task.logDir);
      subTask.output = output;
      subTask.status = output.status === "fail" ? TaskStatus.FAILED : TaskStatus.COMPLETED;
      subTask.completedAt = new Date();

      // 存储任务输出，用于参数传递
      if (output.status === "success") {
        this.taskOutputs.set(subTask.id, output);
      }

      this.writePlanLog(task.masterLogFile, `[PlanExecutor] 子任务 ${subTask.id} 执行完成，状态: ${output.status}`);

      if (output.status === "fail" && subTask.retryCount < subTask.maxRetries) {
        // 重试逻辑
        log({ message: `[PlanExecutor] 子任务 ${subTask.id} 失败，重试 ${subTask.retryCount + 1}/${subTask.maxRetries}` });
        subTask.retryCount++;
        subTask.status = TaskStatus.RETRYING;
        await this.delay(1000 * Math.pow(2, subTask.retryCount)); // 指数退避
        return this.executeSingleTaskWithParamPassing(subTask, task, workerManager);
      }

    } catch (error) {
      log({ message: `[PlanExecutor] 子任务 ${subTask.id} 执行异常: ${error}`, level: 'error' });
      subTask.status = TaskStatus.FAILED;
      subTask.error = error instanceof Error ? error.message : String(error);
      subTask.completedAt = new Date();

      // 降级策略：失败的任务如果不是关键路径，继续执行其他任务
      if (!this.isCriticalPathTask(subTask, task.dag)) {
        log({ message: `[PlanExecutor] 子任务 ${subTask.id} 不在关键路径，继续执行其他任务`, level: 'warn' });
      } else {
        throw error;
      }
    }
  }

  /**
   * 构建增强命令（包含依赖任务的输出）
   */
  private buildEnhancedCommand(subTask: SubTask, task: MainTask): string {
    // 如果没有依赖，直接返回原命令
    if (subTask.dependencies.length === 0) {
      return subTask.command;
    }

    // 收集依赖任务的输出
    const dependencyOutputs: string[] = [];
    for (const depId of subTask.dependencies) {
      const depOutput = this.taskOutputs.get(depId);
      if (depOutput && depOutput.status === "success") {
        const depTask = task.subTasks.get(depId);
        const depName = depTask ? depTask.name : depId;
        const outputData = typeof depOutput.data === 'string'
          ? depOutput.data
          : JSON.stringify(depOutput.data, null, 2);

        dependencyOutputs.push(`\n\n## 依赖任务 "${depName}" 的输出:\n${outputData}`);
      }
    }

    // 将依赖输出追加到命令中
    if (dependencyOutputs.length > 0) {
      const enhancedCommand = subTask.command + '\n' + dependencyOutputs.join('\n');
      log({ message: `[PlanExecutor] 为任务 ${subTask.name} 添加依赖输出，依赖数量: ${dependencyOutputs.length}` });
      return enhancedCommand;
    }

    return subTask.command;
  }

  /**
   * 使用LLM拆分主任务为子任务
   */
  private async splitTaskIntoSubTasksWithLLM(task: MainTask): Promise<SubTask[]> {
    log({ message: `[PlanExecutor] 使用LLM进行任务拆分...` });

    const llm = getLLMClient();

    // 从 RoleManager 动态获取可用的 Agent 类型列表
    const roleDescriptions = this.roleManager.getRoleDescriptions();

    const systemPrompt = `你是一个任务规划专家，负责将复杂的任务拆分为可执行的子任务。

请根据用户的需求，将任务拆分为一系列子任务，在拆分时，率先考虑任务的复杂性，如果任务复杂度较低，建议拆分为较少的子任务，如果任务复杂度较高，建议考虑任务的依赖关系，每个子任务应该：
1. 有清晰的名称和描述
2. 指定适合的执行Agent类型
3. 定义正确的依赖关系

可用的Agent类型：
${roleDescriptions}

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
      throw new Error(
        `[PlanExecutor] LLM任务拆分失败: ${response.error || '未知错误'}。请检查 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN 配置以及 API 连通性。`
      );
    }

    log({ message: `[PlanExecutor] LLM任务拆分成功，获得 ${response.data.subTasks.length} 个子任务` });
    if (response.data.reasoning) {
      log({ message: `[PlanExecutor] 拆分思路: ${response.data.reasoning}` });
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

      // 验证 workerType：从RoleManager检查角色是否存在
      const role = this.roleManager.getRole(llmSubTask.workerType);
      let workerType: string;
      if (role) {
        workerType = llmSubTask.workerType;
      } else {
        log({ message: `[PlanExecutor] 未知的workerType: ${llmSubTask.workerType}，使用general_agent`, level: 'warn' });
        workerType = 'general_agent';
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
   * 使用角色的 systemPrompt 作为开头，然后拼接任务信息和执行要求
   */
  private buildCommandForSubTask(llmSubTask: LLMPlanSubTask, parentTask: MainTask): string {
    // 获取角色的 systemPrompt
    const role = this.roleManager.getRole(llmSubTask.workerType);
    const systemPrompt = role ? role.systemPrompt : '';

    // 精简用户需求：提取关键信息
    const condensedRequest = this.condenseUserRequest(parentTask.userRequest);

    // 构建命令：systemPrompt + 任务信息 + 原始需求 + 执行要求
    const parts: string[] = [];

    // 1. 角色的 systemPrompt
    if (systemPrompt) {
      parts.push(systemPrompt);
    }

    // 2. 任务信息
    parts.push(`\n任务：${llmSubTask.name}`);
    parts.push(`描述：${llmSubTask.description}`);

    // 3. 原始需求
    parts.push(`\n原始需求：${condensedRequest}`);

    // 4. 执行要求
    parts.push(`\n注意：
1. 请基于实际情况来分析和执行任务
2. 如果需要读取文件，请明确指定文件路径
3. 你的输出必须具体且有针对性，不能给出通用建议
4. 请给出完整的执行结果，包含具体的代码或方案`);

    // 5. 执行提示
    parts.push(`\n请开始执行任务。`);

    return parts.join('\n');
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
    return `[需求摘要] ${summary}...\n`;
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
    workerType: string,
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
