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

### 三层调度架构

系统采用 Master → Plan Executor → Worker 三层架构，将复杂任务自动拆解为可并行的子任务图：

- **Master**：接收用户需求，调用 LLM 将需求拆解为子任务列表，构建 DAG 依赖图，协调全局执行流程，汇总各 Worker 结果输出最终答案
- **Plan Executor**：按 DAG 层级调度子任务，同层子任务并行分派给 Worker，管理子任务状态流转（pending → running → completed/failed），处理重试和超时
- **Worker Manager**：为每个子任务创建 Worker 实例，注入角色 prompt 和同层团队信息，跟踪执行进度，收集输出结果

### 双模式运行

- **SDK 模式（默认）**：直接调用 Anthropic API，无需安装 Claude CLI，响应更快，支持 Worker 间通信协作（send_to / broadcast / ask_help）
- **PTY 模式**：通过 node-pty 创建真实终端进程，运行 Claude CLI，支持完整交互式体验，虚拟屏幕捕获输出

### DAG 并行执行

子任务按依赖关系构建有向无环图（DAG），同层任务并行执行，跨层任务串行等待。Plan Executor 按层级推进，每层所有 Worker 完成后才进入下一层，最大化并行度的同时保证依赖正确性。

### 仲裁引擎

当同一子任务由多个 Worker 执行时，仲裁引擎对多份输出进行评判，支持两种仲裁模式：
- **置信度投票（confidence_vote）**：各 Worker 给出置信度分数，取最高者
- **优先级排序（agent_priority）**：按角色优先级选择，如 Review Agent 优先于 Code Agent

### ClaudeLink 通信总线

基于 SQLite + WAL 模式的去中心化通信系统，Worker 间无需中央路由即可互相发送消息：
- **定向发送**：`send_to(target, message)` 向指定 Worker 发送消息
- **紧急发送**：`send_to_high(target, message)` 高优先级消息，确保送达
- **广播**：`broadcast(message)` 向所有同层 Worker 广播消息
- **求助**：`ask_help(question)` 向同层 Worker 请求协助
- 所有消息持久化到 SQLite，支持跨进程访问，自动过期清理

### 角色与技能系统

- **角色（Role）**：定义 Worker 的身份和行为规范，如 Code Agent、Data Agent、Review Agent 等，每个角色包含 system prompt、工具权限和优先级配置
- **技能（Skill）**：从 Claude 目录加载的技能描述文件，为 Worker 提供特定领域知识（如 Worker 通信协议），执行时注入到 Worker 的上下文中

### 桌面应用

基于 Tauri 的跨平台桌面应用，提供可视化操作界面：
- **对话工作区**：提交任务需求，查看 Master 调度输出和最终结果
- **任务日志**：浏览历史任务列表，查看每个任务的完整日志
- **角色管理**：查看和了解各 Worker 角色的配置
- **技能管理**：从 Claude 目录加载、搜索、筛选技能，保存到本地配置
- **系统设置**：配置 API Key、模型、Claude 路径等，支持连接测试

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
