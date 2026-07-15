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
      msgEl.className = `message ${msg.type}`;
      const roleNames = { user: '👤 用户', master: '🤖 Master调度' };
      const lines = msg.content.split('\n');
      const formattedContent = lines.map(line => {
        if (line.startsWith('• ') || line.startsWith('- ')) return `<li>${line.substring(2)}</li>`;
        return `<p>${line}</p>`;
      }).join('');
      const hasList = lines.some(l => l.startsWith('• ') || l.startsWith('- '));
      msgEl.innerHTML = `
        <div class="msg-header">${roleNames[msg.type] || msg.type}</div>
        <div class="msg-body">${hasList ? `<ul>${formattedContent}</ul>` : formattedContent}</div>
      `;
      container.appendChild(msgEl);
    }
  });

  container.scrollTop = container.scrollHeight;
}

// ==================== Tauri 事件监听 ====================

function initSchedulerListeners() {
  if (typeof window.__TAURI__ === 'undefined') return;

  // 监听 scheduler 输出
  window.__TAURI__.event.listen('scheduler-output', (event) => {
    const { traceId, type, line } = event.payload;
    if (!chatMessages.master) chatMessages.master = [];

    // 过滤掉不需要展示的行（如 SQL 语句、PRAGMA 等）
    if (line.match(/^\s*(PRAGMA|CREATE|INSERT|SELECT|ALTER|DROP)\s/i)) return;
    if (line.trim() === '') return;

    // 追加到最后一条 master 消息中，或新建一条
    const lastMsg = chatMessages.master[chatMessages.master.length - 1];
    if (lastMsg && lastMsg.type === 'master' && !lastMsg.closed) {
      lastMsg.content += '\n' + line;
    } else {
      chatMessages.master.push({ type: 'master', content: line, closed: false });
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
