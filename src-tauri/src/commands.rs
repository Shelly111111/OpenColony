use std::fs;
use std::path::Path;
use std::process::Stdio;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    let project_id = request.project_id.unwrap_or_else(|| "__global__".to_string());

    utils::log_info(&format!("[Tauri] 收到任务提交: {} (模式: {}, 项目: {})", task, mode, project_id));

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
        .env("PERMISSION_MODE", &state.permission_mode.lock().unwrap().clone())
        .env("PERMISSION_TIMEOUT_MS", format!("{}", state.permission_timeout_ms.lock().unwrap().clone() * 1000))
        .env("ARBITRATION_MODE", &state.arbitration_mode.lock().unwrap().clone())
        .env("SAME_LAYER_ASYNC", format!("{}", state.same_layer_async.lock().unwrap().clone()))
        .env("MAX_CONCURRENCY", format!("{}", state.max_concurrency.lock().unwrap().clone()))
        .env("TASK_TIMEOUT_MS", format!("{}", state.task_timeout_ms.lock().unwrap().clone()))
        .env("PROJECT_ID", &project_id)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 scheduler 失败: {}", e))?;
    let pid = child.id().unwrap_or(0);
    let trace_id = format!("task_{}", chrono::Local::now().format("%Y%m%d%H%M%S"));

    // 取出 stdin 并存入 AppState，供 inject_info 命令使用
    let child_stdin = child.stdin.take();
    {
        let mut stdin_lock = state.scheduler_stdin.lock().await;
        *stdin_lock = child_stdin;
    }

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

                    // 检测权限审批请求：message 以 __PERM_REQ__: 开头
                    if let Some(perm_json) = message.strip_prefix("__PERM_REQ__:") {
                        let perm_data: serde_json::Value = serde_json::from_str(perm_json).unwrap_or_default();
                        let _ = app_handle.emit_all("permission-request", serde_json::json!({
                            "traceId": trace_id_clone,
                            "request_id": perm_data.get("request_id").and_then(|v| v.as_str()).unwrap_or(""),
                            "worker_id": perm_data.get("worker_id").and_then(|v| v.as_str()).unwrap_or(""),
                            "tool_name": perm_data.get("tool_name").and_then(|v| v.as_str()).unwrap_or(""),
                            "tool_input": perm_data.get("tool_input").cloned().unwrap_or(serde_json::json!({})),
                            "permission_suggestions": perm_data.get("permission_suggestions").cloned().unwrap_or(serde_json::json!([])),
                        }));
                    } else {
                        let _ = app_handle.emit_all("scheduler-output", serde_json::json!({
                            "traceId": trace_id_clone,
                            "type": "log",
                            "prefix": prefix,
                            "message": message,
                            "level": level,
                        }));
                    }
                } else if let Some(rest) = line.strip_prefix("__INJECT_RESULT__:") {
                    // 补充信息注入结果：解析 JSON，按 request_id 匹配 pending channel
                    let parsed: serde_json::Value = serde_json::from_str(rest).unwrap_or_default();
                    let req_id = parsed.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let app_state: State<AppState> = app_handle.state();
                    let mut pending = app_state.pending_injects.lock().unwrap();
                    if let Some(tx) = pending.remove(&req_id) {
                        let _ = tx.send(parsed);
                    }
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
            {
                let mut tasks = app_state.running_tasks.lock().unwrap();
                tasks.remove(&trace_id_clone);
            }
            // 清理 stdin 和未响应的 inject 请求
            let mut stdin_lock = app_state.scheduler_stdin.lock().await;
            *stdin_lock = None;
            let mut pending = app_state.pending_injects.lock().unwrap();
            pending.clear();
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

                                        // 解析插件下的子技能
                                        let mut sub_skills: Vec<Skill> = Vec::new();
                                        let plugin_skills_dir = Path::new(install_path).join("skills");
                                        if plugin_skills_dir.exists() && plugin_skills_dir.is_dir() {
                                            if let Ok(entries) = fs::read_dir(&plugin_skills_dir) {
                                                for sub_entry in entries.filter_map(|e| e.ok()) {
                                                    let sub_path = sub_entry.path();
                                                    if sub_path.is_dir() {
                                                        let sub_skill_id = sub_entry.file_name().to_string_lossy().to_string();
                                                        let sub_skill_file = sub_path.join("SKILL.md");
                                                        if sub_skill_file.exists() {
                                                            if let Ok(content) = fs::read_to_string(&sub_skill_file) {
                                                                let sub_skill = parse_claude_skill(&sub_skill_id, &content);
                                                                if !sub_skill.id.is_empty() {
                                                                    sub_skills.push(sub_skill);
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        all_skills.push(Skill {
                                            id: plugin_name.to_string(),
                                            name: format!("{} v{}", plugin_name, name),
                                            description: format!("安装路径: {}", install_path),
                                            category: "插件".to_string(),
                                            version: name.to_string(),
                                            status: "活跃".to_string(),
                                            icon: "🔌".to_string(),
                                            sub_skills,
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
        sub_skills: Vec::new(),
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
        permission_mode: env.get("PERMISSION_MODE").cloned().unwrap_or_else(|| stored.permission_mode.clone()),
        permission_timeout_ms: env.get("PERMISSION_TIMEOUT_MS").and_then(|v| v.parse().ok()).unwrap_or(stored.permission_timeout_ms),
        arbitration_mode: env.get("ARBITRATION_MODE").cloned().unwrap_or_else(|| stored.arbitration_mode.clone()),
        same_layer_async: env.get("SAME_LAYER_ASYNC").and_then(|v| v.parse().ok()).unwrap_or(stored.same_layer_async),
        max_concurrency: env.get("MAX_CONCURRENCY").and_then(|v| v.parse().ok()).unwrap_or(stored.max_concurrency),
        task_timeout_ms: env.get("TASK_TIMEOUT_MS").and_then(|v| v.parse().ok()).unwrap_or(stored.task_timeout_ms),
    }
}

#[tauri::command]
pub fn save_system_config(config: SystemConfig, state: State<AppState>) -> TaskResult {
    // 1. 写入 .env 文件（api_key, api_base, model_name）
    let env_target = paths::env_write_path();
    let mut env_updates = std::collections::HashMap::new();
    env_updates.insert("ANTHROPIC_API_KEY".to_string(), config.api_key.clone());
    env_updates.insert("ANTHROPIC_BASE_URL".to_string(), config.api_base.clone());
    env_updates.insert("ANTHROPIC_MODEL".to_string(), config.model_name.clone());
    env_updates.insert("PERMISSION_MODE".to_string(), config.permission_mode.clone());
    env_updates.insert("PERMISSION_TIMEOUT_MS".to_string(), format!("{}", config.permission_timeout_ms));

    if let Err(e) = utils::update_env_file(&env_target, &env_updates) {
        return TaskResult::err(&e);
    }

    // 2. 写入 config.json（claude_path, claude_url, max_agents, run_mode, permission_mode）
    utils::ensure_app_data_dir();
    let cfg_path = paths::config_file_path();
    let to_store = SystemConfig {
        model_provider: "Anthropic".to_string(),
        ..config
    };

    match serde_json::to_string_pretty(&to_store) {
        Ok(json) => match fs::write(&cfg_path, json) {
            Ok(_) => {
                // 3. 更新 AppState 中的配置字段
                {
                    let mut pm = state.permission_mode.lock().unwrap();
                    *pm = to_store.permission_mode.clone();
                }
                {
                    let mut pt = state.permission_timeout_ms.lock().unwrap();
                    *pt = to_store.permission_timeout_ms;
                }
                {
                    let mut am = state.arbitration_mode.lock().unwrap();
                    *am = to_store.arbitration_mode.clone();
                }
                {
                    let mut sa = state.same_layer_async.lock().unwrap();
                    *sa = to_store.same_layer_async;
                }
                {
                    let mut mc = state.max_concurrency.lock().unwrap();
                    *mc = to_store.max_concurrency;
                }
                {
                    let mut tt = state.task_timeout_ms.lock().unwrap();
                    *tt = to_store.task_timeout_ms;
                }
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

// ==================== 补充信息注入 ====================

#[tauri::command]
pub async fn inject_info(
    request: InjectInfoRequest,
    state: State<'_, AppState>,
) -> Result<TaskResult, String> {
    use tokio::io::AsyncWriteExt;
    use tokio::sync::oneshot;
    use uuid::Uuid;

    // 生成唯一 request_id，用于匹配响应
    let request_id = Uuid::new_v4().to_string();

    // 创建 oneshot channel 等待 scheduler 进程的响应
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending_injects.lock().unwrap();
        pending.insert(request_id.clone(), tx);
    }

    // 构造注入命令 JSON，写入 scheduler 进程的 stdin
    let inject_cmd = serde_json::json!({
        "request_id": request_id,
        "trace_id": request.trace_id,
        "content": request.content,
        "target_worker_type": request.target_worker_type,
        "route": request.route,
        "urgent": request.urgent,
    });

    let cmd_line = format!("__INJECT__:{}\n", inject_cmd);

    {
        let mut stdin_lock = state.scheduler_stdin.lock().await;
        match stdin_lock.as_mut() {
            Some(stdin) => {
                if let Err(e) = stdin.write_all(cmd_line.as_bytes()).await {
                    // stdin 写入失败，清理 pending
                    let mut pending = state.pending_injects.lock().unwrap();
                    pending.remove(&request_id);
                    return Ok(TaskResult::err(&format!("写入 scheduler stdin 失败: {}", e)));
                }
            }
            None => {
                // 没有运行中的 scheduler 进程
                let mut pending = state.pending_injects.lock().unwrap();
                pending.remove(&request_id);
                return Ok(TaskResult::err("当前没有运行中的任务，无法注入补充信息"));
            }
        }
    }

    // 等待响应，超时 30 秒
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => {
            // scheduler 返回的 JSON 结果
            let data = serde_json::to_string(&result).unwrap_or_default();
            Ok(TaskResult::ok_with_data("补充信息注入完成", data))
        }
        Ok(Err(_)) => {
            // channel 被关闭（scheduler 进程退出）
            Ok(TaskResult::err("scheduler 进程已退出，注入未完成"))
        }
        Err(_) => {
            // 超时
            let mut pending = state.pending_injects.lock().unwrap();
            pending.remove(&request_id);
            Ok(TaskResult::err("注入超时（30秒未收到响应）"))
        }
    }
}

// ==================== 权限审批响应 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct PermissionResponseRequest {
    pub decision: String,  // "allow" 或 "deny"
    pub message: Option<String>,  // deny 时的拒绝原因
}

/// 前端用户审批后调用：将决策通过 stdin 写入 scheduler 进程
#[tauri::command]
pub async fn permission_response(
    request: PermissionResponseRequest,
    state: State<'_, AppState>,
) -> Result<TaskResult, String> {
    let decision_json = if request.decision == "allow" {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": {},
        })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": request.message.unwrap_or_else(|| "用户拒绝".to_string()),
            "interrupt": false,
        })
    };

    let cmd_line = format!("__PERM_RESP__:{}\n", decision_json);

    {
        let mut stdin_lock = state.scheduler_stdin.lock().await;
        match stdin_lock.as_mut() {
            Some(stdin) => {
                if let Err(e) = stdin.write_all(cmd_line.as_bytes()).await {
                    return Ok(TaskResult::err(&format!("写入 scheduler stdin 失败: {}", e)));
                }
            }
            None => {
                return Ok(TaskResult::err("当前没有运行中的任务"));
            }
        }
    }

    Ok(TaskResult::ok("审批决策已发送"))
}

// ==================== 数据库日志查询 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct LogTraceEntry {
    trace_id: String,
    task_id: Option<String>,
    created_at: String,
    log_count: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LogEntry {
    id: i64,
    trace_id: Option<String>,
    task_id: Option<String>,
    worker_id: Option<String>,
    prefix: Option<String>,
    message: String,
    level: String,
    created_at: String,
}

/// 获取 messages.db 的路径
fn messages_db_path() -> std::path::PathBuf {
    paths::app_data_dir().join("messages.db")
}

#[tauri::command]
pub fn get_log_trace_list() -> Result<Vec<LogTraceEntry>, String> {
    let db_path = messages_db_path();
    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("打开数据库失败: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT trace_id, task_id, MIN(created_at) as created_at, COUNT(*) as log_count FROM logs WHERE trace_id IS NOT NULL GROUP BY trace_id ORDER BY created_at DESC"
    ).map_err(|e| format!("准备查询失败: {}", e))?;

    let traces = stmt.query_map([], |row| {
        Ok(LogTraceEntry {
            trace_id: row.get(0)?,
            task_id: row.get(1)?,
            created_at: row.get(2)?,
            log_count: row.get(3)?,
        })
    }).map_err(|e| format!("查询失败: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(traces)
}

#[tauri::command]
pub fn get_logs_by_trace_id(trace_id: String) -> Result<Vec<LogEntry>, String> {
    let db_path = messages_db_path();
    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("打开数据库失败: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, trace_id, task_id, worker_id, prefix, message, level, created_at FROM logs WHERE trace_id = ? ORDER BY created_at ASC"
    ).map_err(|e| format!("准备查询失败: {}", e))?;

    let logs = stmt.query_map([&trace_id], |row| {
        Ok(LogEntry {
            id: row.get(0)?,
            trace_id: row.get(1)?,
            task_id: row.get(2)?,
            worker_id: row.get(3)?,
            prefix: row.get(4)?,
            message: row.get(5)?,
            level: row.get(6)?,
            created_at: row.get(7)?,
        })
    }).map_err(|e| format!("查询失败: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(logs)
}

// ==================== 项目知识管理 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectKnowledgeItem {
    pub id: String,
    pub project_id: String,
    pub category: String,
    pub title: String,
    pub content: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

/// memory.db 的路径
fn memory_db_path() -> std::path::PathBuf {
    paths::app_data_dir().join("memory.db")
}

#[tauri::command]
pub fn get_project_knowledge(project_id: String) -> Result<Vec<ProjectKnowledgeItem>, String> {
    let db_path = memory_db_path();
    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("打开数据库失败: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, project_id, category, title, content, source, created_at, updated_at FROM project_knowledge WHERE project_id = ? ORDER BY category, created_at DESC"
    ).map_err(|e| format!("准备查询失败: {}", e))?;

    let items = stmt.query_map([&project_id], |row| {
        Ok(ProjectKnowledgeItem {
            id: row.get(0)?,
            project_id: row.get(1)?,
            category: row.get(2)?,
            title: row.get(3)?,
            content: row.get(4)?,
            source: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }).map_err(|e| format!("查询失败: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(items)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AddKnowledgeRequest {
    pub project_id: String,
    pub category: String,
    pub title: String,
    pub content: String,
}

#[tauri::command]
pub fn add_project_knowledge(request: AddKnowledgeRequest) -> Result<TaskResult, String> {
    let db_path = memory_db_path();
    if !db_path.exists() {
        return Err("记忆数据库不存在，请先执行一次任务".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO project_knowledge (id, project_id, category, title, content, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'user_specified', ?6, ?7)",
        rusqlite::params![id, request.project_id, request.category, request.title, request.content, now, now],
    ).map_err(|e| format!("插入失败: {}", e))?;

    Ok(TaskResult::ok_with_data("项目知识添加成功", id))
}

#[tauri::command]
pub fn delete_project_knowledge(id: String) -> Result<TaskResult, String> {
    let db_path = memory_db_path();
    if !db_path.exists() {
        return Err("记忆数据库不存在".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let changes = conn.execute("DELETE FROM project_knowledge WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| format!("删除失败: {}", e))?;

    if changes > 0 {
        Ok(TaskResult::ok("项目知识删除成功"))
    } else {
        Ok(TaskResult::err("未找到对应的知识条目"))
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateKnowledgeRequest {
    pub id: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub category: Option<String>,
}

#[tauri::command]
pub fn update_project_knowledge(request: UpdateKnowledgeRequest) -> Result<TaskResult, String> {
    let db_path = memory_db_path();
    if !db_path.exists() {
        return Err("记忆数据库不存在".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let mut fields = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref title) = request.title {
        fields.push("title = ?".to_string());
        values.push(Box::new(title.clone()));
    }
    if let Some(ref content) = request.content {
        fields.push("content = ?".to_string());
        values.push(Box::new(content.clone()));
    }
    if let Some(ref category) = request.category {
        fields.push("category = ?".to_string());
        values.push(Box::new(category.clone()));
    }

    if fields.is_empty() {
        return Ok(TaskResult::err("没有需要更新的字段"));
    }

    fields.push("updated_at = ?".to_string());
    let now = chrono::Local::now().to_rfc3339();
    values.push(Box::new(now));
    values.push(Box::new(request.id.clone()));

    let sql = format!("UPDATE project_knowledge SET {} WHERE id = ?", fields.join(", "));
    let changes = conn.execute(&sql, rusqlite::params_from_iter(values.iter().map(|v| v.as_ref()))).map_err(|e| format!("更新失败: {}", e))?;

    if changes > 0 {
        Ok(TaskResult::ok("项目知识更新成功"))
    } else {
        Ok(TaskResult::err("未找到对应的知识条目"))
    }
}

// ==================== 记忆统计 ====================

#[derive(Serialize)]
pub struct MemoryStats {
    pub experience_count: i64,
    pub knowledge_count: i64,
    pub worker_profile_count: i64,
}

#[tauri::command]
pub fn get_memory_stats(project_id: Option<String>) -> Result<MemoryStats, String> {
    let db_path = memory_db_path();
    if !db_path.exists() {
        return Ok(MemoryStats { experience_count: 0, knowledge_count: 0, worker_profile_count: 0 });
    }

    let conn = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("打开数据库失败: {}", e))?;

    let exp_count: i64 = if let Some(ref pid) = project_id {
        conn.query_row("SELECT COUNT(*) FROM task_experiences WHERE project_id = ?1", rusqlite::params![pid], |r| r.get(0))
    } else {
        conn.query_row("SELECT COUNT(*) FROM task_experiences", [], |r| r.get(0))
    }.unwrap_or(0);

    let knl_count: i64 = if let Some(ref pid) = project_id {
        conn.query_row("SELECT COUNT(*) FROM project_knowledge WHERE project_id = ?1", rusqlite::params![pid], |r| r.get(0))
    } else {
        conn.query_row("SELECT COUNT(*) FROM project_knowledge", [], |r| r.get(0))
    }.unwrap_or(0);

    let wp_count: i64 = conn.query_row("SELECT COUNT(*) FROM worker_profiles", [], |r| r.get(0)).unwrap_or(0);

    Ok(MemoryStats {
        experience_count: exp_count,
        knowledge_count: knl_count,
        worker_profile_count: wp_count,
    })
}
