// 页面切换
function switchPage(pageName) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`);
  });

  if (pageName === 'roles') {
    loadAgentRoles();
  } else if (pageName === 'skills') {
    loadSkills();
  } else if (pageName === 'settings') {
    loadSettings();
  }
}

// 对话Tab切换
let currentChatTab = 'master';

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

// 消息数据
const chatMessages = {
  master: [
    { type: 'user', content: '开发一个电商数据分析面板，包含用户画像、销售趋势、库存预警三个核心模块' },
    { type: 'master', content: '✅ 已收到需求，正在进行任务拆解与分发...\n• Worker1(代码): FastAPI后端开发\n• Worker2(数据): 用户画像分析\n• Worker3(可视): 可视化面板' },
    { type: 'user', content: '好的，开始执行吧' },
    { type: 'master', content: '🚀 DAG任务流水线已启动，3个子任务并行执行中\n• Worker1: 代码生成中 (65%)\n• Worker2: 数据分析中 (80%)\n• Worker3: 等待数据\n⏱️ 预计完成时间: 约45秒' },
    { type: 'task-status', content: '✅ Worker1 已完成 | 🔄 Worker2 执行中 (85%) | ⏳ Worker3 等待中' },
  ],
  worker1: [
    { type: 'worker1', content: '💻 开始执行 FastAPI 后端开发任务\n\n任务目标: 电商数据分析面板后端API' },
    { type: 'worker1', content: '📋 规划阶段\n\n已识别核心模块:\n1. 用户画像 API (/api/user-profiles)\n2. 销售趋势 API (/api/sales-trends)\n3. 库存预警 API (/api/inventory-alerts)\n4. 数据导入模块\n5. 认证与权限' },
    { type: 'worker1', content: '⚙️ 正在生成数据库模型...\n\n- UserProfile 模型 ✓\n- SalesRecord 模型 ✓\n- InventoryItem 模型 ✓' },
    { type: 'worker1', content: '📝 正在生成路由和Schema... (65%)' },
  ],
  worker2: [
    { type: 'worker2', content: '📊 开始执行用户画像分析任务' },
    { type: 'worker2', content: '🔍 数据探索阶段\n\n- 总用户数: 12,847\n- 活跃用户: 4,523\n- 客单价分布: 正态分布偏右' },
    { type: 'worker2', content: '🧮 RFM分析进行中 (85%)\n\n- 重要价值用户: 328人\n- 重要发展用户: 1,245人\n- 重要保持用户: 876人\n- 重要挽留用户: 543人' },
  ],
  worker3: [
    { type: 'worker3', content: '📈 可视化面板任务待启动' },
    { type: 'worker3', content: '⏳ 等待 Worker2 数据分析结果...' },
    { type: 'worker3', content: '📋 预加载 ECharts 组件 ✓\n📋 预设面板布局模板 ✓' },
  ],
};

function renderMessages() {
  const container = document.getElementById('chatMessages');
  const meta = container.querySelector('.msg-meta');
  const messages = chatMessages[currentChatTab] || [];

  const count = messages.length;
  document.getElementById('msgCount').textContent = count;

  const existingMessages = container.querySelectorAll('.message, .task-status');
  existingMessages.forEach(el => el.remove());

  messages.forEach(msg => {
    if (msg.type === 'task-status') {
      const statusEl = document.createElement('div');
      statusEl.className = 'task-status';
      statusEl.innerHTML = `
        <div class="task-status-title">📊 实时任务状态</div>
        <div class="task-status-body">${msg.content}</div>
      `;
      container.appendChild(statusEl);
    } else {
      const msgEl = document.createElement('div');
      msgEl.className = `message ${msg.type}`;
      const roleNames = {
        user: '👤 用户',
        master: '🤖 Master调度',
        worker1: '💻 Worker1 - 代码开发',
        worker2: '📊 Worker2 - 数据分析',
        worker3: '📈 Worker3 - 可视化',
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

function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  if (!chatMessages[currentChatTab]) {
    chatMessages[currentChatTab] = [];
  }
  chatMessages[currentChatTab].push({ type: 'user', content: text });
  input.value = '';
  renderMessages();

  setTimeout(() => {
    const response = generateMockResponse(currentChatTab, text);
    chatMessages[currentChatTab].push({ type: currentChatTab, content: response });
    renderMessages();

    if (typeof window.__TAURI__ !== 'undefined') {
      window.__TAURI__.invoke('submit_task', {
        request: { task: text, mode: 'sdk' }
      }).catch(console.error);
    }
  }, 800);
}

function handleChatInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function generateMockResponse(tab, text) {
  const responses = {
    master: `已收到您的消息: "${text}"\n\n正在分析需求并分配任务...\n• 任务优先级: P1\n• 预计参与Agent: 3个\n• 预计耗时: 约2分钟`,
    worker1: `💻 代码开发Agent收到任务\n\n正在分析: "${text}"\n\n规划步骤:\n1. 需求分析\n2. 架构设计\n3. 代码实现\n4. 单元测试`,
    worker2: `📊 数据分析Agent收到任务\n\n正在分析: "${text}"\n\n准备数据处理管道...`,
    worker3: `📈 可视化Agent收到任务\n\n正在分析: "${text}"\n\n准备图表组件...`,
  };
  return responses[tab] || '已收到消息，正在处理...';
}

// 角色管理
let agentRoles = [];

async function loadAgentRoles() {
  try {
    if (typeof window.__TAURI__ !== 'undefined') {
      agentRoles = await window.__TAURI__.invoke('get_agent_roles');
    } else {
      agentRoles = getMockAgentRoles();
    }
    renderAgentRoles();
  } catch (e) {
    console.error('加载角色失败:', e);
    agentRoles = getMockAgentRoles();
    renderAgentRoles();
  }
}

function getMockAgentRoles() {
  return [
    { id: 'master', name: 'Master调度', description: '主调度Agent · 系统核心', category: '调度', icon: '🧠', color: '#dc2626', task_count: 1247, quality_score: 94.2, skills: ['task_split', 'dag_build', '调度分发'] },
    { id: 'code_agent', name: '代码开发Agent', description: 'Worker1 · 垂直专精', category: '代码', icon: '💻', color: '#2563eb', task_count: 856, quality_score: 91.7, skills: ['FastAPI', '代码生成', 'Code Review'] },
    { id: 'data_agent', name: '数据分析Agent', description: 'Worker2 · 垂直专精', category: '数据', icon: '📊', color: '#16a34a', task_count: 634, quality_score: 89.3, skills: ['Pandas', 'RFM分析', 'Sklearn'] },
    { id: 'vis_agent', name: '可视化Agent', description: 'Worker3 · 垂直专精', category: '可视化', icon: '📈', color: '#d97706', task_count: 412, quality_score: 87.8, skills: ['ECharts', 'Vue3', '仪表板设计'] },
    { id: 'general_agent', name: '通用专精Agent', description: 'WorkerN · 弹性扩容', category: '通用', icon: '🔧', color: '#8b5cf6', task_count: 89, quality_score: 82.1, skills: ['通用推理', '工具调用', '任务兜底'] },
    { id: 'review_agent', name: '独立评审Agent', description: '质量校验 · 防单点故障', category: '评审', icon: '🔍', color: '#ec4899', task_count: 321, quality_score: 96.5, skills: ['规划校验', '输出复核'] },
  ];
}

function renderAgentRoles() {
  const grid = document.getElementById('roleGrid');
  grid.innerHTML = '';
  document.getElementById('roleTotal').textContent = agentRoles.length;

  agentRoles.forEach(role => {
    const card = document.createElement('div');
    card.className = 'role-card';
    card.innerHTML = `
      <div class="role-card-topbar" style="background: ${role.color}"></div>
      <div class="role-card-body">
        <div class="role-header">
          <div class="role-avatar" style="background: ${hexToRgba(role.color, 0.1)}; color: ${role.color}">${role.icon}</div>
          <div class="role-info">
            <h4>${role.name}</h4>
            <div class="role-desc">${role.description}</div>
          </div>
        </div>
        <div class="role-stats">
          <div class="role-stat">📋 一级标签: ${role.category}</div>
          <div class="role-stat">📊 任务完成: ${role.task_count.toLocaleString()}次</div>
          <div class="role-stat">⭐ 质量评分: ${role.quality_score}%</div>
        </div>
        <div class="role-skills">
          ${role.skills.map(s => `<span class="skill-tag">${s}</span>`).join('')}
        </div>
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

