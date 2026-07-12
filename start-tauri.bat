@echo off
chcp 65001 >nul
echo ========================================
echo OpenColony Tauri 桌面应用 - 启动脚本
echo ========================================
echo.

set "MISSING_DEPS=0"

where cargo >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
        echo [提示] 检测到 Rust 但未加入 PATH，正在临时添加...
        set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
    ) else (
        echo [错误 X] 未检测到 Rust/Cargo（Tauri 必需依赖）
        echo.
        echo 安装方法（任选其一）:
        echo   1. 命令行安装: winget install Rustlang.Rustup
        echo   2. 官网下载: https://rustup.rs/
        echo.
        echo 安装完成后请重新打开终端再运行本脚本。
        echo.
        set "MISSING_DEPS=1"
    )
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误 X] 未检测到 npm/Node.js
    echo.
    echo 安装方法:
    echo   1. 命令行安装: winget install OpenJS.NodeJS.LTS
    echo   2. 官网下载: https://nodejs.org/
    echo.
    set "MISSING_DEPS=1"
)

if "%MISSING_DEPS%"=="1" (
    pause
    exit /b 1
)

echo [✓] Rust/Cargo 已就绪
echo [✓] Node.js/npm 已就绪
echo.

echo [1/4] 检查 npm 依赖...
if not exist "node_modules" (
    echo 正在安装 npm 依赖，这可能需要几分钟...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] npm 依赖安装失败
        pause
        exit /b 1
    )
)
echo [✓] npm 依赖已就绪
echo.

echo [2/4] 检查图标资源...
if not exist "src-tauri\icons\icon.ico" (
    echo 正在生成图标...
    call node scripts\generate-ico.js
)
echo [✓] 图标资源已就绪
echo.

echo [3/4] 检查编译环境...
where link >nul 2>nul
if %errorlevel% neq 0 (
    echo [警告] 未检测到 MSVC 编译器 (link.exe)
    echo   如构建时报错，请安装 Visual Studio Build Tools:
    echo   winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    echo.
)
echo [✓] 环境检查完成
echo.

echo [4/4] 启动 Tauri 开发模式...
echo   首次启动会下载并编译 Rust 依赖，需要 5-15 分钟，请耐心等待...
echo.
call npm run tauri:dev

if %errorlevel% neq 0 (
    echo.
    echo [错误] Tauri 启动失败
    echo   如报 link.exe 错误: 安装 VS Build Tools
    echo   如报 cargo 错误:  确认 Rust 安装正确
    echo.
)

pause
