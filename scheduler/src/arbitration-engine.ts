/**
 * 输出标准化与仲裁引擎
 * 实现统一输出Schema、冲突仲裁、结果合并功能
 */

import {
  WorkerOutput,
  MainTask,
  ArbitrationResult,
  ArbitrationMode,
  SchedulerConfig,
  WorkerOutputSchema
} from './types';

export class ArbitrationEngine {
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /**
   * 仲裁多个Worker的输出，合并为最终结果
   */
  async arbitrate(outputs: WorkerOutput[], task: MainTask): Promise<ArbitrationResult> {
    console.log(`[ArbitrationEngine] 开始仲裁 ${outputs.length} 个输出，模式: ${this.config.arbitrationMode}`);

    if (outputs.length === 0) {
      return {
        resolved: false,
        conflicts: ['无有效输出可仲裁'],
        requiresUserInput: false
      };
    }

    if (outputs.length === 1) {
      console.log(`[ArbitrationEngine] 只有一个输出，直接使用`);
      return {
        resolved: true,
        finalOutput: outputs[0].data,
        requiresUserInput: false
      };
    }

    // 根据仲裁模式选择不同的策略
    switch (this.config.arbitrationMode) {
      case ArbitrationMode.CONFIDENCE_VOTE:
        return this.confidenceVoteArbitration(outputs, task);
      case ArbitrationMode.AGENT_PRIORITY:
        return this.agentPriorityArbitration(outputs, task);
      case ArbitrationMode.MERGE_DIFF:
        return this.mergeDiffArbitration(outputs, task);
      default:
        return this.confidenceVoteArbitration(outputs, task);
    }
  }

  /**
   * 置信度投票仲裁
   * 选择置信度最高的输出
   */
  private confidenceVoteArbitration(outputs: WorkerOutput[], task: MainTask): ArbitrationResult {
    console.log(`[ArbitrationEngine] 使用置信度投票仲裁`);

    // 按置信度排序
    const sortedOutputs = [...outputs].sort((a, b) => b.confidence - a.confidence);
    const highestConfidence = sortedOutputs[0].confidence;

    // 检查是否有多个输出置信度相同且最高
    const topOutputs = sortedOutputs.filter(o => o.confidence === highestConfidence);

    if (topOutputs.length === 1) {
      console.log(`[ArbitrationEngine] 选择置信度最高的输出: ${highestConfidence}`);
      return {
        resolved: true,
        finalOutput: topOutputs[0].data,
        requiresUserInput: false
      };
    }

    // 多个输出置信度相同，尝试合并
    console.log(`[ArbitrationEngine] 有 ${topOutputs.length} 个输出置信度相同，尝试合并`);
    return this.tryMergeOutputs(topOutputs, task);
  }

  /**
   * Agent优先级仲裁
   * 高优先级Agent的输出具有更高权重
   */
  private agentPriorityArbitration(outputs: WorkerOutput[], task: MainTask): ArbitrationResult {
    console.log(`[ArbitrationEngine] 使用Agent优先级仲裁`);

    // 定义Agent优先级（数值越大优先级越高）
    const agentPriority: Record<string, number> = {
      'review_agent': 10,  // 评审Agent最高优先级
      'code_agent': 8,
      'general_agent': 5
    };

    // 按Agent优先级排序
    const sortedOutputs = [...outputs].sort((a, b) => {
      const priorityA = agentPriority[a.source_agent] || 0;
      const priorityB = agentPriority[b.source_agent] || 0;
      return priorityB - priorityA;
    });

    const highestPriority = agentPriority[sortedOutputs[0].source_agent] || 0;
    const topOutputs = sortedOutputs.filter(o =>
      (agentPriority[o.source_agent] || 0) === highestPriority
    );

    if (topOutputs.length === 1) {
      console.log(`[ArbitrationEngine] 选择最高优先级Agent ${topOutputs[0].source_agent} 的输出`);
      return {
        resolved: true,
        finalOutput: topOutputs[0].data,
        requiresUserInput: false
      };
    }

    // 多个同优先级Agent输出，再按置信度排序
    console.log(`[ArbitrationEngine] 有 ${topOutputs.length} 个同优先级Agent输出，按置信度选择`);
    return this.confidenceVoteArbitration(topOutputs, task);
  }

  /**
   * 差异合并仲裁
   * 尝试合并多个互补的输出
   */
  private mergeDiffArbitration(outputs: WorkerOutput[], task: MainTask): ArbitrationResult {
    console.log(`[ArbitrationEngine] 使用差异合并仲裁`);

    // 尝试合并所有输出
    return this.tryMergeOutputs(outputs, task);
  }

