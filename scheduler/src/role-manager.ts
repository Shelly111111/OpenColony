/**
 * 角色配置管理器
 * 从 role.json 加载角色配置，提供角色查询功能
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from "./logger";

export interface RoleConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];
}

export interface RoleConfigFile {
  roles: RoleConfig[];
}

export class RoleManager {
  private configPath: string;
  private roles: Map<string, RoleConfig> = new Map();

  constructor(configPath?: string) {
    // 默认配置文件路径：scheduler/config/role.json
    this.configPath = configPath || path.join(__dirname, '../config/role.json');
    this.loadRoles();
  }

  /**
   * 从配置文件加载角色
   */
  private loadRoles(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        log({ prefix: 'RoleManager', message: `角色配置文件不存在: ${this.configPath}，使用默认配置`, level: 'warn' });
        this.loadDefaultRoles();
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf-8');
      const config: RoleConfigFile = JSON.parse(content);

      for (const role of config.roles) {
        this.roles.set(role.id, role);
      }

      log({ prefix: 'RoleManager', message: `已加载 ${this.roles.size} 个角色配置` });
    } catch (error) {
      log({ prefix: 'RoleManager', message: `加载角色配置失败: ${error}`, level: 'error' });
      this.loadDefaultRoles();
    }
  }

  /**
   * 加载默认角色配置（硬编码的备用方案）
   */
  private loadDefaultRoles(): void {
    const defaultRoles: RoleConfig[] = [
      {
        id: 'general_agent',
        name: '通用Agent',
        description: '通用任务，可以做任何类型的任务',
        systemPrompt: '你是一个通用助手，可以执行各种类型的任务。',
        skills: []
      },
      {
        id: 'code_agent',
        name: '代码Agent',
        description: '代码实现、测试等编程相关任务',
        systemPrompt: '你是一个编程专家。',
        skills: []
      },
      {
        id: 'review_agent',
        name: '评审Agent',
        description: '评审、结果验证等',
        systemPrompt: '你是一个严格的代码评审专家。',
        skills: []
      }
    ];

    for (const role of defaultRoles) {
      this.roles.set(role.id, role);
    }
  }

  /**
   * 获取所有角色ID列表
   */
  getAllRoleIds(): string[] {
    return Array.from(this.roles.keys());
  }

  /**
   * 获取所有角色配置
   */
  getAllRoles(): RoleConfig[] {
    return Array.from(this.roles.values());
  }

  /**
   * 根据ID获取角色配置
   */
  getRole(roleId: string): RoleConfig | undefined {
    return this.roles.get(roleId);
  }

  /**
   * 获取角色描述（用于LLM提示词）
   */
  getRoleDescriptions(): string {
    return this.getAllRoles()
      .map(role => `- ${role.id}：${role.description}`)
      .join('\n');
  }

  /**
   * 添加或更新角色
   */
  addOrUpdateRole(role: RoleConfig): void {
    this.roles.set(role.id, role);
  }

  /**
   * 保存配置到文件
   */
  saveToFile(): void {
    try {
      const config: RoleConfigFile = {
        roles: this.getAllRoles()
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      log({ prefix: 'RoleManager', message: `角色配置已保存到: ${this.configPath}` });
    } catch (error) {
      log({ prefix: 'RoleManager', message: `保存角色配置失败: ${error}`, level: 'error' });
    }
  }
}
