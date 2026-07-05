/**
 * 调度中心公共设置配置
 * 用于存储项目的公共设置，包括任务执行方式、并发控制等
 * 设置从 config/settings.json 加载，支持环境变量覆盖
 */

import * as fs from "fs";
import * as path from "path";

/**
 * 任务执行设置
 */
export interface TaskExecutionSettings {
  /** 同层任务是否异步执行（true=异步并行, false=同步串行） */
  sameLayerAsync: boolean;
  /** 最大并发任务数（仅当 sameLayerAsync=true 时有效） */
  maxConcurrency: number;
  /** 任务执行超时时间（毫秒） */
  taskTimeout: number;
}

/**
 * DAG 调度设置
 */
export interface DAGSchedulingSettings {
  /** 是否启用 DAG 模式 */
  enabled: boolean;
  /** 是否自动检测任务依赖 */
  autoDetectDependencies: boolean;
  /** 失败处理策略 */
  onFailure: 'stop-all' | 'continue' | 'retry';
}

/**
 * 日志设置
 */
export interface LoggingSettings {
  /** 是否启用详细日志 */
  verbose: boolean;
  /** 日志目录路径 */
  logDir: string;
  /** 是否保存任务输出到单独文件 */
  saveTaskOutput: boolean;
}

/**
 * 重试设置
 */
export interface RetrySettings {
  /** 任务失败是否重试 */
  enableRetry: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟（毫秒） */
  retryDelay: number;
}

/**
 * 应用设置
 */
export interface AppSettings {
  taskExecution: TaskExecutionSettings;
  dagScheduling: DAGSchedulingSettings;
  logging: LoggingSettings;
  retry: RetrySettings;
}

/** 默认设置（fallback） */
const defaultSettings: AppSettings = {
  taskExecution: {
    sameLayerAsync: true,
    maxConcurrency: 5,
    taskTimeout: 600000,  // 10分钟
  },
  dagScheduling: {
    enabled: true,
    autoDetectDependencies: false,
    onFailure: 'stop-all',
  },
  logging: {
    verbose: false,
    logDir: './logs',
    saveTaskOutput: true,
  },
  retry: {
    enableRetry: false,
    maxRetries: 3,
    retryDelay: 1000,
  },
};

/** 设置文件路径 */
const SETTINGS_FILE_PATH = path.resolve(__dirname, '../../config/settings.json');

/**
 * 从 JSON 文件加载设置
 */
function loadSettingsFromFile(): Partial<AppSettings> | null {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const content = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      return parsed as Partial<AppSettings>;
    }
  } catch (error) {
    console.warn(`[Settings] 加载设置文件失败: ${error}`);
  }
  return null;
}

/**
 * 加载设置
 * 优先级：环境变量 > JSON配置文件 > 默认值
 */
export function loadSettings(
  overrides?: Partial<AppSettings>
): AppSettings {
  // 1. 从默认值开始
  const settings = { ...defaultSettings };

  // 2. 从 JSON 文件加载
  const fileSettings = loadSettingsFromFile();
  if (fileSettings) {
    deepMerge(settings, fileSettings);
  }

  // 3. 从环境变量读取覆盖
  if (process.env.SAME_LAYER_ASYNC !== undefined) {
    settings.taskExecution.sameLayerAsync =
      process.env.SAME_LAYER_ASYNC === 'true';
  }
  if (process.env.MAX_CONCURRENCY !== undefined) {
    settings.taskExecution.maxConcurrency = parseInt(
      process.env.MAX_CONCURRENCY,
      10
    );
  }

  // 4. 应用代码中的覆盖
  if (overrides) {
    deepMerge(settings, overrides);
  }

  return settings;
}

/**
 * 简单深合并
 */
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target } as any;
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue &&
      targetValue &&
      typeof sourceValue === 'object' &&
      typeof targetValue === 'object' &&
      !Array.isArray(sourceValue) &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, any>,
        sourceValue as Record<string, any>
      );
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }
  return result as T;
}
