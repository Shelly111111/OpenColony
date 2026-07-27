/**
 * 输出标准化与仲裁引擎
 * 使用 LLM 进行智能仲裁，替代机械规则
 *
 * 仲裁模式：
 * - confidence_vote：LLM 依次对每个输出打分，选出最高分返回
 * - merge_diff：LLM 根据用户提问，将所有输出合并为一份
 */

import {
  WorkerOutput,
  MainTask,
  ArbitrationResult,
  ArbitrationMode,
  SchedulerConfig,
  WorkerOutputSchema
} from './types';
import { log } from './logger';
import { getLLMClient } from './llm-client';

export class ArbitrationEngine {
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /**
   * 仲裁多个Worker的输出，合并为最终结果
   */
  async arbitrate(outputs: WorkerOutput[], task: MainTask): Promise<ArbitrationResult> {
    log({ prefix: 'ArbitrationEngine', message: `开始仲裁 ${outputs.length} 个输出，模式: ${this.config.arbitrationMode}`, silent: true });

    if (outputs.length === 0) {
      return {
        resolved: false,
        conflicts: ['无有效输出可仲裁'],
        requiresUserInput: false
      };
    }

    if (outputs.length === 1) {
      log({ prefix: 'ArbitrationEngine', message: `只有一个输出，直接使用`, silent: true });
      return {
        resolved: true,
        finalOutput: outputs[0].data,
        requiresUserInput: false
      };
    }

    switch (this.config.arbitrationMode) {
      case ArbitrationMode.CONFIDENCE_VOTE:
        return this.llmConfidenceVote(outputs, task);
      case ArbitrationMode.MERGE_DIFF:
        return this.llmMergeDiff(outputs, task);
      default:
        return this.llmConfidenceVote(outputs, task);
    }
  }

  /**
   * 置信度投票：LLM 依次对每个输出打分，选出最高分返回
   */
  private async llmConfidenceVote(outputs: WorkerOutput[], task: MainTask): Promise<ArbitrationResult> {
    log({ prefix: 'ArbitrationEngine', message: `使用 LLM 置信度投票仲裁`, silent: true });

    const llm = getLLMClient();
    const userRequest = task.userRequest;
    const outputTexts = outputs.map((o, i) => {
      const data = typeof o.data === 'string' ? o.data : JSON.stringify(o.data, null, 2);
      return `--- 输出 #${i + 1} (来自 ${o.source_agent}) ---\n${data}`;
    }).join('\n\n');

    const systemPrompt = `你是一位专业的评审专家。你需要根据用户的原始需求，对每个Worker的输出进行评分。
请严格按照JSON格式返回评分结果，不要输出其他内容。`;

    const userPrompt = `## 用户原始需求
${userRequest}

## 各Worker的输出
${outputTexts}

## 评分要求
对每个输出评分（0-10分），评估其是否准确、完整地满足了用户需求。
返回JSON格式：
{
  "scores": [
    {"index": 1, "score": 8, "reason": "简要评分理由"},
    {"index": 2, "score": 6, "reason": "简要评分理由"}
  ],
  "best_index": 1,
  "best_reason": "选择该输出的理由"
}`;

    const response = await llm.askForJSON<{
      scores: Array<{ index: number; score: number; reason: string }>;
      best_index: number;
      best_reason: string;
    }>(userPrompt, { systemPrompt, temperature: 0.3 });

    if (!response.success || !response.data) {
      log({ prefix: 'ArbitrationEngine', message: `LLM评分失败，回退到选择第一个输出: ${response.error}`, level: 'warn', silent: true });
      return {
        resolved: true,
        finalOutput: outputs[0].data,
        requiresUserInput: false
      };
    }

    const { scores, best_index, best_reason } = response.data;
    const scoreSummary = scores.map(s => `#${s.index}: ${s.score}分 (${s.reason})`).join(', ');
    log({ prefix: 'ArbitrationEngine', message: `LLM评分: ${scoreSummary}`, silent: true });
    log({ prefix: 'ArbitrationEngine', message: `选择 #${best_index}: ${best_reason}`, silent: true });

    const bestIdx = best_index - 1; // 转为0-based
    if (bestIdx >= 0 && bestIdx < outputs.length) {
      return {
        resolved: true,
        finalOutput: outputs[bestIdx].data,
        requiresUserInput: false
      };
    }

    // fallback
    return {
      resolved: true,
      finalOutput: outputs[0].data,
      requiresUserInput: false
    };
  }

  /**
   * 差异合并：LLM 根据用户提问，将所有输出合并为一份
   */
  private async llmMergeDiff(outputs: WorkerOutput[], task: MainTask): Promise<ArbitrationResult> {
    log({ prefix: 'ArbitrationEngine', message: `使用 LLM 差异合并仲裁`, silent: true });

    const llm = getLLMClient();
    const userRequest = task.userRequest;
    const outputTexts = outputs.map((o, i) => {
      const data = typeof o.data === 'string' ? o.data : JSON.stringify(o.data, null, 2);
      return `--- 输出 #${i + 1} (来自 ${o.source_agent}) ---\n${data}`;
    }).join('\n\n');

    const systemPrompt = `你是一位专业的内容整合专家。你需要根据用户的原始需求，将多个Worker的输出合并为一份高质量的综合结果。
合并时请注意：
1. 去除重复内容
2. 保留各输出中有价值的独到见解
3. 确保合并结果逻辑连贯、结构清晰
4. 直接输出合并后的内容，不要添加"合并结果"等前缀`;

    const userPrompt = `## 用户原始需求
${userRequest}

## 各Worker的输出
${outputTexts}

请将以上所有输出合并为一份综合结果，直接输出合并内容。`;

    const response = await llm.ask(userPrompt, { systemPrompt, temperature: 0.3 });

    if (!response.success || !response.content) {
      log({ prefix: 'ArbitrationEngine', message: `LLM合并失败，回退到拼接输出: ${response.error}`, level: 'warn', silent: true });
      // fallback: 拼接所有输出
      const merged = outputs.map((o, i) => {
        const data = typeof o.data === 'string' ? o.data : JSON.stringify(o.data, null, 2);
        return `## 输出 #${i + 1} (${o.source_agent})\n${data}`;
      }).join('\n\n---\n\n');
      return {
        resolved: true,
        finalOutput: merged,
        requiresUserInput: false
      };
    }

    log({ prefix: 'ArbitrationEngine', message: `LLM合并完成`, silent: true });

    return {
      resolved: true,
      finalOutput: response.content,
      requiresUserInput: false
    };
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
