/**
 * Claude PTY Manager
 */

import * as fs from "fs";
import * as path from "path";
import { PtyBackend, ClaudeSession } from "./types";
import { createPtyBackend } from "./backends/pty-selector";
import { ensureLogDir, createLogFile, writeToLog, LOG_DIR } from "./utils/logger";
import { findGitBashPath, getDefaultShell } from "./utils/git-bash";

// 屏幕日志文件后缀
const SCREEN_LOG_SUFFIX = ".screen.log";

// Constants
const COLORS = ["\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m"];
const RESET = "\x1b[0m";

// Claude 状态动画帧符号（需要过滤的无意义行）
const STATUS_ANIMATION_CHARS = ['✶', '✻', '✽', '✢', '·', '○', '◐', '◑', '◔', '◕', '※', '⁂', '⁕', '*'];

// Claude 状态栏关键词（需要过滤）
const STATUS_BAR_KEYWORDS = [
  'bypass permissions',
  'bypass─permissions─on',
  'ctrl+b to run in background',
  'meta+m to cycle',
  'medium',
  '/effort',
  'esc to interrupt',
  'ctrl+o to expand',
];

/**
 * 格式化输出（带颜色前缀）
 */
function formatOutput(sessionId: number, content: string): string {
  const color = COLORS[(sessionId - 1) % COLORS.length];
  const prefix = `[终端${sessionId}] `;
  return content
    .split("\n")
    .filter(line => line.trim() !== '')
    .map(line => `${color}${prefix}${RESET}${line}`)
    .join("\n");
}

export class ClaudeUnifiedPtyManager {
  private backend: PtyBackend | null = null;
  private sessions: ClaudeSession[] = [];
  private activeCount: number = 0;
  private maxSessions: number;
  private backendType: string = "";

  constructor(maxSessions: number) {
    this.maxSessions = maxSessions;
    ensureLogDir();
  }

  /**
   * 过滤 ANSI 控制码
   */
  private stripAnsi(str: string): string {
    const ansiRegex = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b[=>MDE7]/g;
    return str.replace(ansiRegex, '');
  }

  /**
   * 判断是否为无意义的噪音行（状态动画、状态栏等）
   */
  private isNoiseLine(cleanContent: string): boolean {
    const trimmed = cleanContent.trim();

    // 空行或纯空格
    if (trimmed.length === 0) return true;

    // 以状态动画符号开头的行（如 "✶ Discombobulating…"）
    for (const char of STATUS_ANIMATION_CHARS) {
      if (trimmed.startsWith(char)) return true;
    }

    // 以状态动画符号结尾的行（如 "(ctrl+o to expand)✶"）
    for (const char of STATUS_ANIMATION_CHARS) {
      if (trimmed.endsWith(char)) return true;
    }

    // 状态栏相关行（包含 bypass permissions、effort 等关键词的行）
    // 这些是 Claude 底部状态栏的动态更新，没有实质内容
    for (const keyword of STATUS_BAR_KEYWORDS) {
      if (trimmed.includes(keyword)) return true;
    }

    // 纯分隔线（长横线组成的行）
    if (/^[-─]+$/.test(trimmed)) return true;

    // 纯进度条符号（如 "◐"、"◑" 等连续出现）
    if (/^[◐◑○●]+$/.test(trimmed)) return true;

    return false;
  }

