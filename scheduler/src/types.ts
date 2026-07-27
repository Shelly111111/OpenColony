/**
 * 调度中心核心类型定义
 */

import { z } from "zod";

// LLM任务拆分相关类型
export interface LLMPlanSubTask {
  name: string;
  description: string;
  workerType: string;
  dependencies: number[];  // 依赖的子任务索引
  skill?: string;  // 使用的技能，格式: "pluginName:subSkillId" 或 "skillId"，每个子任务最多一个
}

export interface LLMPlanResponse {
  subTasks: LLMPlanSubTask[];
  estimatedDuration?: number;
  reasoning?: string;
  condensedRequest?: string;
}

// ==================== 基础枚举 ====================

/**
 * 任务状态
 */
export enum TaskStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  PARTIAL = "partial",
  RETRYING = "retrying"
}

/**
 * 任务优先级
 */
export enum TaskPriority {
  P0 = "P0",
  P1 = "P1",
  P2 = "P2"
}

/**
 * 仲裁模式
 */
export enum ArbitrationMode {
  CONFIDENCE_VOTE = "confidence_vote",
  AGENT_PRIORITY = "agent_priority",
  MERGE_DIFF = "merge_diff"
}

// ==================== 核心数据结构 ====================

/**
 * 统一Worker输出Schema
 */
export const WorkerOutputSchema = z.object({
  status: z.enum(["success", "fail", "partial"]),
  data: z.any(),
  confidence: z.number().min(0).max(1),
  source_agent: z.string(),
  trace_id: z.string(),
  error: z.string().optional()
});

export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

/**
 * 子任务定义
 */
export interface SubTask {
  id: string;
  parentTaskId: string;
  name: string;
  description: string;
  workerType: string;
  skill?: string;  // 使用的技能，格式: "pluginName:subSkillId" 或 "skillId"
  priority: TaskPriority;
  status: TaskStatus;
  dependencies: string[];
  command: string;
  output?: WorkerOutput;
  error?: string;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  worker?: WorkerInstance;
}

/**
 * 主任务定义
 */
export interface MainTask {
  id: string;
  name: string;
  description: string;
  userRequest: string;
  condensedRequest?: string;
  constraints: string[];
  deliveryStandards: string[];
  priority: TaskPriority;
  status: TaskStatus;
  subTasks: Map<string, SubTask>;
  dag: DAG;
  output?: any;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  traceId: string;
  logDir?: string; // 日志目录路径
  masterLogFile?: string; // Master + PlanExecutor 合并日志文件路径
}

/**
 * DAG节点
 */
export interface DAGNode {
  id: string;
  name: string;
  dependencies: string[];
  subTaskId: string;
}

/**
 * DAG图结构
 */
export interface DAG {
  nodes: Map<string, DAGNode>;
  edges: Map<string, string[]>; // 源节点 -> 目标节点列表
}

/**
 * Worker实例
 */
export interface WorkerInstance {
  id: string;
  type: string;
  status: "idle" | "busy" | "error";
  currentTaskId?: string;
  logFile?: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

/**
 * 任务执行结果
 */
export interface TaskResult {
  success: boolean;
  data?: any;
  error?: string;
  traceId: string;
  duration: number;
}

/**
 * 调度配置
 */
export interface SchedulerConfig {
  maxWorkers: number;
  defaultMaxRetries: number;
  defaultTimeoutMs: number;
  arbitrationMode: ArbitrationMode;
  enableReview: boolean;
  workerTypes: string[];
  runMode?: 'sdk' | 'pty'; // 运行模式：sdk（默认）或 pty
  permissionMode?: PermissionMode; // 权限模式：auto/ask/bypass，默认 ask
}

/**
 * 计划模块输出
 */
export interface PlanOutput {
  subTasks: SubTask[];
  dag: DAG;
  requiredWorkers: number;
}

/**
 * 仲裁结果
 */
export interface ArbitrationResult {
  resolved: boolean;
  finalOutput?: any;
  conflicts?: string[];
  requiresUserInput: boolean;
  userPrompt?: string;
}

// ==================== 受控执行模式相关类型 ====================

/**
 * 权限模式
 */
export enum PermissionMode {
  AUTO = "auto",     // Auto模式：高置信度操作自动执行，低置信度需批准
  ASK = "ask",       // Ask模式：每个写入/执行操作弹出审批Toast（默认）
  BYPASS = "bypass"  // 跳过所有权限检查（仅限开发/调试）
}

// ==================== ClaudeLink 通信相关类型 ====================

/**
 * 消息优先级
 */
export enum MessagePriority {
  HIGH = "high",
  NORMAL = "normal",
  LOW = "low"
}

/**
 * 消息状态
 */
export enum MessageStatus {
  PENDING = "pending",
  SENT = "sent",
  RECEIVED = "received",
  PROCESSED = "processed"
}

/**
 * 消息定义
 */
export interface Message {
  id: string;
  fromWorkerId: string;
  toWorkerId: string;
  content: string;
  priority: MessagePriority;
  status: MessageStatus;
  context?: Record<string, any>;
  createdAt: Date;
  sentAt?: Date;
  receivedAt?: Date;
  processedAt?: Date;
  ttl?: number;
  retryCount?: number;
}

/**
 * Worker 状态信息
 */
export interface WorkerStatusInfo {
  workerId: string;
  type: string;
  status: "idle" | "busy" | "error";
  currentTaskId?: string;
  lastActiveAt?: Date;
}

/**
 * ClaudeLink 配置
 */
export interface ClaudeLinkConfig {
  dbPath?: string;
  messageRetentionDays?: number;
  sendRateLimitMs?: number;
}

// ==================== 动态信息注入相关类型 ====================

/**
 * 补充信息路由模式
 */
export enum InjectionRoute {
  DIRECTED = "directed",     // 定向路由：用户明确指定Worker
  SMART = "smart",           // 智能路由：Master自动判断
  BROADCAST = "broadcast"    // 全局广播：所有Worker
}

/**
 * 信息注入时机
 */
export enum InjectionTiming {
  IMMEDIATE = "immediate",       // 立即注入（默认）
  INTERRUPT = "interrupt",       // 强制中断注入
  WAIT = "wait"                  // 等待注入
}

/**
 * 补充信息注入状态（对应状态码 6001/6002/6003）
 */
export enum InjectionStatus {
  DELIVERED = "delivered",                // 6001: 已送达
  NEEDS_CLARIFICATION = "needs_clarification",  // 6002: 需用户澄清目标
  UNDELIVERABLE = "undeliverable"         // 6003: 无法送达
}

/**
 * 补充信息注入请求
 */
export interface InjectionRequest {
  traceId: string;
  content: string;
  route?: InjectionRoute;
  targetWorkerId?: string;   // 定向路由时指定的Worker ID
  targetWorkerType?: string; // 定向路由时指定的Worker类型（与targetWorkerId二选一）
  timing?: InjectionTiming;
  urgent?: boolean;          // 紧急标记，触发强制中断
}

/**
 * 路由决策详情
 */
export interface RouteDetail {
  targetWorkerIds: string[];
  reason: string;            // 路由决策依据
  confidence?: number;       // 置信度（智能路由时由LLM给出）
  keywordMatches?: string[]; // 关键词匹配项
}

/**
 * 补充信息注入结果
 */
export interface InjectionResult {
  status: InjectionStatus;
  statusCode: number;        // 6001/6002/6003
  route: InjectionRoute;
  routeDetail: RouteDetail;
  messageIds: string[];      // 写入ClaudeLink的消息ID
  candidates?: WorkerInstance[]; // 需澄清时返回候选Worker
  error?: string;
}
