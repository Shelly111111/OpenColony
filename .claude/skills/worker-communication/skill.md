# Worker 协作通讯技能

## 概述

你是一个在多 Agent 系统中工作的 Worker，可以与同层的其他 Worker 进行协作通讯。系统已为你配备了 `worker-collaboration` 工具集，你可以像使用其他内置工具一样调用这些工具来发送消息。

## 可用协作工具

### 1. send_to - 发送私信
向指定的 Worker 发送普通优先级的私信。

**参数：**
- `worker_id` (string): 目标 Worker 的 ID
- `message` (string): 消息内容

**示例：**
```
我需要询问 worker-2 的进度，让我调用 send_to 工具。

send_to({
  worker_id: "worker-2",
  message: "你负责的用户服务模块进度如何？是否需要帮助？"
})
```

### 2. send_to_high - 发送高优先级消息
向指定的 Worker 发送高优先级消息，目标 Worker 会立即暂停当前任务并处理。

**参数：**
- `worker_id` (string): 目标 Worker 的 ID
- `message` (string): 消息内容

**示例：**
```
检测到紧急情况，需要立即通知 worker-1。

send_to_high({
  worker_id: "worker-1",
  message: "紧急：数据库连接池耗尽，请立即释放连接！"
})
```

### 3. broadcast - 广播消息
向同层所有其他 Worker 广播消息。

**参数：**
- `message` (string): 广播消息内容

**示例：**
```
需要通知所有同事关于 API 网关切换的消息。

broadcast({
  message: "注意：API 网关已切换到备用节点，请所有服务重新建立连接"
})
```

### 4. ask_help - 请求协作帮助
向指定的 Worker 请求协作帮助。

**参数：**
- `worker_id` (string): 目标 Worker 的 ID
- `task_description` (string): 需要帮助的任务描述

**示例：**
```
遇到了复杂的 JSON 解析问题，需要请求帮助。

ask_help({
  worker_id: "worker-3",
  task_description: "我需要解析一个复杂的 JSON 配置文件，包含嵌套的条件逻辑，能否协助？"
})
```

## 消息优先级说明

| 优先级 | 工具 | 效果 |
|--------|------|------|
| 高 | send_to_high | 目标 Worker 立即暂停并处理 |
| 普通 | send_to, broadcast, ask_help | 目标 Worker 在当前任务间隙处理 |

## 使用场景

### 场景一：进度同步
当你完成一个关键步骤时，通知相关 Worker：
```
send_to({
  worker_id: "worker-2",
  message: "用户认证模块已完成，可以开始集成测试"
})
```

### 场景二：问题求助
当你遇到困难需要帮助时：
```
ask_help({
  worker_id: "worker-4",
  task_description: "我在解析复杂的 XML 文件时遇到了命名空间问题，能否协助分析？"
})
```

### 场景三：紧急通知
当检测到严重问题时：
```
send_to_high({
  worker_id: "worker-1",
  message: "发现数据不一致，立即停止写入操作！"
})
```

### 场景四：全局通知
当需要通知所有同层 Worker 时：
```
broadcast({
  message: "代码仓库已更新，请拉取最新版本"
})
```

## 最佳实践

1. **明确目标**：发送消息前明确知道要与哪个 Worker 通讯
2. **简洁清晰**：消息内容要简洁明了，避免歧义
3. **适度使用**：不要过度频繁发送消息，避免打扰其他 Worker
4. **高优先级慎用**：高优先级消息会打断目标 Worker 的当前任务，只在紧急情况下使用

## 注意事项

- 工具调用会自动记录到日志中，便于追踪和调试
- 工具调用有返回结果，可以确认消息是否发送成功
- 系统会自动将你的 Worker ID 作为消息发送者
- 如果目标 Worker 不存在，工具会返回相应的错误提示
