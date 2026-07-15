// ==================== 任务日志 ====================

async function loadTaskList() {
  const listEl = document.getElementById('taskList');
  try {
    const tasks = await invoke('get_task_list', {});
    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无任务记录，提交任务后将显示在此</div>';
    } else {
      listEl.innerHTML = tasks.map(t => `
        <div class="task-card">
          <div class="task-card-header">
            <span class="task-badge">📋 ${t.worker_logs.length + (t.master_log ? 1 : 0)} 个日志</span>
            <span class="task-time">${t.created_at}</span>
          </div>
          <div class="task-trace">TraceID: ${t.trace_id}</div>
          <div class="task-dir">📁 ${t.task_dir}</div>
          ${t.master_log ? `<div class="task-log-file" onclick="viewLog('${t.task_dir}', '${t.master_log}')">📄 ${t.master_log}</div>` : ''}
          ${t.worker_logs.map(w => `<div class="task-log-file" onclick="viewLog('${t.task_dir}', '${w}')">📄 ${w}</div>`).join('')}
        </div>
      `).join('');
    }
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }

  try {
    const root = await invoke('get_worker_logs_root', {});
    document.getElementById('taskLogsPath').textContent = `日志根目录: ${root}`;
  } catch (e) {
    document.getElementById('taskLogsPath').textContent = '日志根目录: 获取失败';
  }
}

async function viewLog(taskDir, fileName) {
  const container = document.getElementById('logViewerContainer');
  const viewer = document.getElementById('logViewer');
  const nameEl = document.getElementById('logFileName');

  try {
    const result = await invoke('get_task_log_content', { taskDir, fileName });
    nameEl.textContent = `${fileName} (${formatSize(result.size)})`;
    viewer.textContent = result.content || '(空文件)';
  } catch (e) {
    nameEl.textContent = fileName;
    viewer.textContent = `加载失败: ${e}`;
  }
  container.style.display = 'block';
}

function closeLogViewer() {
  document.getElementById('logViewerContainer').style.display = 'none';
}
