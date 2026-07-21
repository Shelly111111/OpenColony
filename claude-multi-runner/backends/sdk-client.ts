/**
 * Claude Agent SDK 客户端
 * 使用 Claude Agent SDK 执行命令，支持 MCP 协作工具
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as dotenv from 'dotenv';
import * as path from 'path';
import { log, LOG_DIR } from '../utils/logger';
import { ClaudeLink } from '../../scheduler/src/claude-link';
import { MessagePriority } from '../../scheduler/src/types';
import { z } from "zod";

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export class ClaudeSDKClient {
  private model: string;
  private workerId: string;
  private claudeLink: ClaudeLink;

  constructor(workerId: string = 'unknown-worker') {
    this.model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
    this.workerId = workerId;
    this.claudeLink = ClaudeLink.getInstance();
    log({ logFile: undefined, message: `[ClaudeSDKClient] Worker: ${workerId}, 使用模型: ${this.model}` });
  }

  public setWorkerId(workerId: string): void {
    this.workerId = workerId;
  }

  private createCollaborationMcpServer() {
    const self = this;

    return createSdkMcpServer({
      name: "worker-collaboration",
      version: "1.0.0",
      tools: [
        tool(
          "send_to",
          "向指定的 Worker 发送普通优先级的私信消息",
          {
            worker_id: z.string().describe("目标 Worker 的 ID"),
            message: z.string().describe("消息内容")
          },
          async (args) => {
            const { worker_id, message } = args;
            log({ logFile: undefined, message: `[协作] ${self.workerId} -> ${worker_id}: ${message}` });
            await self.claudeLink.sendMessage(self.workerId, worker_id, message, MessagePriority.NORMAL);
            return {
              content: [{
                type: "text",
                text: `消息已发送给 ${worker_id}`
              }]
            };
          }
        ),

        tool(
          "send_to_high",
          "向指定的 Worker 发送高优先级消息，目标 Worker 会立即暂停并处理",
          {
            worker_id: z.string().describe("目标 Worker 的 ID"),
            message: z.string().describe("消息内容")
          },
          async (args) => {
            const { worker_id, message } = args;
            log({ logFile: undefined, message: `[协作] ${self.workerId} -> ${worker_id} (高优先级): ${message}` });
            await self.claudeLink.sendMessage(self.workerId, worker_id, message, MessagePriority.HIGH);
            return {
              content: [{
                type: "text",
                text: `高优先级消息已发送给 ${worker_id}`
              }]
            };
          }
        ),

        tool(
          "broadcast",
          "向同层所有其他 Worker 广播消息",
          {
            message: z.string().describe("广播消息内容")
          },
          async (args) => {
            const { message } = args;
            log({ logFile: undefined, message: `[协作] ${self.workerId} 广播: ${message}` });
            await self.claudeLink.broadcast(self.workerId, message, MessagePriority.NORMAL);
            return {
              content: [{
                type: "text",
                text: `消息已广播给所有同层 Worker`
              }]
            };
          }
        ),

        tool(
          "ask_help",
          "向指定的 Worker 请求协作帮助",
          {
            worker_id: z.string().describe("目标 Worker 的 ID"),
            task_description: z.string().describe("需要帮助的任务描述")
          },
          async (args) => {
            const { worker_id, task_description } = args;
            log({ logFile: undefined, message: `[协作] ${self.workerId} 请求 ${worker_id} 帮助: ${task_description}` });
            await self.claudeLink.sendMessage(self.workerId, worker_id, `[请求帮助] ${task_description}`, MessagePriority.NORMAL);
            return {
              content: [{
                type: "text",
                text: `已向 ${worker_id} 发送帮助请求`
              }]
            };
          }
        ),

        tool(
          "check_inbox",
          "检查收件箱，获取其他 Worker 发送给自己的未处理消息",
          {},
          async () => {
            const messages = self.claudeLink.checkInbox(self.workerId);
            self.claudeLink.markAsReceived(messages.map(m => m.id));
            if (messages.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: "收件箱为空"
                }]
              };
            }
            const messagesText = messages.map(msg =>
              `[${msg.fromWorkerId}] ${msg.content} (优先级: ${msg.priority})`
            ).join('\n');
            return {
              content: [{
                type: "text",
                text: `收到 ${messages.length} 条消息:\n${messagesText}`
              }]
            };
          }
        )
      ]
    });
  }

  async executeCommand(
    command: string,
    sessionId: number,
    logFile: string
  ): Promise<void> {
    log({ logFile, message: `使用 Claude Agent SDK 执行命令`, sessionId, silent: false });
    log({ logFile, message: `执行命令: ${command}`, sessionId, silent: false });

    try {
      let fullResponse = '';
      let assistantMessages: string[] = [];

      const pendingMessages = this.claudeLink.checkInbox(this.workerId);
      if (pendingMessages.length > 0) {
        const messagesText = pendingMessages.map(msg =>
          `[来自 ${msg.fromWorkerId}] ${msg.content}`
        ).join('\n');
        command = `## 收到的消息\n${messagesText}\n\n---\n\n${command}`;
        this.claudeLink.markAsReceived(pendingMessages.map(m => m.id));
        log({ logFile, message: `[协作] 注入 ${pendingMessages.length} 条待处理消息`, sessionId });
      }

      const collaborationServer = this.createCollaborationMcpServer();

      const allowedTools = [
        "Read", "Write", "Edit", "Bash", "Glob", "Grep",
        "mcp__worker-collaboration__send_to",
        "mcp__worker-collaboration__send_to_high",
        "mcp__worker-collaboration__broadcast",
        "mcp__worker-collaboration__ask_help",
        "mcp__worker-collaboration__check_inbox"
      ];

      const self = this;

      // ---- 轮询 + Stop hook 退出标记 ----
      // generator 轮询收件箱注入补充信息
      // Stop hook 在 Agent 退出时设置标记，让 generator 也退出，防止进程挂起
      let shouldStop = false;
      let wakeResolver: (() => void) | null = null;

      /** 等待唤醒或超时，timer.unref() 不阻止进程退出 */
      function waitForWakeOrTimeout(ms: number): Promise<void> {
        return new Promise(resolve => {
          const timer = setTimeout(resolve, ms);
          timer.unref();
          wakeResolver = () => { clearTimeout(timer); resolve(); };
        });
      }

      /** 检查收件箱并格式化补充信息 */
      function checkInboxAndFormat(): string | null {
        const msgs = self.claudeLink.checkInbox(self.workerId);
        if (msgs.length === 0) return null;

        self.claudeLink.markAsReceived(msgs.map(m => m.id));
        log({ logFile, message: `[协作] 检查到 ${msgs.length} 条补充信息`, sessionId });

        return msgs.map(msg => {
          const ctx = msg.context as any;
          const isSupplementary = ctx?.type === 'supplementary_info';
          const prefix = isSupplementary ? '📤 [补充信息]' : '📨 [消息]';
          const fromLabel = msg.fromWorkerId === 'master' ? 'Master' : msg.fromWorkerId;
          return `${prefix} 来自 ${fromLabel}: ${msg.content}`;
        }).join('\n\n');
      }

      /** Generator: yield 初始命令，然后轮询收件箱注入补充信息 */
      async function* generateMessages() {
        // 1. yield 初始命令
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: command },
          parent_tool_use_id: null as null,
          session_id: `session-${sessionId}`
        };

        // 2. 轮询收件箱，有补充信息则 yield 为新的 user message
        while (!shouldStop) {
          await waitForWakeOrTimeout(2000);
          if (shouldStop) break;

          const inboxInfo = checkInboxAndFormat();
          if (inboxInfo) {
            yield {
              type: "user" as const,
              message: {
                role: "user" as const,
                content: `## 📥 收到新的补充信息\n\n${inboxInfo}\n\n---\n请根据以上补充信息调整你的执行策略。如果补充信息要求停止，请立即停止当前操作。`
              },
              parent_tool_use_id: null as null,
              session_id: `session-${sessionId}`
            };
          }
        }
      }

      const queryStream = query({
        prompt: generateMessages(),
        options: {
          cwd: process.cwd(),
          allowedTools,
          mcpServers: {
            "worker-collaboration": collaborationServer
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          model: this.model,
          maxTurns: 50,
          includePartialMessages: true,
          hooks: {
            // Stop hook: Agent 退出时设置跳出标记，让 generator 轮询也退出
            Stop: [{
              hooks: [async (_input: any) => {
                shouldStop = true;
                if (wakeResolver) { wakeResolver(); wakeResolver = null; }
                return { continue: true };
              }]
            }]
          }
        } as any,
      });

      for await (const message of queryStream) {
        const msgType = (message as any).type || 'unknown';

        if (msgType === 'result') {
          const resultMsg = message as any;
          if (resultMsg.subtype === 'success' && resultMsg.result) {
            fullResponse = resultMsg.result;
          } else {
            const errorReason = resultMsg.subtype || 'unknown';
            log({ logFile, message: `执行未完成: ${errorReason}`, silent: false });
            if (assistantMessages.length > 0) {
              fullResponse = assistantMessages.join('');
            }
          }
        } else if (msgType === 'assistant') {
          const assistantMsg = message as any;
          if (assistantMsg.message && assistantMsg.message.content) {
            const content = assistantMsg.message.content;

            const textContent = content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join('');
            if (textContent) {
              assistantMessages.push(textContent);
              log({ logFile, message: `[Assistant] ${textContent}`, sessionId, silent: false });
            }

            const toolUses = content.filter((block: any) => block.type === 'tool_use');
            for (const toolUse of toolUses) {
              const toolInfo = `[tool_use] 使用工具:${toolUse.id}，${toolUse.name}:${JSON.stringify(toolUse.input)}`;
              log({ logFile, message: toolInfo, sessionId, silent: false });
            }
          }
        }
      }
      log({ logFile, message: '', silent: true });

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

let sdkClientInstance: ClaudeSDKClient | null = null;

export function getSDKClient(workerId: string = 'unknown-worker'): ClaudeSDKClient {
  if (!sdkClientInstance) {
    sdkClientInstance = new ClaudeSDKClient(workerId);
  } else if (workerId !== 'unknown-worker') {
    sdkClientInstance.setWorkerId(workerId);
  }
  return sdkClientInstance;
}