// Skill管理
let allSkills = [];

async function loadSkills() {
  try {
    if (typeof window.__TAURI__ !== 'undefined') {
      allSkills = await window.__TAURI__.invoke('get_skills');
    } else {
      allSkills = getMockSkills();
    }
    filterSkills();
  } catch (e) {
    console.error('加载Skill失败:', e);
    allSkills = getMockSkills();
    filterSkills();
  }
}

function getMockSkills() {
  return [
    { id: 'fastapi-gen', name: 'FastAPI生成器', description: '生成FastAPI路由与Schema', category: '代码', version: 'v2.1.0', status: '活跃', icon: '⚡' },
    { id: 'pandas-analytics', name: 'Pandas数据分析', description: '数据清洗与聚合分析', category: '数据', version: 'v1.5.2', status: '活跃', icon: '🐼' },
    { id: 'echarts-dashboard', name: 'ECharts仪表板', description: '可视化图表生成', category: '可视化', version: 'v3.0.1', status: '待更新', icon: '📊' },
    { id: 'code-review', name: 'Code Review', description: '代码质量检查与评审', category: '代码', version: 'v1.0.0', status: '待更新', icon: '✅' },
    { id: 'rfm-segmentation', name: 'RFM用户分群', description: '用户价值RFM分析', category: '数据', version: 'v1.2.0', status: '活跃', icon: '📈' },
    { id: 'vue3-components', name: 'Vue3组件库', description: '前端UI组件生成', category: '可视化', version: 'v2.0.3', status: '活跃', icon: '🎨' },
    { id: 'dag-orchestration', name: 'DAG任务编排', description: '构建任务依赖DAG图', category: '调度', version: 'v1.3.0', status: '活跃', icon: '🧠' },
  ];
}

