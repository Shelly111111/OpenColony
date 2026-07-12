#!/bin/bash
echo "========================================"
echo "OpenColony Tauri 桌面应用 - 启动脚本"
echo "========================================"
echo ""

MISSING_DEPS=0

if ! command -v cargo &> /dev/null; then
    if [ -f "$HOME/.cargo/bin/cargo" ]; then
        echo "[提示] 检测到 Rust 但未加入 PATH，正在临时添加..."
        export PATH="$HOME/.cargo/bin:$PATH"
    else
        echo "[错误 X] 未检测到 Rust/Cargo（Tauri 必需依赖）"
        echo ""
        echo "安装方法:"
        echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        echo ""
        echo "安装完成后请重新打开终端再运行本脚本。"
        echo ""
        MISSING_DEPS=1
    fi
fi

if ! command -v npm &> /dev/null; then
    echo "[错误 X] 未检测到 npm/Node.js"
    echo ""
    echo "安装方法:"
    echo "  macOS:   brew install node"
    echo "  Linux:   参见 https://nodejs.org/"
    echo ""
    MISSING_DEPS=1
fi

if [ "$MISSING_DEPS" -eq 1 ]; then
    exit 1
fi

echo "[✓] Rust/Cargo 已就绪"
echo "[✓] Node.js/npm 已就绪"
echo ""

echo "[1/4] 检查 npm 依赖..."
if [ ! -d "node_modules" ]; then
    echo "正在安装 npm 依赖，这可能需要几分钟..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[错误] npm 依赖安装失败"
        exit 1
    fi
fi
echo "[✓] npm 依赖已就绪"
echo ""

echo "[2/4] 检查图标资源..."
if [ ! -f "src-tauri/icons/icon.ico" ] && [ ! -f "src-tauri/icons/icon.icns" ]; then
    echo "正在生成图标..."
    node scripts/generate-ico.js
fi
echo "[✓] 图标资源已就绪"
echo ""

echo "[3/4] 环境检查完成"
echo ""

echo "[4/4] 启动 Tauri 开发模式..."
echo "  首次启动会下载并编译 Rust 依赖，需要 5-15 分钟，请耐心等待..."
echo ""
npm run tauri:dev

if [ $? -ne 0 ]; then
    echo ""
    echo "[错误] Tauri 启动失败"
    echo "  macOS: 确保已安装 Xcode Command Line Tools (xcode-select --install)"
    echo "  Linux: 确保已安装 webkit2gtk 等依赖"
    echo ""
fi
