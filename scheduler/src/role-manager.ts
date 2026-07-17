/**
 * 角色配置管理器
 * 从 role.json 加载角色配置，提供角色查询功能
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from "./logger";

export interface PluginBind {
  plugin: string;
  skills: string[];
}

export interface RoleConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];
  plugins: PluginBind[];
}

// 技能数据结构（与 skill.json 对齐）
interface SkillItem {
  id: string;
  name: string;
  description: string;
  category: string;
  sub_skills?: SkillItem[];
}

interface SkillConfigFile {
  skills: SkillItem[];
}

export interface RoleConfigFile {
  roles: RoleConfig[];
}

export class RoleManager {
  private configPath: string;
  private roles: Map<string, RoleConfig> = new Map();
  private allSkills: SkillItem[] = [];

  constructor(configPath?: string) {
    // 默认配置文件路径：scheduler/config/role.json
    this.configPath = configPath || path.join(__dirname, '../config/role.json');
    this.loadRoles();
    this.loadSkills();
  }

  /**
   * 从 skill.json 加载技能数据
   */
  private loadSkills(): void {
    try {
      const skillPath = path.join(__dirname, '../config/skill.json');
      if (!fs.existsSync(skillPath)) {
        log({ prefix: 'RoleManager', message: `技能配置文件不存在: ${skillPath}`, level: 'warn' });
        return;
      }
      const content = fs.readFileSync(skillPath, 'utf-8');
      const config: SkillConfigFile = JSON.parse(content);
      this.allSkills = config.skills || [];
      log({ prefix: 'RoleManager', message: `已加载 ${this.allSkills.length} 个技能配置` });
    } catch (error) {
      log({ prefix: 'RoleManager', message: `加载技能配置失败: ${error}`, level: 'error' });
    }
  }

  /**
   * 根据技能ID查找技能信息（支持纯技能和插件子技能）
   * 返回 { id, description } 格式，id 为技能标识，description 为技能描述
   */
  private resolveSkillInfo(skillId: string): { id: string; description: string } | null {
    for (const skill of this.allSkills) {
      if (skill.category === '插件') {
        // 在插件子技能中查找
        if (skill.sub_skills) {
          for (const sub of skill.sub_skills) {
            if (sub.id === skillId) {
              return {
                id: `${skill.id}:${sub.id}`,
                description: sub.description || '',
              };
            }
          }
        }
      } else {
        if (skill.id === skillId) {
          return {
            id: skill.id,
            description: skill.description || '',
          };
        }
      }
    }
    return null;
  }

  /**
   * 获取角色描述（含可用技能及描述），用于LLM提示词
   */
  getRoleSkillDescriptions(): string {
    return this.getAllRoles().map(role => {
      const parts = [`- ${role.id}：${role.description}`];

      // 收集该角色的所有可用技能
      const skillLines: string[] = [];

      // 纯技能
      for (const skillId of role.skills) {
        const info = this.resolveSkillInfo(skillId);
        if (info) {
          skillLines.push(`    - ${info.id}${info.description ? `：${info.description}` : ''}`);
        }
      }

      // 插件子技能
      for (const pb of role.plugins) {
        for (const subId of pb.skills) {
          const info = this.resolveSkillInfo(subId);
          if (info) {
            skillLines.push(`    - ${info.id}${info.description ? `：${info.description}` : ''}`);
          }
        }
      }

      if (skillLines.length > 0) {
        parts.push(`  可用技能:`);
        parts.push(skillLines.join('\n'));
      }

      return parts.join('\n');
    }).join('\n');
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
        skills: [],
        plugins: []
      },
      {
        id: 'code_agent',
        name: '代码Agent',
        description: '代码实现、测试等编程相关任务',
        systemPrompt: '你是一个编程专家。',
        skills: [],
        plugins: []
      },
      {
        id: 'review_agent',
        name: '评审Agent',
        description: '评审、结果验证等',
        systemPrompt: '你是一个严格的代码评审专家。',
        skills: [],
        plugins: []
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
