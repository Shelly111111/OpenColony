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

/** 日志上下文，用于将日志写入文件和数据库 */
interface LogContext {
  logFile?: string;
  traceId?: string;
  taskId?: string;
}

export class ArbitrationEngine {
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /** 统一日志方法，自动携带上下文 */
  private logMsg(message: string, ctx: LogContext, level: 'info' | 'warn' | 'error' = 'info', silent = false): void {
    log({ logFile: ctx.logFile, prefix: 'ArbitrationEngine', message, level, silent, traceId: ctx.traceId, taskId: ctx.taskId });
  }

  /**
   * 仲裁多个Worker的输出，合并为最终结果
   */
  async arbitrate(outputs: WorkerOutput[], task: MainTask, logCtx?: LogContext): Promise<ArbitrationResult> {
    const ctx = logCtx || {};
    this.logMsg(`开始仲裁 ${outputs.length} 个输出，模式: ${this.config.arbitrationMode}`, ctx, 'info', true);

    if (outputs.length === 0) {
      return {
        resolved: false,
        conflicts: ['无有效输出可仲裁'],
        requiresUserInput: false
      };
    }

    if (outputs.length === 1) {
      this.logMsg(`只有一个输出，直接使用`, ctx, 'info', true);
      return {
        resolved: true,
        finalOutput: outputs[0].data,
        requiresUserInput: false,
        confidence: outputs[0].confidence,
      };
    }

    switch (this.config.arbitrationMode) {
      case ArbitrationMode.CONFIDENCE_VOTE:
        return this.llmConfidenceVote(outputs, task, ctx);
      case ArbitrationMode.MERGE_DIFF:
        return this.llmMergeDiff(outputs, task, ctx);
      default:
        return this.llmConfidenceVote(outputs, task, ctx);
    }
  }

  /**
   * 置信度投票：LLM 依次对每个输出打分，选出最高分返回
   */
  private async llmConfidenceVote(outputs: WorkerOutput[], task: MainTask, ctx: LogContext): Promise<ArbitrationResult> {
    this.logMsg(`使用 LLM 置信度投票仲裁`, ctx, 'info', true);

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
      this.logMsg(`LLM评分失败，回退到选择第一个输出: ${response.error}`, ctx, 'warn');
      return {
        resolved: true,
        finalOutput: outputs[0].data,
        requiresUserInput: false
      };
    }

    const { scores, best_index, best_reason } = response.data;
    const scoreSummary = scores.map(s => `#${s.index}: ${s.score}分 (${s.reason})`).join(', ');
    this.logMsg(`LLM评分: ${scoreSummary}`, ctx, 'info', true);
    this.logMsg(`选择 #${best_index}: ${best_reason}`, ctx, 'info', true);

