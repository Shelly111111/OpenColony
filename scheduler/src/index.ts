/**
 * 调度中心主入口
 */

import { MasterScheduler } from "./master";
import { TaskPriority, ArbitrationMode } from "./types";

// 导出所有公共类型和类
export * from "./types";
export { MasterScheduler } from "./master";
export { PlanExecutor } from "./plan-executor";
export { WorkerManager } from "./worker-manager";
export { ArbitrationEngine } from "./arbitration-engine";

/**
 * CLI 入口
 */
async function main() {
  const args = process.argv.slice(2);

  // 如果没有参数或参数为空，进入默认模式（SDK模式）
  if (args.length === 0) {
    await runDefaultMode('sdk');
    return;
  }

  // 检查第一个参数是否是模式参数
  const firstArg = args[0];
  let mode: 'sdk' | 'pty' = 'sdk'; // 默认SDK模式
  let taskArgs: string[];

  if (firstArg === 'sdk' || firstArg === 'pty') {
    mode = firstArg;
    taskArgs = args.slice(1);
  } else {
    taskArgs = args;
  }

  // 如果没有剩余参数，进入默认模式
  if (taskArgs.length === 0) {
    await runDefaultMode(mode);
    return;
  }

  // 检查剩余参数是否是命令
  const nextArg = taskArgs[0];
  const isCommand = ['run', 'test', 'default', 'help'].includes(nextArg);

  if (!isCommand) {
    // 如果不是命令，则将所有参数作为任务描述，进入默认模式执行
    const userRequest = taskArgs.join(' ');
    await runDefaultMode(mode, userRequest);
    return;
  }

  // 如果是命令，按原来的逻辑处理
  switch (nextArg) {
    case "run":
      await runCommand(taskArgs.slice(1));
      break;
    case "test":
      await runTest();
      break;
    case "default":
      await runDefaultMode(mode);
      break;
    case "help":
    default:
      printHelp();
      break;
  }
}

/**
 * 默认模式 - 使用默认配置启动调度中心
 * @param mode 运行模式：sdk 或 pty
 * @param userRequest 可选的任务请求，如果提供则执行该任务
 */
async function runDefaultMode(mode: 'sdk' | 'pty' = 'sdk', userRequest?: string) {
  console.log(`=== 调度中心默认模式 (${mode.toUpperCase()}模式) ===\n`);

  // 使用默认配置创建调度器
  const scheduler = new MasterScheduler({
    maxWorkers: 3,
    arbitrationMode: 'confidence_vote' as ArbitrationMode,
    enableReview: true,
    workerTypes: ['general_agent', 'code_agent', 'review_agent'],
    runMode: mode // 设置运行模式
  });

  try {
    console.log(`调度中心已启动\n`);
    console.log(`配置信息:`);
    console.log(`- 最大Worker数: 3`);
    console.log(`- 仲裁模式: confidence_vote`);
    console.log(`- 评审功能: 已启用`);

    // 如果提供了任务请求，执行该任务
    if (userRequest) {
      console.log(`\n=== 执行任务 ===`);
      console.log(`需求: ${userRequest}`);
      console.log(`==================\n`);

      const result = await scheduler.submitRequest(userRequest, {
        name: "默认模式任务",
        priority: TaskPriority.P1
      });

      console.log(`\n=== 任务执行完成 ===`);
      console.log(`状态: ${result.success ? "成功" : "失败"}`);
      console.log(`TraceID: ${result.traceId}`);
      console.log(`耗时: ${result.duration.toFixed(2)} 秒`);
      console.log(`==================\n`);

      if (result.success) {
        console.log(`输出结果:`);
        if (typeof result.data === "string") {
          console.log(result.data);
        } else {
          console.log(JSON.stringify(result.data, null, 2));
        }
      } else {
        console.error(`错误信息: ${result.error}`);
      }

      // 任务执行完成后关闭调度器
      await scheduler.shutdown();
      return;
    }

    // 没有任务请求时，保持运行
    console.log(`\n提示: 使用 'npm start run "任务描述"' 提交任务\n`);
    console.log(`调度中心正在运行，按 Ctrl+C 停止...\n`);

    // 保持进程运行
    await new Promise(() => {});

  } catch (error) {
    console.error(`调度中心运行异常: ${error}`);
  } finally {
    await scheduler.shutdown();
  }
}

/**
 * 打印帮助信息
 */
function printHelp() {
  console.log(`
调度中心 - Master调度集群 + Plan-Executor + Harness三层嵌套融合架构

使用方法:
  ts-node src/index.ts                    启动调度中心（默认模式）
  ts-node src/index.ts run <用户需求> [选项]    运行一个任务（CLI模式）
  ts-node src/index.ts test                    运行测试用例
  ts-node src/index.ts help                    显示帮助信息

默认模式:
  直接运行不带参数的脚本将进入默认模式，使用默认配置启动调度中心。

CLI模式选项:
  --name <任务名称>        任务名称
  --priority <优先级>      任务优先级 (P0/P1/P2, 默认: P1)
  --workers <数量>         最大Worker数量 (默认: 3)
  --mode <仲裁模式>        仲裁模式 (confidence_vote/agent_priority/merge_diff, 默认: confidence_vote)
  --no-review              禁用独立评审
`);
}

