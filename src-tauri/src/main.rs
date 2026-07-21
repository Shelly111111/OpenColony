#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod paths;
mod utils;

use std::collections::HashMap;
use std::sync::Mutex;

use models::AppState;

fn main() {
    utils::ensure_app_data_dir();

    let state = AppState {
        running_tasks: Mutex::new(HashMap::new()),
        session_id: Mutex::new(format!("#{}", chrono::Local::now().format("%H%M%S"))),
        scheduler_stdin: tokio::sync::Mutex::new(None),
        pending_injects: Mutex::new(HashMap::new()),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_system_status,
            commands::submit_task,
            commands::get_task_list,
            commands::get_task_log_content,
            commands::get_agent_roles,
            commands::save_agent_roles,
            commands::get_skills,
            commands::get_skills_from_claude,
            commands::save_skills_to_file,
            commands::get_system_config,
            commands::save_system_config,
            commands::test_model_connection,
            commands::test_claude_connection,
            commands::get_worker_logs_root,
            commands::get_log_trace_list,
            commands::get_logs_by_trace_id,
            commands::inject_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
