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
  WorkerOutputSchema,
  LoopEvaluation
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
      // 从LLM评分中提取最高分，归一化为0-1的置信度
      const bestScore = scores.find(s => s.index === best_index);
      const confidence = bestScore ? bestScore.score / 10 : outputs[bestIdx].confidence;

      return {
        resolved: true,
        finalOutput: outputs[bestIdx].data,
        requiresUserInput: false,
        confidence,
        arbitrationReason: best_reason
      };
    }

    // fallback
    return {
      resolved: true,
      finalOutput: outputs[0].data,
      requiresUserInput: false,
      confidence: outputs[0].confidence,
      arbitrationReason: '回退到首个输出'
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

请返回JSON格式：
{
  "merged_content": "合并后的内容",
  "confidence": 0.85,
  "reason": "合并决策说明"
}

confidence为0-1之间的数字，表示合并结果对用户需求的满足程度。`;

    const userPrompt = `## 用户原始需求
${userRequest}

## 各Worker的输出
${outputTexts}

请将以上所有输出合并为一份综合结果，并给出置信度。`;

    const response = await llm.askForJSON<{
      merged_content: string;
      confidence: number;
      reason: string;
    }>(userPrompt, { systemPrompt, temperature: 0.3 });

    if (!response.success || !response.data) {
      log({ prefix: 'ArbitrationEngine', message: `LLM合并失败，回退到拼接输出: ${response.error}`, level: 'warn', silent: true });
      // fallback: 拼接所有输出
      const merged = outputs.map((o, i) => {
        const data = typeof o.data === 'string' ? o.data : JSON.stringify(o.data, null, 2);
        return `## 输出 #${i + 1} (${o.source_agent})\n${data}`;
      }).join('\n\n---\n\n');
      return {
        resolved: true,
        finalOutput: merged,
        requiresUserInput: false,
        confidence: 0.5,
        arbitrationReason: 'LLM合并失败，回退到拼接输出'
      };
    }

    log({ prefix: 'ArbitrationEngine', message: `LLM合并完成, 置信度: ${response.data.confidence}`, silent: true });

    return {
      resolved: true,
      finalOutput: response.data.merged_content,
      requiresUserInput: false,
      confidence: response.data.confidence,
      arbitrationReason: response.data.reason
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

  /**
   * 循环调度评审：使用LLM评估当前轮执行结果是否满足交付标准
   *
   * 评审依据：
   * - 用户原始需求
   * - 用户指定的交付标准（deliveryStandards）
   * - 当前轮次的执行结果
   * - 仲裁置信度
   *
   * 返回 LoopEvaluation，由 Master 根据置信度阈值判断是否继续循环
   */
  async evaluateLoopResult(
    task: MainTask,
    arbitrationResult: ArbitrationResult,
    roundNumber: number
  ): Promise<LoopEvaluation> {
    const llm = getLLMClient();

    const outputData = typeof arbitrationResult.finalOutput === 'string'
      ? arbitrationResult.finalOutput
      : JSON.stringify(arbitrationResult.finalOutput, null, 2);

    // 截断过长的输出
    const truncatedOutput = outputData.length > 4000
      ? outputData.substring(0, 4000) + '\n...(输出已截断)'
      : outputData;

    const systemPrompt = `你是一位严格的项目验收专家。请根据以下信息判断执行结果是否满足用户需求。

你需要综合评估：
1. 执行结果是否准确回答了用户的原始需求
2. 是否满足用户指定的交付标准
3. 结果的完整性和可用性
4. 仲裁引擎的置信度参考值: ${arbitrationResult.confidence ?? 'N/A'}

请返回JSON格式：
{
  "satisfied": true/false,
  "confidence": 0.0-1.0,
  "reason": "不满足的具体原因（如满足则为空）",
  "suggestions": "下轮修正建议（如满足则为空）"
}

注意：
- satisfied 为 true 时 confidence 应 >= 0.7
- confidence 体现你对结果满足需求的把握程度，不要与仲裁置信度简单等同
- 如果结果基本满足但有小问题，可以给较高置信度但 satisfied 设为 false，并在 suggestions 中指出修正点`;

    const userPrompt = `## 用户原始需求
${task.userRequest}

## 交付标准
${task.deliveryStandards.length > 0 ? task.deliveryStandards.join('\n') : '无明确交付标准'}

## 当前执行结果（第 ${roundNumber} 轮）
${truncatedOutput}

## 仲裁决策说明
${arbitrationResult.arbitrationReason || '无'}

请判断当前执行结果是否满足用户需求。`;

    try {
      const response = await llm.askForJSON<{
        satisfied: boolean;
        confidence: number;
        reason: string;
        suggestions: string;
      }>(userPrompt, { systemPrompt, temperature: 0.3 });

      if (!response.success || !response.data) {
        log({ prefix: 'ArbitrationEngine', message: `循环评审LLM调用失败: ${response.error}，使用仲裁置信度判断`, level: 'warn' });
        // 降级：直接用仲裁置信度判断
        const arbConfidence = arbitrationResult.confidence ?? 0.5;
        return {
          satisfied: arbConfidence >= 0.8,
          confidence: arbConfidence,
          reason: arbConfidence < 0.8 ? '仲裁置信度不足' : '',
          suggestions: arbConfidence < 0.8 ? '请优化执行策略，提高输出质量' : '',
          roundNumber,
        };
      }

      const { satisfied, confidence, reason, suggestions } = response.data;

      log({
        prefix: 'ArbitrationEngine',
        message: `循环评审结果 (第${roundNumber}轮): satisfied=${satisfied}, confidence=${confidence.toFixed(2)}, reason=${reason || '无'}`
      });

      return {
        satisfied,
        confidence,
        reason: reason || '',
        suggestions: suggestions || '',
        roundNumber,
      };
    } catch (error) {
      log({ prefix: 'ArbitrationEngine', message: `循环评审异常: ${error}`, level: 'error' });
      const arbConfidence = arbitrationResult.confidence ?? 0.5;
      return {
        satisfied: arbConfidence >= 0.8,
        confidence: arbConfidence,
        reason: '评审异常，使用仲裁置信度降级判断',
        suggestions: '',
        roundNumber,
      };
    }
  }
}
