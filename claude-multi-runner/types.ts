/**
 * 类型定义
 */

export interface PtyBackend {
  type: "node-pty";
  spawn(id: string, options: { shell?: string; cols?: number; rows?: number; env?: Record<string, string> }): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onExit?: (id: string, code: number) => void;
  onError?: (id: string, message: string) => void;
  onData?: (id: string, data: string) => void;
  onDiff?: (id: string, changedLines: { row: number; content: string }[]) => void;
  shutdown(): void;
}

export interface ClaudeSession {
  id: number;
  terminalId: string;
  command: string;
  logFile: string;
  screenLogFile?: string; // 屏幕日志文件（每次清空重写）
  startTime: Date;
  status: "running" | "completed" | "error" | "stopped";
  outputBuffer: string;
}