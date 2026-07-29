// ==================== 对话 Tab（多会话管理） ====================

// 会话数据结构：每个 tab 对应一个 session
const sessions = {
  master: {
    sessionId: 'master',
    title: 'Master',
    messages: [],
    traceId: null,
  }
};
let currentChatTab = 'master';

// prefix 对应的显示标签和颜色
const PREFIX_STYLES = {
  Master:            { label: 'Master',  color: '#60a5fa' },
  PlanExecutor:      { label: 'Plan',    color: '#a78bfa' },
  WorkerManager:     { label: 'Worker',  color: '#34d399' },
  ArbitrationEngine: { label: 'Arbiter', color: '#fbbf24' },
  LLMClient:         { label: 'LLM',     color: '#f472b6' },
  ClaudeLink:        { label: 'Link',    color: '#2dd4bf' },
  RoleManager:       { label: 'Role',    color: '#fb923c' },
  MemoryStore:       { label: 'Memory',  color: '#818cf8' },
};

/** 获取当前会话 */
function currentSession() {
  return sessions[currentChatTab];
}

/** 获取当前会话的消息列表 */
function currentMessages() {
  return sessions[currentChatTab]?.messages || [];
}

function switchChatTab(tabName) {
  if (!sessions[tabName]) return;
  currentChatTab = tabName;
  document.querySelectorAll('.chat-tab').forEach(tab => {
    if (tab.classList.contains('add-tab')) return;
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  // 切换 traceId 上下文
  window.currentTraceId = sessions[tabName].traceId || null;
  renderMessages();
}

/** 新增会话 tab */
function addNewTab() {
  const sessionId = 'session_' + Date.now();
  const title = '新会话';
  sessions[sessionId] = {
    sessionId,
    title,
    messages: [],
    traceId: null,
  };

  // 在 add-tab 之前插入新 tab 按钮
  const tabBar = document.getElementById('chatTabBar');
  const addBtn = tabBar.querySelector('.add-tab');
  const tab = document.createElement('button');
  tab.className = 'chat-tab';
  tab.dataset.tab = sessionId;
  tab.innerHTML = `<span class="tab-title" ondblclick="renameTab('${sessionId}')">${title}</span><span class="tab-close" onclick="closeTab(event, '${sessionId}')">x</span>`;
  tab.onclick = () => switchChatTab(sessionId);
  tabBar.insertBefore(tab, addBtn);

  switchChatTab(sessionId);
}

/** 关闭会话 tab */
function closeTab(event, tabName) {
  event.stopPropagation();
  if (tabName === 'master') return; // 主 tab 不可关闭
  if (!sessions[tabName]) return;

  // 切换到前一个 tab
  const tabKeys = Object.keys(sessions);
  const idx = tabKeys.indexOf(tabName);
  const newTab = tabKeys[Math.max(0, idx - 1)] || 'master';

  delete sessions[tabName];

  // 移除 tab DOM
  const tabEl = document.querySelector(`.chat-tab[data-tab="${tabName}"]`);
  if (tabEl) tabEl.remove();

  switchChatTab(newTab);
}

/** 双击重命名 tab */
function renameTab(tabName) {
  const session = sessions[tabName];
  if (!session) return;
  const newTitle = prompt('修改会话名称:', session.title);
  if (newTitle && newTitle.trim()) {
    session.title = newTitle.trim();
    const tabEl = document.querySelector(`.chat-tab[data-tab="${tabName}"] .tab-title`);
    if (tabEl) tabEl.textContent = session.title;
  }
}

function clearMessages() {
  if (sessions[currentChatTab]) {
    sessions[currentChatTab].messages = [];
  }
  renderMessages();
}

// ==================== 消息内容格式化 ====================

function formatContent(content) {
  const lines = content.split('\n');
  const formattedContent = lines.map(line => {
    if (line.startsWith('• ') || line.startsWith('- ')) return `<li>${line.substring(2)}</li>`;
    return `<p>${line}</p>`;
  }).join('');
  const hasList = lines.some(l => l.startsWith('• ') || l.startsWith('- '));
  return hasList ? `<ul>${formattedContent}</ul>` : formattedContent;
}

function buildHeaderHtml(msg) {
  const roleNames = { user: '👤 用户', master: '🤖 Master调度' };
  if (msg.prefix && PREFIX_STYLES[msg.prefix]) {
    const style = PREFIX_STYLES[msg.prefix];
    return `<span style="color:${style.color};font-weight:600">[${style.label}]</span>`;
  }
  return roleNames[msg.type] || msg.type;
}

// ==================== 增量 DOM 操作 ====================

/** 创建一条消息的 DOM 元素，并挂载到容器 */
function appendMessageDom(msg) {
  const container = document.getElementById('chatMessages');

  if (msg.type === 'task-status') {
    const el = document.createElement('div');
    el.className = 'task-status';
    el.innerHTML = `
      <div class="task-status-title">📊 任务状态</div>
      <div class="task-status-body">${msg.content}</div>
    `;
    container.appendChild(el);
    msg._el = el;
  } else {
    const el = document.createElement('div');
    el.className = `message ${msg.type}`;
    el.innerHTML = `
      <div class="msg-header">${buildHeaderHtml(msg)}</div>
      <div class="msg-body">${formatContent(msg.content)}</div>
    `;
    container.appendChild(el);
    msg._el = el;
  }

  container.scrollTop = container.scrollHeight;
}

/** 更新已有消息元素的 body 内容 */
function updateMessageDom(msg) {
  if (!msg._el) return;
  const body = msg._el.querySelector('.msg-body');
  if (body) {
    body.innerHTML = formatContent(msg.content);
  }
  const container = document.getElementById('chatMessages');
  container.scrollTop = container.scrollHeight;
}

/** 更新消息计数 */
function updateMsgCount() {
  const messages = currentMessages();
  document.getElementById('msgCount').textContent = messages.length;
}

// ==================== 全量渲染（仅用于切换 Tab / 清空等场景） ====================

function renderMessages() {
  const container = document.getElementById('chatMessages');
  const messages = currentMessages();

  updateMsgCount();

  const existing = container.querySelectorAll('.message, .task-status');
  existing.forEach(el => el.remove());

  messages.forEach(msg => {
    appendMessageDom(msg);
  });
}

// ==================== Tauri 事件监听 ====================

function initSchedulerListeners() {
  if (typeof window.__TAURI__ === 'undefined') return;

  // 监听 scheduler 输出
  window.__TAURI__.event.listen('scheduler-output', (event) => {
    const { traceId, type, line, prefix, message, level } = event.payload;
    const msgs = currentMessages();

    if (type === 'log') {
      const levelIcon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '';
      // 循环调度状态格式化
      const loopFormatted = formatLoopStatusLog(message);
      const displayMsg = loopFormatted
        ? loopFormatted
        : (levelIcon ? `${levelIcon} ${message}` : message);

      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.type === 'master' && lastMsg.prefix === prefix && !lastMsg.closed) {
        // 追加到最后一条同 prefix 消息 —— 只更新该元素
        lastMsg.content += '\n' + displayMsg;
        updateMessageDom(lastMsg);
      } else {
        // 新建一条消息 —— 只追加新元素
        const msg = { type: 'master', prefix, content: displayMsg, closed: false };
        msgs.push(msg);
        appendMessageDom(msg);
      }
    } else if (type === 'stdout') {
      if (line.match(/^\s*(PRAGMA|CREATE|INSERT|SELECT|ALTER|DROP)\s/i)) return;
      if (line.trim() === '') return;

      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.type === 'master' && !lastMsg.prefix && !lastMsg.closed) {
        lastMsg.content += '\n' + line;
        updateMessageDom(lastMsg);
      } else {
        const msg = { type: 'master', content: line, closed: false };
        msgs.push(msg);
        appendMessageDom(msg);
      }
    } else if (type === 'stderr') {
      if (line.trim() === '') return;
      const msg = { type: 'master', prefix: 'stderr', content: `⚠️ ${line}`, closed: true };
      msgs.push(msg);
      appendMessageDom(msg);
    }

    updateMsgCount();
  });

  // 监听任务完成
  window.__TAURI__.event.listen('task-completed', (event) => {
    const { traceId, exitCode, error } = event.payload;
    const msgs = currentMessages();

    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.type === 'master') {
      lastMsg.closed = true;
    }

    const statusText = error
      ? `❌ 任务异常退出: ${error}`
      : exitCode === 0
        ? '✅ 任务已完成'
        : `⚠️ 任务已退出 (退出码: ${exitCode})`;

    const msg = { type: 'master', content: statusText, closed: true };
    msgs.push(msg);
    appendMessageDom(msg);
    updateMsgCount();

    document.getElementById('masterTabStatus').textContent = '● 已完成';
    document.getElementById('masterTabStatus').style.color = '#4ade80';
    // 隐藏强制终止按钮
    hideForceCancelButton();
    // 清除当前会话的 traceId
    if (currentSession()) currentSession().traceId = null;
    window.currentTraceId = null;
  });
}

