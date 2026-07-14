#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{Manager, State};
use tokio::process::Command;

// ==================== 应用状态 ====================

struct AppState {
    /// 当前运行的任务子进程（traceId -> 业务描述）
    running_tasks: Mutex<HashMap<String, RunningTask>>,
    /// 当前会话ID
    session_id: Mutex<String>,
}

#[derive(Clone, Serialize)]
struct RunningTask {
    trace_id: String,
    task: String,
    started_at: String,
    pid: u32,
}

// ==================== 数据结构 ====================

#[derive(Serialize, Deserialize, Clone)]
struct TaskRequest {
    task: String,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TaskResult {
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SystemStatus {
    running: bool,
    agent_count: i32,
    task_queue: i32,
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_trace_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct AgentRole {
    id: String,
    name: String,
    description: String,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    skills: Vec<String>,
    // 运行时统计（从日志解析）
    #[serde(default)]
    task_count: i64,
    #[serde(default)]
    last_active: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Skill {
    id: String,
    name: String,
    description: String,
    category: String,
    version: String,
    status: String,
    icon: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct SkillFile {
    skills: Vec<Skill>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct SystemConfig {
    model_provider: String,
    model_name: String,
    api_key: String,
    api_base: String,
    claude_path: String,
    claude_url: String,
    max_agents: i32,
    #[serde(default = "default_run_mode")]
    run_mode: String,
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

#[derive(Serialize, Deserialize)]
struct TaskLogEntry {
    trace_id: String,
    task_dir: String,
    created_at: String,
    master_log: String,
    worker_logs: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct LogContent {
    file_name: String,
    content: String,
    size: u64,
}

// ==================== 路径辅助 ====================

/// 项目根目录（src-tauri 的父目录）
fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

/// 应用数据目录：~/.opencolony/
fn app_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".opencolony")
}

/// 系统配置文件路径
fn config_file_path() -> PathBuf {
    app_data_dir().join("config.json")
}

/// Worker 日志根目录：项目根/worker-logs/
fn worker_logs_root() -> PathBuf {
    project_root().join("worker-logs")
}

/// Scheduler 配置目录
fn scheduler_config_dir() -> PathBuf {
    project_root().join("scheduler").join("config")
}

/// Scheduler 入口文件
fn scheduler_entry() -> PathBuf {
    project_root().join("scheduler").join("src").join("index.ts")
}

/// .env 文件路径：优先 .env，不存在则回退到 .env.example
fn env_file_path() -> PathBuf {
    let env = project_root().join(".env");
    if env.exists() {
        env
    } else {
        project_root().join(".env.example")
    }
}

/// 实际写入的 .env 路径（始终为 .env）
fn env_write_path() -> PathBuf {
    project_root().join(".env")
}

// ==================== 工具函数 ====================

fn ensure_app_data_dir() {
    let dir = app_data_dir();
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
}

fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 解析 .env 文件为 HashMap（KEY=VALUE，忽略空行与 # 注释）
fn parse_env_file(path: &PathBuf) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(content) = fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(idx) = line.find('=') {
                let key = line[..idx].trim().to_string();
                let value = line[idx + 1..].trim().to_string();
                map.insert(key, value);
            }
        }
    }
    map
}

/// 将指定键值更新写入 .env 文件，保留原有注释与未涉及的键
fn update_env_file(path: &PathBuf, updates: &HashMap<String, String>) -> Result<(), String> {
    let content = if path.exists() {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    let mut output_lines: Vec<String> = Vec::new();
    let mut updated_keys: Vec<String> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            output_lines.push(line.to_string());
            continue;
        }
        if let Some(idx) = trimmed.find('=') {
            let key = trimmed[..idx].trim().to_string();
            if let Some(new_value) = updates.get(&key) {
                output_lines.push(format!("{}={}", key, new_value));
                updated_keys.push(key);
            } else {
                output_lines.push(line.to_string());
            }
        } else {
            output_lines.push(line.to_string());
        }
    }

    // 追加未在文件中出现的更新键
    for (key, value) in updates {
        if !updated_keys.contains(key) {
            output_lines.push(format!("{}={}", key, value));
        }
    }

    let mut result = output_lines.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }

    fs::write(path, result).map_err(|e| format!("写入 .env 失败: {}", e))
}

// ==================== Tauri 命令 ====================

/// 获取系统状态
#[tauri::command]
fn get_system_status(state: State<AppState>) -> SystemStatus {
    let tasks = state.running_tasks.lock().unwrap();
    let session = state.session_id.lock().unwrap().clone();
    let running = !tasks.is_empty();
    let current_trace_id = tasks.keys().next().cloned();

    // 统计 worker-logs 目录中的任务数量作为 task_queue
    let task_queue = count_task_dirs().unwrap_or(0) as i32;

    // agent_count：从 role.json 获取角色数
    let agent_count = count_roles().unwrap_or(0) as i32;

    SystemStatus {
        running,
        agent_count,
        task_queue,
        session_id: session,
        current_trace_id,
    }
}

/// 提交任务 - 启动 scheduler 子进程异步执行
#[tauri::command]
async fn submit_task(
    request: TaskRequest,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<TaskResult, String> {
    let task = request.task.clone();
    let mode = request.mode.unwrap_or_else(|| "sdk".to_string());

    log_info(&format!("[Tauri] 收到任务提交: {} (模式: {})", task, mode));

    // 启动 scheduler 子进程：npx ts-node scheduler/src/index.ts <mode> "task"
    let scheduler_path = scheduler_entry();
    if !scheduler_path.exists() {
        return Err(format!("Scheduler 入口不存在: {}", scheduler_path.display()));
    }

    let project_root = project_root();

    let mut cmd = Command::new("npx");
    cmd.current_dir(&project_root)
        .arg("ts-node")
        .arg(&scheduler_path)
        .arg(&mode)
        .arg(&task)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 scheduler 失败: {}", e))?;
    let pid = child.id().unwrap_or(0);
    let trace_id = format!("task_{}", chrono::Local::now().format("%Y%m%d%H%M%S"));

    {
        let mut tasks = state.running_tasks.lock().unwrap();
        tasks.insert(
            trace_id.clone(),
            RunningTask {
                trace_id: trace_id.clone(),
                task: task.clone(),
                started_at: now_iso(),
                pid,
            },
        );
    }

    // 异步等待子进程结束
    let trace_id_clone = trace_id.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        {
            let app_state: State<AppState> = app_handle.state();
            let mut tasks = app_state.running_tasks.lock().unwrap();
            tasks.remove(&trace_id_clone);
        }
        log_info(&format!("[Tauri] 任务 {} 子进程已退出", trace_id_clone));
    });

