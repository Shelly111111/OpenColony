# OpenColony 桌面应用打包指南

本项目使用 **Tauri 1.5** 将前端 + Rust 后端打包为 Windows 桌面 exe 程序。

## 项目结构

```
OpenColony/
├── ui/                         # 前端（纯 HTML/CSS/JS，无打包步骤）
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src-tauri/                  # Tauri 桌面应用工程
│   ├── src/
│   │   └── main.rs             # Rust 后端 + Tauri 命令
│   ├── icons/                  # 应用图标资源
│   ├── tauri.conf.json         # Tauri 核心配置
│   ├── Cargo.toml              # Rust 依赖配置
│   └── build.rs
├── scripts/
│   ├── generate-ico.js         # 图标生成脚本
│   └── generate-icons.js
├── start-tauri.bat             # Windows 一键启动脚本
└── package.json                # 包含 tauri 相关 npm scripts
```

## Tauri 配置说明

[tauri.conf.json](src-tauri/tauri.conf.json) 关键配置：

```json
{
  "build": {
    "beforeDevCommand": "",
    "beforeBuildCommand": "",
    "devPath": "../ui",
    "distDir": "../ui",
    "withGlobalTauri": true
  },
  "package": {
    "productName": "OpenColony",
    "version": "2.0.0"
  },
  "tauri": {
    "bundle": {
      "active": true,
      "targets": "all",
      "identifier": "com.opencolony.app",
      "category": "Productivity",
      "shortDescription": "OpenColony Master调度集群",
      "longDescription": "分布式Agent调度系统 - 基于Claude的多终端统一调度平台"
    },
    "windows": [
      {
        "title": "OpenColony - Master调度集群",
        "width": 1400,
        "height": 900,
        "minWidth": 1000,
        "minHeight": 700,
        "resizable": true
      }
    ]
  }
}
```

因为前端是纯静态文件，所以 `beforeBuildCommand` / `beforeDevCommand` 留空，Tauri 直接把 `ui/` 目录作为前端资源使用。

## 前置依赖

| 依赖 | 用途 | 安装命令 |
|------|------|---------|
| **Rust 工具链** (cargo) | 编译 Rust 后端 | `winget install Rustlang.Rustup` |
| **Node.js** ≥ 18 | 运行 Tauri CLI / npm 脚本 | `winget install OpenJS.NodeJS.LTS` |
| **MSVC Build Tools** | Windows 链接器 (link.exe) | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |

> 官网下载地址：
> - Rust: https://rustup.rs/
> - Node.js: https://nodejs.org/

## 构建步骤

### 1. 安装依赖（首次执行）

```bash
npm install
```

### 2. 构建 Windows exe 安装包

```bash
# 默认构建（生成所有目标平台安装包）
npm run tauri:build

# 明确指定 Windows 目标
npm run tauri:build:windows
```

对应的 package.json 脚本：
- `tauri:build` → `tauri build`
- `tauri:build:windows` → `tauri build --target x86_64-pc-windows-msvc`

### 3. 构建产物位置

构建完成后，产物位于 `src-tauri/target/release/` 下：

```
src-tauri/target/release/
├── opencolony.exe                              # 独立可执行文件
└── bundle/
    ├── msi/
    │   └── OpenColony_2.0.0_x64_en-US.msi      # MSI 安装包
    └── nsis/
        └── OpenColony_2.0.0_x64-setup.exe      # NSIS exe 安装包
```

## 开发模式（热重载调试）

```bash
# 直接运行 Tauri 开发模式
npm run tauri:dev

# 或使用一键启动脚本（会自动检查依赖、生成图标）
start-tauri.bat
```

> 首次启动会下载并编译 Rust 依赖，耗时较长（5-15 分钟），后续启动会快很多。

## 一键启动脚本

[start-tauri.bat](start-tauri.bat) 会自动完成以下工作：

1. 检测 Rust/Cargo 是否安装
2. 检测 Node.js/npm 是否安装
3. 检测并自动安装 npm 依赖
4. 检查图标资源，缺失时自动生成
5. 检测 MSVC 编译器并给出安装提示
6. 启动 `npm run tauri:dev`

直接双击运行即可。

## 构建流程图

```
npm run tauri:build
        ↓
Tauri CLI 调用 cargo build --release
        ↓
Rust 编译 src-tauri/src/main.rs → opencolony.exe
        ↓
打包 ui/ 目录作为前端资源嵌入 exe
        ↓
生成 MSI / NSIS 安装包到 src-tauri/target/release/bundle/
```

## 环境自检

构建前可先验证环境是否就绪：

```bash
cargo --version
rustc --version
where link
node --version
```

四个命令都能正常输出版本号，即可执行 `npm run tauri:build`。

## 常见问题

### 1. 报错 `link.exe not found`

未安装 MSVC Build Tools，执行：
```bash
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```
安装完成后重启终端。

### 2. 报错 `cargo not found`

Rust 未安装或未加入 PATH：
- 检查 `%USERPROFILE%\.cargo\bin\cargo.exe` 是否存在
- 若存在但不在 PATH，临时添加：`set PATH=%USERPROFILE%\.cargo\bin;%PATH%`
- 若不存在：`winget install Rustlang.Rustup`

### 3. 图标缺失

执行图标生成脚本：
```bash
npm run tauri:icons
# 或
node scripts/generate-ico.js
```

### 4. 首次编译特别慢

正常现象。首次构建需要下载并编译全部 Rust 依赖（Tauri 本身也是 Rust 项目），耗时 5-15 分钟。后续增量编译会很快。

### 5. 修改前端后看不到变化

开发模式下 Tauri 会监听 `ui/` 目录变化并自动刷新。如果没刷新：
- 确认改动在 `ui/` 目录下
- 尝试在窗口中按 `Ctrl+R` 手动刷新
- 重启 `npm run tauri:dev`

## 相关文档

- [Tauri 官方文档](https://tauri.app/v1/guides/)
- [项目启动指南](STARTUP.md)
- [项目说明](README.md)