/**
 * 运行任务命令
 */
async function runCommand(args: string[]) {
  let userRequest = "";
  const options: {
    name?: string;
    priority?: TaskPriority;
    maxWorkers?: number;
    arbitrationMode?: ArbitrationMode;
    enableReview?: boolean;
  } = {};

  // 解析参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      switch (arg) {
        case "--name":
          options.name = args[++i];
          break;
        case "--priority":
          const priority = args[++i].toUpperCase();
          if (["P0", "P1", "P2"].includes(priority)) {
            options.priority = priority as TaskPriority;
          } else {
            console.error(`无效的优先级: ${priority}，使用默认值 P1`);
          }
          break;
        case "--workers":
          const workers = parseInt(args[++i]);
          if (!isNaN(workers) && workers > 0) {
            options.maxWorkers = workers;
          } else {
            console.error(`无效的Worker数量: ${args[i]}，使用默认值 3`);
          }
          break;
        case "--mode":
          const mode = args[++i];
          if (["confidence_vote", "agent_priority", "merge_diff"].includes(mode)) {
            options.arbitrationMode = mode as ArbitrationMode;
          } else {
            console.error(`无效的仲裁模式: ${mode}，使用默认值 confidence_vote`);
          }
          break;
        case "--no-review":
          options.enableReview = false;
          break;
        default:
          console.warn(`未知选项: ${arg}`);
          break;
      }
    } else {
      userRequest = arg;
      // 处理带空格的需求
      for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) {
        userRequest += " " + args[j];
        i = j;
      }
    }
  }

  if (!userRequest) {
    console.error("请提供用户需求");
    printHelp();
    process.exit(1);
  }

  // 创建调度器
  const scheduler = new MasterScheduler({
    maxWorkers: options.maxWorkers,
    arbitrationMode: options.arbitrationMode,
    enableReview: options.enableReview !== undefined ? options.enableReview : true,
    workerTypes: ['general_agent', 'code_agent', 'review_agent']
  });

  try {
    console.log(`\n=== 开始执行任务 ===`);
    console.log(`需求: ${userRequest}`);
    if (options.name) console.log(`名称: ${options.name}`);
    if (options.priority) console.log(`优先级: ${options.priority}`);
    console.log(`==================\n`);

    // 提交任务
    const result = await scheduler.submitRequest(userRequest, {
      name: options.name,
      priority: options.priority
    });

    console.log(`\n=== 任务执行完成 ===`);
    console.log(`状态: ${result.success ? "成功" : "失败"}`);
    console.log(`TraceID: ${result.traceId}`);
    console.log(`耗时: ${result.duration.toFixed(2)} 秒`);
    console.log(`==================\n`);

    if (result.success) {
      console.log(`输出结果:`);
      if (typeof result.data === "string") {
        console.log(result.data);
      } else {
        console.log(JSON.stringify(result.data, null, 2));
      }
    } else {
      console.error(`错误信息: ${result.error}`);
    }

  } catch (error) {
    console.error(`任务执行异常: ${error}`);
  } finally {
    await scheduler.shutdown();
  }
}

/**
 * 运行测试用例
 */
async function runTest() {
  console.log(`=== 运行测试用例 ===\n`);

  // 创建调度器
  const scheduler = new MasterScheduler({
    maxWorkers: 2,
    enableReview: false,
    workerTypes: ['general_agent']
  });

  try {
    // 测试任务：简单的需求分析
    const testRequest = "请分析调度中心项目的技术架构，列出主要模块和功能";

    console.log(`测试需求: ${testRequest}`);
    console.log(`开始执行测试任务...\n`);

    const result = await scheduler.submitRequest(testRequest, {
      name: "架构分析测试任务",
      priority: TaskPriority.P1
    });

    console.log(`\n测试结果:`);
    console.log(`状态: ${result.success ? "成功" : "失败"}`);
    console.log(`TraceID: ${result.traceId}`);
    console.log(`耗时: ${result.duration.toFixed(2)} 秒\n`);

    if (result.success) {
      console.log(`输出:`);
      console.log(typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2));
    } else {
      console.error(`错误: ${result.error}`);
    }

  } catch (error) {
    console.error(`测试异常: ${error}`);
  } finally {
    await scheduler.shutdown();
  }

  console.log(`\n=== 测试完成 ===`);
}

// 如果直接运行该文件，执行main函数
if (require.main === module) {
  main().catch(console.error);
}
