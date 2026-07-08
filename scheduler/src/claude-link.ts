import { EventEmitter } from "events";
import { Message, MessagePriority, MessageStatus, ClaudeLinkConfig, WorkerStatusInfo, WorkerInstance } from "./types";
import { MessageDB } from "./message-db";
import { v4 as uuidv4 } from "uuid";
import { log } from "./logger";

export class ClaudeLink extends EventEmitter {
  private db: MessageDB;
  private workers: Map<string, WorkerInstance> = new Map();
  private config: ClaudeLinkConfig;
  private static instance: ClaudeLink | null = null;

  private constructor(config?: ClaudeLinkConfig) {
    super();
    this.config = {
      dbPath: config?.dbPath,
      messageRetentionDays: config?.messageRetentionDays || 7,
      sendRateLimitMs: config?.sendRateLimitMs || 100
    };

    this.db = new MessageDB(this.config.dbPath);

    setInterval(() => {
      this.db.cleanupExpiredMessages(this.config.messageRetentionDays);
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
    log({ message: `[ClaudeLink] Worker 注册成功: ${worker.id} (类型: ${worker.type})` });
    this.emit("workerRegistered", worker);
  }

  public unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
    log({ message: `[ClaudeLink] Worker 已注销: ${workerId}` });
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
    priority: MessagePriority = MessagePriority.NORMAL,
    context?: Record<string, any>
  ): Promise<Message> {
    const message: Message = {
      id: uuidv4(),
      fromWorkerId,
      toWorkerId,
      content,
      priority,
      status: MessageStatus.PENDING,
      context,
      createdAt: new Date(),
      ttl: priority === MessagePriority.HIGH ? 300 : priority === MessagePriority.NORMAL ? 3600 : 86400
    };

    this.db.insertMessage(message);
    log({ message: `[ClaudeLink] 消息发送: ${fromWorkerId} -> ${toWorkerId} (优先级: ${priority})` });

    this.emit(`message:${toWorkerId}`, message);

    if (priority === MessagePriority.HIGH) {
      this.emit(`highPriorityMessage:${toWorkerId}`, message);
    }

    return message;
  }

  public async broadcast(
    fromWorkerId: string,
    content: string,
    priority: MessagePriority = MessagePriority.NORMAL,
    context?: Record<string, any>
  ): Promise<Message[]> {
    const messages: Message[] = [];

    for (const workerId of this.workers.keys()) {
      if (workerId !== fromWorkerId) {
        const message = await this.sendMessage(fromWorkerId, workerId, content, priority, context);
        messages.push(message);
      }
    }

    log({ message: `[ClaudeLink] 广播消息: ${fromWorkerId} -> ${messages.length} 个Worker` });
    this.emit("broadcast", { fromWorkerId, content, messages });

    return messages;
  }

  public checkInbox(workerId: string): Message[] {
    const messages = this.db.getPendingMessages(workerId);
    log({ message: `[ClaudeLink] Worker ${workerId} 收件箱有 ${messages.length} 条消息` });
    return messages;
  }

  public markAsReceived(messageIds: string[]): void {
    for (const messageId of messageIds) {
      this.db.updateMessageStatus(messageId, MessageStatus.RECEIVED);
    }
    log({ message: `[ClaudeLink] ${messageIds.length} 条消息标记为已接收` });
  }

  public markAsProcessed(messageIds: string[]): void {
    for (const messageId of messageIds) {
      this.db.updateMessageStatus(messageId, MessageStatus.PROCESSED);
    }
    log({ message: `[ClaudeLink] ${messageIds.length} 条消息标记为已处理` });
  }

  public onMessage(workerId: string, callback: (message: Message) => void): void {
    this.on(`message:${workerId}`, callback);
  }

  public onHighPriorityMessage(workerId: string, callback: (message: Message) => void): void {
    this.on(`highPriorityMessage:${workerId}`, callback);
  }

  public removeMessageListener(workerId: string): void {
    this.removeAllListeners(`message:${workerId}`);
    this.removeAllListeners(`highPriorityMessage:${workerId}`);
  }

  public shutdown(): void {
    this.removeAllListeners();
    this.db.close();
    this.workers.clear();
    log({ message: "[ClaudeLink] 通信总线已关闭" });
  }
}