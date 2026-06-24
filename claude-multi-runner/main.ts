#!/usr/bin/env npx ts-node

/**
 * Claude Multi-Runner
 *
 * 使用 node-pty (伪终端) 技术，让 Claude CLI 产生完整的交互式输出。
 *
 * 用法:
 *     npx ts-node main.ts <终端数量> <命令1> <命令2> ...
 *
 * 示例:
 *     npx ts-node main.ts 2 "分析当前项目结构" "帮我写一个README"
 */

import { ClaudeUnifiedPtyManager } from "./manager";

function printHelp(): void {
  console.log(`
Claude Multi-Runner - 使用 PTY 技术启动多个 Claude 终端并行执行命令

用法:
    npx ts-node main.ts <终端数量> <命令1> <命令2> ...

参数:
    <终端数量>  - 要启动的 Claude 终端数量 (1-10)
    <命令...>   - 要在每个终端中执行的命令

示例:
    npx ts-node main.ts 2 "分析当前项目结构" "帮我写一个README"
    npx ts-node main.ts 3 "修复这个bug" "添加单元测试" "优化性能"

选项:
    -h, --help  显示帮助信息

技术说明:
    PTY (伪终端) 让程序认为它运行在真正的终端中，从而:
    - 支持完整的 ANSI 颜色输出
    - 支持进度条和状态指示器
    - 支持交互式提示
    - 产生完整的中间过程日志
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help") || args.length === 0) {
    printHelp();
    return;
  }

  const terminalCount = parseInt(args[0], 10);

  if (isNaN(terminalCount) || terminalCount < 1 || terminalCount > 10) {
    console.error("\x1b[31m错误: 终端数量必须是 1-10 之间的数字\x1b[0m");
    printHelp();
    process.exit(1);
  }

  const commands = args.slice(1);

  if (commands.length === 0) {
    console.error("\x1b[31m错误: 请提供至少一个命令\x1b[0m");
    printHelp();
    process.exit(1);
  }

  console.log(`
\x1b[36m╔══════════════════════════════════════════╗
║     Claude Unified PTY Runner              ║
║     启动 ${terminalCount} 个终端并行执行任务       ║
╚══════════════════════════════════════════╝\x1b[0m
`);

  const manager = new ClaudeUnifiedPtyManager(terminalCount);

  process.on("SIGINT", () => {
    console.log("\n\x1b[33m正在终止所有终端...\x1b[0m");
    manager.killAll();
    process.exit(0);
  });

  try {
    await manager.initialize();
    await manager.runAll(commands);
  } catch (err) {
    console.error("\x1b[31m执行错误:\x1b[0m", err);
    manager.killAll();
    process.exit(1);
  }
}

main().catch(console.error);