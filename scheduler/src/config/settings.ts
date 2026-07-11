/**
 * 调度中心公共设置配置
 */

import * as fs from "fs";
import * as path from "path";

export interface TaskExecutionSettings {
  sameLayerAsync: boolean;
  maxConcurrency: number;
  taskTimeout: number;
}

export interface AppSettings {
  taskExecution: TaskExecutionSettings;
}

const defaultSettings: AppSettings = {
  taskExecution: {
    sameLayerAsync: true,
    maxConcurrency: 5,
    taskTimeout: 600000,
  },
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
