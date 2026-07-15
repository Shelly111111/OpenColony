# OpenColony 启动指南

## 方式一：桌面应用（推荐）

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发模式

```bash
npm run tauri:dev
```

首次启动会编译 Rust 依赖，后续很快。启动后会打开桌面窗口，左侧导航切换功能页面。

### 3. 配置系统

在「系统设置」页面填写：
- **API Key**：Anthropic API 密钥
- **API Base URL**：API 地址（默认 `https://api.anthropic.com`）
- **模型名称**：如 `claude-3-5-sonnet-20241022`
- **Claude 路径**：Claude CLI 可执行文件路径（默认 `claude`）
- **Claude 目录**：Claude 配置目录（默认 `.claude`）

点击「测试大模型连接」和「测试 Claude 连接」验证配置。

### 4. 管理技能

在「Skill 管理」页面：
- 点击「从 Claude 加载」从本地 Claude 目录读取技能
- 点击「刷新」重新加载已保存的技能
- 点击「保存」将技能写入 `scheduler/config/skill.json`

### 5. 提交任务

在「任务调度」页面输入需求，选择运行模式（SDK/PTY），回车提交。

### 6. 查看日志

在「任务日志」页面查看历史任务的 Master 和 Worker 日志。

---

## 方式二：命令行

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY
```

### 3. 启动调度中心

```bash
# SDK 模式（默认）
npm start run "分析当前目录结构"

# PTY 模式
npm start run pty "分析当前目录结构"

# 指定模式
npm start run sdk "你的任务描述"
```

### 4. 直接调用 Claude

```bash
# SDK 模式
npm start claude 1 "查看当前目录"

# PTY 模式
npm start claude pty 1 "查看当前目录"
```

---

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 显示帮助信息 |
| `npm start run [sdk\|pty] <需求>` | 启动调度中心执行任务 |
| `npm start claude [sdk\|pty] <参数>` | 直接调用 Claude |
| `npm run scheduler` | 直接启动调度中心 |
| `npm run claude` | 启动 Claude 管理器 |
| `npm run build` | 编译 TypeScript |
| `npm run tauri:dev` | Tauri 开发模式 |
| `npm run tauri:build` | 构建 Windows 安装包 |

## 配置文件位置

| 文件 | 路径 | 用途 |
|------|------|------|
| `.env` | 项目根目录 | API Key、API Base、模型名称 |
| `~/.opencolony/config.json` | 用户目录 | Claude 路径、最大 Agent 数、运行模式 |
| `scheduler/config/role.json` | 项目目录 | 角色配置 |
| `scheduler/config/skill.json` | 项目目录 | 技能配置 |

## 常见问题

### 1. 依赖安装失败

确保 Node.js >= 18：

```bash
node --version
```

### 2. 找不到模块

```bash
rm -rf node_modules package-lock.json
npm install
```

### 3. TypeScript 编译错误

```bash
npx tsc --noEmit
```

### 4. Tauri 编译错误

参考 [BUILD.md](BUILD.md) 中的常见问题章节。

## 相关文档

- [项目说明](README.md)
- [构建指南](BUILD.md)
