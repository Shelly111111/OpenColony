// ==================== 任务日志（数据库查询） ====================

/** 当前展开详情的任务卡片元素 */
let _expandedTaskCard = null;
/** 当前展开的详情面板元素 */
let _expandedTaskDetail = null;

async function loadTaskList() {
  const listEl = document.getElementById('taskList');
  try {
    const traces = await invoke('get_log_trace_list', {});
    if (traces.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无任务记录，提交任务后将显示在此</div>';
    } else {
      listEl.innerHTML = traces.map(t => `
        <div class="task-card" onclick="viewTraceLogs(this, '${t.trace_id}')">
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

async function viewTraceLogs(cardEl, traceId) {
  const isExpanded = cardEl === _expandedTaskCard;

  // 先移除当前已展开的详情面板
  if (_expandedTaskDetail && _expandedTaskDetail.parentNode) {
    _expandedTaskDetail.remove();
  }
  if (_expandedTaskCard) {
    _expandedTaskCard.classList.remove('expanded');
  }

  if (isExpanded) {
    // 点击已展开的卡片 → 折叠
    _expandedTaskCard = null;
    _expandedTaskDetail = null;
    return;
  }

  // 创建详情面板，插入到点击的卡片后面
  const panel = document.createElement('div');
  panel.className = 'task-detail-panel';
  panel.innerHTML = `
    <div class="task-detail-header">
      <h3>📄 日志详情 <span class="log-file-name">${traceId}</span></h3>
      <button class="btn-outline" onclick="closeTaskDetail()">✕ 关闭</button>
    </div>
    <pre class="task-detail-content">加载中...</pre>
  `;

  cardEl.classList.add('expanded');
  // 插入到卡片后面（cardEl 是 task-card，其父节点是 task-list）
  if (cardEl.nextSibling) {
    cardEl.parentNode.insertBefore(panel, cardEl.nextSibling);
  } else {
    cardEl.parentNode.appendChild(panel);
  }

  _expandedTaskCard = cardEl;
  _expandedTaskDetail = panel;

  // 异步加载日志内容
  try {
    const logs = await invoke('get_logs_by_trace_id', { traceId });
    const nameEl = panel.querySelector('.log-file-name');
    nameEl.textContent = `${traceId} (${logs.length} 条日志)`;
    const contentEl = panel.querySelector('.task-detail-content');
    contentEl.textContent = logs.map(l => {
      const time = l.created_at ? new Date(l.created_at).toLocaleString() : '';
      const prefix = l.prefix || '';
      const level = l.level !== 'info' ? `[${l.level.toUpperCase()}] ` : '';
      const worker = l.worker_id ? `[${l.worker_id}] ` : '';
      return `${time} ${prefix} ${worker}${level}${l.message}`;
    }).join('\n');
  } catch (e) {
    const contentEl = panel.querySelector('.task-detail-content');
    contentEl.textContent = `加载失败: ${e}`;
  }
}

function closeTaskDetail() {
  if (_expandedTaskDetail && _expandedTaskDetail.parentNode) {
    _expandedTaskDetail.remove();
  }
  if (_expandedTaskCard) {
    _expandedTaskCard.classList.remove('expanded');
  }
  _expandedTaskCard = null;
  _expandedTaskDetail = null;
}

function formatDbTime(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleString();
  } catch {
    return isoStr;
  }
}
