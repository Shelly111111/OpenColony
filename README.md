# OpenColony

分布式 Agent 调度系统 — 基于 Claude 的多终端统一调度平台

## 项目简介

OpenColony 是一个基于 Claude 的多 Agent 调度系统，将复杂任务自动拆解为 DAG 子任务图，分配给多个 Worker 并行执行，最终汇总输出结果。系统采用三层嵌套架构，支持 SDK 和 PTY 两种运行模式，并提供 Tauri 桌面应用进行可视化管理。

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri 桌面应用                        │
│        (主界面 / 任务日志 / 角色管理 / 技能管理 / 设置)     │
└──────────────────────────┬──────────────────────────────┘
                           │ Tauri Commands
┌──────────────────────────▼──────────────────────────────┐
│                    调度中心 (Scheduler)                   │
│  ┌─────────┐   ┌──────────────┐   ┌────────────────┐   │
│  │  Master  │──▶│ PlanExecutor │──▶│ WorkerManager  │   │
│  └────┬────┘   └──────┬───────┘   └───────┬────────┘   │
│       │               │                    │            │
│  ┌────▼────┐   ┌──────▼───────┐   ┌───────▼────────┐   │
│  │ LLM拆分 │   │  DAG分层调度  │   │  Worker创建/回收│   │
│  │ 结果合并 │   │  同层并行执行  │   │  角色prompt注入 │   │
│  └─────────┘   └──────────────┘   └────────────────┘   │
│                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ ClaudeLink   │ │ArbitrationEng│ │   MemoryStore    │ │
│  │  通信总线    │ │  仲裁引擎    │ │  三层记忆系统    │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│               Claude 管理器 (claude-multi-runner)        │
│        ┌──────────────┐    ┌──────────────────┐         │
│        │  SDK Client  │    │ Node-PTY Backend │         │
│        │ (Agent SDK)  │    │  (Claude CLI)    │         │
│        └──────────────┘    └──────────────────┘         │
└─────────────────────────────────────────────────────────┘
```

## 核心功能

### 三层调度架构

系统采用 **Master → Plan Executor → Worker** 三层架构，将复杂任务自动拆解为可并行的子任务图：

- **Master**：系统的唯一对外交互入口，接收用户需求，调用 LLM 将需求拆解为子任务列表，构建 DAG 依赖图，协调全局执行流程，汇总各 Worker 结果输出最终答案
- **Plan Executor**：按 DAG 拓扑排序分层调度子任务，同层子任务并行分派给 Worker，管理子任务状态流转（pending → running → completed/failed），处理超时
- **Worker Manager**：为每个子任务创建 Worker 实例，注入角色 prompt、技能知识和同层团队信息，跟踪执行进度，收集输出结果

### DAG 并行执行

子任务按依赖关系构建有向无环图（DAG），通过拓扑排序分层，同层任务并行执行，跨层任务串行等待。Plan Executor 按层级推进，每层所有 Worker 完成后才进入下一层，最大化并行度的同时保证依赖正确性。

### 双模式运行

- **SDK 模式（默认）**：基于 Claude Agent SDK 直接调用 Anthropic API，无需安装 Claude CLI，响应更快，支持 Worker 间通信协作（send_to / send_to_high / broadcast / ask_help）
- **PTY 模式**：通过 node-pty 创建真实终端进程，运行 Claude CLI，支持完整交互式体验，虚拟屏幕捕获输出

### 仲裁引擎

当同一子任务由多个 Worker 执行时，仲裁引擎对多份输出进行评判合并，支持两种模式：

- **置信度投票（confidence_vote）**：由 LLM 对各 Worker 输出评分，取最高置信度者
- **差异合并（merge_diff）**：由 LLM 整合多个输出为一份统一结果

### ClaudeLink 通信总线

基于 SQLite + WAL 模式的去中心化通信系统，Worker 间无需中央路由即可互相发送消息：

- **定向发送**：`send_to(target, message)` 向指定 Worker 发送消息
- **紧急发送**：`send_to_high(target, message)` 高优先级消息，确保送达
- **广播**：`broadcast(message)` 向所有同层 Worker 广播消息
- **求助**：`ask_help(question)` 向同层 Worker 请求协助

所有消息持久化到 SQLite，支持跨进程访问，自动过期清理（默认 7 天）。

### 三层记忆系统

- **L1 任务经验库**：基于 FTS5 全文搜索，新任务提交时检索相似历史经验，辅助任务拆分和角色分配
- **L2 项目知识库**：按会话窗口隔离（每个 sessionId 对应独立的知识上下文），存储项目约定、技术栈、结构偏好等，执行时注入 Worker 上下文
- **L3 Worker 画像库**：全局共享，记录各角色 Worker 的历史表现（成功率、平均置信度、擅长领域），影响角色选择权重

### 受控执行模式

系统提供三种权限模式控制 Worker 的行为边界：

- **Ask 模式（默认）**：每个写入/执行操作弹出审批 Toast，用户逐条审批
- **Auto 模式**：高置信度操作（文件编辑）自动执行，低置信度操作（命令执行）需审批
- **Bypass 模式**：跳过所有权限检查（仅限开发/调试）

### 动态信息注入

任务执行过程中，用户可随时向运行中的 Worker 注入补充信息：

- **路由模式**：定向路由（指定目标 Worker）、智能路由（LLM 自动判断）、全局广播
- **注入时机**：立即注入、强制中断注入、等待注入
- **状态反馈**：已送达（6001）、需用户澄清目标（6002）、无法送达（6003）

### 角色与技能系统

- **角色（Role）**：定义 Worker 的身份和行为规范，如通用 Agent、代码 Agent、评审 Agent 等，每个角色包含 system prompt、工具权限和技能绑定
- **技能（Skill）**：从本地 Claude 目录加载的技能描述文件（支持插件子技能），为 Worker 提供特定领域知识，执行时注入到 Worker 上下文中

### 桌面应用

基于 Tauri 的跨平台桌面应用（Rust 后端 + 原生 HTML/CSS/JS 前端），提供五个功能页面：

- **主界面**：提交任务需求，选择运行模式和权限模式，实时查看 Master 调度输出
- **任务日志**：浏览历史任务列表，查看每个任务按 Trace ID 组织的完整日志
- **角色管理**：查看、新增和编辑 Agent 角色配置
- **技能管理**：从 Claude 目录加载、搜索、筛选技能，保存到本地配置
- **系统设置**：配置 API Key、模型、Claude 路径、运行模式、权限模式、仲裁模式、并发参数等，支持连接测试

## 快速开始

### 前置要求

- **Node.js** >= 18
- **Rust 工具链**（桌面应用构建需要）
- **MSVC Build Tools**（Windows 构建需要）
- **Anthropic API Key**

### 方式一：桌面应用（推荐）

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式
npm run tauri:dev
```

