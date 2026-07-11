/**
 * 调度中心日志工具
 */

import * as fs from "fs";

function writeToLog(logFile: string, content: string): void {
  const timestamp = new Date().toISOString();
  const formattedContent = `[${timestamp}] ${content}\n`;
  fs.appendFileSync(logFile, formattedContent, "utf-8");
}

/**
 * 统一日志方法：同时写文件 + 输出到终端
 * @param options.silent 静默模式：只写文件不输出到终端
 */
export function log(options: {
  logFile?: string;
  message: string;
  level?: 'info' | 'warn' | 'error';
  silent?: boolean;
}): void {
  const { logFile, message, level = 'info', silent = false } = options;

  // 写文件
  if (logFile) {
    writeToLog(logFile, message);
  }

  // 静默模式：只写文件，不输出终端
  if (silent) return;

  // 输出到终端
  const levelPrefix = level === 'error' ? '\x1b[31m[ERROR]\x1b[0m ' :
    level === 'warn' ? '\x1b[33m[WARN]\x1b[0m ' : '';

  const lines = message.split('\n').filter(line => line.trim() !== '');
  for (const line of lines) {
    console.log(`${levelPrefix}${line}`);
  }
}
