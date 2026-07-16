/**
 * 调度中心日志工具
 * 支持 LOG_FORMAT=json 环境变量，输出结构化 JSON 日志行供 Tauri 实时解析
 */

import * as fs from "fs";

// 是否启用 JSON 输出格式（由 Tauri 后端通过环境变量控制）
const JSON_OUTPUT = process.env.LOG_FORMAT === 'json';

function writeToLog(logFile: string, content: string): void {
  const timestamp = new Date().toISOString();
  const formattedContent = `[${timestamp}] ${content}\n`;
  fs.appendFileSync(logFile, formattedContent, "utf-8");
}

/**
 * 统一日志方法：同时写文件 + 输出到终端
 * @param options.prefix 日志前缀（如 Master/PlanExecutor/ArbitrationEngine 等），自动拼接为 [prefix] 格式
 * @param options.silent 静默模式：只写文件不输出到终端
 */
export function log(options: {
  logFile?: string;
  message: string;
  prefix?: string;
  level?: 'info' | 'warn' | 'error';
  silent?: boolean;
}): void {
  const { logFile, message, prefix, level = 'info', silent = false } = options;
  const fullMessage = prefix ? `[${prefix}] ${message}` : message;

  // 写文件
  if (logFile) {
    writeToLog(logFile, fullMessage);
  }

  // 静默模式：只写文件，不输出终端
  if (silent) return;

  // JSON 格式输出（供 Tauri 实时流式解析）
  if (JSON_OUTPUT) {
    const entry = JSON.stringify({
      prefix: prefix || '',
      message,
      level,
      timestamp: new Date().toISOString(),
    });
    // 使用 __LOG__: 前缀标记，方便 Rust 端识别结构化日志行
    console.log(`__LOG__:${entry}`);
    return;
  }

  // 人类可读格式输出（终端直接运行时）
  const levelPrefix = level === 'error' ? '\x1b[31m[ERROR]\x1b[0m ' :
    level === 'warn' ? '\x1b[33m[WARN]\x1b[0m ' : '';

  const lines = fullMessage.split('\n').filter(line => line.trim() !== '');
  for (const line of lines) {
    console.log(`${levelPrefix}${line}`);
  }
}
