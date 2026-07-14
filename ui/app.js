// ==================== OpenColony 前端逻辑（真实集成） ====================

// Tauri invoke 封装
async function invoke(cmd, args) {
  if (typeof window.__TAURI__ !== 'undefined') {
    return await window.__TAURI__.invoke(cmd, args);
  }
  throw new Error('Tauri 未就绪（请在 Tauri 环境中运行）');
}

// ==================== 页面切换 ====================

function switchPage(pageName) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`);
  });

  // 进入页面时按需加载
  if (pageName === 'roles') loadAgentRoles();
  else if (pageName === 'skills') loadSkills();
  else if (pageName === 'settings') loadSettings();
  else if (pageName === 'tasks') loadTaskList();
}

// ==================== 对话 Tab ====================

let currentChatTab = 'master';
const chatMessages = {
  master: [],
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

function renderMessages() {
  const container = document.getElementById('chatMessages');
  const meta = container.querySelector('.msg-meta');
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
      const roleNames = {
        user: '👤 用户',
        master: '🤖 Master调度',
      };
      const lines = msg.content.split('\n');
      const formattedContent = lines.map(line => {
        if (line.startsWith('• ') || line.startsWith('- ')) {
          return `<li>${line.substring(2)}</li>`;
        }
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

  // 真实调用 Tauri submit_task
  try {
    const result = await invoke('submit_task', {
      request: { task: text, mode: mode }
    });

    if (result.success) {
      chatMessages[currentChatTab].push({
        type: 'master',
        content: `✅ ${result.message}\n\n📝 Trace ID: ${result.trace_id || 'N/A'}\n${result.data || ''}`
      });
      // 更新Tab状态为执行中
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

// ==================== 任务日志 ====================

async function loadTaskList() {
  const listEl = document.getElementById('taskList');
  try {
    const tasks = await invoke('get_task_list', {});
    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无任务记录，提交任务后将显示在此</div>';
    } else {
      listEl.innerHTML = tasks.map(t => `
        <div class="task-card" onclick="expandTask('${t.task_dir}')">
          <div class="task-card-header">
            <span class="task-badge">📋 ${t.worker_logs.length + (t.master_log ? 1 : 0)} 个日志</span>
            <span class="task-time">${t.created_at}</span>
          </div>
          <div class="task-trace">TraceID: ${t.trace_id}</div>
          <div class="task-dir">📁 ${t.task_dir}</div>
          ${t.master_log ? `<div class="task-log-file" onclick="event.stopPropagation(); viewLog('${t.task_dir}', '${t.master_log}')">📄 ${t.master_log}</div>` : ''}
          ${t.worker_logs.map(w => `<div class="task-log-file" onclick="event.stopPropagation(); viewLog('${t.task_dir}', '${w}')">📄 ${w}</div>`).join('')}
        </div>
      `).join('');
    }
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }

  // 加载日志根目录路径
  try {
    const root = await invoke('get_worker_logs_root', {});
    document.getElementById('taskLogsPath').textContent = `日志根目录: ${root}`;
  } catch (e) {
    document.getElementById('taskLogsPath').textContent = `日志根目录: 获取失败`;
  }
}

function expandTask(taskDir) {
  // 占位，未来可展开详情
}

async function viewLog(taskDir, fileName) {
  const container = document.getElementById('logViewerContainer');
  const viewer = document.getElementById('logViewer');
  const nameEl = document.getElementById('logFileName');

  try {
    const result = await invoke('get_task_log_content', { taskDir, fileName });
    nameEl.textContent = `${fileName} (${formatSize(result.size)})`;
    viewer.textContent = result.content || '(空文件)';
    container.style.display = 'block';
  } catch (e) {
    nameEl.textContent = fileName;
    viewer.textContent = `加载失败: ${e}`;
    container.style.display = 'block';
  }
}

function closeLogViewer() {
  document.getElementById('logViewerContainer').style.display = 'none';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ==================== 角色管理 ====================

let agentRoles = [];

async function loadAgentRoles() {
  const grid = document.getElementById('roleGrid');
  try {
    agentRoles = await invoke('get_agent_roles', {});
    renderAgentRoles();
  } catch (e) {
    console.error('加载角色失败:', e);
    grid.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }
}

function renderAgentRoles() {
  const grid = document.getElementById('roleGrid');
  grid.innerHTML = '';
  document.getElementById('roleTotal').textContent = agentRoles.length;

  // 角色颜色映射
  const colorMap = {
    'general_agent': '#8b5cf6',
    'code_agent': '#2563eb',
    'review_agent': '#ec4899',
    'data_agent': '#16a34a',
    'vis_agent': '#d97706',
    'master': '#dc2626',
  };
  const iconMap = {
    'general_agent': '🔧',
    'code_agent': '💻',
    'review_agent': '🔍',
    'data_agent': '📊',
    'vis_agent': '📈',
    'master': '🧠',
  };

  agentRoles.forEach(role => {
    const color = colorMap[role.id] || '#64748b';
    const icon = iconMap[role.id] || '⚙️';
    const card = document.createElement('div');
    card.className = 'role-card';
    card.innerHTML = `
      <div class="role-card-topbar" style="background: ${color}"></div>
      <div class="role-card-body">
        <div class="role-header">
          <div class="role-avatar" style="background: ${hexToRgba(color, 0.1)}; color: ${color}">${icon}</div>
          <div class="role-info">
            <h4>${role.name}</h4>
            <div class="role-desc">${role.description}</div>
          </div>
        </div>
        <div class="role-stats">
          <div class="role-stat">📋 ID: ${role.id}</div>
          ${role.task_count ? `<div class="role-stat">📊 任务完成: ${role.task_count}次</div>` : ''}
          ${role.last_active ? `<div class="role-stat">⏱ 最后活跃: ${role.last_active}</div>` : ''}
        </div>
        ${role.skills && role.skills.length > 0 ? `
          <div class="role-skills">
            ${role.skills.map(s => `<span class="skill-tag">${s}</span>`).join('')}
          </div>
        ` : '<div class="role-skills"><span class="skill-tag muted">无绑定技能</span></div>'}
        ${role.system_prompt ? `<details class="role-prompt"><summary>查看系统提示词</summary><pre>${escapeHtml(role.system_prompt)}</pre></details>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ==================== Skill 管理 ====================

let allSkills = [];

async function loadSkills() {
  try {
    const claudeDir = document.getElementById('claudeUrl')?.value || '.claude';
    const result = await invoke('get_skills_from_claude', { claude_dir: claudeDir });
    
    if (result.success && result.data) {
      try {
        const jsonData = JSON.parse(result.data);
        allSkills = parseClaudeSkills(jsonData);
        showToast(`成功加载 ${allSkills.length} 个技能`, 'success');
      } catch (parseErr) {
        console.error('解析技能数据失败:', parseErr);
        allSkills = [];
        showToast('解析技能数据失败', 'error');
      }
    } else {
      console.warn('从Claude目录加载技能失败:', result.message);
      allSkills = [];
      showToast(result.message || '加载失败', 'error');
    }
    filterSkills();
  } catch (e) {
    console.error('加载Skill失败:', e);
    allSkills = [];
    filterSkills();
    showToast('加载失败: ' + e.message, 'error');
  }
}

async function saveSkills() {
  try {
    const skillsJson = JSON.stringify(allSkills);
    const result = await invoke('save_skills_to_file', { skills_json: skillsJson });
    
    if (result.success) {
      showToast('技能保存成功', 'success');
    } else {
      showToast(result.message || '保存失败', 'error');
    }
  } catch (e) {
    console.error('保存Skill失败:', e);
    showToast('保存失败: ' + e.message, 'error');
  }
}

function parseClaudeSkills(data) {
  if (!data) return [];
  
  let skills = [];
  
  if (Array.isArray(data)) {
    skills = data;
  } else if (data.skills && Array.isArray(data.skills)) {
    skills = data.skills;
  } else if (data.functions && Array.isArray(data.functions)) {
    skills = data.functions.map(f => ({
      id: f.name || f.id || '',
      name: f.description || f.name || '',
      description: f.description || '',
      category: '代码',
      version: 'v1.0.0',
      status: '活跃',
      icon: '🔧',
    }));
  }
  
  return skills.map(s => ({
    id: s.id || s.name || '',
    name: s.name || '',
    description: s.description || '',
    category: s.category || '通用',
    version: s.version || 'v1.0.0',
    status: s.status || '活跃',
    icon: s.icon || '🔧',
  }));
}

function filterSkills() {
  const search = document.getElementById('skillSearch').value.toLowerCase();
  const statusFilter = document.getElementById('statusFilter').value;
  const categoryFilter = document.getElementById('categoryFilter').value;

  const filtered = allSkills.filter(skill => {
    const matchSearch = !search || skill.name.toLowerCase().includes(search) || skill.description.toLowerCase().includes(search);
    const matchStatus = !statusFilter || skill.status === statusFilter;
    const matchCategory = !categoryFilter || skill.category === categoryFilter;
    return matchSearch && matchStatus && matchCategory;
  });

  renderSkills(filtered);
  updateSkillStats();
}

function renderSkills(skills) {
  const tbody = document.getElementById('skillTableBody');
  tbody.innerHTML = '';
  document.getElementById('skillTotal').textContent = allSkills.length;

  if (skills.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">无匹配Skill</td></tr>';
    return;
  }

  skills.forEach(skill => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="skill-name-cell">
          <div class="skill-icon">${skill.icon}</div>
          <span class="skill-name">${skill.name}</span>
        </div>
      </td>
      <td>${skill.description}</td>
      <td><span class="category-tag ${skill.category}">${skill.category}</span></td>
      <td>${skill.version}</td>
      <td><span class="status-tag ${skill.status}">${skill.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function updateSkillStats() {
  const total = allSkills.length;
  const active = allSkills.filter(s => s.status === '活跃').length;
  const pending = allSkills.filter(s => s.status === '待更新').length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statActive').textContent = active;
  document.getElementById('statPending').textContent = pending;
}

// ==================== 系统设置 ====================

async function loadSettings() {
  try {
    const config = await invoke('get_system_config', {});
    document.getElementById('modelProvider').value = 'Anthropic';
    document.getElementById('modelName').value = config.model_name || '';
    document.getElementById('apiKey').value = config.api_key || '';
    document.getElementById('apiBase').value = config.api_base || '';
    document.getElementById('claudePath').value = config.claude_path || 'claude';
    document.getElementById('claudeUrl').value = config.claude_url || '.claude';
    document.getElementById('maxAgents').value = config.max_agents || 8;
    document.getElementById('runModeCfg').value = config.run_mode || 'sdk';

    // 同步主界面的模式选择
    document.getElementById('runModeSelect').value = config.run_mode || 'sdk';
    document.getElementById('runModeDisplay').textContent = `模式: ${(config.run_mode || 'sdk').toUpperCase()}`;
  } catch (e) {
    console.error('加载设置失败:', e);
  }
}

async function saveSettings() {
  const config = {
    model_provider: document.getElementById('modelProvider').value,
    model_name: document.getElementById('modelName').value,
    api_key: document.getElementById('apiKey').value,
    api_base: document.getElementById('apiBase').value,
    claude_path: document.getElementById('claudePath').value,
    claude_url: document.getElementById('claudeUrl').value,
    max_agents: parseInt(document.getElementById('maxAgents').value) || 8,
    run_mode: document.getElementById('runModeCfg').value,
  };

  try {
    const result = await invoke('save_system_config', { config });
    if (result.success) {
      alert(`✅ ${result.message}\n路径: ${result.data || ''}`);
      // 同步主界面
      document.getElementById('runModeSelect').value = config.run_mode;
      document.getElementById('runModeDisplay').textContent = `模式: ${config.run_mode.toUpperCase()}`;
    } else {
      alert(`❌ 保存失败: ${result.message}`);
    }
  } catch (e) {
    alert(`❌ 保存失败: ${e}`);
  }
}

async function testModelConnection() {
  const statusEl = document.getElementById('modelTestStatus');
  statusEl.innerHTML = '<span class="status-dot pending"></span> 测试中...';
  statusEl.className = 'test-status warning';

  try {
    const result = await invoke('test_model_connection', {});
    if (result.success) {
      statusEl.innerHTML = `<span class="status-dot running"></span> ${result.message}`;
      statusEl.className = 'test-status success';
      updateConnectionStatus(true, false);
    } else {
      statusEl.innerHTML = `<span class="status-dot pending"></span> ${result.message}`;
      statusEl.className = 'test-status warning';
    }
  } catch (e) {
    statusEl.innerHTML = `<span class="status-dot pending"></span> 异常: ${e}`;
    statusEl.className = 'test-status warning';
  }
}

async function testClaudeConnection() {
  const statusEl = document.getElementById('claudeTestStatus');
  statusEl.innerHTML = '<span class="status-dot pending"></span> 测试中...';
  statusEl.className = 'test-status warning';

  try {
    const result = await invoke('test_claude_connection', {});
    if (result.success) {
      statusEl.innerHTML = `<span class="status-dot running"></span> ${result.message}`;
      statusEl.className = 'test-status success';
      updateConnectionStatus(false, true);
    } else {
      statusEl.innerHTML = `<span class="status-dot pending"></span> ${result.message}`;
      statusEl.className = 'test-status warning';
    }
  } catch (e) {
    statusEl.innerHTML = `<span class="status-dot pending"></span> 异常: ${e}`;
    statusEl.className = 'test-status warning';
  }
}

function updateConnectionStatus(llmOk, claudeOk) {
  const el = document.getElementById('connectionStatus');
  const parts = [];
  parts.push(llmOk ? '✓ 大模型' : '✗ 大模型');
  parts.push(claudeOk ? '✓ Claude' : '✗ Claude');
  el.textContent = `📡 连接状态: ${parts.join(' | ')}`;
}

// ==================== 系统状态刷新 ====================

async function updateSystemStatus() {
  try {
    const status = await invoke('get_system_status', {});
    document.getElementById('agentCount').textContent = status.agent_count;
    document.getElementById('taskQueue').textContent = status.task_queue;
    document.getElementById('sessionId').textContent = status.session_id;

    // 更新标题栏状态
    const dot = document.getElementById('systemDot');
    const text = document.getElementById('systemStatusText');
    if (status.running) {
      dot.className = 'status-dot pending';
      text.textContent = `任务执行中 (${status.current_trace_id || ''})`;
      text.style.color = '#fef3c7';
    } else {
      dot.className = 'status-dot running';
      text.textContent = '系统就绪';
      text.style.color = '#dbeafe';
    }
  } catch (e) {
    // 静默失败
  }

  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(/\//g, '-');
  const updateEls = document.querySelectorAll('#lastUpdate, #lastSync');
  updateEls.forEach(el => { if (el) el.textContent = timeStr; });
}

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', () => {
  renderMessages();
  loadSettings();
  updateSystemStatus();
  // 每 5 秒刷新一次系统状态
  setInterval(updateSystemStatus, 5000);
});