  /**
   * 尝试合并多个输出
   */
  private tryMergeOutputs(outputs: WorkerOutput[], task: MainTask): ArbitrationResult {
    // 检查输出类型
    const outputTypes = outputs.map(o => typeof o.data);
    const allSameType = outputTypes.every(t => t === outputTypes[0]);

    if (!allSameType) {
      console.warn(`[ArbitrationEngine] 输出类型不一致: ${outputTypes.join(', ')}`);
      console.log(`[ArbitrationEngine] 将采用选择置信度最高的单个输出策略`);
      const sortedByConfidence = [...outputs].sort((a, b) => b.confidence - a.confidence);
      return {
        resolved: true,
        finalOutput: sortedByConfidence[0].data,
        requiresUserInput: false
      };
    }

    const dataType = outputTypes[0];

    try {
      const allArrays = outputs.every(o => Array.isArray(o.data));
      if (allArrays) {
        return this.mergeArrayOutputs(outputs);
      }

      switch (dataType) {
        case 'string':
          return this.mergeStringOutputs(outputs);
        case 'object':
          return this.mergeObjectOutputs(outputs);
        default:
          return this.mergePrimitiveOutputs(outputs);
      }
    } catch (error) {
      console.error(`[ArbitrationEngine] 合并失败:`, error);
      console.log(`[ArbitrationEngine] 合并失败，回退到选择置信度最高的输出`);
      const sortedByConfidence = [...outputs].sort((a, b) => b.confidence - a.confidence);
      return {
        resolved: true,
        finalOutput: sortedByConfidence[0].data,
        requiresUserInput: false
      };
    }
  }

  /**
   * 合并字符串输出
   */
  private mergeStringOutputs(outputs: WorkerOutput[]): ArbitrationResult {
    const uniqueContents = new Set<string>();
    outputs.forEach(o => {
      if (typeof o.data === 'string') {
        uniqueContents.add(o.data.trim());
      }
    });

    const merged = Array.from(uniqueContents).join('\n\n---\n\n');

    return {
      resolved: true,
      finalOutput: merged,
      requiresUserInput: false
    };
  }

  /**
   * 合并对象输出
   */
  private mergeObjectOutputs(outputs: WorkerOutput[]): ArbitrationResult {
    const merged: any = {};

    outputs.forEach(o => {
      if (typeof o.data === 'object' && o.data !== null) {
        this.deepMerge(merged, o.data);
      }
    });

    return {
      resolved: true,
      finalOutput: merged,
      requiresUserInput: false
    };
  }

  /**
   * 合并数组输出
   */
  private mergeArrayOutputs(outputs: WorkerOutput[]): ArbitrationResult {
    const merged: any[] = [];
    const seen = new Set<string>();

    outputs.forEach(o => {
      if (Array.isArray(o.data)) {
        o.data.forEach(item => {
          const key = JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(item);
          }
        });
      }
    });

    return {
      resolved: true,
      finalOutput: merged,
      requiresUserInput: false
    };
  }

  /**
   * 合并基本类型输出
   */
  private mergePrimitiveOutputs(outputs: WorkerOutput[]): ArbitrationResult {
    const valueCounts = new Map<any, number>();

    outputs.forEach(o => {
      const value = o.data;
      valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
    });

    let maxCount = 0;
    let mostFrequent: any = null;

    valueCounts.forEach((count, value) => {
      if (count > maxCount) {
        maxCount = count;
        mostFrequent = value;
      }
    });

    if (maxCount === 1 || valueCounts.size === outputs.length) {
      const sortedByConfidence = [...outputs].sort((a, b) => b.confidence - a.confidence);
      mostFrequent = sortedByConfidence[0].data;
    }

    return {
      resolved: true,
      finalOutput: mostFrequent,
      requiresUserInput: false
    };
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: any, source: any): void {
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (
          typeof source[key] === 'object' &&
          source[key] !== null &&
          !Array.isArray(source[key]) &&
          typeof target[key] === 'object' &&
          target[key] !== null
        ) {
          this.deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    }
  }

  /**
   * 验证输出是否符合Schema
   */
  validateOutput(output: WorkerOutput): boolean {
    const result = WorkerOutputSchema.safeParse(output);
    return result.success;
  }

  /**
   * 标准化输出格式
   */
  normalizeOutput(output: any, sourceAgent: string, traceId: string): WorkerOutput {
    if (this.validateOutput(output)) {
      return output;
    }

    return {
      status: 'success',
      data: output,
      confidence: 0.7,
      source_agent: sourceAgent,
      trace_id: traceId
    };
  }
}