    Ok(TaskResult {
        success: true,
        message: "任务已提交，正在异步执行".to_string(),
        data: Some("任务正在执行中，可查看任务日志面板".to_string()),
        trace_id: Some(trace_id),
    })
}

/// 获取所有任务日志列表
#[tauri::command]
fn get_task_list() -> Vec<TaskLogEntry> {
    let root = worker_logs_root();
    let mut entries = Vec::new();

    if let Ok(dirs) = fs::read_dir(&root) {
        for dir_entry in dirs.flatten() {
            let path = dir_entry.path();
            if path.is_dir() {
                let dir_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                // 目录名格式: <traceId>_<timestamp>
                let (trace_id, created_at) = parse_task_dir_name(&dir_name);

                // 获取 Master 日志文件
                let master_log = path
                    .read_dir()
                    .ok()
                    .and_then(|mut iter| {
                        iter.next().and_then(|e| e.ok()).and_then(|e| {
                            let name = e.file_name().to_string_lossy().to_string();
                            if name.starts_with("Master_") {
                                Some(name)
                            } else {
                                None
                            }
                        })
                    })
                    .unwrap_or_default();

                // 获取所有 Worker 日志
                let mut worker_logs = Vec::new();
                if let Ok(rd) = fs::read_dir(&path) {
                    for we in rd.flatten() {
                        let name = we.file_name().to_string_lossy().to_string();
                        if name.starts_with("WorkerManager_") {
                            worker_logs.push(name);
                        }
                    }
                }

                let meta = fs::metadata(&path).ok();
                let created = meta
                    .and_then(|m| m.created().ok())
                    .map(|t| {
                        let dt: chrono::DateTime<chrono::Local> = t.into();
                        dt.format("%Y-%m-%d %H:%M:%S").to_string()
                    })
                    .unwrap_or_else(|| created_at.clone());

                entries.push(TaskLogEntry {
                    trace_id,
                    task_dir: dir_name,
                    created_at: created,
                    master_log,
                    worker_logs,
                });
            }
        }
    }

    // 按创建时间倒序
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    entries
}

