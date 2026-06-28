/**
 * LLM客户端
 * 封装Anthropic API调用，提供统一的LLM接口
 */

import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

// 加载环境变量
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  success: boolean;
  content?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class LLMClient {
  private client: Anthropic;
  private model: string;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    this.model = process.env.ANTHROPIC_MODEL ||
                 'claude-3-5-sonnet-20241022';

    if (!apiKey) {
      throw new Error(
        '[LLMClient] 未设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN，请检查 .env 文件'
      );
    }

    console.log(`[LLMClient] 使用API端点: ${baseURL || '默认Anthropic API'}`);
    console.log(`[LLMClient] 使用模型: ${this.model}`);
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || undefined
    });
  }

  /**
   * 发送消息到LLM
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<LLMResponse> {
    const {
      systemPrompt = '你是一个有用的AI助手。',
      maxTokens = 4096,
      temperature = 0.7
    } = options || {};

    try {
      console.log(`[LLMClient] 调用LLM，模型: ${this.model}`);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      });

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      console.log(`[LLMClient] LLM调用成功，输入: ${response.usage?.input_tokens} tokens，输出: ${response.usage?.output_tokens} tokens`);

      return {
        success: true,
        content,
        usage: {
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0
        }
      };
    } catch (error) {
      console.error(`[LLMClient] LLM调用失败:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 发送单次消息（简化接口）
   */
  async ask(
    userPrompt: string,
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<LLMResponse> {
    return this.sendMessage([{ role: 'user', content: userPrompt }], options);
  }

  /**
   * 提取JSON格式的输出
   */
  async askForJSON<T>(
    userPrompt: string,
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const response = await this.ask(userPrompt, options);

    if (!response.success || !response.content) {
      return { success: false, error: response.error };
    }

    // 尝试从markdown代码块中提取JSON
    const content = response.content;
    let jsonStr = content;

    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    try {
      const data = JSON.parse(jsonStr) as T;
      return { success: true, data };
    } catch (error) {
      console.error(`[LLMClient] JSON解析失败:`, error);
      console.error(`[LLMClient] 原始内容:`, jsonStr);
      return {
        success: false,
        error: `JSON解析失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

// 导出单例
let llmClientInstance: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClientInstance) {
    llmClientInstance = new LLMClient();
  }
  return llmClientInstance;
}
