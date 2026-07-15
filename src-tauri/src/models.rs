use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// ==================== 应用状态 ====================

pub struct AppState {
    /// 当前运行的任务子进程（traceId -> 业务描述）
    pub running_tasks: Mutex<HashMap<String, RunningTask>>,
    /// 当前会话ID
    pub session_id: Mutex<String>,
}

#[derive(Clone, Serialize, Debug)]
pub struct RunningTask {
    pub trace_id: String,
    pub task: String,
    pub started_at: String,
    pub pid: u32,
}

// ==================== 通用结果 ====================

#[derive(Serialize)]
pub struct TaskResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

impl TaskResult {
    pub fn ok(message: &str) -> Self {
        TaskResult { success: true, message: message.to_string(), data: None, trace_id: None }
    }

    pub fn ok_with_data(message: &str, data: String) -> Self {
        TaskResult { success: true, message: message.to_string(), data: Some(data), trace_id: None }
    }

    pub fn ok_with_trace(message: &str, trace_id: String) -> Self {
        TaskResult { success: true, message: message.to_string(), data: None, trace_id: Some(trace_id) }
    }

    pub fn err(message: &str) -> Self {
        TaskResult { success: false, message: message.to_string(), data: None, trace_id: None }
    }
}

// ==================== 请求 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct TaskRequest {
    pub task: String,
    #[serde(default)]
    pub mode: Option<String>,
}

// ==================== 系统状态 ====================

#[derive(Serialize, Clone)]
pub struct SystemStatus {
    pub running: bool,
    pub agent_count: i32,
    pub task_queue: i32,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_trace_id: Option<String>,
}

// ==================== 角色 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentRole {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub task_count: i64,
    #[serde(default)]
    pub last_active: Option<String>,
}

// ==================== 技能 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub version: String,
    pub status: String,
    pub icon: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SkillFile {
    pub skills: Vec<Skill>,
}

// ==================== 系统配置 ====================

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SystemConfig {
    pub model_provider: String,
    pub model_name: String,
    pub api_key: String,
    pub api_base: String,
    pub claude_path: String,
    pub claude_url: String,
    pub max_agents: i32,
    #[serde(default = "default_run_mode")]
    pub run_mode: String,
}

fn default_run_mode() -> String {
    "sdk".to_string()
}

impl Default for SystemConfig {
    fn default() -> Self {
        SystemConfig {
            model_provider: "Anthropic".to_string(),
            model_name: "claude-3-5-sonnet-20241022".to_string(),
            api_key: String::new(),
            api_base: "https://api.anthropic.com".to_string(),
            claude_path: "claude".to_string(),
            claude_url: ".claude".to_string(),
            max_agents: 8,
            run_mode: "sdk".to_string(),
        }
    }
}

// ==================== 日志 ====================

#[derive(Serialize)]
pub struct TaskLogEntry {
    pub trace_id: String,
    pub task_dir: String,
    pub created_at: String,
    pub master_log: String,
    pub worker_logs: Vec<String>,
}

#[derive(Serialize)]
pub struct LogContent {
    pub file_name: String,
    pub content: String,
    pub size: u64,
}
