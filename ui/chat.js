// ==================== 对话 Tab ====================

let currentChatTab = 'master';
const chatMessages = { master: [] };

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

function renderMessages() {
  const container = document.getElementById('chatMessages');
  const messages = chatMessages[currentChatTab] || [];

  document.getElementById('msgCount').textContent = messages.length;

  const existing = container.querySelectorAll('.message, .task-status');
  existing.forEach(el => el.remove());

  messages.forEach(msg => {
    if (msg.type === 'task-status') {
      const statusEl = document.createElement('div');
      statusEl.className = 'task-status';
      statusEl.innerHTML = `
        <div class="task-status-title">📊 任务状态</div>
        <div class="task-status-body">${msg.content}</div>
      `;
      container.appendChild(statusEl);
    } else {
      const msgEl = document.createElement('div');
      const isUser = msg.type === 'user';
      msgEl.className = `message ${msg.type}`;

      const roleNames = { user: '👤 用户', master: '🤖 Master调度' };

      // 根据 prefix 生成标签
      let headerHtml;
      if (msg.prefix && PREFIX_STYLES[msg.prefix]) {
        const style = PREFIX_STYLES[msg.prefix];
        headerHtml = `<span style="color:${style.color};font-weight:600">[${style.label}]</span>`;
      } else {
        headerHtml = roleNames[msg.type] || msg.type;
      }

      const lines = msg.content.split('\n');
      const formattedContent = lines.map(line => {
        if (line.startsWith('• ') || line.startsWith('- ')) return `<li>${line.substring(2)}</li>`;
        return `<p>${line}</p>`;
      }).join('');
      const hasList = lines.some(l => l.startsWith('• ') || l.startsWith('- '));
      msgEl.innerHTML = `
        <div class="msg-header">${headerHtml}</div>
        <div class="msg-body">${hasList ? `<ul>${formattedContent}</ul>` : formattedContent}</div>
      `;
      container.appendChild(msgEl);
    }
  });

  container.scrollTop = container.scrollHeight;
}

// ==================== Tauri 事件监听 ====================

// prefix 对应的显示标签和颜色
const PREFIX_STYLES = {
  Master:          { label: 'Master',  color: '#60a5fa' },
  PlanExecutor:    { label: 'Plan',    color: '#a78bfa' },
  WorkerManager:   { label: 'Worker',  color: '#34d399' },
  ArbitrationEngine: { label: 'Arbiter', color: '#fbbf24' },
  LLMClient:       { label: 'LLM',     color: '#f472b6' },
  ClaudeLink:      { label: 'Link',    color: '#2dd4bf' },
  RoleManager:     { label: 'Role',    color: '#fb923c' },
};

function initSchedulerListeners() {
  if (typeof window.__TAURI__ === 'undefined') return;

  // 监听 scheduler 输出
  window.__TAURI__.event.listen('scheduler-output', (event) => {
    const { traceId, type, line, prefix, message, level } = event.payload;
    if (!chatMessages.master) chatMessages.master = [];

    if (type === 'log') {
      // 结构化日志：带 prefix + level 信息
      const style = PREFIX_STYLES[prefix] || { label: prefix, color: '#94a3b8' };
      const levelIcon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '';
      const displayMsg = levelIcon ? `${levelIcon} ${message}` : message;

      // 追加到最后一条同 prefix 消息中，或新建一条
      const lastMsg = chatMessages.master[chatMessages.master.length - 1];
      if (lastMsg && lastMsg.type === 'master' && lastMsg.prefix === prefix && !lastMsg.closed) {
        lastMsg.content += '\n' + displayMsg;
      } else {
        chatMessages.master.push({ type: 'master', prefix, content: displayMsg, closed: false });
      }
    } else if (type === 'stdout') {
      // 普通 stdout 行（过滤噪音）
      if (line.match(/^\s*(PRAGMA|CREATE|INSERT|SELECT|ALTER|DROP)\s/i)) return;
      if (line.trim() === '') return;

      const lastMsg = chatMessages.master[chatMessages.master.length - 1];
      if (lastMsg && lastMsg.type === 'master' && !lastMsg.prefix && !lastMsg.closed) {
        lastMsg.content += '\n' + line;
      } else {
        chatMessages.master.push({ type: 'master', content: line, closed: false });
      }
    } else if (type === 'stderr') {
      if (line.trim() === '') return;
      chatMessages.master.push({ type: 'master', prefix: 'stderr', content: `⚠️ ${line}`, closed: true });
    }

    renderMessages();
  });

  // 监听任务完成
  window.__TAURI__.event.listen('task-completed', (event) => {
    const { traceId, exitCode, error } = event.payload;

    // 关闭最后一条消息的追加
    const lastMsg = chatMessages.master[chatMessages.master.length - 1];
    if (lastMsg && lastMsg.type === 'master') {
      lastMsg.closed = true;
    }

    // 添加任务完成状态
    const statusText = error
      ? `❌ 任务异常退出: ${error}`
      : exitCode === 0
        ? '✅ 任务已完成'
        : `⚠️ 任务已退出 (退出码: ${exitCode})`;

    chatMessages.master.push({ type: 'master', content: statusText, closed: true });
    renderMessages();

    // 更新状态指示器
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
  chatMessages[currentChatTab].push({ type: 'user', content: text });
  input.value = '';
  renderMessages();

  try {
    const result = await invoke('submit_task', { request: { task: text, mode } });

    if (result.success) {
      chatMessages[currentChatTab].push({
        type: 'master',
        content: `✅ ${result.message}\n\n📝 Trace ID: ${result.trace_id || 'N/A'}\n${result.data || ''}`,
        closed: true
      });
      document.getElementById('masterTabStatus').textContent = '● 执行中';
      document.getElementById('masterTabStatus').style.color = '#facc15';
    } else {
      chatMessages[currentChatTab].push({
        type: 'master',
        content: `❌ 任务提交失败: ${result.message}`
      });
    }
  } catch (e) {
    chatMessages[currentChatTab].push({
      type: 'master',
      content: `❌ 调用失败: ${e}`
    });
  }

  renderMessages();
}

function handleChatInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}
