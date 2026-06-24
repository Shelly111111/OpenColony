# Claude Multi-Runner

启动多个 Claude 终端并行执行命令，支持交互式流式输出和实时日志记录。

## 功能特点

- **并行执行**: 同时启动多个 Claude 终端，提高工作效率
- **node-pty 后端**: 使用原生 node-pty 模块实现 PTY 功能
- **流式输出**: 实时显示每个终端的输出，不同终端使用不同颜色区分
- **日志记录**: 所有输出实时写入独立的日志文件，便于后续分析
- **优雅中断**: 支持 Ctrl+C 安全终止所有进程

## 运行模式

使用 node-pty (伪终端) 技术运行 Claude CLI，让程序认为它运行在真正的终端中。

**优点:**
- 完全支持交互式输出（颜色、进度条、状态更新）
- Claude CLI 产生完整的中间过程日志
- 更接近真实终端体验

**使用方法:**
```bash
npx ts-node main.ts <终端数量> <命令1> <命令2> ...
```

## 安装

```bash
cd claude-multi-runner
npm install
```

node-pty 需要编译原生模块：
- Windows 需要 Visual Studio Build Tools 和 Python
- macOS/Linux 通常可以直接安装

## 使用方法

```bash
npx ts-node main.ts <终端数量> <命令1> <命令2> ...
```

**启动 2 个终端执行不同任务:**
```bash
npx ts-node main.ts 2 "分析当前项目结构" "帮我写一个README"
```

**启动 3 个终端并行处理不同任务:**
```bash
npx ts-node main.ts 3 "修复这个bug" "添加单元测试" "优化性能"
```

## 参数说明

| 参数 | 说明 |
|------|------|
| `<终端数量>` | 要启动的 Claude 终端数量 (1-10) |
| `<命令...>` | 要在每个终端中执行的命令 |

### 输出说明

- **终端输出**: 不同终端使用不同颜色区分（绿色、黄色、蓝色等）
- **日志文件**: 保存在 `claude-logs` 目录下，文件名格式为 `claude-session-{编号}-{时间}.log`

## 日志格式

每条日志记录包含时间戳和内容类型标记：

```
[2024-01-15T10:30:00.000Z] 启动 Claude 终端 1
[2024-01-15T10:30:00.500Z] 发送命令到 Claude: 分析当前项目结构
[2024-01-15T10:30:01.000Z] [OUTPUT] 正在分析项目结构...
```

## 技术原理

### 为什么需要 PTY？

Claude CLI 模式不支持交互式 stdin 持续输入。当使用普通的 `spawn` + `stdio: ["pipe", ...]` 时：

1. 程序检测到 stdin 不是真正的终端（TTY）
2. Claude CLI 禁用交互式输出特性
3. **中间过程日志不完整或延迟**

### PTY 如何解决这些问题？

PTY（伪终端）创建了一个虚拟的终端环境：
- 程序认为它连接到了真正的终端
- 支持所有终端特性（颜色、光标移动、屏幕更新）
- 输出是实时的、完整的

## 项目结构

```
claude-multi-runner/
├── main.ts                  # 主程序入口
├── manager.ts               # PTY 管理器
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

## 执行流程

1. 创建 PTY 后端 (node-pty)
2. 并行创建指定数量的 PTY 终端
3. 每个 PTY 启动 shell 并运行 Claude CLI
4. 发送对应的命令到 Claude
5. 实时捕获 PTY 输出（包含 ANSI 控制码）
6. 写入日志文件并显示到控制台
7. 等待所有进程完成
8. 输出执行汇总信息

## 故障排除

### node-pty 安装失败

如果 node-pty 安装失败：
1. Windows: 确保已安装 Visual Studio Build Tools 和 Python
2. macOS/Linux: 检查是否有编译工具链 (gcc, make 等)
3. 尝试清理后重新安装: `rm -rf node_modules && npm install`

### 输出显示异常

PTY 模式的输出包含 ANSI 控制码：
- 使用支持 ANSI 的终端查看器
- 日志文件可以使用 `cat` 命令查看
- 或使用文本编辑器查看原始内容

## 注意事项

1. 确保 Claude CLI 已正确安装并配置
2. 命令数量少于终端数量时，多余终端将执行第一个命令
3. 使用 Ctrl+C 可以安全终止所有正在运行的终端
4. 日志文件不会自动清理，请定期清理旧日志