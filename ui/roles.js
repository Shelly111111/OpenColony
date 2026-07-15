// ==================== 角色管理 ====================

let agentRoles = [];

async function loadAgentRoles() {
  const grid = document.getElementById('roleGrid');
  try {
    agentRoles = await invoke('get_agent_roles', {});
    renderAgentRoles();
  } catch (e) {
    showToast('加载角色失败: ' + e, 'error');
    grid.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }
}

function renderAgentRoles() {
  const grid = document.getElementById('roleGrid');
  grid.innerHTML = '';
  document.getElementById('roleTotal').textContent = agentRoles.length;

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
