# OpenColony

分布式 Agent 调度系统 - 基于 Claude CLI 的多终端统一调度平台

## 项目简介

OpenColony 是一个强大的 Claude CLI 调度系统，包含：
- **PTY 管理器**：使用 node-pty 管理多个 Claude 终端会话
- **调度中心**：Master + Plan-Executor + Worker 三层架构
- **统一入口**：通过根目录的 npm scripts 统一管理所有服务

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env` 文件：

```bash
# 复制示例配置
cp scheduler/.env.example .env

# 编辑 .env 文件，添加你的 ANTHROPIC_API_KEY
```

### 3. 启动服务

#### 使用统一入口（推荐）

```bash
# 显示帮助
npm start

# 启动调度中心执行任务
npm start run "分析当前目录结构"

# 直接调用 Claude（默认 SDK 模式）
npm start -- claude 1 "查看当前目录"

# 使用 PTY 模式
npm start -- claude pty 1 "查看当前目录"
```

#### 使用独立脚本

```bash
# 启动调度中心
npm run scheduler

# 启动 Claude 管理器（SDK 模式默认）
npm run claude
```

## 项目结构

```
OpenColony/
├── src/                          # 统一入口
│   └── index.ts                  # 主入口文件
├── scheduler/                    # 调度中心
│   ├── src/
│   │   ├── index.ts              # 调度器入口
│   │   ├── master.ts             # Master 节点
│   │   ├── plan-executor.ts      # Plan Executor
│   │   ├── worker-manager.ts     # Worker 管理器
│   │   ├── arbitration-engine.ts # 仲裁引擎
│   │   ├── llm-client.ts         # LLM 客户端
│   │   ├── task-queue.ts         # 任务队列
│   │   └── types.ts              # 类型定义
│   └── .env                      # 环境变量配置
├── claude-multi-runner/          # Claude 管理器（支持 SDK 和 PTY 模式）
│   ├── main.ts                   # 主入口（支持模式切换）
│   ├── manager.ts                # 统一管理器
│   ├── sdk-client.ts            # SDK 客户端
│   ├── virtual-screen.ts         # 虚拟屏幕
│   ├── types.ts                  # 类型定义
│   ├── backends/                 # PTY 后端
│   └── utils/                    # 工具函数
├── package.json                  # 统一依赖管理
├── tsconfig.json                 # TypeScript 配置
├── STARTUP.md                    # 详细启动指南
└── README.md                     # 项目说明
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 显示帮助信息 |
| `npm start run <需求>` | 启动调度中心执行任务 |
| `npm start claude [sdk\|pty] <参数>` | 直接调用 Claude（支持 SDK/PTY 模式） |
| `npm run run` | 等同于 `npm start run` |
| `npm run scheduler` | 直接启动调度中心 |
| `npm run claude` | 直接启动 Claude 管理器（默认 SDK 模式） |
| `npm run build` | 编译 TypeScript |
| `npm run dev` | 开发模式（需要安装 ts-node-dev） |

## 核心功能

### 1. Claude 管理器 (claude-multi-runner)

支持两种运行模式：

**SDK 模式（默认）**：
- 使用 Claude Agent SDK 直接调用 API
- 无需安装 Claude CLI
- 响应更快，适合自动化场景

**PTY 模式**：
- 使用 node-pty 创建真实终端
- 支持多终端并行执行
- 实时日志记录
- 虚拟屏幕捕获输出
- 完整的交互式体验（颜色、进度条等）

### 2. 调度中心 (scheduler)

- 使用 node-pty 创建真实终端
- 支持多终端并行执行
- 实时日志记录
- 虚拟屏幕捕获输出

### 2. 调度中心 (scheduler)

- **Master 节点**：任务规划和调度
- **Plan Executor**：执行计划和管理子任务
- **Worker 管理器**：管理 PTY  worker 集群
- **仲裁引擎**：结果验证和冲突解决

## 开发指南

### 本地开发

```bash
# 安装开发依赖
npm install

# 开发模式（自动重启）
npm run dev

# 编译
npm run build

# 清理编译输出
npm run clean
```

### 添加新功能

1. 在相应的目录下添加代码
2. 更新类型定义
3. 运行 `npm run build` 确保编译通过
4. 测试功能

## 配置说明

### 环境变量

调度中心使用 `.env` 文件配置：

```bash
# scheduler/.env
ANTHROPIC_API_KEY=your_api_key_here
```

### TypeScript 配置

- 根目录 `tsconfig.json`：用于编译 `src/` 目录
- `scheduler/tsconfig.json`：用于编译调度中心
- `claude-multi-runner/tsconfig.json`：用于编译 PTY 管理器

## 文档

- [启动指南](STARTUP.md) - 详细的启动说明
- [调度中心文档](scheduler/README.md) - 调度中心使用说明
- [PTY 管理器文档](claude-multi-runner/README.md) - PTY 管理器使用说明

## 技术栈

- **运行时**：Node.js >= 18
- **语言**：TypeScript
- **终端**：node-pty
- **AI SDK**：@anthropic-ai/sdk
- **其他**：uuid, zod, p-queue

## 贡献指南

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

## 作者

Shelly111111

## 更新日志

查看 [LICENSE](LICENSE) 文件了解更多信息。
