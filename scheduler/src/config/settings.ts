/**
 * 调度中心公共设置配置
 */

import * as fs from "fs";
import * as path from "path";
import { PermissionMode } from "../types";

export interface TaskExecutionSettings {
  sameLayerAsync: boolean;
  maxConcurrency: number;
  taskTimeout: number;
  maxLoopRounds: number;
  loopConfidenceThreshold: number;
}

export interface AppSettings {
  taskExecution: TaskExecutionSettings;
  permissionMode: PermissionMode;
  permissionTimeoutMs: number; // 权限审批等待超时（毫秒）
}

const defaultSettings: AppSettings = {
  taskExecution: {
    sameLayerAsync: true,
    maxConcurrency: 5,
    taskTimeout: 600000,
    maxLoopRounds: 5,
    loopConfidenceThreshold: 0.8,
  },
  permissionMode: PermissionMode.ASK,
  permissionTimeoutMs: 120000,
};

const SETTINGS_FILE_PATH = path.resolve(__dirname, '../../config/settings.json');

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

export function loadSettings(
  overrides?: Partial<AppSettings>
): AppSettings {
  const settings = { ...defaultSettings };

  const fileSettings = loadSettingsFromFile();
  if (fileSettings) {
    deepMerge(settings, fileSettings);
  }

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

  if (process.env.PERMISSION_MODE !== undefined) {
    const mode = process.env.PERMISSION_MODE.toLowerCase();
    if (mode === 'auto' || mode === 'ask' || mode === 'bypass') {
      settings.permissionMode = mode as PermissionMode;
    }
  }

  if (process.env.PERMISSION_TIMEOUT_MS !== undefined) {
    const ms = parseInt(process.env.PERMISSION_TIMEOUT_MS, 10);
    if (ms > 0) {
      settings.permissionTimeoutMs = ms;
    }
  }

  if (overrides) {
    deepMerge(settings, overrides);
  }

  return settings;
}

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
