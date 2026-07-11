import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { Message, MessageStatus, MessagePriority, WorkerStatusInfo } from "./types";
import { v4 as uuidv4 } from "uuid";

export class MessageDB {
  private db: ReturnType<typeof Database>;

  constructor(dbPath?: string) {
    const defaultPath = path.join(process.env.APP_DATA_DIR || process.env.HOME || process.cwd(), ".opencolony", "messages.db");
    const finalPath = dbPath || defaultPath;

    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(finalPath, {
      verbose: console.log,
      timeout: 5000
    });

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_worker_id TEXT NOT NULL,
        to_worker_id TEXT NOT NULL,
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending',
        context TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at DATETIME,
        received_at DATETIME,
        processed_at DATETIME,
        ttl INTEGER DEFAULT 3600,
        retry_count INTEGER DEFAULT 0
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_to_worker_id ON messages(to_worker_id);
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `);
  }

  insertMessage(message: Message): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, from_worker_id, to_worker_id, content, priority, status,
        context, created_at, sent_at, received_at, processed_at, ttl, retry_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      message.fromWorkerId,
      message.toWorkerId,
      message.content,
      message.priority,
      message.status,
      message.context ? JSON.stringify(message.context) : null,
      message.createdAt.toISOString(),
      message.sentAt?.toISOString() || null,
      message.receivedAt?.toISOString() || null,
      message.processedAt?.toISOString() || null,
      message.ttl || 3600,
      message.retryCount || 0
    );
  }

  getMessagesByWorkerId(workerId: string, status?: MessageStatus): Message[] {
    let query = `SELECT * FROM messages WHERE to_worker_id = ?`;
    const params: any[] = [workerId];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(this.rowToMessage);
  }

  getPendingMessages(workerId: string): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages 
      WHERE to_worker_id = ? 
        AND status = 'pending'
        AND (ttl IS NULL OR strftime('%s', 'now') - strftime('%s', created_at) < ttl)
      ORDER BY priority DESC, created_at ASC
    `);

    const rows = stmt.all(workerId) as any[];
    return rows.map(this.rowToMessage);
  }

  updateMessageStatus(messageId: string, status: MessageStatus): void {
    const now = new Date();
    const stmt = this.db.prepare(`
      UPDATE messages 
      SET status = ?, 
          ${status === MessageStatus.SENT ? 'sent_at' : status === MessageStatus.RECEIVED ? 'received_at' : 'processed_at'} = ?
      WHERE id = ?
    `);
    stmt.run(status, now.toISOString(), messageId);
  }

  deleteMessage(messageId: string): void {
    const stmt = this.db.prepare(`DELETE FROM messages WHERE id = ?`);
    stmt.run(messageId);
  }

  cleanupExpiredMessages(retentionDays: number = 7): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const stmt = this.db.prepare(`
      DELETE FROM messages 
      WHERE created_at < ?
    `);
    stmt.run(cutoffDate.toISOString());
  }

  getAllMessages(): Message[] {
    const stmt = this.db.prepare(`SELECT * FROM messages ORDER BY created_at DESC`);
    const rows = stmt.all() as any[];
    return rows.map(this.rowToMessage);
  }

  getMessageById(messageId: string): Message | undefined {
    const stmt = this.db.prepare(`SELECT * FROM messages WHERE id = ?`);
    const row = stmt.get(messageId) as any;
    return row ? this.rowToMessage(row) : undefined;
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      fromWorkerId: row.from_worker_id,
      toWorkerId: row.to_worker_id,
      content: row.content,
      priority: row.priority as MessagePriority,
      status: row.status as MessageStatus,
      context: row.context ? JSON.parse(row.context) : undefined,
      createdAt: new Date(row.created_at),
      sentAt: row.sent_at ? new Date(row.sent_at) : undefined,
      receivedAt: row.received_at ? new Date(row.received_at) : undefined,
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
      ttl: row.ttl,
      retryCount: row.retry_count
    };
  }

  close(): void {
    this.db.close();
  }
}