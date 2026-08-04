/**
 * 记忆存储层
 * 三层记忆检索架构：
 * - L1: 任务经验库（sqlite-vec 向量语义搜索优先，FTS5 全文搜索降级，新任务提交时检索相似历史）
 * - L2: 项目知识库（按 project_id 隔离，注入 Worker 上下文）
 * - L3: Worker 画像库（全局共享，影响角色选择权重）
 */

import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { log } from "./logger";
import { EmbeddingProvider, LocalEmbeddingProvider } from "./embedding-provider";

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
  private vecAvailable = false;
  private vecDimension = 384;
  private embeddingProvider: EmbeddingProvider | null = null;

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

    // 尝试加载 sqlite-vec 扩展
    this.vecDimension = parseInt(process.env.EMBEDDING_DIMENSION || '384', 10);
    try {
      const sqliteVec = require('sqlite-vec');
      this.db.loadExtension(sqliteVec.getLoadablePath());
      this.vecAvailable = true;
      log({ prefix: "MemoryStore", message: `sqlite-vec 扩展加载成功 (dimension=${this.vecDimension})` });
    } catch (error) {
      this.vecAvailable = false;
      log({ prefix: "MemoryStore", message: `sqlite-vec 扩展加载失败，将使用 FTS5 搜索: ${error}`, level: "warn" });
    }

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

    // L1: sqlite-vec 向量虚拟表（语义搜索）
    if (this.vecAvailable) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS task_experience_vecs USING vec0(
            embedding FLOAT[${this.vecDimension}]
          );
        `);
        log({ prefix: "MemoryStore", message: "向量虚拟表 task_experience_vecs 创建成功" });
      } catch (error) {
        this.vecAvailable = false;
        log({ prefix: "MemoryStore", message: `向量虚拟表创建失败: ${error}`, level: "warn" });
      }
    }

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
   * 如果配置了 EmbeddingProvider 且 sqlite-vec 可用，会异步生成并存储向量
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

    const result = stmt.run(
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

    // 异步生成并存储向量（不阻塞，失败不影响写入）
    if (this.embeddingProvider && this.vecAvailable) {
      const rowid = BigInt(result.lastInsertRowid);
      const text = `${exp.userRequest} ${exp.condensedRequest || ''}`.trim();
      this.embeddingProvider.getEmbedding(text)
        .then(embedding => {
          this.storeExperienceVector(rowid, embedding);
          log({ prefix: "MemoryStore", message: `L1 向量已存储: ${id}` });
        })
        .catch(error => {
          log({ prefix: "MemoryStore", message: `L1 向量生成失败: ${id} - ${error}，该记录将无法被向量搜索检索`, level: "warn" });
          // 标记该经验缺少向量，便于后续排查
          try {
            const updateStmt = this.db.prepare(`UPDATE task_experiences SET condensed_request = COALESCE(condensed_request, '') || ' [VEC_MISSING]' WHERE id = ?`);
            updateStmt.run(id);
          } catch { /* 忽略标记失败 */ }
        });
    }

    return id;
  }

  /**
   * 搜索相似任务经验
   * 优先使用向量语义搜索（sqlite-vec），降级到 FTS5 全文搜索，最终降级到模糊搜索
   * 返回按相关性排序的结果，限制 topN
   */
  async searchSimilarExperiences(
    projectId: string,
    query: string,
    topN?: number
  ): Promise<ExperienceSearchResult[]> {
    const effectiveTopN = topN ?? parseInt(process.env.EMBEDDING_TOPN || '3', 10);
    // 优先使用向量语义搜索
    if (this.embeddingProvider && this.vecAvailable) {
      try {
        const queryEmbedding = await this.embeddingProvider.getEmbedding(query);
        const results = this.vectorSearchExperiences(projectId, queryEmbedding, effectiveTopN);
        if (results.length > 0) {
          log({ prefix: "MemoryStore", message: `向量搜索命中 ${results.length} 条` });
          return results;
        }
        // 向量搜索无结果，降级到 FTS5
      } catch (error) {
        log({ prefix: "MemoryStore", message: `向量搜索失败，降级到 FTS5: ${error}`, level: "warn" });
      }
    }

    // FTS5 全文搜索
    return this.ftsSearchExperiences(projectId, query, effectiveTopN);
  }

  /**
   * 向量语义搜索（sqlite-vec）
   */
  private vectorSearchExperiences(
    projectId: string,
    queryEmbedding: number[],
    topN: number
  ): ExperienceSearchResult[] {
    const embeddingBuffer = this.embeddingToBuffer(queryEmbedding);
    // sqlite-vec 要求 KNN 查询使用 k = ? 指定返回数量
    // 多取候选（乘以3），再按 project_id 过滤，确保 topN 有效结果
    const candidateCount = topN * 3;
    const stmt = this.db.prepare(`
      SELECT te.*, vec.distance
      FROM task_experience_vecs vec
      JOIN task_experiences te ON te.rowid = vec.rowid
      WHERE vec.embedding MATCH vec_f32(?)
        AND k = ?
        AND (te.project_id = ? OR te.project_id = '__global__')
      ORDER BY vec.distance
      LIMIT ?
    `);

    const rows = stmt.all(embeddingBuffer, candidateCount, projectId, topN) as any[];
    return rows.map(row => ({
      experience: this.rowToTaskExperience(row),
      relevanceScore: 1 - row.distance, // cosine distance → similarity
    }));
  }

  /**
   * FTS5 全文搜索（词法匹配）
   */
  private ftsSearchExperiences(
    projectId: string,
    query: string,
    topN: number
  ): ExperienceSearchResult[] {
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
        relevanceScore: -row.fts_rank,
      }));
    } catch (error) {
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

    const copyResult = stmt.run(
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

    // 复制向量（如果可用）
    if (this.vecAvailable) {
      try {
        const origRowid = this.db.prepare(`SELECT rowid FROM task_experiences WHERE id = ?`).get(experienceId) as any;
        const newRowid = BigInt(copyResult.lastInsertRowid);
        if (origRowid) {
          this.db.prepare(`
            INSERT INTO task_experience_vecs(rowid, embedding)
            SELECT ?, embedding FROM task_experience_vecs WHERE rowid = ?
          `).run(newRowid, BigInt(origRowid.rowid));
        }
      } catch (error) {
        log({ prefix: "MemoryStore", message: `向量复制失败: ${error}`, level: "warn" });
      }
    }

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

  // ==================== 向量搜索工具方法 ====================

  /**
   * 设置向量嵌入提供者
   * 设置后，新写入的经验会自动生成向量，搜索时优先使用向量语义匹配
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    if (!this.vecAvailable) {
      log({ prefix: "MemoryStore", message: "sqlite-vec 不可用，设置 EmbeddingProvider 后搜索仍将使用 FTS5", level: "warn" });
    }
    this.embeddingProvider = provider;
    log({ prefix: "MemoryStore", message: `EmbeddingProvider 已设置 (dimension=${provider.getDimension()})` });
  }

  /**
   * 自动初始化本地 EmbeddingProvider
   * 使用本地 ONNX 模型，无需外部 API Key
   * 模型在首次调用时自动下载到本地缓存
   */
  autoInitEmbeddingProvider(): boolean {
    try {
      const provider = new LocalEmbeddingProvider();
      this.setEmbeddingProvider(provider);
      return true;
    } catch (error) {
      log({ prefix: "MemoryStore", message: `本地 EmbeddingProvider 初始化失败: ${error}`, level: "warn" });
      return false;
    }
  }

  /**
   * 存储单条经验的向量
   */
  private storeExperienceVector(rowid: bigint, embedding: number[]): void {
    if (!this.vecAvailable) return;
    const buffer = this.embeddingToBuffer(embedding);
    // 先删除旧向量（如果存在），再插入新向量
    this.db.prepare(`DELETE FROM task_experience_vecs WHERE rowid = ?`).run(rowid);
    this.db.prepare(`INSERT INTO task_experience_vecs(rowid, embedding) VALUES (?, vec_f32(?))`).run(rowid, buffer);
  }

  /**
   * 将 embedding 数组转换为 Float32 Buffer（sqlite-vec vec_f32 需要）
   */
  private embeddingToBuffer(embedding: number[]): Buffer {
    const buffer = Buffer.alloc(embedding.length * 4);
    for (let i = 0; i < embedding.length; i++) {
      buffer.writeFloatLE(embedding[i], i * 4);
    }
    return buffer;
  }

  /**
   * 批量重新向量化所有任务经验
   * 用于迁移已有数据或更换 embedding 模型后重建索引
   */
  async reindexAllVectors(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (!this.embeddingProvider) {
      throw new Error('未配置 EmbeddingProvider，无法进行向量化');
    }
    if (!this.vecAvailable) {
      throw new Error('sqlite-vec 不可用，无法进行向量化');
    }

    const rows = this.db.prepare(
      `SELECT rowid, user_request, condensed_request FROM task_experiences`
    ).all() as any[];
    let indexed = 0;

    for (const row of rows) {
      try {
        const text = `${row.user_request} ${row.condensed_request || ''}`.trim();
        const embedding = await this.embeddingProvider.getEmbedding(text);
        this.storeExperienceVector(BigInt(row.rowid), embedding);
        indexed++;
        onProgress?.(indexed, rows.length);
      } catch (error) {
        log({ prefix: "MemoryStore", message: `向量化失败 rowid=${row.rowid}: ${error}`, level: "warn" });
      }
    }

    log({ prefix: "MemoryStore", message: `批量向量化完成: ${indexed}/${rows.length}` });
    return indexed;
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
    const hasUpdate = updates.title !== undefined || updates.content !== undefined || updates.category !== undefined;
    if (!hasUpdate) return false;

    const now = new Date().toISOString();

    // 根据传入字段选择对应的预编译语句，避免 SQL 拼接
    if (updates.title !== undefined && updates.content !== undefined && updates.category !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET title = ?, content = ?, category = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.title, updates.content, updates.category, now, id).changes > 0;
    }
    if (updates.title !== undefined && updates.content !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET title = ?, content = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.title, updates.content, now, id).changes > 0;
    }
    if (updates.title !== undefined && updates.category !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET title = ?, category = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.title, updates.category, now, id).changes > 0;
    }
    if (updates.content !== undefined && updates.category !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET content = ?, category = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.content, updates.category, now, id).changes > 0;
    }
    if (updates.title !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET title = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.title, now, id).changes > 0;
    }
    if (updates.content !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET content = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.content, now, id).changes > 0;
    }
    if (updates.category !== undefined) {
      const stmt = this.db.prepare(`UPDATE project_knowledge SET category = ?, updated_at = ? WHERE id = ?`);
      return stmt.run(updates.category, now, id).changes > 0;
    }
    return false;
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
   * 同时清理对应的向量数据
   */
  cleanupOldExperiences(retentionDays: number = 90): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    if (this.vecAvailable) {
      // 先清理向量表中对应的记录
      this.db.prepare(`
        DELETE FROM task_experience_vecs
        WHERE rowid IN (SELECT rowid FROM task_experiences WHERE created_at < ?)
      `).run(cutoffDate.toISOString());
    }

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
    const expStmt = projectId
      ? this.db.prepare(`SELECT COUNT(*) as cnt FROM task_experiences WHERE project_id = ?`)
      : this.db.prepare(`SELECT COUNT(*) as cnt FROM task_experiences`);
    const expResult = projectId
      ? expStmt.get(projectId) as any
      : expStmt.get() as any;

    const knlStmt = projectId
      ? this.db.prepare(`SELECT COUNT(*) as cnt FROM project_knowledge WHERE project_id = ?`)
      : this.db.prepare(`SELECT COUNT(*) as cnt FROM project_knowledge`);
    const knlResult = projectId
      ? knlStmt.get(projectId) as any
      : knlStmt.get() as any;

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
