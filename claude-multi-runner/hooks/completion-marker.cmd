@echo off
REM 当 Claude 任务完成时，写入标记文件
REM 环境变量 CLAUDE_SESSION_ID 用于标识会话
set MARKER_DIR=%cd%\claude-logs\.completion
if not exist "%MARKER_DIR%" mkdir "%MARKER_DIR%"

REM 获取 session ID，如果没有则使用默认值
if "%CLAUDE_SESSION_ID%"=="" set CLAUDE_SESSION_ID=default

REM 写入时间戳标记
echo %DATE% %TIME% > "%MARKER_DIR%\completed-%CLAUDE_SESSION_ID%.marker"
echo Marker file created: %MARKER_DIR%\completed-%CLAUDE_SESSION_ID%.marker