// ==================== 提交任务 ====================

/**
 * 解析输入，判断是补充信息注入还是普通任务提交
 *
 * 规则：
 * 1. @worker_type 内容 → 定向路由注入
 * 2. @all 内容 → 全局广播注入
 * 3. 任务执行中 + 无@前缀 → 智能路由注入（默认行为）
 * 4. 无任务执行中 + 无@前缀 → 创建新任务
 */
function parseInput(text, isTaskRunning) {
  // 匹配 @worker_type 或 @all 开头
  const directedMatch = text.match(/^@(\w+)\s+(.+)$/s);
  if (directedMatch) {
    const target = directedMatch[1].toLowerCase();
    const content = directedMatch[2].trim();
    if (target === 'all' || target === 'broadcast') {
      return { type: 'inject', route: 'broadcast', content };
    }
    return { type: 'inject', route: 'directed', targetWorkerType: target, content };
  }
  // 任务执行中，后续消息作为补充信息（智能路由）
  if (isTaskRunning) {
    return { type: 'inject', route: 'smart', content: text };
  }
  return { type: 'task' };
}

/**
 * 检查当前是否有任务正在执行
 */
function isTaskRunning() {
  const statusEl = document.getElementById('masterTabStatus');
  return statusEl && statusEl.textContent && statusEl.textContent.includes('执行中');
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const mode = document.getElementById('runModeSelect').value;
  const permissionMode = document.getElementById('permissionModeSelect')?.value || 'ask';
  const parsed = parseInput(text, isTaskRunning());
  const session = currentSession();
  const msgs = currentMessages();

  const userMsg = { type: 'user', content: text };
  msgs.push(userMsg);
  input.value = '';
  appendMessageDom(userMsg);
  updateMsgCount();

  // 首条消息时自动设置会话标题
  if (msgs.length === 1 && session) {
    session.title = text.substring(0, 20) + (text.length > 20 ? '...' : '');
    const tabEl = document.querySelector(`.chat-tab[data-tab="${currentChatTab}"] .tab-title`);
    if (tabEl) tabEl.textContent = session.title;
  }

  // 补充信息注入
  if (parsed.type === 'inject') {
    await sendSupplementaryInfo(parsed, mode);
    return;
  }

  // 普通任务提交（带 projectId = 当前会话的 sessionId）
  try {
    const result = await invoke('submit_task', {
      request: {
        task: text,
        mode,
        project_id: session?.sessionId || '__global__',
      }
    });

    if (result.success) {
      // 存储当前 traceId，供补充信息注入使用
      window.currentTraceId = result.trace_id || null;
      if (session) session.traceId = result.trace_id || null;
      const permLabel = { ask: 'Ask（逐条审批）', auto: 'Auto（自动接受编辑）', bypass: 'Bypass（跳过权限）' };
      const msg = {
        type: 'master',
        content: `✅ ${result.message}\n\n📝 Trace ID: ${result.trace_id || 'N/A'}\n🔐 权限模式: ${permLabel[permissionMode] || permissionMode}\n${result.data || ''}`,
        closed: true
      };
      msgs.push(msg);
      appendMessageDom(msg);
      document.getElementById('masterTabStatus').textContent = '● 执行中';
      document.getElementById('masterTabStatus').style.color = '#facc15';
      // 显示强制终止按钮
      showForceCancelButton(result.trace_id);
    } else {
      const msg = {
        type: 'master',
        content: `❌ 任务提交失败: ${result.message}`
      };
      msgs.push(msg);
      appendMessageDom(msg);
    }
  } catch (e) {
    const msg = {
      type: 'master',
      content: `❌ 调用失败: ${e}`
    };
    msgs.push(msg);
    appendMessageDom(msg);
  }

  updateMsgCount();
}

