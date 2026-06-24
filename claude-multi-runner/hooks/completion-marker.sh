#!/bin/bash
# 当 Claude 任务完成时，写入标记文件
# 环境变量 CLAUDE_SESSION_ID 用于标识会话
MARKER_DIR="$(pwd)/claude-logs/.completion"
mkdir -p "$MARKER_DIR"

# 获取 session ID，如果没有则使用默认值
SESSION_ID="${CLAUDE_SESSION_ID:-default}"

# 写入时间戳标记
echo "$(date)" > "$MARKER_DIR/completed-${SESSION_ID}.marker"