/**
 * Claude Agent SDK 客户端
 * 使用 Claude Agent SDK 执行命令，支持 MCP 协作工具
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as dotenv from 'dotenv';
import * as path from 'path';
import { log, LOG_DIR } from '../utils/logger';
import { ClaudeLink } from '../../scheduler/src/claude-link';
import { PermissionMode } from '../../scheduler/src/types';
import { permissionBus } from '../../scheduler/src/permission-bus';
import { z } from "zod";

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export class ClaudeSDKClient {
  private model: string;
  private workerId: string;
  private claudeLink: ClaudeLink;
  private permissionMode: PermissionMode;

  constructor(workerId: string = 'unknown-worker') {
    this.model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
    this.workerId = workerId;
    this.permissionMode = PermissionMode.ASK;
    this.claudeLink = ClaudeLink.getInstance();
    log({ logFile: undefined, message: `[ClaudeSDKClient] Worker: ${workerId}, 使用模型: ${this.model}, 权限模式: ${this.permissionMode}`, silent: true });
  }

  public setWorkerId(workerId: string): void {
    this.workerId = workerId;
  }

  public setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /**
   * 将 PermissionMode 映射为 Claude Agent SDK 的 permissionMode 参数
   */
  private getSdkPermissionMode(): string {
    switch (this.permissionMode) {
      case PermissionMode.AUTO:
        return 'acceptEdits';     // 自动接受文件编辑，仅命令需审批
      case PermissionMode.ASK:
        return 'default';         // 每个写入/执行操作需审批
      case PermissionMode.BYPASS:
        return 'bypassPermissions'; // 跳过所有权限检查
      default:
        return 'default';
    }
  }

  private createCollaborationMcpServer() {
    const self = this;

    return createSdkMcpServer({
      name: "worker-collaboration",
      version: "1.0.0",
      tools: [
        tool(
          "send_to",
          "向指定的 Worker 发送私信消息",
          {
            worker_id: z.string().describe("目标 Worker 的 ID"),
            message: z.string().describe("消息内容")
          },
          async (args) => {
            const { worker_id, message } = args;
            log({ logFile: undefined, message: `[协作] ${self.workerId} -> ${worker_id}: ${message}` });
            await self.claudeLink.sendMessage(self.workerId, worker_id, message);
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
          "向指定的 Worker 发送紧急消息，目标 Worker 应尽快处理",
          {
            worker_id: z.string().describe("目标 Worker 的 ID"),
            message: z.string().describe("消息内容")
          },
          async (args) => {
            const { worker_id, message } = args;
            log({ logFile: undefined, message: `[协作] ${self.workerId} -> ${worker_id} (紧急): ${message}` });
            await self.claudeLink.sendMessage(self.workerId, worker_id, `[紧急] ${message}`);
            return {
              content: [{
                type: "text",
                text: `紧急消息已发送给 ${worker_id}`
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
            await self.claudeLink.broadcast(self.workerId, message);
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
            await self.claudeLink.sendMessage(self.workerId, worker_id, `[请求帮助] ${task_description}`);
            return {
              content: [{
                type: "text",
                text: `已向 ${worker_id} 发送帮助请求`
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
        "mcp__worker-collaboration__ask_help"
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

      const sdkPermissionMode = this.getSdkPermissionMode();
      const isBypass = this.permissionMode === PermissionMode.BYPASS;

      // ---- 权限审批桥接 ----
      // 当 SDK 需要审批时，通过 __PERM_REQ__: 日志行发送到 Rust 前端
      // 前端用户审批后，通过 __PERM_RESP__: stdin 写回，resolve pendingPermPromise
      let pendingPermResolver: ((decision: any) => void) | null = null;
      const permTimeoutMs = parseInt(process.env.PERMISSION_TIMEOUT_MS || '120000', 10);

      /** 等待前端权限审批响应 */
      function waitForPermissionResponse(requestId: string): Promise<any> {
        return new Promise((resolve, reject) => {
          pendingPermResolver = resolve;
          const timeout = setTimeout(() => {
            if (pendingPermResolver === resolve) {
              pendingPermResolver = null;
              permissionBus.removeListener('resolve', onResolve);
              reject(new Error('权限审批超时'));
            }
          }, permTimeoutMs);
          // 清理 timeout 在 resolve 时
          const originalResolve = resolve;
          const onResolve = (decision: any) => {
            clearTimeout(timeout);
            if (pendingPermResolver === originalResolve) {
              pendingPermResolver = null;
              originalResolve(decision);
            }
          };
          pendingPermResolver = onResolve;
          permissionBus.once('resolve', onResolve);
        });
      }

      const queryStream = query({
        prompt: generateMessages(),
        options: {
          cwd: process.cwd(),
          allowedTools,
          mcpServers: {
            "worker-collaboration": collaborationServer
          },
          permissionMode: sdkPermissionMode,
          allowDangerouslySkipPermissions: isBypass,
          model: this.model,
          maxTurns: 50,
          includePartialMessages: true,
          hooks: {
            // PermissionRequest hook: 桥接到前端审批
            PermissionRequest: [{
              hooks: [async (input: any) => {
                const toolName = input.tool_name || 'unknown';
                const toolInput = input.tool_input || {};
                const suggestions = input.permission_suggestions || [];
                const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                // 通过 __PERM_REQ__: 日志行发送到 Rust → 前端
                log({
                  logFile,
                  message: `__PERM_REQ__:${JSON.stringify({
                    request_id: requestId,
                    worker_id: self.workerId,
                    tool_name: toolName,
                    tool_input: toolInput,
                    permission_suggestions: suggestions,
                  })}`,
                  sessionId,
                  silent: false
                });

                try {
                  // 等待前端审批响应
                  const decision = await waitForPermissionResponse(requestId);
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PermissionRequest' as const,
                      decision
                    }
                  };
                } catch (e) {
                  // 超时或错误，默认拒绝
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PermissionRequest' as const,
                      decision: { behavior: 'deny' as const, message: '审批超时，默认拒绝' }
                    }
                  };
                }
              }]
            }],
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
              log({ logFile, message: toolInfo, sessionId, silent: true });
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

/**
 * 创建新的 ClaudeSDKClient 实例
 * 每个 Worker 应拥有独立实例，避免并发时 workerId/permissionMode 相互覆盖
 */
export function createSDKClient(workerId: string = 'unknown-worker'): ClaudeSDKClient {
  return new ClaudeSDKClient(workerId);
}
