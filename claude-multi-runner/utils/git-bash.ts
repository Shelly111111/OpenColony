/**
 * Git Bash 工具 - 统一的 Git Bash 路径查找逻辑
 */

import * as fs from "fs";
import * as path from "path";

/**
 * 获取 Git Bash 路径
 * @returns Git Bash 路径，如果未找到则返回 null
 */
export function findGitBashPath(): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  // 优先使用环境变量
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  }

  // 从 PATH 中查找 git.exe 并推导 bash 路径
  const gitExePath = findGitFromPath();
  if (gitExePath) {
    const gitDir = path.dirname(path.dirname(gitExePath));
    const bashPaths = [
      path.join(gitDir, "bin", "bash.exe"),
      path.join(gitDir, "usr", "bin", "bash.exe"),
    ];
    for (const p of bashPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }

  // 检查常见安装路径
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

/**
 * 获取默认 Shell 路径
 * @returns Shell 路径
 */
export function getDefaultShell(): string {
  if (process.platform === "win32") {
    const gitBashPath = findGitBashPath();
    if (gitBashPath) {
      return gitBashPath;
    }
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

/**
 * 从 PATH 环境变量中查找 git.exe
 */
function findGitFromPath(): string | null {
  try {
    const pathEnv = process.env.PATH || "";
    const pathDirs = pathEnv.split(";");

    for (const dir of pathDirs) {
      const gitExe = path.join(dir, "git.exe");
      if (fs.existsSync(gitExe)) {
        return gitExe;
      }
    }
  } catch {
    // ignore
  }
  return null;
}