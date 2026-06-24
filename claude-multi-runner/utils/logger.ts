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

export function writeToLog(logFile: string, content: string): void {
  const timestamp = new Date().toISOString();
  const formattedContent = `[${timestamp}] ${content}\n`;
  fs.appendFileSync(logFile, formattedContent, "utf-8");
}