首次启动编译 Rust 依赖较慢，后续增量编译很快。启动后在「系统设置」页面配置 API Key 和模型。

### 方式二：命令行

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY

# 3. SDK 模式执行任务（默认）
npm start run "分析当前目录结构"

# PTY 模式执行任务
npm start run pty "分析当前目录结构"
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
| `npm run tauri:build` | 构建桌面安装包 |

## 配置说明

### 环境变量（`.env`）

```bash
ANTHROPIC_API_KEY=your_api_key_here       # Anthropic API 密钥（必填）
ANTHROPIC_BASE_URL=https://api.anthropic.com  # API 端点
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022    # 模型名称
PERMISSION_MODE=ask                        # 权限模式：ask / auto / bypass
PERMISSION_TIMEOUT_MS=120000               # 审批超时（毫秒）
```

### 应用配置（`~/.opencolony/config.json`）

Claude 路径、最大 Agent 数、运行模式、仲裁模式、并发参数等。

### 数据存储

| 数据 | 路径 | 说明 |
|------|------|------|
| 角色配置 | `scheduler/config/role.json` | Agent 角色定义 |
| 技能配置 | `scheduler/config/skill.json` | 技能列表与描述 |
| 运行时配置 | `scheduler/config/settings.json` | DAG 调度、重试等参数 |
| 通信数据库 | `~/.opencolony/messages.db` | ClaudeLink 消息与日志（SQLite） |
| 记忆数据库 | `~/.opencolony/memory.db` | 三层记忆系统（SQLite + FTS5） |
| 任务日志 | `worker-logs/<traceId>/` | 按 Trace ID 组织的执行日志 |
| 环境变量 | 项目根 `.env` | API Key 等敏感配置 |

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Tauri 1.5（Rust 后端 + 原生前端） |
| 后端语言 | TypeScript / Rust |
| AI SDK | @anthropic-ai/sdk / @anthropic-ai/claude-agent-sdk |
| 终端模拟 | node-pty |
| 数据库 | better-sqlite3（SQLite + WAL / FTS5） |
| 工具库 | zod, uuid, p-queue, reqwest, chrono, serde |

## 文档

- [构建指南](BUILD.md) — 桌面应用打包说明
- [启动指南](STARTUP.md) — 详细启动步骤

## 许可证

MIT License