/// 读取指定任务的日志文件内容
#[tauri::command]
fn get_task_log_content(task_dir: String, file_name: String) -> Result<LogContent, String> {
    let path = worker_logs_root().join(&task_dir).join(&file_name);
    if !path.exists() {
        return Err(format!("日志文件不存在: {}", path.display()));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(LogContent {
        file_name,
        content,
        size,
    })
}

/// 获取角色列表（从 scheduler/config/role.json 读取）
#[tauri::command]
fn get_agent_roles() -> Vec<AgentRole> {
    let role_file = scheduler_config_dir().join("role.json");
    if !role_file.exists() {
        return Vec::new();
    }

    #[derive(Deserialize)]
    struct RoleFile {
        roles: Vec<AgentRole>,
    }

    match fs::read_to_string(&role_file) {
        Ok(content) => {
            let parsed: RoleFile =
                serde_json::from_str(&content).unwrap_or(RoleFile { roles: Vec::new() });
            parsed.roles
        }
        Err(_) => Vec::new(),
    }
}

/// 获取 Skill 列表（从 scheduler/config/skill.json 读取）
#[tauri::command]
fn get_skills() -> Vec<Skill> {
    let skill_file = scheduler_config_dir().join("skill.json");
    if !skill_file.exists() {
        return Vec::new();
    }

    match fs::read_to_string(&skill_file) {
        Ok(content) => {
            let parsed: SkillFile =
                serde_json::from_str(&content).unwrap_or(SkillFile { skills: Vec::new() });
            parsed.skills
        }
        Err(_) => Vec::new(),
    }
}

/// 从 Claude 目录加载技能列表（.claude/skills.json + .claude/plugins/）
#[tauri::command]
fn get_skills_from_claude(claude_dir: String) -> TaskResult {
    let dir_path = Path::new(&claude_dir);
    
    if !dir_path.exists() || !dir_path.is_dir() {
        return TaskResult {
            success: false,
            message: format!("目录不存在: {}", claude_dir),
            data: None,
            trace_id: None,
        };
    }

    let mut all_skills: Vec<Skill> = Vec::new();

    let skills_json_path = dir_path.join("skills.json");
    if skills_json_path.exists() {
        match fs::read_to_string(&skills_json_path) {
            Ok(content) => {
                match serde_json::from_str::<SkillFile>(&content) {
                    Ok(parsed) => {
                        all_skills.extend(parsed.skills);
                    }
                    Err(e) => {
                        return TaskResult {
                            success: false,
                            message: format!("skills.json 解析失败: {}", e),
                            data: None,
                            trace_id: None,
                        };
                    }
                }
            }
            Err(e) => {
                return TaskResult {
                    success: false,
                    message: format!("读取 skills.json 失败: {}", e),
                    data: None,
                    trace_id: None,
                };
            }
        }
    }

    let plugins_dir = dir_path.join("plugins");
    if plugins_dir.exists() && plugins_dir.is_dir() {
        match fs::read_dir(&plugins_dir) {
            Ok(entries) => {
                for entry in entries.filter_map(|e| e.ok()) {
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if file_name.ends_with(".json") {
                        match fs::read_to_string(entry.path()) {
                            Ok(content) => {
                                match serde_json::from_str::<serde_json::Value>(&content) {
                                    Ok(plugin_data) => {
                                        let plugin_name = plugin_data.get("name")
                                            .and_then(|v| v.as_str()).unwrap_or(&file_name);
                                        let plugin_desc = plugin_data.get("description")
                                            .and_then(|v| v.as_str()).unwrap_or("");
                                        
                                        all_skills.push(Skill {
                                            id: format!("plugin-{}", plugin_name),
                                            name: plugin_name.to_string(),
                                            description: plugin_desc.to_string(),
                                            category: "插件".to_string(),
                                            version: "v1.0.0".to_string(),
                                            status: "活跃".to_string(),
                                            icon: "🔌".to_string(),
                                        });
                                    }
                                    Err(_) => {}
                                }
                            }
                            Err(_) => {}
                        }
                    }
                }
            }
            Err(_) => {}
        }
    }

    let skills_json = match serde_json::to_string(&all_skills) {
        Ok(j) => j,
        Err(e) => {
            return TaskResult {
                success: false,
                message: format!("序列化失败: {}", e),
                data: None,
                trace_id: None,
            };
        }
    };

    TaskResult {
        success: true,
        message: format!("成功加载 {} 个技能", all_skills.len()),
        data: Some(skills_json),
        trace_id: None,
    }
}

/// 保存技能列表到 skill.json 文件
#[tauri::command]
fn save_skills_to_file(skills_json: String) -> TaskResult {
    let skill_file_path = Path::new("scheduler/config/skill.json");
    
    let skills: Vec<Skill> = match serde_json::from_str(&skills_json) {
        Ok(s) => s,
        Err(e) => {
            return TaskResult {
                success: false,
                message: format!("JSON 解析失败: {}", e),
                data: None,
                trace_id: None,
            };
        }
    };

    let skill_file = SkillFile { skills };
    
    match serde_json::to_string_pretty(&skill_file) {
        Ok(content) => {
            match fs::write(skill_file_path, content) {
                Ok(_) => TaskResult {
                    success: true,
                    message: "技能保存成功".to_string(),
                    data: None,
                    trace_id: None,
                },
                Err(e) => TaskResult {
                    success: false,
                    message: format!("写入文件失败: {}", e),
                    data: None,
                    trace_id: None,
                },
            }
        }
        Err(e) => TaskResult {
            success: false,
            message: format!("序列化失败: {}", e),
            data: None,
            trace_id: None,
        },
    }
}

/// 获取系统配置
/// - api_key / api_base / model_name：从 .env（回退 .env.example）读取
/// - claude_path / claude_url / max_agents / run_mode：从 ~/.opencolony/config.json 读取
/// - model_provider：固定为 "Anthropic"
#[tauri::command]
fn get_system_config() -> SystemConfig {
    let env = parse_env_file(&env_file_path());

    let cfg_path = config_file_path();
    let stored: SystemConfig = if cfg_path.exists() {
        fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default()
    } else {
        SystemConfig::default()
    };

    SystemConfig {
        model_provider: "Anthropic".to_string(),
        api_key: env.get("ANTHROPIC_API_KEY").cloned().unwrap_or_default(),
        api_base: env
            .get("ANTHROPIC_BASE_URL")
            .cloned()
            .unwrap_or_default(),
        model_name: env.get("ANTHROPIC_MODEL").cloned().unwrap_or_default(),
        claude_path: stored.claude_path,
        claude_url: stored.claude_url,
        max_agents: stored.max_agents,
        run_mode: stored.run_mode,
    }
}

/// 保存系统配置
/// - api_key / api_base / model_name：写入项目根目录 .env 文件
/// - claude_path / claude_url / max_agents / run_mode：写入 ~/.opencolony/config.json
#[tauri::command]
fn save_system_config(config: SystemConfig) -> TaskResult {
    // 1. 写入 .env 文件（api_key, api_base, model_name）
    let env_target = env_write_path();
    let mut env_updates = HashMap::new();
    env_updates.insert("ANTHROPIC_API_KEY".to_string(), config.api_key.clone());
    env_updates.insert("ANTHROPIC_BASE_URL".to_string(), config.api_base.clone());
    env_updates.insert("ANTHROPIC_MODEL".to_string(), config.model_name.clone());

    if let Err(e) = update_env_file(&env_target, &env_updates) {
        return TaskResult {
            success: false,
            message: e,
            data: None,
            trace_id: None,
        };
    }

    // 2. 写入 config.json（claude_path, claude_url, max_agents, run_mode）
    ensure_app_data_dir();
    let cfg_path = config_file_path();
    let to_store = SystemConfig {
        model_provider: "Anthropic".to_string(),
        model_name: config.model_name.clone(),
        api_key: config.api_key.clone(),
        api_base: config.api_base.clone(),
        claude_path: config.claude_path.clone(),
        claude_url: config.claude_url.clone(),
        max_agents: config.max_agents,
        run_mode: config.run_mode.clone(),
    };

    match serde_json::to_string_pretty(&to_store) {
        Ok(json) => match fs::write(&cfg_path, json) {
            Ok(_) => {
                log_info(&format!(
                    "[Tauri] 配置已保存: .env + {}",
                    cfg_path.display()
                ));
                TaskResult {
                    success: true,
                    message: "配置保存成功".to_string(),
                    data: Some(format!(
                        ".env: {} | config.json: {}",
                        env_target.display(),
                        cfg_path.display()
                    )),
                    trace_id: None,
                }
            }
            Err(e) => TaskResult {
                success: false,
                message: format!("写入 config.json 失败: {}", e),
                data: None,
                trace_id: None,
            },
        },
        Err(e) => TaskResult {
            success: false,
            message: format!("序列化失败: {}", e),
            data: None,
            trace_id: None,
        },
    }
}

/// 测试 LLM 连接（真实 HTTP 调用）
#[tauri::command]
async fn test_model_connection() -> TaskResult {
    let config = get_system_config();
    if config.api_base.is_empty() {
        return TaskResult {
            success: false,
            message: "API 地址未配置".to_string(),
            data: None,
            trace_id: None,
        };
    }

    // 构造 OpenAI 兼容请求
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return TaskResult {
                success: false,
                message: format!("HTTP 客户端创建失败: {}", e),
                data: None,
                trace_id: None,
            }
        }
    };

    let body = serde_json::json!({
        "model": config.model_name,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 5
    });

    let mut req = client.post(&config.api_base).json(&body);
    if !config.api_key.is_empty() {
        req = req.bearer_auth(&config.api_key);
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                TaskResult {
                    success: true,
                    message: format!("大模型连接成功 ({})", config.model_name),
                    data: None,
                    trace_id: None,
                }
            } else {
                TaskResult {
                    success: false,
                    message: format!("HTTP {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("")),
                    data: None,
                    trace_id: None,
                }
            }
        }
        Err(e) => TaskResult {
            success: false,
            message: format!("连接失败: {}", e),
            data: None,
            trace_id: None,
        },
    }
}

