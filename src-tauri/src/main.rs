#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

struct AppState {
    scheduler_running: Mutex<bool>,
}

#[derive(Serialize, Deserialize)]
struct TaskRequest {
    task: String,
    mode: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TaskResult {
    success: bool,
    message: String,
    data: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct SystemStatus {
    running: bool,
    agent_count: i32,
    task_queue: i32,
    session_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct AgentRole {
    id: String,
    name: String,
    description: String,
    category: String,
    icon: String,
    color: String,
    task_count: i32,
    quality_score: f32,
    skills: Vec<String>,
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

#[derive(Serialize, Deserialize)]
struct SystemConfig {
    model_provider: String,
    model_name: String,
    api_key: String,
    api_base: String,
    claude_path: String,
    max_agents: i32,
}

#[tauri::command]
fn get_system_status(state: State<AppState>) -> SystemStatus {
    let running = state.scheduler_running.lock().unwrap();
    SystemStatus {
        running: *running,
        agent_count: 8,
        task_queue: 3,
        session_id: "#1024".to_string(),
    }
}

#[tauri::command]
fn get_agent_roles() -> Vec<AgentRole> {
    vec![
        AgentRole {
            id: "master".to_string(),
            name: "Master调度".to_string(),
            description: "主调度Agent · 系统核心".to_string(),
            category: "调度".to_string(),
            icon: "🧠".to_string(),
            color: "#dc2626".to_string(),
            task_count: 1247,
            quality_score: 94.2,
            skills: vec!["task_split".to_string(), "dag_build".to_string(), "调度分发".to_string()],
        },
        AgentRole {
            id: "code_agent".to_string(),
            name: "代码开发Agent".to_string(),
            description: "Worker1 · 垂直专精".to_string(),
            category: "代码".to_string(),
            icon: "💻".to_string(),
            color: "#2563eb".to_string(),
            task_count: 856,
            quality_score: 91.7,
            skills: vec!["FastAPI".to_string(), "代码生成".to_string(), "Code Review".to_string()],
        },
        AgentRole {
            id: "data_agent".to_string(),
            name: "数据分析Agent".to_string(),
            description: "Worker2 · 垂直专精".to_string(),
            category: "数据".to_string(),
            icon: "📊".to_string(),
            color: "#16a34a".to_string(),
            task_count: 634,
            quality_score: 89.3,
            skills: vec!["Pandas".to_string(), "RFM分析".to_string(), "Sklearn".to_string()],
        },
        AgentRole {
            id: "vis_agent".to_string(),
            name: "可视化Agent".to_string(),
            description: "Worker3 · 垂直专精".to_string(),
            category: "可视化".to_string(),
            icon: "📈".to_string(),
            color: "#d97706".to_string(),
            task_count: 412,
            quality_score: 87.8,
            skills: vec!["ECharts".to_string(), "Vue3".to_string(), "仪表板设计".to_string()],
        },
        AgentRole {
            id: "general_agent".to_string(),
            name: "通用专精Agent".to_string(),
            description: "WorkerN · 弹性扩容".to_string(),
            category: "通用".to_string(),
            icon: "🔧".to_string(),
            color: "#8b5cf6".to_string(),
            task_count: 89,
            quality_score: 82.1,
            skills: vec!["通用推理".to_string(), "工具调用".to_string(), "任务兜底".to_string()],
        },
        AgentRole {
            id: "review_agent".to_string(),
            name: "独立评审Agent".to_string(),
            description: "质量校验 · 防单点故障".to_string(),
            category: "评审".to_string(),
            icon: "🔍".to_string(),
            color: "#ec4899".to_string(),
            task_count: 321,
            quality_score: 96.5,
            skills: vec!["规划校验".to_string(), "输出复核".to_string()],
        },
    ]
}

#[tauri::command]
fn get_skills() -> Vec<Skill> {
    vec![
        Skill {
            id: "fastapi-gen".to_string(),
            name: "FastAPI生成器".to_string(),
            description: "生成FastAPI路由与Schema".to_string(),
            category: "代码".to_string(),
            version: "v2.1.0".to_string(),
            status: "活跃".to_string(),
            icon: "⚡".to_string(),
        },
        Skill {
            id: "pandas-analytics".to_string(),
            name: "Pandas数据分析".to_string(),
            description: "数据清洗与聚合分析".to_string(),
            category: "数据".to_string(),
            version: "v1.5.2".to_string(),
            status: "活跃".to_string(),
            icon: "🐼".to_string(),
        },
        Skill {
            id: "echarts-dashboard".to_string(),
            name: "ECharts仪表板".to_string(),
            description: "可视化图表生成".to_string(),
            category: "可视化".to_string(),
            version: "v3.0.1".to_string(),
            status: "待更新".to_string(),
            icon: "📊".to_string(),
        },
        Skill {
            id: "code-review".to_string(),
            name: "Code Review".to_string(),
            description: "代码质量检查与评审".to_string(),
            category: "代码".to_string(),
            version: "v1.0.0".to_string(),
            status: "待更新".to_string(),
            icon: "✅".to_string(),
        },
        Skill {
            id: "rfm-segmentation".to_string(),
            name: "RFM用户分群".to_string(),
            description: "用户价值RFM分析".to_string(),
            category: "数据".to_string(),
            version: "v1.2.0".to_string(),
            status: "活跃".to_string(),
            icon: "📈".to_string(),
        },
        Skill {
            id: "vue3-components".to_string(),
            name: "Vue3组件库".to_string(),
            description: "前端UI组件生成".to_string(),
            category: "可视化".to_string(),
            version: "v2.0.3".to_string(),
            status: "活跃".to_string(),
            icon: "🎨".to_string(),
        },
        Skill {
            id: "dag-orchestration".to_string(),
            name: "DAG任务编排".to_string(),
            description: "构建任务依赖DAG图".to_string(),
            category: "调度".to_string(),
            version: "v1.3.0".to_string(),
            status: "活跃".to_string(),
            icon: "🧠".to_string(),
        },
    ]
}

#[tauri::command]
fn get_system_config() -> SystemConfig {
    SystemConfig {
        model_provider: "OpenAI".to_string(),
        model_name: "gpt-4-turbo".to_string(),
        api_key: "sk-************************".to_string(),
        api_base: "https://api.openai.com/v1/chat/completions".to_string(),
        claude_path: "/usr/local/claude/bin/claude-server".to_string(),
        max_agents: 8,
    }
}

#[tauri::command]
fn save_system_config(config: SystemConfig) -> TaskResult {
    println!("保存配置: {} / {}", config.model_provider, config.model_name);
    TaskResult {
        success: true,
        message: "配置保存成功".to_string(),
        data: None,
    }
}

#[tauri::command]
fn test_model_connection() -> TaskResult {
    TaskResult {
        success: true,
        message: "大模型连接成功".to_string(),
        data: None,
    }
}

#[tauri::command]
fn test_claude_connection() -> TaskResult {
    TaskResult {
        success: true,
        message: "Claude连接成功".to_string(),
        data: None,
    }
}

#[tauri::command]
fn submit_task(request: TaskRequest, state: State<AppState>) -> TaskResult {
    let mut running = state.scheduler_running.lock().unwrap();
    *running = true;
    println!("收到任务: {}, 模式: {:?}", request.task, request.mode);
    TaskResult {
        success: true,
        message: "任务已提交".to_string(),
        data: Some("任务正在执行中...".to_string()),
    }
}

fn main() {
    let state = AppState {
        scheduler_running: Mutex::new(false),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_system_status,
            get_agent_roles,
            get_skills,
            get_system_config,
            save_system_config,
            test_model_connection,
            test_claude_connection,
            submit_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