/**
 * 发送补充信息注入
 */
async function sendSupplementaryInfo(parsed, mode) {
  // 获取当前运行中任务的traceId
  let traceId = null;

  // 优先从全局变量获取（submit_task 时存储）
  if (window.currentTraceId) {
    traceId = window.currentTraceId;
  } else {
    // 回退：从系统状态获取
    try {
      const status = await invoke('get_system_status', {});
      traceId = status.current_trace_id;
    } catch (e) {
      // 忽略
    }
  }

  if (!traceId) {
    const msg = {
      type: 'master',
      content: '⚠️ 当前没有执行中的任务，无法注入补充信息。请先提交任务。',
      closed: true
    };
    currentMessages().push(msg);
    appendMessageDom(msg);
    updateMsgCount();
    return;
  }

  const request = {
    trace_id: traceId,
    content: parsed.content,
    target_worker_type: parsed.targetWorkerType || null,
    route: parsed.route || null,
    urgent: false,
  };

  try {
    const result = await invoke('inject_info', { request });

    if (result.success && result.data) {
      const injectResult = JSON.parse(result.data);
      const cardHtml = buildInjectionCard(injectResult, parsed);
      const msg = {
        type: 'master',
        prefix: 'Master',
        content: cardHtml,
        closed: true,
        isHtml: true,
      };
      currentMessages().push(msg);
      appendMessageDom(msg);
    } else {
      const msg = {
        type: 'master',
        content: `❌ 补充信息注入失败: ${result.message}`,
        closed: true
      };
      currentMessages().push(msg);
      appendMessageDom(msg);
    }
  } catch (e) {
    const msg = {
      type: 'master',
      content: `❌ 注入调用失败: ${e}`,
      closed: true
    };
    currentMessages().push(msg);
    appendMessageDom(msg);
  }

  updateMsgCount();
}

