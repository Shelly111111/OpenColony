use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::paths;

/// 确保应用数据目录存在
pub fn ensure_app_data_dir() {
    let dir = paths::app_data_dir();
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
}

/// 当前时间的 ISO 格式字符串
pub fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 日志输出
pub fn log_info(msg: &str) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    println!("[{}] {}", ts, msg);
}

/// 解析 .env 文件为 HashMap（KEY=VALUE，忽略空行与 # 注释）
pub fn parse_env_file(path: &Path) -> HashMap<String, String> {
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
pub fn update_env_file(path: &Path, updates: &HashMap<String, String>) -> Result<(), String> {
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

/// 统计任务目录数量
pub fn count_task_dirs() -> Option<usize> {
    fs::read_dir(paths::worker_logs_root())
        .ok()
        .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).count())
}
