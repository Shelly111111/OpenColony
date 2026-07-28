// ==================== 任务日志（数据库查询） ====================

/** 当前展开详情的任务卡片元素 */
let _expandedTaskCard = null;
/** 当前展开的详情面板元素 */
let _expandedTaskDetail = null;

/** 分页状态 */
let _allTraces = [];
let _taskPage = 1;
const _taskPageSize = 10;

async function loadTaskList() {
  const listEl = document.getElementById('taskList');
  try {
    _allTraces = await invoke('get_log_trace_list', {});
    _taskPage = 1;
    renderTaskPage();
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }

  const statusBar = document.getElementById('taskLogsPath');
  if (statusBar) statusBar.textContent = '数据源: MessageDB logs 表';
}

function renderTaskPage() {
  const listEl = document.getElementById('taskList');
  const total = _allTraces.length;

  if (total === 0) {
    listEl.innerHTML = '<div class="empty-state">暂无任务记录，提交任务后将显示在此</div>';
    document.getElementById('taskPagination').innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(total / _taskPageSize);
  if (_taskPage > totalPages) _taskPage = totalPages;
  const start = (_taskPage - 1) * _taskPageSize;
  const pageTraces = _allTraces.slice(start, start + _taskPageSize);

  listEl.innerHTML = pageTraces.map(t => `
    <div class="task-card" onclick="viewTraceLogs(this, '${t.trace_id}')">
      <div class="task-card-header">
        <span class="task-badge">📋 ${t.log_count} 条日志</span>
        <span class="task-time">${formatDbTime(t.created_at)}</span>
      </div>
      <div class="task-trace">TraceID: ${t.trace_id}</div>
      ${t.task_id ? `<div class="task-dir">TaskID: ${t.task_id}</div>` : ''}
    </div>
  `).join('');

  // 渲染分页控件
  const pagEl = document.getElementById('taskPagination');
  if (totalPages <= 1) {
    pagEl.innerHTML = `<span class="pagination-info">共 ${total} 条</span>`;
    return;
  }

  let html = `<span class="pagination-info">共 ${total} 条，第 ${_taskPage}/${totalPages} 页</span><div class="pagination-controls">`;
  html += `<button class="page-btn" onclick="goTaskPage(1)" ${_taskPage === 1 ? 'disabled' : ''}>«</button>`;
  html += `<button class="page-btn" onclick="goTaskPage(${_taskPage - 1})" ${_taskPage === 1 ? 'disabled' : ''}>‹</button>`;

  const pStart = Math.max(1, Math.min(_taskPage - 2, totalPages - 4));
  const pEnd = Math.min(totalPages, pStart + 4);
  for (let p = pStart; p <= pEnd; p++) {
    html += `<button class="page-btn ${p === _taskPage ? 'active' : ''}" onclick="goTaskPage(${p})">${p}</button>`;
  }

  html += `<button class="page-btn" onclick="goTaskPage(${_taskPage + 1})" ${_taskPage === totalPages ? 'disabled' : ''}>›</button>`;
  html += `<button class="page-btn" onclick="goTaskPage(${totalPages})" ${_taskPage === totalPages ? 'disabled' : ''}>»</button>`;
  html += `</div>`;
  pagEl.innerHTML = html;
}

function goTaskPage(page) {
  const totalPages = Math.ceil(_allTraces.length / _taskPageSize);
  if (page < 1 || page > totalPages) return;
  _taskPage = page;
  closeTaskDetail();
  renderTaskPage();
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
      <div class="task-detail-actions">
        <button class="btn-outline" onclick="importToNewSession('${traceId}')">📤 导入到新会话</button>
        <button class="btn-outline" onclick="closeTaskDetail()">✕ 关闭</button>
      </div>
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

/**
 * 导入任务日志到新会话窗口
 * 1. 创建新会话 tab
 * 2. 在新 tab 中展示该 traceId 的日志作为上下文
 */
async function importToNewSession(traceId) {
  // 创建新会话
  const sessionId = 'session_' + Date.now();
  const title = `日志: ${traceId.substring(0, 12)}...`;
  
  // 在 chat.js 的 sessions 中注册
  if (typeof sessions !== 'undefined') {
    sessions[sessionId] = {
      sessionId,
      title,
      messages: [],
      traceId: null,
    };

    // 创建 tab DOM
    const tabBar = document.getElementById('chatTabBar');
    const addBtn = tabBar.querySelector('.add-tab');
    const tab = document.createElement('button');
    tab.className = 'chat-tab';
    tab.dataset.tab = sessionId;
    tab.innerHTML = `<span class="tab-title" ondblclick="renameTab('${sessionId}')">${title}</span><span class="tab-close" onclick="closeTab(event, '${sessionId}')">x</span>`;
    tab.onclick = () => switchChatTab(sessionId);
    tabBar.insertBefore(tab, addBtn);
  }

  // 切换到主界面
  switchPage('chat');

  // 切换到新 tab
  if (typeof switchChatTab === 'function') {
    switchChatTab(sessionId);
  }

  // 在新会话中添加一条说明消息
  const msgs = sessions[sessionId]?.messages;
  if (msgs) {
    msgs.push({
      type: 'master',
      content: `📤 已导入日志 TraceID: ${traceId}\n你可以在新会话中继续相关任务，历史经验将被自动参考。`,
      closed: true,
    });
    if (typeof appendMessageDom === 'function') {
      appendMessageDom(msgs[msgs.length - 1]);
    }
    if (typeof updateMsgCount === 'function') {
      updateMsgCount();
    }
  }
}
