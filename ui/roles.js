// ==================== 角色管理 ====================

let agentRoles = [];

// 根据 skill id 查找可读名称（纯技能）
function resolveSkillName(skillId) {
  for (const skill of allSkills) {
    if (skill.id === skillId && skill.category !== '插件') return skill.name;
  }
  return skillId;
}

// 根据 plugin id + sub skill id 查找可读名称，返回 "插件名:子技能名"
function resolvePluginSkillName(pluginId, subSkillId) {
  for (const skill of allSkills) {
    if (skill.id === pluginId && skill.sub_skills) {
      for (const sub of skill.sub_skills) {
        if (sub.id === subSkillId) return `${skill.name}:${sub.name}`;
      }
    }
  }
  return `${pluginId}:${subSkillId}`;
}

// 构建角色已绑定技能的完整展示列表
function buildRoleSkillDisplay(role) {
  const tags = [];

  // 纯技能
  (role.skills || []).forEach(skillId => {
    const name = resolveSkillName(skillId);
    tags.push(`<span class="skill-tag" title="${escapeHtml(skillId)}">${escapeHtml(name)}</span>`);
  });

  // 插件子技能
  (role.plugins || []).forEach(pb => {
    (pb.skills || []).forEach(subId => {
      const name = resolvePluginSkillName(pb.plugin, subId);
      const fullId = `${pb.plugin}:${subId}`;
      tags.push(`<span class="skill-tag plugin-tag" title="${escapeHtml(fullId)}">${escapeHtml(name)}</span>`);
    });
  });

  return tags;
}

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
    const skillTags = buildRoleSkillDisplay(role);

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
        ${skillTags.length > 0 ? `<div class="role-skills">${skillTags.join('')}</div>` : '<div class="role-skills"><span class="skill-tag muted">无绑定技能</span></div>'}
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

  // 拆分技能和插件
  const plainSkills = allSkills.filter(s => s.category !== '插件');
  const plugins = allSkills.filter(s => s.category === '插件');
  const roleSkills = role.skills || [];
  const rolePlugins = role.plugins || [];

  // 构建 rolePlugins 快查表: pluginId -> Set<subSkillId>
  const pluginBindMap = {};
  rolePlugins.forEach(pb => { pluginBindMap[pb.plugin] = new Set(pb.skills || []); });

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
        <div class="form-group">
          <label>绑定技能</label>
          <div class="skill-checkbox-list" id="editRoleSkills">
            ${plainSkills.map(skill => `
              <label class="skill-checkbox-item">
                <input type="checkbox" class="role-skill-cb" value="${escapeHtml(skill.id)}" ${roleSkills.includes(skill.id) ? 'checked' : ''} />
                <span class="skill-checkbox-icon">${skill.icon || '🔧'}</span>
                <span class="skill-checkbox-name">${escapeHtml(skill.name)}</span>
              </label>
            `).join('')}
            ${plainSkills.length === 0 ? '<div class="skill-tag muted">暂无可用技能</div>' : ''}
          </div>
        </div>
        <div class="form-group">
          <label>绑定插件</label>
          <div class="plugin-bind-list" id="editRolePlugins">
            ${plugins.map(plugin => {
              const hasSubSkills = plugin.sub_skills && plugin.sub_skills.length > 0;
              const boundSubs = pluginBindMap[plugin.id] || new Set();
              return `
                <div class="plugin-bind-item">
                  <div class="plugin-bind-header">
                    <button class="expand-btn" onclick="togglePluginBind('${plugin.id}')" title="展开子技能"><span class="expand-arrow" id="plugin-arrow-${plugin.id}">▶</span></button>
                    <span class="skill-checkbox-icon">🔌</span>
                    <span class="skill-checkbox-name">${escapeHtml(plugin.name)}</span>
                    ${hasSubSkills ? `<button class="select-all-btn" onclick="selectAllSubSkills('${plugin.id}')">全选</button>` : ''}
                  </div>
                  ${hasSubSkills ? `
                    <div class="plugin-sub-skills" id="plugin-subs-${plugin.id}" style="display:none">
                      ${plugin.sub_skills.map(sub => `
                        <label class="skill-checkbox-item sub-skill-cb-item">
                          <input type="checkbox" class="plugin-sub-cb" data-plugin="${escapeHtml(plugin.id)}" value="${escapeHtml(sub.id)}" ${boundSubs.has(sub.id) ? 'checked' : ''} />
                          <span class="skill-checkbox-icon">${sub.icon || '📎'}</span>
                          <span class="skill-checkbox-name">${escapeHtml(sub.name)}</span>
                        </label>
                      `).join('')}
                    </div>
                  ` : '<div class="plugin-sub-skills-empty">该插件无子技能</div>'}
                </div>
              `;
            }).join('')}
            ${plugins.length === 0 ? '<div class="skill-tag muted">暂无可用插件</div>' : ''}
          </div>
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

  // 收集绑定的技能（非插件）
  const skillCbs = document.querySelectorAll('#editRoleSkills .role-skill-cb');
  const selectedSkills = Array.from(skillCbs).filter(cb => cb.checked).map(cb => cb.value);

  // 收集绑定的插件子技能，按插件分组构建 {plugin, skills} 结构
  const pluginCbs = document.querySelectorAll('#editRolePlugins .plugin-sub-cb');
  const pluginGroups = {};
  pluginCbs.forEach(cb => {
    if (cb.checked) {
      const pluginId = cb.dataset.plugin;
      if (!pluginGroups[pluginId]) pluginGroups[pluginId] = [];
      pluginGroups[pluginId].push(cb.value);
    }
  });
  const selectedPlugins = Object.entries(pluginGroups).map(([plugin, skills]) => ({ plugin, skills }));

  if (!name) {
    showToast('名称不能为空', 'error');
    return;
  }

  agentRoles[index].name = name;
  agentRoles[index].description = desc;
  agentRoles[index].system_prompt = prompt;
  agentRoles[index].skills = selectedSkills;
  agentRoles[index].plugins = selectedPlugins;

  await saveAgentRoles();
  renderAgentRoles();
  closeRoleEditor();
}

// ==================== 插件绑定展开/全选 ====================

function togglePluginBind(pluginId) {
  const subsEl = document.getElementById(`plugin-subs-${pluginId}`);
  const arrow = document.getElementById(`plugin-arrow-${pluginId}`);
  if (!subsEl) return;

  const isExpanded = subsEl.style.display !== 'none';
  subsEl.style.display = isExpanded ? 'none' : '';

  if (arrow) {
    arrow.textContent = isExpanded ? '▶' : '▼';
    arrow.classList.toggle('expanded', !isExpanded);
  }
}

function selectAllSubSkills(pluginId) {
  const cbs = document.querySelectorAll(`.plugin-sub-cb[data-plugin="${CSS.escape(pluginId)}"]`);
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !allChecked; });
}