  async initialize(): Promise<void> {
    this.backend = await createPtyBackend();
    if (!this.backend) {
      throw new Error("无法创建 PTY 后端。请确保 node-pty 已正确安装");
    }
    this.backendType = this.backend.type;

    // 设置回调
    this.backend.onData = (terminalId: string, data: string) => {
      const session = this.sessions.find(s => s.terminalId === terminalId);
      if (session) {
        session.outputBuffer = data; // 只保留最新的屏幕内容

        // 清空 screen.log 文件并写入最新的屏幕内容（终端不再打印完整屏幕）
        if (session.screenLogFile) {
          const timestamp = new Date().toISOString();
          const fullContent = `[${timestamp}] 屏幕内容:\n${data}\n`;
          fs.writeFileSync(session.screenLogFile, fullContent, 'utf-8');
        }
      }
    };

    // diff 回调 - 将变化的行追加到主日志文件，并输出到终端
    this.backend.onDiff = (terminalId: string, changedLines: { row: number; content: string }[]) => {
      const session = this.sessions.find(s => s.terminalId === terminalId);
      if (session && changedLines.length > 0) {
        // 过滤无意义的行：空行、状态动画、状态栏等
        // 同时预先清理 ANSI 码，避免重复调用 stripAnsi
        const meaningfulLines = changedLines
          .map(line => ({ ...line, cleanContent: this.stripAnsi(line.content) }))
          .filter(line => !this.isNoiseLine(line.cleanContent));

        if (meaningfulLines.length > 0) {
          const timestamp = new Date().toISOString();
          const diffContent = `[${timestamp}] ` +
            meaningfulLines.map(line => `  ${line.cleanContent}`).join('\n') + '\n';
          fs.appendFileSync(session.logFile, diffContent, 'utf-8');

          // 终端输出变化的行
          const color = COLORS[(session.id - 1) % COLORS.length];
          const prefix = `[终端${session.id}]`;
          for (const line of meaningfulLines) {
            process.stdout.write(`${color}${prefix}${RESET} ${line.cleanContent}\n`);
          }
        }
      }
    };

    this.backend.onExit = (terminalId: string, code: number) => {
      const session = this.sessions.find(s => s.terminalId === terminalId);
      if (session) {
        if (session.status !== "running") {
          writeToLog(session.logFile, `[INFO] 进程退出 (退出码: ${code})，会话已终止`);
          return;
        }

        session.status = code === 0 ? "completed" : "error";
        writeToLog(session.logFile, `进程结束，退出码: ${code}`);
        console.log(formatOutput(session.id, `终端结束 (退出码: ${code}) - 状态: ${session.status}`));
        this.activeCount--;

        const endTime = new Date();
        const duration = (endTime.getTime() - session.startTime.getTime()) / 1000;
        writeToLog(
          session.logFile,
          `=== 会话汇总 ===\n开始时间: ${session.startTime.toISOString()}\n结束时间: ${endTime.toISOString()}\n运行时长: ${duration}秒\n命令: ${session.command}\n状态: ${session.status}`
        );
      }
    };

    this.backend.onError = (terminalId: string, message: string) => {
      const session = this.sessions.find(s => s.terminalId === terminalId);
      if (session) {
        writeToLog(session.logFile, `[ERROR] ${message}`);
        console.log(formatOutput(session.id, `[错误] ${message}`));
      }
    };

    console.log(`[pty] 使用 PTY 后端: ${this.backendType}`);
  }

