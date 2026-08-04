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
  LLMPlanSubTask,
  WorkerInstance
} from "./types";
import { WorkerManager } from "./worker-manager";
import { getLLMClient } from "./llm-client";
import { RoleManager } from "./role-manager";
import { log } from "./logger";
import { loadSettings, AppSettings } from "./config/settings";
import { ClaudeLink } from "./claude-link";
import { getMemoryStore } from "./memory-store";

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
  private writePlanLog(masterLogFile: string | undefined, message: string, traceId?: string, taskId?: string): void {
    if (!masterLogFile) return;
    log({ logFile: masterLogFile, prefix: 'PlanExecutor', message, silent: true, traceId, taskId });
  }

  /**
   * 规划任务，拆分子任务并构建DAG
   */
  async planTask(task: MainTask): Promise<PlanOutput> {
    log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `开始规划任务 ${task.id}`, traceId: task.traceId, taskId: task.id });

    // 调用LLM进行任务拆分
    const subTasks = await this.splitTaskIntoSubTasksWithLLM(task);
    log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `拆分为 ${subTasks.length} 个子任务`, traceId: task.traceId, taskId: task.id });

    // 构建DAG
    const dag = await this.buildDAG(subTasks);
    log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `DAG构建完成，包含 ${dag.nodes.size} 个节点，${dag.edges.size} 条边`, traceId: task.traceId, taskId: task.id });

    // 输出DAG结构
    this.printDAG(dag, task.masterLogFile, task.traceId, task.id);

    return {
      subTasks,
      dag,
      requiredWorkers: this.calculateRequiredWorkers(dag)
    };
  }

  /**
   * 执行DAG任务（增强版）
   * 支持分层执行和参数传递
   */
  async executeDAG(task: MainTask, workerManager: WorkerManager): Promise<WorkerOutput[]> {
    log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `开始执行DAG任务 ${task.id}`, traceId: task.traceId, taskId: task.id });
    this.writePlanLog(task.masterLogFile, `子任务数量: ${task.subTasks.size}`, task.traceId, task.id);

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
        logFile: task.masterLogFile,
        prefix: 'PlanExecutor',
        message: `执行第 ${layer.level + 1}/${layers.length} 层任务，共 ${layer.taskIds.length} 个任务，执行方式: ${this.settings.taskExecution.sameLayerAsync ? '异步' : '同步'}`,
        traceId: task.traceId,
        taskId: task.id
      });

      const layerTasks = layer.taskIds
        .map(taskId => task.subTasks.get(taskId))
        .filter((st): st is SubTask => st !== undefined);

      // 为当前层所有任务预创建Worker
      const layerWorkers = await Promise.all(
        layerTasks.map(subTask => workerManager.createWorker(subTask.workerType, task.logDir, task.traceId, subTask.id))
      );
      log({ prefix: 'PlanExecutor', message: `为第 ${layer.level + 1} 层创建了 ${layerWorkers.length} 个Worker` });

      // 将Worker关联到对应的SubTask
      for (let i = 0; i < layerTasks.length; i++) {
        layerTasks[i].worker = layerWorkers[i];
      }

      // 只有SDK模式才启用协作功能
      const isSDKMode = workerManager.runMode === 'sdk';
      const claudeLink = isSDKMode ? ClaudeLink.getInstance() : null;

      if (isSDKMode) {
        for (const worker of layerWorkers) {
          claudeLink!.registerWorker(worker);
        }
        log({ prefix: 'PlanExecutor', message: `SDK模式：注册 ${layerWorkers.length} 个Worker到ClaudeLink` });
        // 注入同层团队信息（只有SDK模式）
        this.injectLayerTeamInfo(layerTasks, task);
      }

      // 根据设置决定同层任务的执行方式
      if (this.settings.taskExecution.sameLayerAsync) {
        log({ prefix: 'PlanExecutor', message: `同层任务异步并行执行` });
        await this.executeLayerAsync(layerTasks, layerWorkers, task, workerManager, completedTasks, executingTasks, results, claudeLink);
      } else {
        log({ prefix: 'PlanExecutor', message: `同层任务同步串行执行` });
        await this.executeLayerSync(layerTasks, layerWorkers, task, workerManager, completedTasks, executingTasks, results, claudeLink);
      }

      // 兜底：清空ClaudeLink中本层所有Worker（防止个别Worker未被及时注销）
      if (isSDKMode) {
        const remainingWorkers = claudeLink!.getAllWorkers();
        if (remainingWorkers.length > 0) {
          log({ prefix: 'PlanExecutor', message: `兜底清理：ClaudeLink中剩余 ${remainingWorkers.length} 个Worker未注销，执行清空`, level: 'warn' });
          claudeLink!.clearAllWorkers();
        }
      }

      // 释放WorkerManager中的Worker资源
      for (const w of layerWorkers) {
        workerManager.releaseWorker(w.id, task.traceId, task.id);
      }

      log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `第 ${layer.level + 1} 层任务执行完成`, traceId: task.traceId, taskId: task.id });
    }

    log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `DAG执行完成，共完成 ${completedTasks.size} 个子任务`, traceId: task.traceId, taskId: task.id });
    return results;
  }

  /**
   * 异步并行执行一层任务
   */
  private async executeLayerAsync(
    layerTasks: SubTask[],
    layerWorkers: WorkerInstance[],
    task: MainTask,
    workerManager: WorkerManager,
    completedTasks: Set<string>,
    executingTasks: Set<string>,
    results: WorkerOutput[],
    claudeLink: ClaudeLink | null
  ): Promise<void> {
    const maxConcurrency = this.settings.taskExecution.maxConcurrency;

    if (layerTasks.length <= maxConcurrency) {
      await Promise.all(
        layerTasks.map(async (subTask, index) => {
          const worker = layerWorkers[index];
          await this.executeSingleTaskWithParamPassing(subTask, task, workerManager, worker);
          // Worker执行完毕，立即从ClaudeLink中注销
          claudeLink?.unregisterWorker(worker.id);
          completedTasks.add(subTask.id);
          if (subTask.output) {
            results.push(subTask.output);
          }
        })
      );
    } else {
      for (let i = 0; i < layerTasks.length; i += maxConcurrency) {
        const batch = layerTasks.slice(i, i + maxConcurrency);
        const workerBatch = layerWorkers.slice(i, i + maxConcurrency);
        await Promise.all(
          batch.map(async (subTask, index) => {
            const worker = workerBatch[index];
            await this.executeSingleTaskWithParamPassing(subTask, task, workerManager, worker);
            // Worker执行完毕，立即从ClaudeLink中注销
            claudeLink?.unregisterWorker(worker.id);
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
    layerWorkers: WorkerInstance[],
    task: MainTask,
    workerManager: WorkerManager,
    completedTasks: Set<string>,
    executingTasks: Set<string>,
    results: WorkerOutput[],
    claudeLink: ClaudeLink | null
  ): Promise<void> {
    for (let i = 0; i < layerTasks.length; i++) {
      const subTask = layerTasks[i];
      const worker = layerWorkers[i];
      await this.executeSingleTaskWithParamPassing(subTask, task, workerManager, worker);
      // Worker执行完毕，立即从ClaudeLink中注销
      claudeLink?.unregisterWorker(worker.id);
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

    log({ prefix: 'PlanExecutor', message: `拓扑排序完成，共 ${layers.length} 层` });
    layers.forEach(layer => {
      const taskNames = layer.taskIds.map(id => {
        const st = task.subTasks.get(id);
        return st ? st.name : id;
      });
      log({
        prefix: 'PlanExecutor',
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
    workerManager: WorkerManager,
    worker?: WorkerInstance
  ): Promise<void> {
    try {
      subTask.status = TaskStatus.RUNNING;
      subTask.startedAt = new Date();

      log({ logFile: task.masterLogFile, prefix: 'PlanExecutor', message: `开始执行子任务 ${subTask.id}: ${subTask.name}`, traceId: task.traceId, taskId: subTask.id });

      if (subTask.dependencies.length > 0) {
        const enhancedCommand = this.buildEnhancedCommand(subTask, task);
        subTask.command = enhancedCommand;
      }

      const output = await workerManager.executeSubTask(subTask, task.traceId, task.logDir, worker);
      subTask.output = output;
      subTask.status = output.status === "fail" ? TaskStatus.FAILED : TaskStatus.COMPLETED;
      subTask.completedAt = new Date();

      if (output.status === "success") {
        this.taskOutputs.set(subTask.id, output);
      }

      this.writePlanLog(task.masterLogFile, `子任务 ${subTask.id} 执行完成，状态: ${output.status}`, task.traceId, subTask.id);

      if (output.status === "fail" && subTask.retryCount < subTask.maxRetries) {
        log({ prefix: 'PlanExecutor', message: `子任务 ${subTask.id} 失败，重试 ${subTask.retryCount + 1}/${subTask.maxRetries}` });
        subTask.retryCount++;
        subTask.status = TaskStatus.RETRYING;
        await this.delay(1000 * Math.pow(2, subTask.retryCount));
        return this.executeSingleTaskWithParamPassing(subTask, task, workerManager, worker);
      }

    } catch (error) {
      log({ prefix: 'PlanExecutor', message: `子任务 ${subTask.id} 执行异常: ${error}`, level: 'error' });
      subTask.status = TaskStatus.FAILED;
      subTask.error = error instanceof Error ? error.message : String(error);
      subTask.completedAt = new Date();

      if (!this.isCriticalPathTask(subTask, task.dag)) {
        log({ prefix: 'PlanExecutor', message: `子任务 ${subTask.id} 不在关键路径，继续执行其他任务`, level: 'warn' });
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
      log({ prefix: 'PlanExecutor', message: `为任务 ${subTask.name} 添加依赖输出，依赖数量: ${dependencyOutputs.length}` });
      return enhancedCommand;
    }

    return subTask.command;
  }

  /**
   * 使用LLM拆分主任务为子任务
   */
  private async splitTaskIntoSubTasksWithLLM(task: MainTask): Promise<SubTask[]> {
    log({ prefix: 'PlanExecutor', message: `使用LLM进行任务拆分...` });

    const llm = getLLMClient();

    // 从 RoleManager 动态获取可用的 Agent 类型列表（含技能）
    const roleDescriptions = this.roleManager.getRoleSkillDescriptions();

    // L3: 注入 Worker 画像描述
    const memoryStore = getMemoryStore();
    const profileDesc = memoryStore.getWorkerProfileDescriptions();

    // L1: 检索相似历史任务经验
    const projectId = task.projectId || '__global__';
    let experienceContext = '';
    try {
      const similarExperiences = await memoryStore.searchSimilarExperiences(projectId, task.userRequest);
      if (similarExperiences.length > 0) {
        experienceContext = '\n## 历史相似任务参考（仅供参考，根据实际情况调整，不要照搬）\n';
        for (const { experience, relevanceScore } of similarExperiences) {
          const statusLabel = experience.status === 'success' ? '成功' : experience.status === 'partial' ? '部分成功' : '失败';
          const confLabel = experience.confidence ? `·置信度${experience.confidence.toFixed(2)}` : '';
          let expSummary = `${statusLabel}${confLabel} "${experience.userRequest.substring(0, 60)}"\n`;
          try {
            const subTasks = JSON.parse(experience.subTasksJson);
            const subTaskSummary = subTasks.map((st: any) => `${st.name}(${st.workerType})`).join(' → ');
            expSummary += `   → 拆分: ${subTaskSummary}\n`;
          } catch { /* ignore */ }
          if (experience.finalOutputSummary) {
            expSummary += `   → 结果: ${experience.finalOutputSummary.substring(0, 100)}\n`;
          }
          experienceContext += `${similarExperiences.indexOf({ experience, relevanceScore } as any) + 1}. [${expSummary.trim()}]\n`;
        }
        log({ prefix: 'PlanExecutor', message: `L1 找到 ${similarExperiences.length} 条相似经验` });
      }
    } catch (error) {
      log({ prefix: 'PlanExecutor', message: `L1 经验检索失败: ${error}`, level: 'warn' });
    }

    const systemPrompt = `你是一个任务规划专家，负责将复杂的任务拆分为可执行的子任务。

请根据用户的需求，将任务拆分为一系列子任务，在拆分时，率先考虑任务的复杂性，如果任务复杂度较低，建议拆分为较少的子任务，如果任务复杂度较高，建议考虑任务的依赖关系，每个子任务应该：
1. 有清晰的名称和描述
2. 指定适合的执行Agent类型
3. 定义正确的依赖关系
4. 每个子任务最多指定一个skill，skill必须来自该Agent类型的可用技能列表

可用的Agent类型及其技能：
${roleDescriptions}
${profileDesc ? `\n各角色历史表现：\n${profileDesc}` : ''}${experienceContext}
请返回JSON格式，格式如下：
{
  "subTasks": [
    {
      "name": "任务名称",
      "description": "详细任务描述",
      "workerType": "general_agent",
      "dependencies": [0],  // 依赖的子任务索引，从0开始，空数组表示无依赖
      "skill": "qsuperpowers:auto-coding"  // 可选，使用的技能，格式为"pluginName:subSkillId"或"skillId"，每个子任务最多一个
    }
  ],
  "reasoning": "拆分思路说明",
  "condensedRequest": "需求摘要：用100-300字精炼概括用户需求的核心内容、关键约束和交付标准，便于子任务执行者快速理解整体目标"
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

    log({ prefix: 'PlanExecutor', message: `LLM任务拆分成功，获得 ${response.data.subTasks.length} 个子任务` });
    if (response.data.reasoning) {
      log({ prefix: 'PlanExecutor', message: `拆分思路: ${response.data.reasoning}` });
    }

    if (response.data.condensedRequest) {
      task.condensedRequest = response.data.condensedRequest;
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
        log({ prefix: 'PlanExecutor', message: `未知的workerType: ${llmSubTask.workerType}，使用general_agent`, level: 'warn' });
        workerType = 'general_agent';
      }

      subTasks.push({
        id: subTaskId,
        parentTaskId: task.id,
        name: llmSubTask.name,
        description: llmSubTask.description,
        workerType,
        skill: llmSubTask.skill,  // LLM分配的技能
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
    const condensedRequest = this.condenseUserRequest(parentTask);

    // 构建命令：systemPrompt + skill + 任务信息 + 原始需求 + 执行要求
    const parts: string[] = [];

    // 1. 角色的 systemPrompt
    if (systemPrompt) {
      parts.push(systemPrompt);
    }

    // 2. 如果指定了 skill，注入技能引用
    if (llmSubTask.skill) {
      parts.push(`\n请使用技能 "${llmSubTask.skill}" 来完成此任务。`);
    }

    // 3. 任务信息
    parts.push(`\n任务：${llmSubTask.name}`);
    parts.push(`描述：${llmSubTask.description}`);

    // 4. 原始需求
    parts.push(`\n原始需求：${condensedRequest}`);

    // 5. 执行要求
    parts.push(`\n注意：
1. 请基于实际情况来分析和执行任务
2. 如果需要读取文件，请明确指定文件路径
3. 你的输出必须具体且有针对性，不能给出通用建议
4. 请给出完整的执行结果，包含具体的代码或方案`);

    // 6. 执行提示
    parts.push(`\n请开始执行任务。`);

    return parts.join('\n');
  }

  /**
   * 精简用户需求：提取关键信息，避免prompt过长
   */
  private condenseUserRequest(task: MainTask): string {
    const fullRequest = task.userRequest;
    // 如果需求较短，直接返回
    if (fullRequest.length <= 500) {
      return fullRequest;
    }

    // 如果有LLM生成的摘要，直接返回
    if (task.condensedRequest) {
      return task.condensedRequest;
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
   * 打印DAG结构（层号 + 节点名称 + 边）
   */
  private printDAG(dag: DAG, logFile?: string, traceId?: string, taskId?: string): void {
    // 按层分组
    const nodeLayers = new Map<string, number>();
    const visited = new Set<string>();
    const queue: Array<{ id: string; layer: number }> = [];

    // 找到所有入度为0的节点作为起始层
    const inDegree = new Map<string, number>();
    for (const [id] of dag.nodes) {
      inDegree.set(id, 0);
    }
    for (const [, targets] of dag.edges) {
      for (const target of targets) {
        inDegree.set(target, (inDegree.get(target) || 0) + 1);
      }
    }
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push({ id, layer: 0 });
        visited.add(id);
      }
    }

    // BFS分层
    let maxLayer = 0;
    while (queue.length > 0) {
      const { id, layer } = queue.shift()!;
      nodeLayers.set(id, layer);
      if (layer > maxLayer) maxLayer = layer;
      const targets = dag.edges.get(id) || [];
      for (const target of targets) {
        if (!visited.has(target)) {
          visited.add(target);
          queue.push({ id: target, layer: layer + 1 });
        } else {
          // 更新为目标层的最大值
          const currentLayer = nodeLayers.get(target) || 0;
          if (layer + 1 > currentLayer) {
            nodeLayers.set(target, layer + 1);
            if (layer + 1 > maxLayer) maxLayer = layer + 1;
          }
        }
      }
    }

    // 按层输出
    for (let layer = 0; layer <= maxLayer; layer++) {
      const layerNodes = Array.from(dag.nodes.entries())
        .filter(([, node]) => nodeLayers.get(node.id) === layer);
      const nodeNames = layerNodes.map(([, node]) => node.name).join(', ');
      log({ logFile, prefix: 'PlanExecutor', message: `  层${layer}: ${nodeNames}`, traceId, taskId });
    }

    // 输出边
    const edgeList: string[] = [];
    for (const [from, targets] of dag.edges) {
      const fromName = dag.nodes.get(from)?.name || from;
      for (const to of targets) {
        const toName = dag.nodes.get(to)?.name || to;
        edgeList.push(`${fromName} -> ${toName}`);
      }
    }
    log({ logFile, prefix: 'PlanExecutor', message: `  边: ${edgeList.join(', ')}`, traceId, taskId });
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

  /**
   * 为当前层任务注入同层团队信息和协作技能引用
   */
  private injectLayerTeamInfo(layerTasks: SubTask[], task: MainTask): void {
    const hasTeammates = layerTasks.length > 1;

    for (const subTask of layerTasks) {
      let teamInfo = this.buildCollaborationSkillReference();

      if (hasTeammates) {
        teamInfo += '\n\n' + this.buildLayerTeamInfo(subTask, layerTasks);
      }

      subTask.command += '\n\n' + teamInfo;
    }

    log({ prefix: 'PlanExecutor', message: `为当前层的 ${layerTasks.length} 个任务注入协作信息` });
  }

  /**
   * 构建同层团队成员列表（排除当前Worker）
   */
  private buildLayerTeamInfo(currentTask: SubTask, layerTasks: SubTask[]): string {
    const lines: string[] = [];
    lines.push('## 同层团队成员');
    lines.push('当前层有以下 Worker 正在并行执行任务，你可以与他们协作：');
    lines.push('');

    for (const subTask of layerTasks) {
      if (subTask.id === currentTask.id) {
        continue;
      }

      const worker = subTask.worker;
      if (!worker) {
        continue;
      }

      const role = this.roleManager.getRole(subTask.workerType);
      const roleName = role ? role.name : subTask.workerType;

      lines.push(`- **${worker.id}** (${roleName})：${subTask.description}`);
    }

    return lines.join('\n');
  }

  /**
   * 构建协作技能文件引用（始终注入）
   */
  private buildCollaborationSkillReference(): string {
    const lines: string[] = [];
    lines.push('## 协作技能');
    lines.push('系统已为你配备 `worker-collaboration` 工具集，可用于与其他 Worker 通讯协作。');
    lines.push('详细使用说明请阅读技能文件: `.claude/skills/worker-communication/skill.md`');
    return lines.join('\n');
  }
}
