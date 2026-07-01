/**
 * OpenColony 统一入口
 * 根据命令行参数决定启动调度中心还是直接调用Claude PTY
 */

import * as path from "path";
import * as fs from "fs";

function printHelp() {
  console.log(`
OpenColony - Claude CLI调度系统

使用方法:
  npm start run <用户需求>          启动调度中心执行任务
  npm start claude <命令>           直接调用Claude PTY执行命令
  npm start help                    显示帮助信息

示例:
  npm start run "分析当前目录结构"
  npm start claude 1 "查看当前目录" "修复bug"
  npx ts-node claude-multi-runner/main.ts 1 "查看当前目录"
`);
}

async function main() {
  // 正确处理参数：跳过 node、ts-node、脚本名
  let args = process.argv.slice(2);

  // 如果第一个参数是 .ts 或 .js 文件，跳过它
  if (args.length > 0 && (args[0].endsWith('.ts') || args[0].endsWith('.js'))) {
    args = args.slice(1);
  }

  if (args.length === 0 || args[0] === "help") {
    printHelp();
    return;
  }

  const command = args[0];

  switch (command) {
    case "run":
      // 启动调度中心
      const schedulerArgs = args.slice(1);
      if (schedulerArgs.length === 0) {
        console.error("请提供用户需求");
        printHelp();
        process.exit(1);
      }

      // 动态引入scheduler并执行
      try {
        const schedulerPath = path.join(__dirname, "../scheduler/src/index.ts");
        if (!fs.existsSync(schedulerPath)) {
          console.error(`调度中心入口文件不存在: ${schedulerPath}`);
          process.exit(1);
        }

        // 使用子进程方式启动scheduler
        const { spawn } = require("child_process");
        const child = spawn("npx", ["ts-node", schedulerPath, "run", ...schedulerArgs], {
          stdio: "inherit",
          shell: true
        });

        child.on("close", (code: any) => {
          process.exit(code || 0);
        });

        child.on("error", (error: any) => {
          console.error("启动调度中心失败:", error);
          process.exit(1);
        });
      } catch (error) {
        console.error("启动调度中心失败:", error);
        process.exit(1);
      }
      break;

    case "claude":
      // 直接调用Claude PTY
      const claudeArgs = args.slice(1);
      if (claudeArgs.length === 0) {
        console.error("请提供Claude命令");
        printHelp();
        process.exit(1);
      }

      try {
        const claudePath = path.join(__dirname, "../claude-multi-runner/main.ts");
        if (!fs.existsSync(claudePath)) {
          console.error(`Claude PTY入口文件不存在: ${claudePath}`);
          process.exit(1);
        }

        // 重置argv，让claude-multi-runner的CLI解析正常工作
        // 注意：main.ts 期望的第一个参数是终端数量，所以直接传递 claudeArgs
        process.argv = ["node", claudePath, ...claudeArgs];
        require(claudePath);
      } catch (error) {
        console.error("启动Claude PTY失败:", error);
        process.exit(1);
      }
      break;

    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