/// 测试 Claude 连接（执行 claude --version）
#[tauri::command]
async fn test_claude_connection() -> TaskResult {
    let config = get_system_config();
    let claude_path = if config.claude_path.is_empty() {
        "claude".to_string()
    } else {
        config.claude_path
    };

    let mut cmd = Command::new(&claude_path);
    cmd.arg("--version");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output().await {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                TaskResult {
                    success: true,
                    message: format!("Claude 连接成功: {}", version),
                    data: Some(version),
                    trace_id: None,
                }
            } else {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                TaskResult {
                    success: false,
                    message: format!("Claude 命令失败: {}", err),
                    data: None,
                    trace_id: None,
                }
            }
        }
        Err(e) => TaskResult {
            success: false,
            message: format!("Claude 不可用 ({}): {}", claude_path, e),
            data: None,
            trace_id: None,
        },
    }
}

/// 获取 Worker 日志根目录路径
#[tauri::command]
fn get_worker_logs_root() -> String {
    worker_logs_root().display().to_string()
}

// ==================== 辅助函数 ====================

fn parse_task_dir_name(dir_name: &str) -> (String, String) {
    // 格式: <traceId>_<timestamp>，traceId 是 UUID，timestamp 是 ISO 时间
    // UUID 形如 8-4-4-4-12，包含 '-'，需要找最后一个 '_' 分割
    if let Some(idx) = dir_name.rfind('_') {
        let trace_id = dir_name[..idx].to_string();
        let timestamp = dir_name[idx + 1..].replace('-', ":");
        // 尝试转换为可读时间
        let readable = if timestamp.len() >= 15 {
            format!(
                "{}-{}-{} {}:{}:{}",
                &timestamp[0..4],
                &timestamp[4..6],
                &timestamp[6..8],
                &timestamp[9..11],
                &timestamp[11..13],
                &timestamp[13..15]
            )
        } else {
            timestamp
        };
        (trace_id, readable)
    } else {
        (dir_name.to_string(), String::new())
    }
}

fn count_task_dirs() -> Option<usize> {
    fs::read_dir(worker_logs_root()).ok().map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).count())
}

fn count_roles() -> Option<usize> {
    Some(get_agent_roles().len())
}

fn log_info(msg: &str) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    println!("[{}] {}", ts, msg);
}

// ==================== 主入口 ====================

fn main() {
    ensure_app_data_dir();

    let state = AppState {
        running_tasks: Mutex::new(HashMap::new()),
        session_id: Mutex::new(format!("#{}", chrono::Local::now().format("%H%M%S"))),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_system_status,
            submit_task,
            get_task_list,
            get_task_log_content,
            get_agent_roles,
            get_skills,
            get_skills_from_claude,
            save_skills_to_file,
            get_system_config,
            save_system_config,
            test_model_connection,
            test_claude_connection,
            get_worker_logs_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
