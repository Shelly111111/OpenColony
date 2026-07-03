/**
 * 日志工具
 */

import * as fs from "fs";
import * as path from "path";

export const LOG_DIR = path.join(process.cwd(), "claude-logs");

export function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function createLogFile(sessionId: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `claude-session-${sessionId}-${timestamp}.log`;
  return path.join(LOG_DIR, filename);
}

function writeToLog(logFile: string, content: string): void {
  const timestamp = new Date().toISOString();
  const formattedContent = `[${timestamp}] ${content}\n`;
  fs.appendFileSync(logFile, formattedContent, "utf-8");
}

/**
 * 统一日志方法：同时写文件 + 输出到终端
 * @param options.logFile 日志文件路径（可选）
 * @param options.message 日志内容
 * @param options.sessionId 会话ID（可选，用于终端输出格式化）
 * @param options.level 日志级别（可选）
 * @param options.silent 静默模式：只写文件不输出到终端（可选，默认 false）
 */
export function log(options: {
  logFile?: string;
  message: string;
  sessionId?: number;
  level?: 'info' | 'warn' | 'error';
  silent?: boolean;
}): void {
  const { logFile, message, sessionId, level = 'info', silent = false } = options;

  // 写文件
  if (logFile) {
    writeToLog(logFile, message);
  }

  // 静默模式：只写文件，不输出终端
  if (silent) return;

  // 输出到终端
  const levelPrefix = level === 'error' ? '\x1b[31m[ERROR]\x1b[0m ' :
    level === 'warn' ? '\x1b[33m[WARN]\x1b[0m ' : '';

  if (sessionId !== undefined) {
    // 有 sessionId：使用 formatOutput 格式化
    console.log(formatOutput(sessionId, message));
  } else {
    console.log(`${levelPrefix}${message}`);
  }
}

/**
 * 格式化输出（带颜色前缀）- 导出供外部使用
 */
export function formatOutput(sessionId: number, content: string): string {
  const COLORS = ["\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m"];
  const RESET = "\x1b[0m";
  const color = COLORS[(sessionId - 1) % COLORS.length];
  const prefix = `[终端${sessionId}] `;
  return content
    .split("\n")
    .filter(line => line.trim() !== '')
    .map(line => `${color}${prefix}${RESET}${line}`)
    .join("\n");
}