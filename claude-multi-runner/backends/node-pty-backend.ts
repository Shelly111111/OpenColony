/**
 * Node-PTY Backend 实现
 */

import { PtyBackend } from "../types";
import { VirtualScreen } from "./virtual-screen";
import { findGitBashPath } from "../utils/git-bash";
import { log } from "../utils/logger";

let nodePty: typeof import("node-pty") | null = null;

try {
  nodePty = require("node-pty");
} catch (e) {
  log({ logFile: undefined, message: "[pty] node-pty 未安装，请运行 npm install node-pty", level: 'error' });
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

    const cols = options.cols || 120;
    const rows = options.rows || 40;

    // 获取 shell 路径：优先使用传入的 shell，否则自动查找
    const shell = options.shell || (process.platform === "win32" ? findGitBashPath() : null) || process.env.SHELL || "/bin/bash";
    const gitBashPath = process.platform === "win32" ? findGitBashPath() : null;

    // 构建环境变量：不继承父进程的所有环境变量
    // 只传递必要的变量和自定义变量
    const env: Record<string, string> = { ...(options.env || {}) };

    // 从 process.env 中复制必要的环境变量（如果未设置）
    const neededEnvVars = ['PATH', 'HOME', 'USER', 'USERNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL'];
    for (const key of neededEnvVars) {
      if (process.env[key] && !env[key]) {
        env[key] = process.env[key]!;
      }
    }

    const pty = nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: {
        ...env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        CLAUDE_CODE_GIT_BASH_PATH: gitBashPath || process.env.CLAUDE_CODE_GIT_BASH_PATH || "",
      },
    });

    const virtualScreen = this.createVirtualScreen(id, cols, rows);

    const session = {
      pty,
      virtualScreen,
    };
    this.sessions.set(id, session);

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

  /**
   * 创建虚拟屏并设置回调
   */
  private createVirtualScreen(id: string, cols: number, rows: number): VirtualScreen {
    const virtualScreen = new VirtualScreen({ cols, rows });

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

    return virtualScreen;
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
      // 重新创建虚拟屏（包含完整的回调设置）
      session.virtualScreen = this.createVirtualScreen(id, cols, rows);
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