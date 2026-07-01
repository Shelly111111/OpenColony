# Claude Multi-Runner

启动多个 Claude 终端并行执行命令，支持 **SDK** 和 **PTY** 两种运行模式。

## 快速开始

```bash
# 使用默认 SDK 模式
npm start -- claude 2 "分析项目结构" "写README"

# 使用 PTY 模式
npm start -- claude pty 2 "分析项目结构" "写README"
```

## 运行模式

### SDK 模式（默认）

使用 Claude Agent SDK 直接调用 API，无需安装 Claude CLI。

**优点:**
- 直接调用 API，响应更快
- 无需安装 Claude CLI
- 适合自动化场景和服务器环境
- 默认模式，无需额外配置

**使用方法:**
```bash
# 默认使用 SDK 模式（可省略 sdk）
npm start -- claude 2 "命令1" "命令2"
npm start -- claude sdk 2 "命令1" "命令2"
```

**环境要求:**
- 在项目根目录创建 `.env` 文件，设置 `ANTHROPIC_API_KEY`
- 可选：设置 `ANTHROPIC_MODEL`（默认：hy3-preview）
- 可选：设置 `ANTHROPIC_BASE_URL`（用于代理或本地部署）

### PTY 模式

使用 node-pty（伪终端）技术运行 Claude CLI，提供完整的交互式体验。

**优点:**
- 完全支持交互式输出（颜色、进度条、状态更新）
- Claude CLI 产生完整的中间过程日志
- 更接近真实终端体验
- 使用 Claude CLI 自己的配置（不加载 .env）

**使用方法:**
```bash
# 使用 pty 参数
npm start -- claude pty 2 "命令1" "命令2"
```

**环境要求:**
- 安装 Claude CLI 并配置好 API key
- 安装 node-pty 依赖（需要编译原生模块）

## 功能特点

- **双模式支持**: SDK 模式（默认）直接调用 API，PTY 模式使用交互式终端
- **并行执行**: 同时启动多个 Claude 终端，提高工作效率
- **流式输出**: 实时显示每个终端的输出，不同终端使用不同颜色区分
- **日志记录**: 所有输出实时写入独立的日志文件，便于后续分析
- **优雅中断**: 支持 Ctrl+C 安全终止所有进程

## 安装

### SDK 模式（推荐）

```bash
cd claude-multi-runner
npm install
```

只需设置 `ANTHROPIC_API_KEY` 环境变量即可使用。

### PTY 模式

```bash
cd claude-multi-runner
npm install
```

node-pty 需要编译原生模块：
- Windows 需要 Visual Studio Build Tools 和 Python
- macOS/Linux 通常可以直接安装

## 使用方法

### SDK 模式示例（默认）

**启动 2 个终端执行不同任务:**
```bash
npm start -- claude 2 "分析当前项目结构" "帮我写一个README"
```

**启动 3 个终端并行处理不同任务:**
```bash
npm start -- claude 3 "修复这个bug" "添加单元测试" "优化性能"
```

### PTY 模式示例

```bash
npm start -- claude pty 2 "分析当前项目结构" "帮我写一个README"
```

## 参数说明

| 参数 | 说明 |
|------|------|
| `[sdk\|pty]` | 运行模式（可选，默认：sdk）。可放在终端数量前 |
| `<终端数量>` | 要启动的 Claude 终端数量 (1-10) |
| `<命令...>` | 要在每个终端中执行的命令 |

**注意**: 模式参数必须放在终端数量之前，如 `claude pty 2 "命令"`，不能放在命令之后。

### 输出说明

- **终端输出**: 不同终端使用不同颜色区分（绿色、黄色、蓝色等）
- **日志文件**: 保存在 `claude-logs` 目录下，文件名格式为 `claude-session-{编号}-{时间}.log`

## 配置

### 环境变量（SDK 模式）

在项目根目录创建 `.env` 文件：

```bash
# Claude API配置（SDK 模式需要）
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# 可选：自定义 API 端点（用于代理或本地部署）
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### 环境变量（PTY 模式）

```bash
# Claude CLI路径（PTY 模式需要）
# CLAUDE_CLI_PATH=claude
```

## 日志格式

每条日志记录包含时间戳和内容类型标记：

```
[2024-01-15T10:30:00.000Z] 启动 Claude 终端 1
[2024-01-15T10:30:00.500Z] 发送命令到 Claude: 分析当前项目结构
[2024-01-15T10:30:01.000Z] [OUTPUT] 正在分析项目结构...
```

## 项目结构

```
claude-multi-runner/
├── main.ts                  # 主程序入口
├── manager.ts               # PTY 管理器
├── sdk-client.ts           # SDK 客户端（新增）
├── types.ts                 # 类型定义
├── virtual-screen.ts        # 虚拟屏幕实现
├── backends/
│   ├── index.ts             # 模块导出
│   ├── pty-selector.ts      # PTY 后端选择器
│   └── node-pty-backend.ts  # node-pty 后端实现
├── utils/
│   └ logger.ts              # 日志工具
├── package.json             # 项目配置
├── tsconfig.json            # TypeScript 配置
└── README.md                # 使用说明
```

## 技术原理

### SDK 模式

SDK 模式使用 Anthropic 官方 SDK 直接调用 Claude API：
- 无需启动 Claude CLI 进程
- 直接发送 HTTP 请求到 Anthropic API
- 响应更快，资源占用更少

### PTY 模式

PTY（伪终端）创建了一个虚拟的终端环境：
- 程序认为它连接到了真正的终端
- 支持所有终端特性（颜色、光标移动、屏幕更新）
- 输出是实时的、完整的

## 故障排除

### SDK 模式

**API 调用失败:**
1. 检查 `ANTHROPIC_API_KEY` 是否正确设置
2. 检查网络连接是否正常
3. 检查 `ANTHROPIC_BASE_URL` 配置（如果使用代理）

### PTY 模式

**node-pty 安装失败:**

如果 node-pty 安装失败：
1. Windows: 确保已安装 Visual Studio Build Tools 和 Python
2. macOS/Linux: 检查是否有编译工具链 (gcc, make 等)
3. 尝试清理后重新安装: `rm -rf node_modules && npm install`

**输出显示异常:**

PTY 模式的输出包含 ANSI 控制码：
- 使用支持 ANSI 的终端查看器
- 日志文件可以使用 `cat` 命令查看
- 或使用文本编辑器查看原始内容

## 注意事项

1. SDK 模式为默认模式，无需额外配置即可使用
2. PTY 模式需要确保 Claude CLI 已正确安装并配置
3. 命令数量少于终端数量时，多余终端将执行第一个命令
4. 使用 Ctrl+C 可以安全终止所有正在运行的终端
5. 日志文件不会自动清理，请定期清理旧日志
