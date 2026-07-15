# OpenColony

分布式 Agent 调度系统 — 基于 Claude 的多终端统一调度平台

## 项目简介

OpenColony 是一个 Claude CLI 调度系统，包含三大模块：

- **Tauri 桌面应用**：可视化界面，管理系统配置、角色、技能，提交和监控任务
- **调度中心 (scheduler)**：Master + Plan-Executor + Worker 三层架构，支持 SDK 和 PTY 两种运行模式
- **Claude 管理器 (claude-multi-runner)**：支持 SDK 和 PTY 两种模式，管理多个 Claude 终端会话

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env

# 编辑 .env 文件，填入 ANTHROPIC_API_KEY
```

### 3. 启动桌面应用

```bash
# 开发模式
npm run tauri:dev

# 构建 Windows 安装包
npm run tauri:build
```

### 4. 或使用命令行调度

```bash
# SDK 模式执行任务（默认）
npm start run "分析当前目录结构"

# PTY 模式执行任务
npm start run pty "分析当前目录结构"

# 直接调用 Claude
npm start claude 1 "查看当前目录"
```

## 项目结构

```
OpenColony/
├── src/                          # 统一 CLI 入口
│   └── index.ts
├── scheduler/                    # 调度中心
│   ├── src/
│   │   ├── index.ts              # 调度器入口
│   │   ├── master.ts             # Master 节点
│   │   ├── plan-executor.ts      # Plan Executor
│   │   ├── worker-manager.ts     # Worker 管理器
│   │   ├── arbitration-engine.ts # 仲裁引擎
│   │   ├── claude-link.ts        # Claude 连接层
│   │   ├── llm-client.ts         # LLM 客户端
│   │   ├── message-db.ts         # 消息数据库
│   │   ├── role-manager.ts       # 角色管理
│   │   ├── logger.ts             # 日志模块
│   │   └── types.ts              # 类型定义
│   └── config/
│       ├── role.json             # 角色配置
│       ├── skill.json            # 技能配置
│       └── settings.json         # 调度器设置
├── claude-multi-runner/          # Claude 管理器
│   ├── main.ts                   # 入口
│   ├── manager.ts                # 统一管理器
│   ├── backends/
│   │   ├── sdk-client.ts        # SDK 客户端
│   │   ├── node-pty-backend.ts  # PTY 后端
│   │   ├── pty-selector.ts      # PTY 选择器
│   │   └── virtual-screen.ts    # 虚拟屏幕
│   ├── hooks/                    # 完成标记脚本
│   ├── utils/
│   │   ├── git-bash.ts          # Git Bash 工具
│   │   └── logger.ts            # 日志模块
│   └── types.ts
├── src-tauri/                    # Tauri 桌面应用
│   ├── src/
│   │   ├── main.rs              # 入口 + Tauri 构建
│   │   ├── commands.rs          # Tauri 命令
│   │   ├── models.rs            # 数据结构
│   │   ├── paths.rs             # 路径辅助
│   │   └── utils.rs             # 工具函数
│   ├── icons/                    # 应用图标
│   ├── tauri.conf.json           # Tauri 配置
│   └── Cargo.toml                # Rust 依赖
├── ui/                           # 前端界面
│   ├── index.html
│   ├── styles.css
│   ├── common.js                 # 公共工具 + 初始化
│   ├── chat.js                   # 对话 + 任务提交
│   ├── tasks.js                  # 任务日志
│   ├── roles.js                  # 角色管理
│   ├── skills.js                 # 技能管理
│   └── settings.js               # 系统设置
├── scripts/                      # 构建脚本
│   ├── generate-ico.js
│   └── generate-icons.js
├── .env.example                  # 环境变量示例
├── package.json
├── tsconfig.json
├── BUILD.md                      # 构建指南
└── STARTUP.md                    # 启动指南
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 显示帮助信息 |
| `npm start run [sdk\|pty] <需求>` | 启动调度中心执行任务 |
| `npm start claude [sdk\|pty] <参数>` | 直接调用 Claude |
| `npm run scheduler` | 直接启动调度中心 |
| `npm run build` | 编译 TypeScript |
| `npm run tauri:dev` | Tauri 开发模式 |
| `npm run tauri:build` | 构建 Windows 安装包 |

## 核心功能

### 1. 桌面应用 (Tauri)

- 系统配置管理（API Key、模型、Claude 路径等）
- 角色与技能的查看和管理
- 从 Claude 目录加载技能
- 任务提交与日志查看
- 大模型/Claude 连接测试

### 2. 调度中心 (scheduler)

**SDK 模式（默认）**：
- 使用 Claude Agent SDK 执行任务
- 无需安装 Claude CLI
- 响应更快，适合自动化场景

**PTY 模式**：
- 使用 node-pty 创建真实终端
- 支持完整的交互式体验

**架构组成**：
- **Master 节点**：任务规划和调度
- **Plan Executor**：执行计划和管理子任务
- **Worker 管理器**：管理 Worker 集群
- **仲裁引擎**：结果验证和冲突解决

### 3. Claude 管理器 (claude-multi-runner)

支持 SDK 和 PTY 两种模式统一管理 Claude 会话，提供虚拟屏幕输出捕获。

## 配置说明

### 环境变量

根目录 `.env` 文件：

```bash
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
```

### 应用数据

桌面应用的配置保存在 `~/.opencolony/config.json`（Claude 路径、最大 Agent 数等）。

## 技术栈

- **运行时**：Node.js >= 18
- **语言**：TypeScript / Rust
- **桌面框架**：Tauri 1.5
- **AI SDK**：@anthropic-ai/sdk
- **终端**：node-pty
- **其他**：uuid, zod, p-queue, reqwest, chrono, serde

## 文档

- [构建指南](BUILD.md) — 桌面应用打包说明
- [启动指南](STARTUP.md) — 详细启动步骤

## 许可证

MIT License
