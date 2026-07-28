import { EventEmitter } from "events";
import { Message, MessageStatus, ClaudeLinkConfig, WorkerStatusInfo, WorkerInstance } from "./types";
import { MessageDB } from "./message-db";
import { v4 as uuidv4 } from "uuid";
import { log } from "./logger";

export class ClaudeLink extends EventEmitter {
  private db: MessageDB;
  private workers: Map<string, WorkerInstance> = new Map();
  private config: ClaudeLinkConfig;
  private static instance: ClaudeLink | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(config?: ClaudeLinkConfig) {
    super();
    this.config = {
      dbPath: config?.dbPath,
      messageRetentionDays: config?.messageRetentionDays || 7,
      sendRateLimitMs: config?.sendRateLimitMs || 100
    };

    this.db = new MessageDB(this.config.dbPath);

    this.cleanupTimer = setInterval(() => {
      try {
        this.db.cleanupExpiredMessages(this.config.messageRetentionDays);
      } catch (error) {
        log({ prefix: 'ClaudeLink', message: `清理过期消息失败: ${error}`, level: 'error' });
      }
    }, 60000);
  }

  public static getInstance(config?: ClaudeLinkConfig): ClaudeLink {
    if (!ClaudeLink.instance) {
      ClaudeLink.instance = new ClaudeLink(config);
    }
    return ClaudeLink.instance;
  }

  public registerWorker(worker: WorkerInstance): void {
    this.workers.set(worker.id, worker);
    log({ prefix: 'ClaudeLink', message: `Worker 注册成功: ${worker.id} (类型: ${worker.type})` });
    this.emit("workerRegistered", worker);
  }

  public unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
    log({ prefix: 'ClaudeLink', message: `Worker 已注销: ${workerId}` });
    this.emit("workerUnregistered", workerId);
  }

  public getWorker(workerId: string): WorkerInstance | undefined {
    return this.workers.get(workerId);
  }

  public getAllWorkers(): WorkerInstance[] {
    return Array.from(this.workers.values());
  }

  public getWorkerStatus(workerId: string): WorkerStatusInfo | undefined {
    const worker = this.workers.get(workerId);
    if (!worker) return undefined;

    return {
      workerId: worker.id,
      type: worker.type,
      status: worker.status,
      currentTaskId: worker.currentTaskId,
      lastActiveAt: worker.lastUsedAt
    };
  }

  public getAllWorkerStatus(): WorkerStatusInfo[] {
    return Array.from(this.workers.values()).map(worker => ({
      workerId: worker.id,
      type: worker.type,
      status: worker.status,
      currentTaskId: worker.currentTaskId,
      lastActiveAt: worker.lastUsedAt
    }));
  }

  public async sendMessage(
    fromWorkerId: string,
    toWorkerId: string,
    content: string,
    context?: Record<string, any>
  ): Promise<Message> {
    const message: Message = {
      id: uuidv4(),
      fromWorkerId,
      toWorkerId,
      content,
      status: MessageStatus.PENDING,
      context,
      createdAt: new Date(),
      ttl: 3600
    };

    this.db.insertMessage(message);
    log({ prefix: 'ClaudeLink', message: `消息发送: ${fromWorkerId} -> ${toWorkerId}` });

    this.emit(`message:${toWorkerId}`, message);

    return message;
  }

  public async broadcast(
    fromWorkerId: string,
    content: string,
    context?: Record<string, any>
  ): Promise<Message[]> {
    const messages: Message[] = [];

    for (const workerId of this.workers.keys()) {
      if (workerId !== fromWorkerId) {
        const message = await this.sendMessage(fromWorkerId, workerId, content, context);
        messages.push(message);
      }
    }

    log({ prefix: 'ClaudeLink', message: `广播消息: ${fromWorkerId} -> ${messages.length} 个Worker` });
    this.emit("broadcast", { fromWorkerId, content, messages });

    return messages;
  }

  public checkInbox(workerId: string): Message[] {
    const messages = this.db.getPendingMessages(workerId);
    log({ prefix: 'ClaudeLink', message: `Worker ${workerId} 收件箱有 ${messages.length} 条消息`, silent: true });
    return messages;
  }

  public markAsReceived(messageIds: string[]): void {
    for (const messageId of messageIds) {
      this.db.updateMessageStatus(messageId, MessageStatus.RECEIVED);
    }
    log({ prefix: 'ClaudeLink', message: `${messageIds.length} 条消息标记为已接收` });
  }

  public markAsProcessed(messageIds: string[]): void {
    for (const messageId of messageIds) {
      this.db.updateMessageStatus(messageId, MessageStatus.PROCESSED);
    }
    log({ prefix: 'ClaudeLink', message: `${messageIds.length} 条消息标记为已处理` });
  }

  public onMessage(workerId: string, callback: (message: Message) => void): void {
    this.on(`message:${workerId}`, callback);
  }

  public removeMessageListener(workerId: string): void {
    this.removeAllListeners(`message:${workerId}`);
  }

  public shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.removeAllListeners();
    this.db.close();
    this.workers.clear();
    ClaudeLink.instance = null;
    log({ prefix: 'ClaudeLink', message: "通信总线已关闭" });
  }
}