#!/usr/bin/env npx ts-node

/**
 * Claude Multi-Runner
 *
 * 支持两种模式调用 Claude:
 * 1. SDK 模式 (默认): 使用 Anthropic SDK 直接调用 Claude API
 * 2. PTY 模式: 使用 node-pty 启动 Claude CLI 交互式终端
 *
 * 用法:
 *     npx ts-node main.ts [sdk|pty] <终端数量> <命令1> <命令2> ...
 *
 * 示例:
 *     npx ts-node main.ts 2 "分析当前项目结构" "帮我写一个README"
 *     npx ts-node main.ts pty 2 "分析项目"
 */

import { ClaudeUnifiedPtyManager, ClaudeRunMode } from "./manager";
import { log } from "./utils/logger";

function printHelp(): void {
  console.log(`
Claude Multi-Runner - 支持 SDK 和 PTY 两种模式调用 Claude

用法:
    npx ts-node main.ts [sdk|pty] <终端数量> <命令1> <命令2> ...

参数:
    [sdk|pty]  - 运行模式 (可选，默认: sdk)
                  sdk: 使用 Anthropic SDK 直接调用 API
                  pty: 使用 PTY 启动 Claude CLI 交互式终端
    <终端数量>  - 要启动的 Claude 终端数量 (1-10)
    <命令...>   - 要在每个终端中执行的命令

示例:
    npx ts-node main.ts 2 "分析当前项目结构" "帮我写一个README"
    npx ts-node main.ts pty 2 "分析项目"
    npx ts-node main.ts sdk 3 "修复bug" "添加测试" "优化性能"

选项:
    -h, --help  显示帮助信息

模式说明:
    SDK 模式 (默认):
    - 直接调用 Anthropic API
    - 无需安装 Claude CLI
    - 响应更快，适合自动化场景

    PTY 模式:
    - 使用伪终端运行 Claude CLI
    - 支持完整的 ANSI 颜色输出
    - 支持交互式提示和进度条
    - 产生完整的中间过程日志
`);
}

async function main(): Promise<void> {
  let args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help") || args.length === 0) {
    printHelp();
    return;
  }

  // 解析模式参数（第一个参数可以是 sdk 或 pty）
  let mode: ClaudeRunMode = 'sdk'; // 默认使用 SDK 模式

  if (args[0] === 'sdk' || args[0] === 'pty') {
    mode = args[0];
    args = args.slice(1);
  }

  const terminalCount = parseInt(args[0], 10);

  if (isNaN(terminalCount) || terminalCount < 1 || terminalCount > 10) {
    log({ logFile: undefined, message: "错误: 终端数量必须是 1-10 之间的数字", level: 'error' });
    printHelp();
    process.exit(1);
  }

  const commands = args.slice(1);

  if (commands.length === 0) {
    log({ logFile: undefined, message: "错误: 请提供至少一个命令", level: 'error' });
    printHelp();
    process.exit(1);
  }

  const modeText = mode === 'sdk' ? 'SDK (API)' : 'PTY (CLI)';
  console.log(`
\x1b[36m╔══════════════════════════════════════════╗
║     Claude Multi-Runner                    ║
║     模式: ${modeText.padEnd(20)}║
║     启动 ${terminalCount} 个终端并行执行任务       ║
╚══════════════════════════════════════════╝\x1b[0m
`);

  const manager = new ClaudeUnifiedPtyManager(terminalCount, mode);

  process.on("SIGINT", () => {
    log({ logFile: undefined, message: "正在终止所有终端...", level: 'warn' });
    manager.killAll();
    process.exit(0);
  });

  try {
    await manager.initialize();
    await manager.runAll(commands);
  } catch (err) {
    log({ logFile: undefined, message: `执行错误: ${err}`, level: 'error' });
    manager.killAll();
    process.exit(1);
  }
}

main().catch(console.error);