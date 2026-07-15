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
        content: `✅ ${result.message}\n\n📝 Trace ID: ${result.trace_id || 'N/A'}\n${result.data || ''}`
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
