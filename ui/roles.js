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

async function saveAgentRoles() {
  try {
    const rolesJson = JSON.stringify(agentRoles);
    const result = await invoke('save_agent_roles', { rolesJson });
    if (result.success) {
      showToast('角色保存成功', 'success');
    } else {
      showToast(result.message || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存角色失败: ' + e.message, 'error');
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

  agentRoles.forEach((role, index) => {
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
            <h4>${escapeHtml(role.name)}</h4>
            <div class="role-desc">${escapeHtml(role.description)}</div>
          </div>
          <button class="edit-btn" onclick="openRoleEditor(${index})" title="编辑">✏️</button>
        </div>
        <div class="role-stats">
          <div class="role-stat">📋 ID: ${role.id}</div>
          ${role.task_count ? `<div class="role-stat">📊 任务完成: ${role.task_count}次</div>` : ''}
          ${role.last_active ? `<div class="role-stat">⏱ 最后活跃: ${role.last_active}</div>` : ''}
        </div>
        ${role.skills && role.skills.length > 0 ? `
          <div class="role-skills">
            ${role.skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
          </div>
        ` : '<div class="role-skills"><span class="skill-tag muted">无绑定技能</span></div>'}
        ${role.system_prompt ? `<details class="role-prompt"><summary>查看系统提示词</summary><pre>${escapeHtml(role.system_prompt)}</pre></details>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

// ==================== 角色编辑弹窗 ====================

function openRoleEditor(index) {
  const role = agentRoles[index];
  if (!role) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'roleEditOverlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeRoleEditor(); };

  overlay.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header">
        <h3>编辑角色</h3>
        <button class="modal-close" onclick="closeRoleEditor()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>角色ID（不可修改）</label>
          <input type="text" class="form-input" value="${escapeHtml(role.id)}" disabled />
        </div>
        <div class="form-group">
          <label>名称</label>
          <input type="text" class="form-input" id="editRoleName" value="${escapeHtml(role.name)}" />
        </div>
        <div class="form-group">
          <label>描述</label>
          <textarea class="form-textarea" id="editRoleDesc" rows="3">${escapeHtml(role.description)}</textarea>
        </div>
        <div class="form-group">
          <label>系统提示词</label>
          <textarea class="form-textarea" id="editRolePrompt" rows="6">${escapeHtml(role.system_prompt || '')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-outline" onclick="closeRoleEditor()">取消</button>
        <button class="btn-primary" onclick="saveRoleEdit(${index})">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
}

function closeRoleEditor() {
  const overlay = document.getElementById('roleEditOverlay');
  if (overlay) overlay.remove();
}

async function saveRoleEdit(index) {
  const name = document.getElementById('editRoleName').value.trim();
  const desc = document.getElementById('editRoleDesc').value.trim();
  const prompt = document.getElementById('editRolePrompt').value.trim();

  if (!name) {
    showToast('名称不能为空', 'error');
    return;
  }

  agentRoles[index].name = name;
  agentRoles[index].description = desc;
  agentRoles[index].system_prompt = prompt;

  await saveAgentRoles();
  renderAgentRoles();
  closeRoleEditor();
}