function filterSkills() {
  const search = document.getElementById('skillSearch').value.toLowerCase();
  const statusFilter = document.getElementById('statusFilter').value;
  const categoryFilter = document.getElementById('categoryFilter').value;

  const filtered = allSkills.filter(skill => {
    const matchSearch = !search || skill.name.toLowerCase().includes(search) || skill.category.toLowerCase().includes(search);
    const matchStatus = !statusFilter || skill.status === statusFilter;
    const matchCategory = !categoryFilter || skill.category === categoryFilter;
    return matchSearch && matchStatus && matchCategory;
  });

  renderSkills(filtered);
  updateSkillStats(filtered);
}

function renderSkills(skills) {
  const tbody = document.getElementById('skillTableBody');
  tbody.innerHTML = '';
  document.getElementById('skillTotal').textContent = allSkills.length;

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
      <td>
        <div class="action-links">
          <a onclick="alert('编辑Skill: ${skill.name}')">编辑</a>
          <a class="delete" onclick="if(confirm('确定删除 ${skill.name} 吗？')) alert('已删除')">删除</a>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function updateSkillStats(skills) {
  const total = allSkills.length;
  const active = allSkills.filter(s => s.status === '活跃').length;
  const pending = allSkills.filter(s => s.status === '待更新').length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statActive').textContent = active;
  document.getElementById('statPending').textContent = pending;
}

// 系统设置
async function loadSettings() {
  try {
    let config;
    if (typeof window.__TAURI__ !== 'undefined') {
      config = await window.__TAURI__.invoke('get_system_config');
    } else {
      config = getMockConfig();
    }
    document.getElementById('modelProvider').value = config.model_provider;
    document.getElementById('modelName').value = config.model_name;
    document.getElementById('apiKey').value = config.api_key;
    document.getElementById('apiBase').value = config.api_base;
    document.getElementById('claudePath').value = config.claude_path;
    document.getElementById('maxAgents').value = config.max_agents;
  } catch (e) {
    console.error('加载设置失败:', e);
  }
}

function getMockConfig() {
  return {
    model_provider: 'OpenAI',
    model_name: 'gpt-4-turbo',
    api_key: 'sk-************************',
    api_base: 'https://api.openai.com/v1/chat/completions',
    claude_path: '/usr/local/claude/bin/claude-server',
    max_agents: 8,
  };
}

async function saveSettings() {
  const config = {
    model_provider: document.getElementById('modelProvider').value,
    model_name: document.getElementById('modelName').value,
    api_key: document.getElementById('apiKey').value,
    api_base: document.getElementById('apiBase').value,
    claude_path: document.getElementById('claudePath').value,
    max_agents: parseInt(document.getElementById('maxAgents').value),
  };

  try {
    if (typeof window.__TAURI__ !== 'undefined') {
      const result = await window.__TAURI__.invoke('save_system_config', { config });
      alert(result.message || '保存成功');
    } else {
      alert('配置保存成功');
    }
  } catch (e) {
    console.error('保存失败:', e);
    alert('保存失败: ' + e);
  }
}

async function testModelConnection() {
  const statusEl = document.getElementById('modelTestStatus');
  statusEl.innerHTML = '<span class="status-dot pending"></span> 测试中...';
  statusEl.className = 'test-status warning';

  try {
    let result;
    if (typeof window.__TAURI__ !== 'undefined') {
      result = await window.__TAURI__.invoke('test_model_connection');
    } else {
      await new Promise(r => setTimeout(r, 1000));
      result = { success: true, message: '连接成功' };
    }
    if (result.success) {
      statusEl.innerHTML = '<span class="status-dot running"></span> 大模型 已连接';
      statusEl.className = 'test-status success';
    } else {
      statusEl.innerHTML = '<span class="status-dot pending"></span> 连接失败';
      statusEl.className = 'test-status warning';
    }
  } catch (e) {
    statusEl.innerHTML = '<span class="status-dot pending"></span> 测试异常';
    statusEl.className = 'test-status warning';
  }
}

async function testClaudeConnection() {
  const statusEl = document.getElementById('claudeTestStatus');
  statusEl.innerHTML = '<span class="status-dot pending"></span> 测试中...';
  statusEl.className = 'test-status warning';

  try {
    let result;
    if (typeof window.__TAURI__ !== 'undefined') {
      result = await window.__TAURI__.invoke('test_claude_connection');
    } else {
      await new Promise(r => setTimeout(r, 1200));
      result = { success: true, message: '连接成功' };
    }
    if (result.success) {
      statusEl.innerHTML = '<span class="status-dot running"></span> Claude 已连接';
      statusEl.className = 'test-status success';
    } else {
      statusEl.innerHTML = '<span class="status-dot pending"></span> 连接失败';
      statusEl.className = 'test-status warning';
    }
  } catch (e) {
    statusEl.innerHTML = '<span class="status-dot pending"></span> 测试异常';
    statusEl.className = 'test-status warning';
  }
}

// 系统状态
async function updateSystemStatus() {
  try {
    if (typeof window.__TAURI__ !== 'undefined') {
      const status = await window.__TAURI__.invoke('get_system_status');
      document.getElementById('agentCount').textContent = status.agent_count;
      document.getElementById('taskQueue').textContent = status.task_queue;
      document.getElementById('sessionId').textContent = status.session_id;
    }
  } catch (e) {
    // 静默失败
  }

  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/\//g, '-');
  const updateEls = document.querySelectorAll('#lastUpdate, #lastSync');
  updateEls.forEach(el => { if (el) el.textContent = timeStr; });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  renderMessages();
  updateSystemStatus();
  setInterval(updateSystemStatus, 30000);
});
