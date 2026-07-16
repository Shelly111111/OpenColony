// ==================== 对话 Tab ====================

let currentChatTab = 'master';
const chatMessages = { master: [] };

// prefix 对应的显示标签和颜色
const PREFIX_STYLES = {
  Master:            { label: 'Master',  color: '#60a5fa' },
  PlanExecutor:      { label: 'Plan',    color: '#a78bfa' },
  WorkerManager:     { label: 'Worker',  color: '#34d399' },
  ArbitrationEngine: { label: 'Arbiter', color: '#fbbf24' },
  LLMClient:         { label: 'LLM',     color: '#f472b6' },
  ClaudeLink:        { label: 'Link',    color: '#2dd4bf' },
  RoleManager:       { label: 'Role',    color: '#fb923c' },
};

function switchChatTab(tabName) {
  currentChatTab = tabName;
  document.querySelectorAll('.chat-tab').forEach(tab => {
    if (tab.classList.contains('add-tab')) return;
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  renderMessages();
}

function addNewTab() {
  alert('新增对话功能开发中');
}

function clearMessages() {
  chatMessages.master = [];
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
  const messages = chatMessages[currentChatTab] || [];
  document.getElementById('msgCount').textContent = messages.length;
}

// ==================== 全量渲染（仅用于切换 Tab / 清空等场景） ====================

function renderMessages() {
  const container = document.getElementById('chatMessages');
  const messages = chatMessages[currentChatTab] || [];

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
    if (!chatMessages.master) chatMessages.master = [];

    if (type === 'log') {
      const levelIcon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '';
      const displayMsg = levelIcon ? `${levelIcon} ${message}` : message;

      const lastMsg = chatMessages.master[chatMessages.master.length - 1];
      if (lastMsg && lastMsg.type === 'master' && lastMsg.prefix === prefix && !lastMsg.closed) {
        // 追加到最后一条同 prefix 消息 —— 只更新该元素
        lastMsg.content += '\n' + displayMsg;
        updateMessageDom(lastMsg);
      } else {
        // 新建一条消息 —— 只追加新元素
        const msg = { type: 'master', prefix, content: displayMsg, closed: false };
        chatMessages.master.push(msg);
        appendMessageDom(msg);
      }
    } else if (type === 'stdout') {
      if (line.match(/^\s*(PRAGMA|CREATE|INSERT|SELECT|ALTER|DROP)\s/i)) return;
      if (line.trim() === '') return;

      const lastMsg = chatMessages.master[chatMessages.master.length - 1];
      if (lastMsg && lastMsg.type === 'master' && !lastMsg.prefix && !lastMsg.closed) {
        lastMsg.content += '\n' + line;
        updateMessageDom(lastMsg);
      } else {
        const msg = { type: 'master', content: line, closed: false };
        chatMessages.master.push(msg);
        appendMessageDom(msg);
      }
    } else if (type === 'stderr') {
      if (line.trim() === '') return;
      const msg = { type: 'master', prefix: 'stderr', content: `⚠️ ${line}`, closed: true };
      chatMessages.master.push(msg);
      appendMessageDom(msg);
    }

    updateMsgCount();
  });

  // 监听任务完成
  window.__TAURI__.event.listen('task-completed', (event) => {
    const { traceId, exitCode, error } = event.payload;

    const lastMsg = chatMessages.master[chatMessages.master.length - 1];
    if (lastMsg && lastMsg.type === 'master') {
      lastMsg.closed = true;
    }

    const statusText = error
      ? `❌ 任务异常退出: ${error}`
      : exitCode === 0
        ? '✅ 任务已完成'
        : `⚠️ 任务已退出 (退出码: ${exitCode})`;

    const msg = { type: 'master', content: statusText, closed: true };
    chatMessages.master.push(msg);
    appendMessageDom(msg);
    updateMsgCount();

    document.getElementById('masterTabStatus').textContent = '● 已完成';
    document.getElementById('masterTabStatus').style.color = '#4ade80';
  });
}

// ==================== 提交任务 ====================

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const mode = document.getElementById('runModeSelect').value;

  if (!chatMessages[currentChatTab]) chatMessages[currentChatTab] = [];
  const userMsg = { type: 'user', content: text };
  chatMessages[currentChatTab].push(userMsg);
  input.value = '';
  appendMessageDom(userMsg);
  updateMsgCount();

  try {
    const result = await invoke('submit_task', { request: { task: text, mode } });

    if (result.success) {
      const msg = {
        type: 'master',
        content: `✅ ${result.message}\n\n📝 Trace ID: ${result.trace_id || 'N/A'}\n${result.data || ''}`,
        closed: true
      };
      chatMessages[currentChatTab].push(msg);
      appendMessageDom(msg);
      document.getElementById('masterTabStatus').textContent = '● 执行中';
      document.getElementById('masterTabStatus').style.color = '#facc15';
    } else {
      const msg = {
        type: 'master',
        content: `❌ 任务提交失败: ${result.message}`
      };
      chatMessages[currentChatTab].push(msg);
      appendMessageDom(msg);
    }
  } catch (e) {
    const msg = {
      type: 'master',
      content: `❌ 调用失败: ${e}`
    };
    chatMessages[currentChatTab].push(msg);
    appendMessageDom(msg);
  }

  updateMsgCount();
}

function handleChatInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}