    const bestIdx = best_index - 1; // 转为0-based
    if (bestIdx >= 0 && bestIdx < outputs.length) {
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
  private async llmMergeDiff(outputs: WorkerOutput[], task: MainTask, ctx: LogContext): Promise<ArbitrationResult> {
    this.logMsg(`使用 LLM 差异合并仲裁`, ctx, 'info', true);

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
      this.logMsg(`LLM合并失败，回退到拼接输出: ${response.error}`, ctx, 'warn');
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

    this.logMsg(`LLM合并完成, 置信度: ${response.data.confidence}`, ctx, 'info', true);

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
   * 评审LLM同时负责：
   * 1. 从含系统日志的输出中识别实际执行结果
   * 2. 判断是否满足用户需求
   * 3. 返回提取后的干净输出（clean_output）
   *
   * 返回 LoopEvaluation，由 Master 根据置信度阈值判断是否继续循环
   */
  async evaluateLoopResult(
    task: MainTask,
    arbitrationResult: ArbitrationResult,
    roundNumber: number,
    logCtx?: LogContext
  ): Promise<LoopEvaluation> {
    const ctx = logCtx || {};
    const llm = getLLMClient();

    const outputData = typeof arbitrationResult.finalOutput === 'string'
      ? arbitrationResult.finalOutput
      : JSON.stringify(arbitrationResult.finalOutput, null, 2);

    const arbConfidence = arbitrationResult.confidence ?? 0.5;

    // 诊断日志
    this.logMsg(`[诊断] 循环评审输入: round=${roundNumber}, arbConfidence=${arbConfidence.toFixed(2)}, finalOutput长度=${outputData.length}, finalOutput:\n${outputData}`, ctx);

    const systemPrompt = `你是一位严格的项目验收专家。请根据以下信息判断执行结果是否满足用户需求。

注意：执行结果中可能包含系统日志（时间戳、初始化信息、工具调用记录等噪音），你需要忽略这些系统日志，只关注实际的执行结果内容来判断是否满足用户需求。

你需要综合评估：
1. 实际执行结果是否准确回答了用户的原始需求（忽略系统日志）
2. 是否满足用户指定的交付标准
3. 结果的完整性和可用性
4. 仲裁引擎的置信度参考值: ${arbConfidence.toFixed(2)}

请返回JSON格式：
{
  "satisfied": true/false,
  "confidence": 0.0-1.0,
  "reason": "不满足的具体原因（如满足则为空）",
  "suggestions": "下轮修正建议（如满足则为空）",
  "clean_output": "当satisfied为true时，从执行结果中提取的干净内容（去除系统日志等噪音，只保留有意义的执行结果）；当satisfied为false时留空"
}

注意：
- satisfied 为 true 时 confidence 应 >= 0.7
- confidence 体现你对结果满足需求的把握程度
- 如果能提取出有意义的干净输出，说明结果实质性地满足了需求，应设 satisfied 为 true
- 只有结果明显偏离用户需求或存在严重遗漏时，才设 satisfied 为 false
- clean_output 仅在 satisfied 为 true 时填写，用于返回给用户`;

    const userPrompt = `## 用户原始需求
${task.userRequest}

## 交付标准
${task.deliveryStandards.length > 0 ? task.deliveryStandards.join('\n') : '无明确交付标准'}

## 当前执行结果（第 ${roundNumber} 轮，可能含系统日志）
${outputData}

## 仲裁决策说明
${arbitrationResult.arbitrationReason || '无'}

请忽略系统日志噪音，根据实际执行结果判断是否满足用户需求，并提取干净输出。`;

    try {
      const response = await llm.askForJSON<{
        satisfied: boolean;
        confidence: number;
        reason: string;
        suggestions: string;
        clean_output?: string;
      }>(userPrompt, { systemPrompt, temperature: 0.3 });

      if (!response.success || !response.data) {
        this.logMsg(`循环评审LLM调用失败: ${response.error}，使用仲裁置信度判断`, ctx, 'warn');
        const arbConfidence = arbitrationResult.confidence ?? 0.5;
        return {
          satisfied: arbConfidence >= 0.8,
          confidence: arbConfidence,
          reason: arbConfidence < 0.8 ? '仲裁置信度不足' : '',
          suggestions: arbConfidence < 0.8 ? '请优化执行策略，提高输出质量' : '',
          roundNumber,
          finalOutput: arbitrationResult.finalOutput,
        };
      }

      const { satisfied, confidence, reason, suggestions, clean_output } = response.data;

      // 使用LLM提取的干净输出，兜底用原始输出
      const finalCleanOutput = clean_output && clean_output.trim().length > 0
        ? clean_output
        : arbitrationResult.finalOutput;

      // 诊断日志
      this.logMsg(`[诊断] 循环评审结果 (第${roundNumber}轮): satisfied=${satisfied}, confidence=${confidence.toFixed(2)}, reason="${reason}", clean_output长度=${clean_output?.length ?? 'N/A'}`, ctx);
      return {
        satisfied,
        confidence,
        reason: reason || '',
        suggestions: suggestions || '',
        roundNumber,
        finalOutput: finalCleanOutput,
      };
    } catch (error) {
      this.logMsg(`循环评审异常: ${error}`, ctx, 'error');
      const arbConfidence = arbitrationResult.confidence ?? 0.5;
      return {
        satisfied: arbConfidence >= 0.8,
        confidence: arbConfidence,
        reason: '评审异常，使用仲裁置信度降级判断',
        suggestions: '',
        roundNumber,
        finalOutput: arbitrationResult.finalOutput,
      };
    }
  }
}