/**
 * 构建路由详情卡片
 */
function buildInjectionCard(result, parsed) {
  const statusIcon = result.statusCode === 6001 ? '✅' : result.statusCode === 6002 ? '❓' : '❌';
  const statusText = result.statusCode === 6001 ? '已送达'
    : result.statusCode === 6002 ? '需澄清目标'
    : '无法送达';

  const targetWorkers = (result.routeDetail?.targetWorkerIds || []).join(', ') || '无';
  const reason = result.routeDetail?.reason || '';
  const confidence = result.routeDetail?.confidence != null
    ? `${(result.routeDetail.confidence * 100).toFixed(0)}%`
    : '';
  const keywordMatches = (result.routeDetail?.keywordMatches || []).join(', ');

  let candidateHtml = '';
  if (result.candidates && result.candidates.length > 0) {
    const candidates = result.candidates.map(c => `• ${c.type} (${c.id.slice(0, 8)}...) - ${c.status}`).join('\n');
    candidateHtml = `\n└─ 候选Worker:\n${candidates}`;
  }

  return `📤 补充信息路由详情
├─ 原始输入: "${parsed.content}"
├─ 路由模式: ${result.route}
├─ 目标Worker: ${targetWorkers}
├─ 决策依据: ${reason}
${confidence ? `├─ 置信度: ${confidence}\n` : ''}${keywordMatches ? `├─ 关键词匹配: ${keywordMatches}\n` : ''}├─ 注入状态: ${statusIcon} ${statusText} (状态码: ${result.statusCode})
${candidateHtml}`;
}

function handleChatInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// ==================== 权限审批 Toast ====================

/**
 * 显示权限审批 Toast：展示工具名+输入，允许/拒绝按钮
 */
function showPermissionToast(data) {
  const { request_id, worker_id, tool_name, tool_input } = data;

  // 截断过长的 tool_input
  let inputStr = '';
  try {
    inputStr = JSON.stringify(tool_input, null, 2);
    if (inputStr.length > 300) inputStr = inputStr.slice(0, 300) + '...';
  } catch { inputStr = String(tool_input); }

  const toast = document.createElement('div');
  toast.className = 'permission-toast';
  toast.innerHTML = `
    <div class="perm-header">
      <span class="perm-icon">🔐</span>
      <span class="perm-title">权限审批请求</span>
      <span class="perm-worker">Worker: ${escapeHtml(worker_id.slice(0, 8))}</span>
    </div>
    <div class="perm-body">
      <div class="perm-tool"><strong>工具:</strong> ${escapeHtml(tool_name)}</div>
      <pre class="perm-input">${escapeHtml(inputStr)}</pre>
    </div>
    <div class="perm-actions">
      <button class="perm-allow" onclick="resolvePermission('${request_id}', 'allow')">✅ 允许</button>
      <button class="perm-deny" onclick="resolvePermission('${request_id}', 'deny')">❌ 拒绝</button>
    </div>
  `;
  document.body.appendChild(toast);

  // 超时后自动拒绝（使用配置的超时秒数）
  const timeoutSec = window.permissionTimeoutMs ? Math.floor(window.permissionTimeoutMs / 1000) : 120;
  setTimeout(() => {
    if (document.body.contains(toast)) {
      resolvePermission(request_id, 'deny');
      toast.remove();
    }
  }, window.permissionTimeoutMs || 120000);
}

