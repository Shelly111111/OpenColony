/**
 * Node-PTY Backend 实现
 */

import * as fs from "fs";
import { PtyBackend } from "../types";
import { VirtualScreen } from "../virtual-screen";

let nodePty: typeof import("node-pty") | null = null;

try {
  nodePty = require("node-pty");
} catch (e) {
  console.error("[pty] node-pty 未安装，请运行 npm install node-pty");
}

export class NodePtyBackend implements PtyBackend {
  type: "node-pty" = "node-pty";

  private sessions = new Map<string, {
    pty: import("node-pty").IPty;
    virtualScreen: VirtualScreen;
  }>();

  onExit?: (id: string, code: number) => void;
  onError?: (id: string, message: string) => void;
  onData?: (id: string, data: string) => void;
  onDiff?: (id: string, changedLines: { row: number; content: string }[]) => void;

  async spawn(id: string, options: {
    shell?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  } = {}): Promise<void> {
    if (!nodePty) {
      throw new Error("node-pty 未安装");
    }

    const shell = options.shell || this.getDefaultShell();
    const cols = options.cols || 120;
    const rows = options.rows || 40;

    const gitBashPath = this.getGitBashPath();

    const pty = nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,  // 合合传入的环境变量
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        CLAUDE_CODE_GIT_BASH_PATH: gitBashPath || process.env.CLAUDE_CODE_GIT_BASH_PATH || "",
      },
    });

    const virtualScreen = new VirtualScreen({ cols, rows });

    const session = {
      pty,
      virtualScreen,
    };
    this.sessions.set(id, session);

    // 设置虚拟屏回调：每次屏幕更新，输出完整屏幕内容
    virtualScreen.setScreenUpdateCallback((fullScreen: string) => {
      if (this.onData) {
        this.onData(id, fullScreen);
      }
    });

    // 设置 diff 回调：输出变化的行
    virtualScreen.setDiffUpdateCallback((changedLines: { row: number; content: string }[]) => {
      if (this.onDiff) {
        this.onDiff(id, changedLines);
      }
    });

    // 处理 pty 数据，更新虚拟屏
    pty.onData((data: string) => {
      virtualScreen.process(data);
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.sessions.delete(id);
      if (this.onExit) {
        this.onExit(id, exitCode);
      }
    });
  }

  private getGitBashPath(): string | null {
    if (process.platform !== "win32") return null;

    const commonPaths = [
      "D:\\Program Files\\Git\\bin\\bash.exe",
      "D:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  private getDefaultShell(): string {
    if (process.platform === "win32") {
      const gitBashPath = this.getGitBashPath();
      if (gitBashPath) {
        return gitBashPath;
      }
      return process.env.COMSPEC || "cmd.exe";
    }
    return process.env.SHELL || "/bin/bash";
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.write(data);
    }
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.resize(cols, rows);
      // 重新创建虚拟屏
      session.virtualScreen = new VirtualScreen({ cols, rows });
      session.virtualScreen.setScreenUpdateCallback((fullScreen: string) => {
        if (this.onData) {
          this.onData(id, fullScreen);
        }
      });
    }
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.kill();
      this.sessions.delete(id);
    }
  }

  shutdown(): void {
    for (const [, session] of this.sessions) {
      session.pty.kill();
    }
    this.sessions.clear();
  }
}

export function isNodePtyAvailable(): boolean {
  return nodePty !== null;
}