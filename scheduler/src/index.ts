/**
 * 调度中心主入口
 */

import { MasterScheduler } from "./master";
import { TaskPriority, ArbitrationMode, InjectionRoute, InjectionTiming, InjectionRequest } from "./types";
import { log } from "./logger";
import { MessageDB } from "./message-db";
import * as readline from "readline";

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
  const isCommand = ['run', 'test', 'default', 'query-logs', 'help'].includes(nextArg);

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
    case "query-logs":
      runQueryLogs(taskArgs.slice(1));
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
 * 启动 stdin 监听器，接收 Tauri 发来的补充信息注入命令
 *
 * 通信协议：
 * - Tauri 写入: __INJECT__:<json>\n
 * - Tauri 写入: __PERM_RESP__:<json>\n  （权限审批响应）
 * - scheduler 输出: __INJECT_RESULT__:<json>\n
 *
 * json 字段: request_id, trace_id, content, target_worker_type, route, urgent
 */
function startStdinListener(scheduler: MasterScheduler): { stop: () => void } {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    // 权限审批响应
    const permPrefix = '__PERM_RESP__:';
    if (line.startsWith(permPrefix)) {
      const jsonStr = line.slice(permPrefix.length);
      try {
        const decision = JSON.parse(jsonStr);
        // 调用 sdk-client 暴露的全局 resolve 函数
        if (typeof (globalThis as any).__resolvePermission === 'function') {
          (globalThis as any).__resolvePermission(decision);
        }
      } catch {
        log({ message: `stdin 权限审批响应 JSON 解析失败: ${jsonStr}`, level: 'error', silent: true });
      }
      return;
    }

    // 补充信息注入
    const prefix = '__INJECT__:';
    if (!line.startsWith(prefix)) return;

    const jsonStr = line.slice(prefix.length);
    let cmd: any;
    try {
      cmd = JSON.parse(jsonStr);
    } catch {
      log({ message: `stdin 注入命令 JSON 解析失败: ${jsonStr}`, level: 'error' });
      return;
    }

    log({ message: `收到补充信息注入请求: request_id=${cmd.request_id}, content="${(cmd.content || '').slice(0, 80)}..."` });

    try {
      // 构造注入请求
      const request: InjectionRequest = {
        traceId: cmd.trace_id || '',
        content: cmd.content || '',
        targetWorkerType: cmd.target_worker_type || undefined,
        route: cmd.route as InjectionRoute | undefined,
        urgent: cmd.urgent || false,
      };

      const result = await scheduler.injectSupplementaryInfo(request);

      // 输出结果到 stdout，供 Tauri 解析
      process.stdout.write(`__INJECT_RESULT__:${JSON.stringify({
        request_id: cmd.request_id,
        success: true,
        status: result.status,
        statusCode: result.statusCode,
        route: result.route,
        routeDetail: result.routeDetail,
        messageIds: result.messageIds,
        candidates: result.candidates?.map(w => ({ id: w.id, type: w.type, status: w.status })),
        error: result.error,
      })}\n`);
    } catch (error) {
      process.stdout.write(`__INJECT_RESULT__:${JSON.stringify({
        request_id: cmd.request_id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  });

  return {
    stop: () => rl.close(),
  };
}

/**
 * 默认模式 - 使用默认配置启动调度中心
 * @param mode 运行模式：sdk 或 pty
 * @param userRequest 可选的任务请求，如果提供则执行该任务
 */
async function runDefaultMode(mode: 'sdk' | 'pty' = 'sdk', userRequest?: string) {
  log({ message: `=== 调度中心默认模式 (${mode.toUpperCase()}模式) ===` });

  // 使用默认配置创建调度器
  const scheduler = new MasterScheduler({
    maxWorkers: 3,
    arbitrationMode: 'confidence_vote' as ArbitrationMode,
    enableReview: true,
    workerTypes: ['general_agent', 'code_agent', 'review_agent'],
    runMode: mode // 设置运行模式
  });

  let shutdownResolve: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

  const handleShutdown = async () => {
    log({ message: `收到停止信号，正在关闭调度中心...` });
    if (shutdownResolve) {
      shutdownResolve();
    }
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    log({ message: `调度中心已启动` });
    log({ message: `配置信息:` });
    log({ message: `- 最大Worker数: 3` });
    log({ message: `- 仲裁模式: confidence_vote` });
    log({ message: `- 评审功能: 已启用` });

    // 如果提供了任务请求，执行该任务
    if (userRequest) {
      log({ message: `\n=== 执行任务 ===` });
      log({ message: `需求: ${userRequest}` });
      log({ message: `==================` });

      // 启动 stdin 监听器，接收 Tauri 的补充信息注入命令
      const stdinListener = startStdinListener(scheduler);

      const result = await scheduler.submitRequest(userRequest, {
        name: "默认模式任务",
        priority: TaskPriority.P1
      });

      // 任务完成后停止 stdin 监听
      stdinListener.stop();

      log({ message: `\n=== 任务执行完成 ===` });
      log({ message: `状态: ${result.success ? "成功" : "失败"}` });
      log({ message: `TraceID: ${result.traceId}` });
      log({ message: `耗时: ${result.duration.toFixed(2)} 秒` });
      log({ message: `==================` });

      if (result.success) {
        log({ message: `输出结果:` });
        if (typeof result.data === "string") {
          log({ message: result.data });
        } else {
          log({ message: JSON.stringify(result.data, null, 2) });
        }
      } else {
        log({ message: `错误信息: ${result.error}`, level: 'error' });
      }

      // 任务执行完成后关闭调度器
      await scheduler.shutdown();
      return;
    }

    // 没有任务请求时，保持运行
    log({ message: `\n提示: 使用 'npm start run "任务描述"' 提交任务` });
    log({ message: `调度中心正在运行，按 Ctrl+C 停止...` });

    // 保持进程运行，等待停止信号
    await shutdownPromise;

  } catch (error) {
    log({ message: `调度中心运行异常: ${error}`, level: 'error' });
  } finally {
    process.removeListener('SIGINT', handleShutdown);
    process.removeListener('SIGTERM', handleShutdown);
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
            log({ message: `无效的优先级: ${priority}，使用默认值 P1`, level: 'error' });
          }
          break;
        case "--workers":
          const workers = parseInt(args[++i]);
          if (!isNaN(workers) && workers > 0) {
            options.maxWorkers = workers;
          } else {
            log({ message: `无效的Worker数量: ${args[i]}，使用默认值 3`, level: 'error' });
          }
          break;
        case "--mode":
          const mode = args[++i];
          if (["confidence_vote", "agent_priority", "merge_diff"].includes(mode)) {
            options.arbitrationMode = mode as ArbitrationMode;
          } else {
            log({ message: `无效的仲裁模式: ${mode}，使用默认值 confidence_vote`, level: 'error' });
          }
          break;
        case "--no-review":
          options.enableReview = false;
          break;
        default:
          log({ message: `未知选项: ${arg}`, level: 'warn' });
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
    log({ message: "请提供用户需求", level: 'error' });
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
    log({ message: `\n=== 开始执行任务 ===` });
    log({ message: `需求: ${userRequest}` });
    if (options.name) log({ message: `名称: ${options.name}` });
    if (options.priority) log({ message: `优先级: ${options.priority}` });
    log({ message: `==================` });

    // 提交任务
    const result = await scheduler.submitRequest(userRequest, {
      name: options.name,
      priority: options.priority
    });

    log({ message: `\n=== 任务执行完成 ===` });
    log({ message: `状态: ${result.success ? "成功" : "失败"}` });
    log({ message: `TraceID: ${result.traceId}` });
    log({ message: `耗时: ${result.duration.toFixed(2)} 秒` });
    log({ message: `==================` });

    if (result.success) {
      log({ message: `输出结果:` });
      if (typeof result.data === "string") {
        log({ message: result.data });
      } else {
        log({ message: JSON.stringify(result.data, null, 2) });
      }
    } else {
      log({ message: `错误信息: ${result.error}`, level: 'error' });
    }

  } catch (error) {
    log({ message: `任务执行异常: ${error}`, level: 'error' });
  } finally {
    await scheduler.shutdown();
  }
}

/**
 * 查询日志数据库
 * 用法: query-logs [traceId] [--list]
 *   --list: 列出所有 traceId
 *   traceId: 查询指定 traceId 的日志
 */
function runQueryLogs(args: string[]): void {
  const db = new MessageDB();

  try {
    if (args.includes('--list') || args.length === 0) {
      // 列出所有 traceId
      const traces = db.getLogTraceIds();
      console.log(JSON.stringify(traces));
    } else {
      // 查询指定 traceId 的日志
      const traceId = args.find(a => !a.startsWith('--')) || '';
      const logs = db.getLogsByTraceId(traceId);
      console.log(JSON.stringify(logs));
    }
  } finally {
    db.close();
  }
}

/**
 * 运行测试用例
 */
async function runTest() {
  log({ message: `=== 运行测试用例 ===` });

  // 创建调度器
  const scheduler = new MasterScheduler({
    maxWorkers: 2,
    enableReview: false,
    workerTypes: ['general_agent']
  });

  try {
    // 测试任务：简单的需求分析
    const testRequest = "请分析调度中心项目的技术架构，列出主要模块和功能";

    log({ message: `测试需求: ${testRequest}` });
    log({ message: `开始执行测试任务...` });

    const result = await scheduler.submitRequest(testRequest, {
      name: "架构分析测试任务",
      priority: TaskPriority.P1
    });

    log({ message: `\n测试结果:` });
    log({ message: `状态: ${result.success ? "成功" : "失败"}` });
    log({ message: `TraceID: ${result.traceId}` });
    log({ message: `耗时: ${result.duration.toFixed(2)} 秒` });

    if (result.success) {
      log({ message: `输出:` });
      log({ message: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2) });
    } else {
      log({ message: `错误: ${result.error}`, level: 'error' });
    }

  } catch (error) {
    log({ message: `测试异常: ${error}`, level: 'error' });
  } finally {
    await scheduler.shutdown();
  }

  log({ message: `\n=== 测试完成 ===` });
}

// 如果直接运行该文件，执行main函数
if (require.main === module) {
  main().catch(console.error);
}
