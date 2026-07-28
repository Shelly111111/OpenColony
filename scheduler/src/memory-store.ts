/**
 * 记忆存储层
 * 三层记忆检索架构：
 * - L1: 任务经验库（FTS5 全文搜索，新任务提交时检索相似历史）
 * - L2: 项目知识库（按 project_id 隔离，注入 Worker 上下文）
 * - L3: Worker 画像库（全局共享，影响角色选择权重）
 */

import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { log } from "./logger";

// ==================== 类型定义 ====================

export interface TaskExperience {
  id: string;
  projectId: string;
  userRequest: string;
  condensedRequest?: string;
  subTasksJson: string;
  dagLayers?: number;
  workerTypes?: string;
  status: "success" | "partial" | "fail";
  finalOutputSummary?: string;
  confidence?: number;
  durationSeconds?: number;
  traceId?: string;
  createdAt: string;
}

export interface ProjectKnowledge {
  id: string;
  projectId: string;
  category: "convention" | "tech_stack" | "structure" | "preference";
  title: string;
  content: string;
  source: "user_specified" | "auto_extracted";
  createdAt: string;
  updatedAt: string;
}

export interface WorkerProfile {
  id: string;
  workerType: string;
  totalTasks: number;
  successCount: number;
  avgConfidence: number;
  avgDurationSeconds: number;
  skillStats?: Record<string, { used: number; success: number }>;
  strongDomains?: string[];
  updatedAt: string;
}

export interface ExperienceSearchResult {
  experience: TaskExperience;
  relevanceScore: number;
}

// ==================== MemoryStore ====================

export class MemoryStore {
  private db: ReturnType<typeof Database>;

