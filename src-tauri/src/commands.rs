use std::fs;
use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::models::*;
use crate::paths;
use crate::utils;

// ==================== 系统状态 ====================

#[tauri::command]
pub fn get_system_status(state: State<AppState>) -> SystemStatus {
    let tasks = state.running_tasks.lock().unwrap();
    let session = state.session_id.lock().unwrap().clone();
    let running = !tasks.is_empty();
    let current_trace_id = tasks.keys().next().cloned();

    let task_queue = utils::count_task_dirs().unwrap_or(0) as i32;
    let agent_count = get_agent_roles().len() as i32;

    SystemStatus {
        running,
        agent_count,
        task_queue,
        session_id: session,
        current_trace_id,
    }
}

// ==================== 任务管理 ====================

#[tauri::command]
pub async fn submit_task(
    request: TaskRequest,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<TaskResult, String> {
    let task = request.task.clone();
    let mode = request.mode.unwrap_or_else(|| "sdk".to_string());

    utils::log_info(&format!("[Tauri] 收到任务提交: {} (模式: {})", task, mode));

    let scheduler_path = paths::scheduler_entry();
    if !scheduler_path.exists() {
        return Err(format!("Scheduler 入口不存在: {}", scheduler_path.display()));
    }

    let project_root = paths::project_root();

    let mut cmd = Command::new("node");
    cmd.current_dir(&project_root)
        .arg("-r")
        .arg("ts-node/register")
        .arg(&scheduler_path)
        .arg(&mode)
        .arg(&task)
        .env("LOG_FORMAT", "json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
                started_at: utils::now_iso(),
                pid,
            },
        );
    }

    let trace_id_clone = trace_id.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        // 实时流式读取 stdout
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(rest) = line.strip_prefix("__LOG__:") {
                    // 结构化日志行：解析 JSON 并带 prefix 推送
                    let parsed: serde_json::Value = serde_json::from_str(rest).unwrap_or_default();
                    let prefix = parsed.get("prefix").and_then(|v| v.as_str()).unwrap_or("");
                    let message = parsed.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let level = parsed.get("level").and_then(|v| v.as_str()).unwrap_or("info");

                    let _ = app_handle.emit_all("scheduler-output", serde_json::json!({
                        "traceId": trace_id_clone,
                        "type": "log",
                        "prefix": prefix,
                        "message": message,
                        "level": level,
                    }));
                } else {
                    // 普通 stdout 行（非结构化日志）
                    let _ = app_handle.emit_all("scheduler-output", serde_json::json!({
                        "traceId": trace_id_clone,
                        "type": "stdout",
                        "line": line
                    }));
                }
            }
        }

        // 读取 stderr
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_handle.emit_all("scheduler-output", serde_json::json!({
                    "traceId": trace_id_clone,
                    "type": "stderr",
                    "line": line
                }));
            }
        }

        // 等待进程退出
        let exit_status = child.wait().await;
        let exit_code = exit_status.ok().and_then(|s| s.code());

        // 推送任务完成事件
        let _ = app_handle.emit_all("task-completed", serde_json::json!({
            "traceId": trace_id_clone,
            "exitCode": exit_code
        }));

        utils::log_info(&format!("[Tauri] 任务 {} 子进程已退出 (code: {:?})", trace_id_clone, exit_code));

        {
            let app_state: State<AppState> = app_handle.state();
            let mut tasks = app_state.running_tasks.lock().unwrap();
            tasks.remove(&trace_id_clone);
        }
    });

    Ok(TaskResult::ok_with_trace("任务已提交，正在异步执行", trace_id))
}

// ==================== 任务日志 ====================