  async spawnClaude(sessionId: number, command: string): Promise<void> {
    if (!this.backend) {
      throw new Error("PTY 后端未初始化");
    }

    const terminalId = `claude-${sessionId}-${Date.now()}`;
    const baseLogFile = createLogFile(sessionId);
    const screenLogFile = baseLogFile.replace('.log', SCREEN_LOG_SUFFIX);
    const session: ClaudeSession = {
      id: sessionId,
      terminalId,
      command,
      logFile: baseLogFile,
      screenLogFile,
      startTime: new Date(),
      status: "running",
      outputBuffer: "",
    };

    this.sessions.push(session);

    writeToLog(session.logFile, `启动 Claude 终端 ${sessionId} (PTY: ${this.backendType})`);
    writeToLog(session.logFile, `执行命令: ${command}`);
    console.log(formatOutput(sessionId, `启动终端，准备执行: "${command}" (${this.backendType})`));

    const shellPath = getDefaultShell();
    writeToLog(session.logFile, `使用 Shell: ${shellPath}`);

    await this.backend.spawn(terminalId, {
      shell: shellPath,
      cols: 120,
      rows: 40,
      env: {
        CLAUDE_SESSION_ID: String(sessionId),
      },
    });

    this.activeCount++;

    await new Promise((resolve) => setTimeout(resolve, 1000));

    writeToLog(session.logFile, `发送 'claude --dangerously-skip-permissions' 命令启动 Claude CLI`);

    // 构建 Stop hook 配置
    // Windows 路径需要转换为正斜杠，避免 JSON 转义问题
    const hookScriptPath = path.join(process.cwd(), "claude-multi-runner/hooks", "completion-marker.sh").replace(/\\/g, "/");
    const settingsJson = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: hookScriptPath
              }
            ]
          }
        ]
      }
    });

    // 使用 --settings 参数传递 Stop hook 配置
    // 在 bash 中使用单引号包裹 JSON
    const claudeCmd = `claude --dangerously-skip-permissions --settings '${settingsJson}'`;
    writeToLog(session.logFile, `启动命令: ${claudeCmd}`);
    this.backend.write(terminalId, claudeCmd + "\r");

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const claudeReady = await this.waitForClaudeReady(session, 30000);

    if (!claudeReady) {
      writeToLog(session.logFile, `[WARN] Claude 启动超时，额外等待 2 秒后发送命令`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    writeToLog(session.logFile, `发送用户命令到 Claude: "${command}"`);
    // 对于长命令，使用分块发送以避免 PTY 缓冲区限制
    await this.sendCommandInChunks(terminalId, command, session.logFile);
  }

  /**
   * 分块发送命令，避免 PTY 缓冲区限制
   * 对于长命令，将其分成小块发送，每块之间添加延时
   */
  private async sendCommandInChunks(terminalId: string, command: string, logFile: string): Promise<void> {
    const CHUNK_SIZE = 80; // 每块80个字符（一行的最大值）
    const CHUNK_DELAY_MS = 20; // 每块之间的延时（毫秒）
    const COMMAND_END_DELAY_MS = 200; // 发送完命令后的延时

    // 如果命令长度小于阈值，直接发送
    if (command.length <= CHUNK_SIZE) {
      writeToLog(logFile, `[INFO] 命令长度 ${command.length} 字符，直接发送`);
      this.backend!.write(terminalId, command + "\r");
      await new Promise(resolve => setTimeout(resolve, COMMAND_END_DELAY_MS));
      return;
    }

    // 长命令使用分块发送
    writeToLog(logFile, `[INFO] 命令长度 ${command.length} 字符，使用分块发送（每块 ${CHUNK_SIZE} 字符）`);

    // 将命令按块发送
    for (let i = 0; i < command.length; i += CHUNK_SIZE) {
      const chunk = command.slice(i, i + CHUNK_SIZE);
      this.backend!.write(terminalId, chunk);

      if (i + CHUNK_SIZE < command.length) {
        await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }

    // 发送回车执行命令
    writeToLog(logFile, `[INFO] 命令分块发送完成，发送回车执行`);
    this.backend!.write(terminalId, "\r");

    // 等待命令执行
    await new Promise(resolve => setTimeout(resolve, COMMAND_END_DELAY_MS));
  }

  private async waitForClaudeReady(session: ClaudeSession, maxWaitMs: number): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 500;
    const stabilityWaitMs = 3000;  // 检测到特征后等待3秒确保界面稳定

    // 只保留可靠的启动特征，移除容易误匹配的模式（如 dangerously-skip 会匹配命令回显）
    const readyPatterns = [
      /Welcome.*back/i,
      /No.*recent.*activity/i,
      /Usage.*Billing/i,
      /\u2502.*\u2502.*\u2502/i,  // 界面边框（多个竖线）
      /╭.*Claude.*Code.*╮/i,  // Claude Code 界面框
    ];

    let readyDetectedTime = 0;

    while (Date.now() - startTime < maxWaitMs) {
      const buffer = session.outputBuffer;

      // 检测启动特征
      for (const pattern of readyPatterns) {
        if (pattern.test(buffer)) {
          if (readyDetectedTime === 0) {
            readyDetectedTime = Date.now();
            writeToLog(session.logFile, `[INFO] 检测到 Claude 启动特征: ${pattern}`);
          }
          break;
        }
      }

      // 如果检测到特征，等待足够时间确保界面完全渲染
      if (readyDetectedTime > 0) {
        const elapsedSinceReady = Date.now() - readyDetectedTime;
        if (elapsedSinceReady >= stabilityWaitMs) {
          writeToLog(session.logFile, `[INFO] Claude 准备就绪，稳定等待 ${stabilityWaitMs}ms 完成`);
          return true;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    writeToLog(session.logFile, `[WARN] waitForClaudeReady 超时，maxWaitMs: ${maxWaitMs}`);
    return false;
  }

  async runAll(commands: string[]): Promise<void> {
    if (commands.length < this.maxSessions) {
      console.log(
        `\x1b[33m警告: 命令数量(${commands.length})少于终端数量(${this.maxSessions})，部分终端将空闲\x1b[0m`
      );
    }

    const spawnPromises: Promise<void>[] = [];

    for (let i = 0; i < this.maxSessions; i++) {
      const command = commands[i] || commands[0];
      spawnPromises.push(this.spawnClaude(i + 1, command));
    }

    await Promise.all(spawnPromises);

    console.log(`\x1b[36m=== 已启动 ${this.maxSessions} 个 Claude 终端 (${this.backendType}) ===\x1b[0m`);
    console.log(`日志目录: ${LOG_DIR}`);

    await this.waitForCompletion();
  }

  private async waitForCompletion(): Promise<void> {
    const markerDir = path.join(LOG_DIR, ".completion");

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        // 检查每个 running 状态的 session
        for (const session of this.sessions) {
          if (session.status === "running") {
            const markerFile = path.join(markerDir, `completed-${session.id}.marker`);

            // 检查标记文件是否存在
            if (fs.existsSync(markerFile)) {
              session.status = "completed";
              writeToLog(session.logFile, `[INFO] 检测到完成标记文件: ${markerFile}`);
              console.log(formatOutput(session.id, `任务完成 (检测到 Stop hook 标记)`));
              this.activeCount--;

              const endTime = new Date();
              const duration = (endTime.getTime() - session.startTime.getTime()) / 1000;
              writeToLog(
                session.logFile,
                `=== 会话汇总 ===\n开始时间: ${session.startTime.toISOString()}\n结束时间: ${endTime.toISOString()}\n运行时长: ${duration}秒\n命令: ${session.command}\n状态: ${session.status}`
              );

              // 删除标记文件（避免重复检测）
              fs.unlinkSync(markerFile);

              // 强制关闭 bash shell
              this.backend?.kill(session.terminalId);
            }
          }
        }

        if (this.activeCount === 0) {
          clearInterval(checkInterval);
          console.log("\n\x1b[36m=== 所有 Claude 终端已完成 ===\x1b[0m");
          this.printSummary();
          resolve();
        }
      }, 1000);  // 每 1 秒检查一次标记文件
    });
  }

  private printSummary(): void {
    console.log("\n=== 执行汇总 ===");
    for (const session of this.sessions) {
      console.log(
        `终端 ${session.id}: ${session.status} - 日志: ${path.basename(session.logFile)}, 屏幕: ${path.basename(session.screenLogFile || '')}`
      );
    }
    console.log(`\n所有日志保存在: ${LOG_DIR}`);
  }

  killAll(): void {
    if (this.backend) {
      for (const session of this.sessions) {
        if (session.status === "running") {
          writeToLog(session.logFile, "手动终止进程");
          this.backend.kill(session.terminalId);
        }
      }
      this.backend.shutdown();
    }
  }
}