  constructor(dbPath?: string) {
    const defaultPath = path.join(
      process.env.APP_DATA_DIR || process.env.HOME || process.cwd(),
      ".opencolony",
      "memory.db"
    );
    const finalPath = dbPath || defaultPath;

    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(finalPath, { timeout: 5000 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.initTables();
    log({ prefix: "MemoryStore", message: `记忆数据库初始化完成: ${finalPath}` });
  }

  // ==================== 表初始化 ====================

  private initTables(): void {
    // L1: 任务经验库
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_experiences (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_request TEXT NOT NULL,
        condensed_request TEXT,
        sub_tasks_json TEXT NOT NULL,
        dag_layers INTEGER,
        worker_types TEXT,
        status TEXT NOT NULL,
        final_output_summary TEXT,
        confidence REAL,
        duration_seconds REAL,
        trace_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_te_project_id ON task_experiences(project_id);
      CREATE INDEX IF NOT EXISTS idx_te_status ON task_experiences(status);
      CREATE INDEX IF NOT EXISTS idx_te_created_at ON task_experiences(created_at);
    `);

    // L1: FTS5 全文搜索虚拟表
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS task_experiences_fts USING fts5(
        user_request,
        condensed_request,
        final_output_summary,
        content=task_experiences,
        content_rowid=rowid
      );
    `);

    // FTS5 同步触发器
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_experiences_ai AFTER INSERT ON task_experiences BEGIN
        INSERT INTO task_experiences_fts(rowid, user_request, condensed_request, final_output_summary)
        VALUES (new.rowid, new.user_request, new.condensed_request, new.final_output_summary);
      END;

      CREATE TRIGGER IF NOT EXISTS task_experiences_ad AFTER DELETE ON task_experiences BEGIN
        INSERT INTO task_experiences_fts(task_experiences_fts, rowid, user_request, condensed_request, final_output_summary)
        VALUES ('delete', old.rowid, old.user_request, old.condensed_request, old.final_output_summary);
      END;

      CREATE TRIGGER IF NOT EXISTS task_experiences_au AFTER UPDATE ON task_experiences BEGIN
        INSERT INTO task_experiences_fts(task_experiences_fts, rowid, user_request, condensed_request, final_output_summary)
        VALUES ('delete', old.rowid, old.user_request, old.condensed_request, old.final_output_summary);
        INSERT INTO task_experiences_fts(rowid, user_request, condensed_request, final_output_summary)
        VALUES (new.rowid, new.user_request, new.condensed_request, new.final_output_summary);
      END;
    `);

    // L2: 项目知识库
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user_specified',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_pk_project_id ON project_knowledge(project_id);
      CREATE INDEX IF NOT EXISTS idx_pk_category ON project_knowledge(category);
    `);

    // L2: FTS5 全文搜索虚拟表
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS project_knowledge_fts USING fts5(
        title,
        content,
        category,
        content=project_knowledge,
        content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS project_knowledge_ai AFTER INSERT ON project_knowledge BEGIN
        INSERT INTO project_knowledge_fts(rowid, title, content, category)
        VALUES (new.rowid, new.title, new.content, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS project_knowledge_ad AFTER DELETE ON project_knowledge BEGIN
        INSERT INTO project_knowledge_fts(project_knowledge_fts, rowid, title, content, category)
        VALUES ('delete', old.rowid, old.title, old.content, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS project_knowledge_au AFTER UPDATE ON project_knowledge BEGIN
        INSERT INTO project_knowledge_fts(project_knowledge_fts, rowid, title, content, category)
        VALUES ('delete', old.rowid, old.title, old.content, old.category);
        INSERT INTO project_knowledge_fts(rowid, title, content, category)
        VALUES (new.rowid, new.title, new.content, new.category);
      END;
    `);

    // L3: Worker 画像库（全局共享）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_profiles (
        id TEXT PRIMARY KEY,
        worker_type TEXT NOT NULL UNIQUE,
        total_tasks INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        avg_confidence REAL NOT NULL DEFAULT 0,
        avg_duration_seconds REAL NOT NULL DEFAULT 0,
        skill_stats TEXT,
        strong_domains TEXT,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_wp_worker_type ON worker_profiles(worker_type);
    `);
  }

  // ==================== L1: 任务经验库 ====================

  /**
   * 写入任务经验
   */
  insertTaskExperience(exp: Omit<TaskExperience, "id" | "createdAt">): string {
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO task_experiences (
        id, project_id, user_request, condensed_request, sub_tasks_json,
        dag_layers, worker_types, status, final_output_summary,
        confidence, duration_seconds, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      exp.projectId,
      exp.userRequest,
      exp.condensedRequest || null,
      exp.subTasksJson,
      exp.dagLayers || null,
      exp.workerTypes || null,
      exp.status,
      exp.finalOutputSummary || null,
      exp.confidence || null,
      exp.durationSeconds || null,
      exp.traceId || null
    );

    log({ prefix: "MemoryStore", message: `L1 任务经验已写入: ${id} (项目: ${exp.projectId}, 状态: ${exp.status})` });
    return id;
  }

  /**
   * FTS5 搜索相似任务经验
   * 返回按相关性排序的结果，限制 topN
   */
  searchSimilarExperiences(
    projectId: string,
    query: string,
    topN: number = 3
  ): ExperienceSearchResult[] {
    // FTS5 全文搜索，只搜当前项目 + 全局（project_id 为 __global__）
    const ftsQuery = query
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => `"${w}"`)
      .join(" OR ");

    if (!ftsQuery) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT
          te.*,
          te_fts.rank AS fts_rank
        FROM task_experiences te
        JOIN task_experiences_fts te_fts ON te.rowid = te_fts.rowid
        WHERE (te.project_id = ? OR te.project_id = '__global__')
          AND te_fts.task_experiences_fts MATCH ?
        ORDER BY te_fts.rank DESC
        LIMIT ?
      `);

      const rows = stmt.all(projectId, ftsQuery, topN) as any[];

      return rows.map(row => ({
        experience: this.rowToTaskExperience(row),
        relevanceScore: -row.fts_rank, // FTS5 rank 是负数，取反
      }));
    } catch (error) {
      // FTS5 可能对特殊字符报错，降级为关键词模糊搜索
      log({ prefix: "MemoryStore", message: `FTS5 搜索失败，降级为模糊搜索: ${error}`, level: "warn" });
      return this.fallbackSearchExperiences(projectId, query, topN);
    }
  }

  /**
   * 降级搜索：关键词模糊匹配
   */
  private fallbackSearchExperiences(
    projectId: string,
    query: string,
    topN: number
  ): ExperienceSearchResult[] {
    const keyword = `%${query.substring(0, 50)}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM task_experiences
      WHERE (project_id = ? OR project_id = '__global__')
        AND (user_request LIKE ? OR condensed_request LIKE ?)
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(projectId, keyword, keyword, topN) as any[];
    return rows.map(row => ({
      experience: this.rowToTaskExperience(row),
      relevanceScore: 0.5,
    }));
  }

  /**
   * 将任务经验复制到新项目（用于日志导入到新会话）
   */
  copyExperienceToProject(experienceId: string, targetProjectId: string): string {
    const original = this.db.prepare(`SELECT * FROM task_experiences WHERE id = ?`).get(experienceId) as any;
    if (!original) {
      throw new Error(`任务经验不存在: ${experienceId}`);
    }

    const newId = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO task_experiences (
        id, project_id, user_request, condensed_request, sub_tasks_json,
        dag_layers, worker_types, status, final_output_summary,
        confidence, duration_seconds, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newId,
      targetProjectId,
      original.user_request,
      original.condensed_request,
      original.sub_tasks_json,
      original.dag_layers,
      original.worker_types,
      original.status,
      original.final_output_summary,
      original.confidence,
      original.duration_seconds,
      original.trace_id
    );

    log({ prefix: "MemoryStore", message: `L1 经验已复制: ${experienceId} → ${targetProjectId} (新ID: ${newId})` });
    return newId;
  }

  private rowToTaskExperience(row: any): TaskExperience {
    return {
      id: row.id,
      projectId: row.project_id,
      userRequest: row.user_request,
      condensedRequest: row.condensed_request,
      subTasksJson: row.sub_tasks_json,
      dagLayers: row.dag_layers,
      workerTypes: row.worker_types,
      status: row.status,
      finalOutputSummary: row.final_output_summary,
      confidence: row.confidence,
      durationSeconds: row.duration_seconds,
      traceId: row.trace_id,
      createdAt: row.created_at,
    };
  }

  // ==================== L2: 项目知识库 ====================

  /**
   * 写入项目知识
   */
  insertProjectKnowledge(knowledge: Omit<ProjectKnowledge, "id" | "createdAt" | "updatedAt">): string {
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO project_knowledge (id, project_id, category, title, content, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, knowledge.projectId, knowledge.category, knowledge.title, knowledge.content, knowledge.source, now, now);

    log({ prefix: "MemoryStore", message: `L2 项目知识已写入: ${id} (项目: ${knowledge.projectId}, 分类: ${knowledge.category})` });
    return id;
  }

  /**
   * 获取指定项目的所有知识
   */
  getProjectKnowledge(projectId: string): ProjectKnowledge[] {
    const stmt = this.db.prepare(`
      SELECT * FROM project_knowledge
      WHERE project_id = ?
      ORDER BY category, created_at DESC
    `);

    const rows = stmt.all(projectId) as any[];
    return rows.map(this.rowToProjectKnowledge);
  }

  /**
   * 搜索项目知识（FTS5）
   */
  searchProjectKnowledge(projectId: string, query: string): ProjectKnowledge[] {
    const ftsQuery = query
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => `"${w}"`)
      .join(" OR ");

    if (!ftsQuery) return this.getProjectKnowledge(projectId);

    try {
      const stmt = this.db.prepare(`
        SELECT pk.*
        FROM project_knowledge pk
        JOIN project_knowledge_fts pk_fts ON pk.rowid = pk_fts.rowid
        WHERE pk.project_id = ?
          AND pk_fts.project_knowledge_fts MATCH ?
        ORDER BY pk_fts.rank DESC
      `);

      const rows = stmt.all(projectId, ftsQuery) as any[];
      return rows.map(this.rowToProjectKnowledge);
    } catch (error) {
      log({ prefix: "MemoryStore", message: `L2 FTS5 搜索失败: ${error}`, level: "warn" });
      return this.getProjectKnowledge(projectId);
    }
  }

  /**
   * 更新项目知识
   */
  updateProjectKnowledge(id: string, updates: { title?: string; content?: string; category?: string }): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.content !== undefined) { fields.push("content = ?"); values.push(updates.content); }
    if (updates.category !== undefined) { fields.push("category = ?"); values.push(updates.category); }