#[tauri::command]
pub fn get_task_list() -> Vec<TaskLogEntry> {
    let root = paths::worker_logs_root();
    let mut entries = Vec::new();

    if let Ok(dirs) = fs::read_dir(&root) {
        for dir_entry in dirs.flatten() {
            let path = dir_entry.path();
            if path.is_dir() {
                let dir_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let (trace_id, created_at) = utils::parse_task_dir_name(&dir_name);

                let master_log = path
                    .read_dir()
                    .ok()
                    .and_then(|mut iter| {
                        iter.next().and_then(|e| e.ok()).and_then(|e| {
                            let name = e.file_name().to_string_lossy().to_string();
                            if name.starts_with("Master_") { Some(name) } else { None }
                        })
                    })
                    .unwrap_or_default();

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

    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    entries
}

#[tauri::command]
pub fn get_task_log_content(task_dir: String, file_name: String) -> Result<LogContent, String> {
    let path = paths::worker_logs_root().join(&task_dir).join(&file_name);
    if !path.exists() {
        return Err(format!("日志文件不存在: {}", path.display()));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(LogContent { file_name, content, size })
}

// ==================== 角色 ====================

#[derive(Serialize, Deserialize)]
struct RoleFile {
    roles: Vec<AgentRole>,
}

#[tauri::command]
pub fn get_agent_roles() -> Vec<AgentRole> {
    let role_file = paths::scheduler_config_dir().join("role.json");
    if !role_file.exists() {
        return Vec::new();
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

#[tauri::command]
pub fn save_agent_roles(roles_json: String) -> TaskResult {
    let role_file_path = paths::scheduler_config_dir().join("role.json");

    let roles: Vec<AgentRole> = match serde_json::from_str(&roles_json) {
        Ok(r) => r,
        Err(e) => return TaskResult::err(&format!("JSON 解析失败: {}", e)),
    };

    let role_file = RoleFile { roles };

    match serde_json::to_string_pretty(&role_file) {
        Ok(content) => match fs::write(role_file_path, content) {
            Ok(_) => TaskResult::ok("角色保存成功"),
            Err(e) => TaskResult::err(&format!("写入文件失败: {}", e)),
        },
        Err(e) => TaskResult::err(&format!("序列化失败: {}", e)),
    }
}

// ==================== 技能 ====================

#[tauri::command]
pub fn get_skills() -> Vec<Skill> {
    let skill_file = paths::scheduler_config_dir().join("skill.json");
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

#[tauri::command]
pub fn get_skills_from_claude(claude_dir: String) -> TaskResult {
    let dir_path = Path::new(&claude_dir);

    if !dir_path.exists() || !dir_path.is_dir() {
        return TaskResult::err(&format!("目录不存在: {}", claude_dir));
    }

    let mut all_skills: Vec<Skill> = Vec::new();

    // 解析 installed_plugins.json
    let installed_plugins_path = dir_path.join("plugins").join("installed_plugins.json");
    if installed_plugins_path.exists() {
        match fs::read_to_string(&installed_plugins_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(installed_data) => {
                        if let Some(plugins) = installed_data.get("plugins").and_then(|p| p.as_object()) {
                            for (plugin_key, plugin_value) in plugins.iter() {
                                if let Some(plugin_list) = plugin_value.as_array() {
                                    for plugin_data in plugin_list.iter() {
                                        let name = plugin_data.get("version")
                                            .and_then(|v| v.as_str()).unwrap_or(plugin_key);
                                        let install_path = plugin_data.get("installPath")
                                            .and_then(|v| v.as_str()).unwrap_or("");
                                        let plugin_name = plugin_key.split('@').next().unwrap_or(plugin_key);

                                        all_skills.push(Skill {
                                            id: format!("plugin-{}", plugin_name),
                                            name: format!("{} v{}", plugin_name, name),
                                            description: format!("安装路径: {}", install_path),
                                            category: "插件".to_string(),
                                            version: name.to_string(),
                                            status: "活跃".to_string(),
                                            icon: "🔌".to_string(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => return TaskResult::err(&format!("installed_plugins.json 解析失败: {}", e)),
                }
            }
            Err(e) => return TaskResult::err(&format!("读取 installed_plugins.json 失败: {}", e)),
        }
    }

    // 解析 skills 目录（子目录形式 + 直接 .md 文件形式）
    let skills_dir = dir_path.join("skills");
    if skills_dir.exists() && skills_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    // 子目录形式: skills/<skill_id>/SKILL.md
                    let skill_id = entry.file_name().to_string_lossy().to_string();
                    let skill_file = path.join("SKILL.md");
                    if skill_file.exists() {
                        if let Ok(content) = fs::read_to_string(&skill_file) {
                            let skill_info = parse_claude_skill(&skill_id, &content);
                            if !skill_info.id.is_empty() {
                                all_skills.push(skill_info);
                            }
                        }
                    }
                } else if path.is_file() {
                    // 直接文件形式: skills/<skill_id>.md
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if file_name.ends_with(".md") {
                        let skill_id = file_name.trim_end_matches(".md").to_string();
                        if let Ok(content) = fs::read_to_string(&path) {
                            let skill_info = parse_claude_skill(&skill_id, &content);
                            if !skill_info.id.is_empty() {
                                all_skills.push(skill_info);
                            }
                        }
                    }
                }
            }
        }
    }

    match serde_json::to_string(&all_skills) {
        Ok(json) => TaskResult::ok_with_data(&format!("成功加载 {} 个技能", all_skills.len()), json),
        Err(e) => TaskResult::err(&format!("序列化失败: {}", e)),
    }
}

fn parse_claude_skill(skill_id: &str, content: &str) -> Skill {
    let mut name = skill_id.replace('-', " ").to_string();
    let mut description = String::new();

    let lines: Vec<&str> = content.lines().collect();

    // 解析 YAML front matter
    if lines.len() >= 4 && lines[0] == "---" {
        for i in 1..lines.len() {
            if lines[i] == "---" {
                break;
            }
            if let Some((key, val)) = lines[i].split_once(':') {
                let key = key.trim();
                let val = val.trim().trim_matches('"').trim_matches('\'');
                if key == "name" {
                    name = val.to_string();
                } else if key == "description" {
                    description = val.to_string();
                }
            }
        }
    }

    // 回退：从 ## 概述 / ## 简节 提取描述
    if description.is_empty() {
        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("## 概述") || line.starts_with("## 简介") {
                for j in i + 1..lines.len() {
                    let next_line = lines[j];
                    if next_line.starts_with("## ") {
                        break;
                    }
                    if !next_line.is_empty() {
                        description.push_str(next_line.trim());
                        description.push('\n');
                    }
                }
                description = description.trim().to_string();
                break;
            }
        }
    }

    if description.is_empty() {
        description = "技能文档".to_string();
    }

    Skill {
        id: skill_id.to_string(),
        name,
        description,
        category: "技能".to_string(),
        version: "v1.0.0".to_string(),
        status: "活跃".to_string(),
        icon: "🎯".to_string(),
    }
}

#[tauri::command]
pub fn save_skills_to_file(skills_json: String) -> TaskResult {
    let skill_file_path = paths::scheduler_config_dir().join("skill.json");

    let skills: Vec<Skill> = match serde_json::from_str(&skills_json) {
        Ok(s) => s,
        Err(e) => return TaskResult::err(&format!("JSON 解析失败: {}", e)),
    };

    let skill_file = SkillFile { skills };

    match serde_json::to_string_pretty(&skill_file) {
        Ok(content) => match fs::write(skill_file_path, content) {
            Ok(_) => TaskResult::ok("技能保存成功"),
            Err(e) => TaskResult::err(&format!("写入文件失败: {}", e)),
        },
        Err(e) => TaskResult::err(&format!("序列化失败: {}", e)),
    }
}

// ==================== 系统配置 ====================

#[tauri::command]
pub fn get_system_config() -> SystemConfig {
    let env = utils::parse_env_file(&paths::env_file_path());

    let cfg_path = paths::config_file_path();
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
        api_base: env.get("ANTHROPIC_BASE_URL").cloned().unwrap_or_default(),
        model_name: env.get("ANTHROPIC_MODEL").cloned().unwrap_or_default(),
        claude_path: stored.claude_path,
        claude_url: stored.claude_url,
        max_agents: stored.max_agents,
        run_mode: stored.run_mode,
    }
}

#[tauri::command]
pub fn save_system_config(config: SystemConfig) -> TaskResult {
    // 1. 写入 .env 文件（api_key, api_base, model_name）
    let env_target = paths::env_write_path();
    let mut env_updates = std::collections::HashMap::new();
    env_updates.insert("ANTHROPIC_API_KEY".to_string(), config.api_key.clone());
    env_updates.insert("ANTHROPIC_BASE_URL".to_string(), config.api_base.clone());
    env_updates.insert("ANTHROPIC_MODEL".to_string(), config.model_name.clone());

    if let Err(e) = utils::update_env_file(&env_target, &env_updates) {
        return TaskResult::err(&e);
    }

    // 2. 写入 config.json（claude_path, claude_url, max_agents, run_mode）
    utils::ensure_app_data_dir();
    let cfg_path = paths::config_file_path();
    let to_store = SystemConfig {
        model_provider: "Anthropic".to_string(),
        ..config
    };

    match serde_json::to_string_pretty(&to_store) {
        Ok(json) => match fs::write(&cfg_path, json) {
            Ok(_) => {
                utils::log_info(&format!("[Tauri] 配置已保存: .env + {}", cfg_path.display()));
                TaskResult::ok_with_data(
                    "配置保存成功",
                    format!(".env: {} | config.json: {}", env_target.display(), cfg_path.display()),
                )
            }
            Err(e) => TaskResult::err(&format!("写入 config.json 失败: {}", e)),
        },
        Err(e) => TaskResult::err(&format!("序列化失败: {}", e)),
    }
}

// ==================== 连接测试 ====================

#[tauri::command]
pub async fn test_model_connection() -> TaskResult {
    let config = get_system_config();
    if config.api_base.is_empty() {
        return TaskResult::err("API 地址未配置");
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return TaskResult::err(&format!("HTTP 客户端创建失败: {}", e)),
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
                TaskResult::ok(&format!("大模型连接成功 ({})", config.model_name))
            } else {
                TaskResult::err(&format!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("")
                ))
            }
        }
        Err(e) => TaskResult::err(&format!("连接失败: {}", e)),
    }
}

#[tauri::command]
pub async fn test_claude_connection() -> TaskResult {
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
                TaskResult::ok_with_data(&format!("Claude 连接成功: {}", version), version)
            } else {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                TaskResult::err(&format!("Claude 命令失败: {}", err))
            }
        }
        Err(e) => TaskResult::err(&format!("Claude 不可用 ({}): {}", claude_path, e)),
    }
}

// ==================== 其他 ====================

#[tauri::command]
pub fn get_worker_logs_root() -> String {
    paths::worker_logs_root().display().to_string()
}
