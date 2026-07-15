// ==================== Skill 管理 ====================

let allSkills = [];

async function loadSkillsFromConfig() {
  try {
    const skills = await invoke('get_skills', {});
    if (Array.isArray(skills) && skills.length > 0) {
      allSkills = skills;
      filterSkills();
    }
  } catch (e) {
    showToast('从配置加载技能失败: ' + e, 'error');
  }
}

async function loadSkills() {
  const claudeDirInput = document.getElementById('claudeUrl');
  const claudeDir = claudeDirInput?.value || systemConfig?.claude_url || '.claude';

  if (!claudeDir || claudeDir.trim() === '') {
    alert('❌ 请先在系统设置中配置 Claude 目录路径');
    return;
  }

  alert(`⏳ 正在从 Claude 目录加载技能...\n目录: ${claudeDir.trim()}`);

  try {
    const result = await invoke('get_skills_from_claude', { claudeDir: claudeDir.trim() });

    if (result.success && result.data) {
      try {
        const jsonData = JSON.parse(result.data);
        allSkills = parseClaudeSkills(jsonData);
        alert(`✅ 加载完毕！成功加载 ${allSkills.length} 个技能`);
      } catch (parseErr) {
        allSkills = [];
        alert('❌ 解析技能数据失败: ' + parseErr.message);
      }
    } else {
      allSkills = [];
      alert('❌ 加载失败: ' + (result.message || '未知错误'));
    }
    filterSkills();
  } catch (e) {
    showToast('加载技能失败: ' + e.message, 'error');
    allSkills = [];
    filterSkills();
    alert('❌ 加载异常: ' + e.message);
  }
}

async function saveSkills() {
  try {
    const skillsJson = JSON.stringify(allSkills);
    const result = await invoke('save_skills_to_file', { skillsJson });
    if (result.success) {
      showToast('技能保存成功', 'success');
    } else {
      showToast(result.message || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存技能失败: ' + e.message, 'error');
  }
}

function parseClaudeSkills(data) {
  if (!data) return [];

  let skills = [];
  if (Array.isArray(data)) {
    skills = data;
  } else if (data.skills && Array.isArray(data.skills)) {
    skills = data.skills;
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
  try {
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
  } catch (e) {
    showToast('筛选技能异常: ' + e.message, 'error');
  }
}

function renderSkills(skills) {
  const tbody = document.getElementById('skillTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  document.getElementById('statTotal').textContent = allSkills.length;

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
  document.getElementById('statTotal').textContent = allSkills.length;
  document.getElementById('statActive').textContent = allSkills.filter(s => s.status === '活跃').length;
  document.getElementById('statPending').textContent = allSkills.filter(s => s.status === '待更新').length;
}