/**
 * 用户审批决策：调用 Tauri 命令发送到 scheduler
 */
async function resolvePermission(requestId, decision) {
  try {
    await invoke('permission_response', {
      request: { decision, message: decision === 'deny' ? '用户拒绝' : undefined }
    });
  } catch (e) {
    showToast(`审批响应失败: ${e}`, 'error');
  }
  // 移除对应的 toast
  document.querySelectorAll('.permission-toast').forEach(t => t.remove());
}

/**
 * 监听 Tauri 的 permission-request 事件
 */
function initPermissionListener() {
  if (typeof window.__TAURI__ !== 'undefined') {
    const { listen } = window.__TAURI__.event;
    listen('permission-request', (event) => {
      showPermissionToast(event.payload);
    });
  }
}

// 初始化权限监听
initPermissionListener();

// ==================== 强制终止按钮 & 循环调度状态 ====================

/**
 * 显示强制终止按钮（任务执行中时）
 */
function showForceCancelButton(traceId) {
  // 如果已存在则不重复创建
  if (document.getElementById('forceCancelBtn')) return;

  const btn = document.createElement('button');
  btn.id = 'forceCancelBtn';
  btn.className = 'force-cancel-btn';
  btn.innerHTML = '⏹ 终止任务';
  btn.onclick = () => handleForceCancel(traceId);
  document.body.appendChild(btn);
}

/**
 * 隐藏强制终止按钮
 */
function hideForceCancelButton() {
  const btn = document.getElementById('forceCancelBtn');
  if (btn) btn.remove();
}

/**
 * 处理强制终止
 */
async function handleForceCancel(traceId) {
  const btn = document.getElementById('forceCancelBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ 终止中...';
  }

  try {
    const result = await invoke('force_cancel_task', { traceId });
    if (result.success) {
      showToast('任务已强制终止', 'info');
      hideForceCancelButton();
      document.getElementById('masterTabStatus').textContent = '● 已终止';
      document.getElementById('masterTabStatus').style.color = '#f87171';
    } else {
      showToast(`终止失败: ${result.message}`, 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '⏹ 终止任务';
      }
    }
  } catch (e) {
    showToast(`终止调用失败: ${e}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⏹ 终止任务';
    }
  }
}

/**
 * 解析日志中的循环调度状态信息并格式化展示
 * 在 appendLog 中被调用
 */
function formatLoopStatusLog(message) {
  // 匹配状态码 8001/8002/8003/8004 的日志
  if (message.includes('状态码 8001') || message.includes('进入第') && message.includes('轮循环调度')) {
    const roundMatch = message.match(/第 (\d+)\/(\d+) 轮/);
    if (roundMatch) {
      return `🔄 循环调度 → 第 ${roundMatch[1]}/${roundMatch[2]} 轮`;
    }
  }
  if (message.includes('状态码 8002') || message.includes('评审未通过')) {
    const reasonMatch = message.match(/评审未通过:?\s*(.*)/);
    return `⏳ 评审未通过${reasonMatch ? ': ' + reasonMatch[1].substring(0, 80) : ''}`;
  }
  if (message.includes('状态码 8003') || message.includes('达到最大循环轮次')) {
    return `⚠️ 达到最大循环轮次`;
  }
  if (message.includes('状态码 8004') || message.includes('强制终止')) {
    return `🛑 任务被强制终止`;
  }
  // 评审通过
  if (message.includes('评审通过') && message.includes('置信度')) {
    const confMatch = message.match(/置信度 ([\d.]+)/);
    return `✅ 评审通过${confMatch ? ' (置信度: ' + confMatch[1] + ')' : ''}`;
  }
  // 评审结果行
  if (message.includes('satisfied=') && message.includes('confidence=')) {
    const satMatch = message.match(/satisfied=(true|false)/);
    const confMatch = message.match(/confidence=([\d.]+)/);
    if (satMatch && confMatch) {
      return satMatch[1] === 'true'
        ? `✅ 评审通过 (置信度: ${confMatch[1]})`
        : `⏳ 评审未通过 (置信度: ${confMatch[1]})`;
    }
  }
  // 循环调度摘要
  if (message.includes('循环调度摘要')) {
    const lines = message.split('\n');
    const summaryLines = lines.filter(l =>
      l.includes('总轮次') || l.includes('最终状态') || l.includes('confidence=')
    );
    if (summaryLines.length > 0) {
      return '📊 ' + summaryLines.join('\n📊 ');
    }
  }
  return null;
}
