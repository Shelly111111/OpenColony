use std::path::PathBuf;

/// 项目根目录（src-tauri 的父目录）
pub fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

/// 应用数据目录：~/.opencolony/
pub fn app_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".opencolony")
}

/// 系统配置文件路径
pub fn config_file_path() -> PathBuf {
    app_data_dir().join("config.json")
}

/// Worker 日志根目录：项目根/worker-logs/
pub fn worker_logs_root() -> PathBuf {
    project_root().join("worker-logs")
}

/// Scheduler 配置目录
pub fn scheduler_config_dir() -> PathBuf {
    project_root().join("scheduler").join("config")
}

/// Scheduler 入口文件
pub fn scheduler_entry() -> PathBuf {
    project_root().join("scheduler").join("src").join("index.ts")
}

/// .env 文件路径：优先 .env，不存在则回退到 .env.example
pub fn env_file_path() -> PathBuf {
    let env = project_root().join(".env");
    if env.exists() {
        env
    } else {
        project_root().join(".env.example")
    }
}

/// 实际写入的 .env 路径（始终为 .env）
pub fn env_write_path() -> PathBuf {
    project_root().join(".env")
}
