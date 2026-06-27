# OpenColony 启动指南

## 统一启动方式

项目已统一使用根目录的 npm scripts 管理所有服务。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

#### 方式一：使用统一入口（推荐）

```bash
# 显示帮助
npm start

# 启动调度中心执行任务
npm run run "分析当前目录结构"

# 或直接
npm start run "分析当前目录结构"

# 直接调用 Claude PTY
npm start claude 1 "查看当前目录"
```

#### 方式二：使用独立脚本

```bash
# 启动调度中心
npm run scheduler

# 启动 Claude PTY 管理器
npm run claude

# 通过统一入口调用 Claude
npm run claude:direct
```

### 3. 开发模式

```bash
# 开发模式（自动重启）
npm run dev

# 或指定命令
npm run dev run "任务描述"
npm run dev claude 1 "命令"
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 显示帮助信息 |
| `npm start run <需求>` | 启动调度中心执行任务 |
| `npm start claude <参数>` | 直接调用 Claude PTY |
| `npm run run` | 等同于 `npm start run` |
| `npm run scheduler` | 直接启动调度中心 |
| `npm run claude` | 直接启动 Claude PTY 管理器 |
| `npm run claude:direct` | 通过统一入口调用 Claude |
| `npm run dev` | 开发模式（需要安装 ts-node-dev） |
| `npm run build` | 编译 TypeScript |
| `npm run clean` | 清理编译输出 |

## 项目结构

```
OpenColony/
├── src/                      # 统一入口
│   └── index.ts              # 主入口文件
├── scheduler/                # 调度中心
│   └── src/
│       ├── index.ts          # 调度器入口
│       ├── master.ts         # Master 节点
│       ├── plan-executor.ts  # Plan Executor
│       └── worker-manager.ts # Worker 管理器
├── claude-multi-runner/      # Claude PTY 管理器
│   ├── main.ts               # PTY 管理器入口
│   ├── manager.ts            # 终端管理器
│   └── virtual-screen.ts     # 虚拟屏幕
├── package.json              # 统一依赖管理
└── tsconfig.json             # TypeScript 配置
```

## 配置说明

### 环境变量

调度中心需要配置 `.env` 文件：

```bash
# scheduler/.env
ANTHROPIC_API_KEY=your_api_key_here
```

### TypeScript 配置

根目录的 `tsconfig.json` 已配置包含所有子项目的源代码。

## 常见问题

### 1. 依赖安装失败

确保 Node.js 版本 >= 18.0.0：

```bash
node --version
```

### 2. 找不到模块

重新安装依赖：

```bash
rm -rf node_modules package-lock.json
npm install
```

### 3. TypeScript 编译错误

检查 tsconfig.json 配置：

```bash
npx tsc --noEmit
```

## 从旧版本迁移

如果您之前使用子目录的独立 package.json：

1. 删除子目录的 `node_modules`
2. 在根目录运行 `npm install`
3. 使用新的 npm scripts 启动服务

```bash
# 旧方式（不推荐）
cd scheduler && npm start

# 新方式（推荐）
npm run scheduler
```

## 开发建议

1. 使用 `npm run dev` 进行开发，支持热重载
2. 提交前运行 `npm run build` 确保编译通过
3. 使用 TypeScript 类型检查避免运行时错误

## 更多信息

- 调度中心文档：`scheduler/README.md`
- Claude PTY 文档：`claude-multi-runner/README.md`
- 项目许可证：MIT
