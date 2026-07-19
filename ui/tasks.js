// ==================== 任务日志（数据库查询） ====================

async function loadTaskList() {
  const listEl = document.getElementById('taskList');
  try {
    const traces = await invoke('get_log_trace_list', {});
    if (traces.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无任务记录，提交任务后将显示在此</div>';
    } else {
      listEl.innerHTML = traces.map(t => `
        <div class="task-card" onclick="viewTraceLogs('${t.trace_id}')">
          <div class="task-card-header">
            <span class="task-badge">📋 ${t.log_count} 条日志</span>
            <span class="task-time">${formatDbTime(t.created_at)}</span>
          </div>
          <div class="task-trace">TraceID: ${t.trace_id}</div>
          ${t.task_id ? `<div class="task-dir">TaskID: ${t.task_id}</div>` : ''}
        </div>
      `).join('');
    }
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }

  const statusBar = document.getElementById('taskLogsPath');
  if (statusBar) statusBar.textContent = '数据源: MessageDB logs 表';
}

async function viewTraceLogs(traceId) {
  const container = document.getElementById('logViewerContainer');
  const viewer = document.getElementById('logViewer');
  const nameEl = document.getElementById('logFileName');

  try {
    const logs = await invoke('get_logs_by_trace_id', { traceId });
    nameEl.textContent = `${traceId} (${logs.length} 条日志)`;
    viewer.textContent = logs.map(l => {
      const time = l.created_at ? new Date(l.created_at).toLocaleString() : '';
      const prefix = l.prefix || '';
      const level = l.level !== 'info' ? `[${l.level.toUpperCase()}] ` : '';
      const worker = l.worker_id ? `[${l.worker_id}] ` : '';
      return `${time} ${prefix} ${worker}${level}${l.message}`;
    }).join('\n');
  } catch (e) {
    nameEl.textContent = traceId;
    viewer.textContent = `加载失败: ${e}`;
  }
  container.style.display = 'block';
}

function closeLogViewer() {
  document.getElementById('logViewerContainer').style.display = 'none';
}

function formatDbTime(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleString();
  } catch {
    return isoStr;
  }
}