    if (fields.length === 0) return false;

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE project_knowledge SET ${fields.join(", ")} WHERE id = ?`);
    const result = stmt.run(...values);
    return result.changes > 0;
  }

  /**
   * 删除项目知识
   */
  deleteProjectKnowledge(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM project_knowledge WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * 将项目知识复制到新项目（日志导入到新会话时）
   */
  copyProjectKnowledgeToProject(sourceProjectId: string, targetProjectId: string): number {
    const stmt = this.db.prepare(`SELECT * FROM project_knowledge WHERE project_id = ?`);
    const rows = stmt.all(sourceProjectId) as any[];

    const insertStmt = this.db.prepare(`
      INSERT INTO project_knowledge (id, project_id, category, title, content, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    for (const row of rows) {
      const newId = uuidv4();
      insertStmt.run(newId, targetProjectId, row.category, row.title, row.content, row.source, row.created_at, row.updated_at);
      count++;
    }

    log({ prefix: "MemoryStore", message: `L2 知识已复制: ${sourceProjectId} → ${targetProjectId} (${count} 条)` });
    return count;
  }

  private rowToProjectKnowledge(row: any): ProjectKnowledge {
    return {
      id: row.id,
      projectId: row.project_id,
      category: row.category,
      title: row.title,
      content: row.content,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ==================== L3: Worker 画像库 ====================

  /**
   * 更新 Worker 画像（子任务完成后调用）
   */
  updateWorkerProfile(
    workerType: string,
    result: { success: boolean; confidence: number; durationSeconds: number; skillId?: string }
  ): void {
    const existing = this.db.prepare(`SELECT * FROM worker_profiles WHERE worker_type = ?`).get(workerType) as any;

    if (!existing) {
      // 新建画像
      const id = uuidv4();
      const skillStats: Record<string, { used: number; success: number }> = {};
      if (result.skillId) {
        skillStats[result.skillId] = { used: 1, success: result.success ? 1 : 0 };
      }

      const stmt = this.db.prepare(`
        INSERT INTO worker_profiles (id, worker_type, total_tasks, success_count, avg_confidence, avg_duration_seconds, skill_stats, strong_domains, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        workerType,
        result.success ? 1 : 0,
        result.confidence,
        result.durationSeconds,
        Object.keys(skillStats).length > 0 ? JSON.stringify(skillStats) : null,
        null,
        new Date().toISOString()
      );
    } else {
      // 增量更新画像
      const newTotal = existing.total_tasks + 1;
      const newSuccess = existing.success_count + (result.success ? 1 : 0);
      const newAvgConfidence = (existing.avg_confidence * existing.total_tasks + result.confidence) / newTotal;
      const newAvgDuration = (existing.avg_duration_seconds * existing.total_tasks + result.durationSeconds) / newTotal;

      // 更新技能统计
      let skillStats: Record<string, { used: number; success: number }> =
        existing.skill_stats ? JSON.parse(existing.skill_stats) : {};
      if (result.skillId) {
        if (!skillStats[result.skillId]) {
          skillStats[result.skillId] = { used: 0, success: 0 };
        }
        skillStats[result.skillId].used++;
        if (result.success) skillStats[result.skillId].success++;
      }

      // 更新擅长领域（成功率 ≥ 70% 且使用 ≥ 3 次的技能归为擅长领域）
      const strongDomains: string[] = [];
      for (const [skillId, stats] of Object.entries(skillStats)) {
        if (stats.used >= 3 && stats.success / stats.used >= 0.7) {
          strongDomains.push(skillId);
        }
      }

      const stmt = this.db.prepare(`
        UPDATE worker_profiles
        SET total_tasks = ?, success_count = ?, avg_confidence = ?, avg_duration_seconds = ?,
            skill_stats = ?, strong_domains = ?, updated_at = ?
        WHERE worker_type = ?
      `);

      stmt.run(
        newTotal,
        newSuccess,
        newAvgConfidence,
        newAvgDuration,
        Object.keys(skillStats).length > 0 ? JSON.stringify(skillStats) : null,
        strongDomains.length > 0 ? strongDomains.join(",") : null,
        new Date().toISOString(),
        workerType
      );
    }
  }

  /**
   * 获取所有 Worker 画像
   */
  getAllWorkerProfiles(): WorkerProfile[] {
    const stmt = this.db.prepare(`SELECT * FROM worker_profiles ORDER BY total_tasks DESC`);
    const rows = stmt.all() as any[];
    return rows.map(this.rowToWorkerProfile);
  }

  /**
   * 获取指定角色的画像
   */
  getWorkerProfile(workerType: string): WorkerProfile | undefined {
    const stmt = this.db.prepare(`SELECT * FROM worker_profiles WHERE worker_type = ?`);
    const row = stmt.get(workerType) as any;
    return row ? this.rowToWorkerProfile(row) : undefined;
  }

  /**
   * 生成角色画像描述文本（用于注入 LLM prompt）
   */
  getWorkerProfileDescriptions(): string {
    const profiles = this.getAllWorkerProfiles();
    if (profiles.length === 0) return "";

    return profiles.map(p => {
      const successRate = p.totalTasks > 0 ? Math.round((p.successCount / p.totalTasks) * 100) : 0;
      const parts = [`- ${p.workerType}: 历史执行 ${p.totalTasks} 次, 成功率 ${successRate}%, 平均置信度 ${p.avgConfidence.toFixed(2)}`];
      if (p.strongDomains && p.strongDomains.length > 0) {
        parts.push(`  擅长领域: ${p.strongDomains.join(", ")}`);
      }
      return parts.join("\n");
    }).join("\n");
  }

  private rowToWorkerProfile(row: any): WorkerProfile {
    return {
      id: row.id,
      workerType: row.worker_type,
      totalTasks: row.total_tasks,
      successCount: row.success_count,
      avgConfidence: row.avg_confidence,
      avgDurationSeconds: row.avg_duration_seconds,
      skillStats: row.skill_stats ? JSON.parse(row.skill_stats) : undefined,
      strongDomains: row.strong_domains ? row.strong_domains.split(",").filter(Boolean) : undefined,
      updatedAt: row.updated_at,
    };
  }

  // ==================== 维护方法 ====================

  /**
   * 清理过期的任务经验（默认保留90天）
   */
  cleanupOldExperiences(retentionDays: number = 90): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const stmt = this.db.prepare(`DELETE FROM task_experiences WHERE created_at < ?`);
    const result = stmt.run(cutoffDate.toISOString());

    log({ prefix: "MemoryStore", message: `清理过期任务经验: 删除 ${result.changes} 条 (${retentionDays} 天前)` });
    return result.changes;
  }

  /**
   * 获取统计信息
   */
  getStats(projectId?: string): {
    experienceCount: number;
    knowledgeCount: number;
    workerProfileCount: number;
  } {
    const expQuery = projectId
      ? `SELECT COUNT(*) as cnt FROM task_experiences WHERE project_id = ?`
      : `SELECT COUNT(*) as cnt FROM task_experiences`;
    const expResult = projectId
      ? this.db.prepare(expQuery).get(projectId) as any
      : this.db.prepare(expQuery).get() as any;

    const knlQuery = projectId
      ? `SELECT COUNT(*) as cnt FROM project_knowledge WHERE project_id = ?`
      : `SELECT COUNT(*) as cnt FROM project_knowledge`;
    const knlResult = projectId
      ? this.db.prepare(knlQuery).get(projectId) as any
      : this.db.prepare(knlQuery).get() as any;

    const wpResult = this.db.prepare(`SELECT COUNT(*) as cnt FROM worker_profiles`).get() as any;

    return {
      experienceCount: expResult.cnt,
      knowledgeCount: knlResult.cnt,
      workerProfileCount: wpResult.cnt,
    };
  }

  close(): void {
    this.db.close();
    log({ prefix: "MemoryStore", message: "记忆数据库已关闭" });
  }
}

// ==================== 单例 ====================

let memoryStoreInstance: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!memoryStoreInstance) {
    memoryStoreInstance = new MemoryStore();
  }
  return memoryStoreInstance;
}

export function resetMemoryStore(): void {
  if (memoryStoreInstance) {
    memoryStoreInstance.close();
    memoryStoreInstance = null;
  }
}
