/**
 * Claude Agent SDK 客户端
 * 使用 Claude Agent SDK 执行命令
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as dotenv from 'dotenv';
import * as path from 'path';
import { log, LOG_DIR } from '../utils/logger';

// 加载环境变量（SDK 模式需要）
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export class ClaudeSDKClient {
  private model: string;

  constructor() {
    this.model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
    log({ logFile: undefined, message: `[ClaudeSDKClient] 使用模型: ${this.model}` });
  }

  /**
   * 执行命令并保存日志
   */
  async executeCommand(
    command: string,
    sessionId: number,
    logFile: string
  ): Promise<void> {
    log({ logFile, message: `使用 Claude Agent SDK 执行命令`, sessionId, silent: false });
    log({ logFile, message: `执行命令: ${command}`, sessionId, silent: false });

    try {
      let fullResponse = '';
      let assistantMessages: string[] = [];  // 保存 assistant 消息的内容

      // 使用 query() 函数执行命令
      const queryStream = query({
        prompt: command,
        options: {
          cwd: process.cwd(),
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          model: this.model,
          maxTurns: 50,  // 增加最大轮次
          includePartialMessages: true,  // 包含部分消息
        }
      });

      // 添加超时处理
      const messagesPromise = (async () => {
        for await (const message of queryStream) {
          const msgType = (message as any).type || 'unknown';

          // 处理最终结果
          if (msgType === 'result') {
            const resultMsg = message as any;

            if (resultMsg.subtype === 'success' && resultMsg.result) {
              fullResponse = resultMsg.result;
            } else {
              // 处理错误结果
              const errorReason = resultMsg.subtype || 'unknown';
              log({ logFile, message: `执行未完成: ${errorReason}`, silent: false });

              // 使用缓冲的 assistant 消息作为部分结果
              if (assistantMessages.length > 0) {
                fullResponse = assistantMessages.join('');
              }
            }
          } else if (msgType === 'assistant') {
            // 提取并打印 assistant 消息的内容
            const assistantMsg = message as any;
            if (assistantMsg.message && assistantMsg.message.content) {
              const content = assistantMsg.message.content;

              // 打印文本内容
              const textContent = content
                .filter((block: any) => block.type === 'text')
                .map((block: any) => block.text)
                .join('');
              if (textContent) {
                assistantMessages.push(textContent);
                log({ logFile, message: `[Assistant] ${textContent}`, sessionId, silent: false });
              }

              // 打印工具使用
              const toolUses = content.filter((block: any) => block.type === 'tool_use');
              for (const toolUse of toolUses) {
                const toolInfo = `[tool_use] 使用工具:${toolUse.id}，${toolUse.name}:${JSON.stringify(toolUse.input)}`;
                log({ logFile, message: toolInfo, sessionId, silent: false });
              }
            }
          }
        }
        log({ logFile, message: '', silent: true });
      })();

      await messagesPromise;

      if (fullResponse) {
        log({ logFile, message: '执行完成', sessionId, silent: false });
      } else {
        log({ logFile, message: '警告: 未收到有效响应', sessionId, level: 'warn' });
      }

    } catch (error) {
      const errorTimestamp = new Date().toISOString();
      const errorMsg = error instanceof Error ? error.message : String(error);
      log({ logFile, message: `[错误] ${errorMsg}`, sessionId, silent: false, level: 'error' });
      throw error;
    }

  }
}

// 导出单例
let sdkClientInstance: ClaudeSDKClient | null = null;

export function getSDKClient(): ClaudeSDKClient {
  if (!sdkClientInstance) {
    sdkClientInstance = new ClaudeSDKClient();
  }
  return sdkClientInstance;
}
