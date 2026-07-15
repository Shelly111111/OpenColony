# OpenColony 桌面应用构建指南

本项目使用 **Tauri 1.5** 将前端 + Rust 后端打包为 Windows 桌面 exe 程序。

## 前置依赖

| 依赖 | 用途 | 安装命令 |
|------|------|---------|
| **Rust 工具链** (cargo) | 编译 Rust 后端 | `winget install Rustlang.Rustup` |
| **Node.js** >= 18 | 运行 Tauri CLI / npm 脚本 | `winget install OpenJS.NodeJS.LTS` |
| **MSVC Build Tools** | Windows 链接器 (link.exe) | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |

> 官网下载：Rust https://rustup.rs/ · Node.js https://nodejs.org/

## 项目结构

```
src-tauri/                      # Tauri 工程目录
├── src/
│   ├── main.rs                # 入口：初始化 Tauri 并注册命令
│   ├── commands.rs            # 所有 Tauri 命令（前端可调用）
│   ├── models.rs              # 数据结构（SystemConfig, Skill, TaskResult 等）
│   ├── paths.rs               # 路径辅助（项目根、配置目录、日志目录）
│   └── utils.rs               # 工具函数（env 解析、日志、时间格式化）
├── icons/                      # 应用图标资源
├── tauri.conf.json             # Tauri 核心配置
├── Cargo.toml                  # Rust 依赖
└── build.rs

ui/                             # 前端（纯 HTML/CSS/JS，无打包步骤）
├── index.html
├── styles.css
├── common.js                   # 公共工具 + 初始化
├── chat.js                     # 对话 + 任务提交
├── tasks.js                    # 任务日志
├── roles.js                    # 角色管理
├── skills.js                   # 技能管理
└── settings.js                 # 系统设置
```

## 构建步骤

### 1. 安装依赖（首次）

```bash
npm install
```

### 2. 构建 Windows 安装包

```bash
# 默认构建
npm run tauri:build

# 明确指定 Windows 目标
npm run tauri:build:windows
```

### 3. 构建产物

```
src-tauri/target/release/
├── opencolony.exe                              # 独立可执行文件
└── bundle/
    ├── msi/
    │   └── OpenColony_2.0.0_x64_en-US.msi      # MSI 安装包
    └── nsis/
        └── OpenColony_2.0.0_x64-setup.exe      # NSIS exe 安装包
```

## 开发模式

```bash
npm run tauri:dev
```

> 首次启动会编译 Rust 依赖，耗时 5-15 分钟，后续增量编译很快。

开发模式下 Tauri 直接从 `ui/` 目录加载前端文件，修改 JS/CSS 后刷新页面即可看到变化。

## 一键启动脚本

双击 `start-tauri.bat` 自动完成：
1. 检测 Rust/Cargo 和 Node.js/npm
2. 检测并安装 npm 依赖
3. 检查图标资源
4. 启动 `npm run tauri:dev`

## Tauri 配置说明

`tauri.conf.json` 关键配置：

- `build.devPath`: `"../ui"` — 开发模式读取 `ui/` 目录
- `build.distDir`: `"../ui"` — 构建时打包 `ui/` 目录
- `build.withGlobalTauri`: `true` — 前端通过 `window.__TAURI__` 调用
- `build.beforeBuildCommand` / `beforeDevCommand`: 空 — 前端无打包步骤

## 环境自检

构建前验证环境：

```bash
cargo --version && rustc --version && where link && node --version
```

四个命令都正常输出即可构建。

## 常见问题

### 1. `link.exe not found`

未安装 MSVC Build Tools，安装后重启终端：

```bash
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

### 2. `cargo not found`

检查 `%USERPROFILE%\.cargo\bin\cargo.exe` 是否存在。若不在 PATH：

```bash
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
```

### 3. 图标缺失

```bash
npm run tauri:icons
```

### 4. 首次编译慢

正常现象。首次构建需编译全部 Rust 依赖，后续增量编译很快。

### 5. 修改前端后看不到变化

开发模式下按 `Ctrl+R` 刷新，或重启 `npm run tauri:dev`。

> 注意：直接运行 `src-tauri/target/debug/` 下的 exe 使用的是构建时打包的旧资源，需 `cargo build` 重新编译才能看到 JS 修改。

## 相关文档

- [Tauri 官方文档](https://tauri.app/v1/guides/)
- [项目说明](README.md)
- [启动指南](STARTUP.md)
