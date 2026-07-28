// ==================== 系统设置 ====================

async function loadSettings() {
  try {
    const config = await invoke('get_system_config', {});
    systemConfig = config;
    document.getElementById('modelProvider').value = 'Anthropic';
    document.getElementById('modelName').value = config.model_name || '';
    document.getElementById('apiKey').value = config.api_key || '';
    document.getElementById('apiBase').value = config.api_base || '';
    document.getElementById('claudePath').value = config.claude_path || 'claude';
    document.getElementById('claudeUrl').value = config.claude_url || '.claude';
    document.getElementById('maxAgents').value = config.max_agents || 8;
    document.getElementById('runModeCfg').value = config.run_mode || 'sdk';
    document.getElementById('permissionMode').value = config.permission_mode || 'ask';
    document.getElementById('permissionTimeout').value = config.permission_timeout_ms || 120;
    window.permissionTimeoutMs = (config.permission_timeout_ms || 120) * 1000;

    // 任务执行配置
    document.getElementById('arbitrationMode').value = config.arbitration_mode || 'confidence_vote';
    document.getElementById('sameLayerAsync').value = String(config.same_layer_async !== undefined ? config.same_layer_async : true);
    document.getElementById('maxConcurrency').value = config.max_concurrency || 5;
    document.getElementById('taskTimeout').value = Math.round((config.task_timeout_ms || 600000) / 1000);

    document.getElementById('runModeSelect').value = config.run_mode || 'sdk';
    document.getElementById('permissionModeSelect').value = config.permission_mode || 'ask';
    document.getElementById('runModeDisplay').textContent = `模式: ${(config.run_mode || 'sdk').toUpperCase()} | 权限: ${(config.permission_mode || 'ask').toUpperCase()}`;
  } catch (e) {
    showToast('加载设置失败: ' + e, 'error');
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
    permission_mode: document.getElementById('permissionMode').value,
    permission_timeout_ms: parseInt(document.getElementById('permissionTimeout').value) || 120,
    arbitration_mode: document.getElementById('arbitrationMode').value,
    same_layer_async: document.getElementById('sameLayerAsync').value === 'true',
    max_concurrency: parseInt(document.getElementById('maxConcurrency').value) || 5,
    task_timeout_ms: (parseInt(document.getElementById('taskTimeout').value) || 600) * 1000,
  };

  try {
    const result = await invoke('save_system_config', { config });
    if (result.success) {
      alert(`✅ ${result.message}\n路径: ${result.data || ''}`);
      systemConfig = config;
      document.getElementById('runModeSelect').value = config.run_mode;
      document.getElementById('permissionModeSelect').value = config.permission_mode;
      document.getElementById('runModeDisplay').textContent = `模式: ${config.run_mode.toUpperCase()} | 权限: ${config.permission_mode.toUpperCase()}`;
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

// ==================== 项目知识管理 ====================

/** 当前选中的项目ID（默认为当前会话的 sessionId） */
function currentProjectId() {
  if (typeof currentSession === 'function' && currentSession()) {
    return currentSession().sessionId || '__global__';
  }
  return '__global__';
}

async function loadProjectKnowledge() {
  const projectId = currentProjectId();
  const listEl = document.getElementById('knowledgeList');
  if (!listEl) return;

  try {
    const items = await invoke('get_project_knowledge', { projectId });
    if (items.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无项目知识，点击下方按钮添加</div>';
    } else {
      listEl.innerHTML = items.map(item => `
        <div class="knowledge-item" data-id="${item.id}">
          <div class="knowledge-item-header">
            <span class="knowledge-category">${categoryLabel(item.category)}</span>
            <span class="knowledge-source">${item.source === 'auto_extracted' ? '自动提取' : '手动添加'}</span>
          </div>
          <div class="knowledge-title">${escapeHtml(item.title)}</div>
          <div class="knowledge-content">${escapeHtml(item.content)}</div>
          <div class="knowledge-item-actions">
            <button class="btn-sm" onclick="editKnowledge('${item.id}')">编辑</button>
            <button class="btn-sm btn-danger" onclick="deleteKnowledge('${item.id}')">删除</button>
          </div>
        </div>
      `).join('');
    }
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state error">加载失败: ${e}</div>`;
  }

  // 更新记忆统计
  try {
    const stats = await invoke('get_memory_stats', { projectId });
    const statsEl = document.getElementById('memoryStats');
    if (statsEl) {
      statsEl.textContent = `经验: ${stats.experience_count} | 知识: ${stats.knowledge_count} | 画像: ${stats.worker_profile_count}`;
    }
  } catch { /* ignore */ }
}

function categoryLabel(cat) {
  const labels = {
    convention: '约定',
    tech_stack: '技术栈',
    structure: '架构',
    preference: '偏好',
  };
  return labels[cat] || cat;
}

function addKnowledge() {
  const projectId = currentProjectId();
  const title = prompt('知识标题:');
  if (!title) return;
  const content = prompt('知识内容:');
  if (!content) return;
  const category = prompt('分类 (convention/tech_stack/structure/preference):', 'convention') || 'convention';

  invoke('add_project_knowledge', {
    request: { project_id: projectId, category, title, content }
  }).then(result => {
    if (result.success) {
      showToast('知识添加成功');
      loadProjectKnowledge();
    } else {
      showToast('添加失败: ' + result.message, 'error');
    }
  }).catch(e => showToast('添加失败: ' + e, 'error'));
}

async function editKnowledge(id) {
  const items = await invoke('get_project_knowledge', { projectId: currentProjectId() });
  const item = items.find(i => i.id === id);
  if (!item) return;

  const title = prompt('知识标题:', item.title);
  if (!title) return;
  const content = prompt('知识内容:', item.content);
  if (!content) return;

  invoke('update_project_knowledge', {
    request: { id, title, content }
  }).then(result => {
    if (result.success) {
      showToast('更新成功');
      loadProjectKnowledge();
    } else {
      showToast('更新失败: ' + result.message, 'error');
    }
  }).catch(e => showToast('更新失败: ' + e, 'error'));
}

function deleteKnowledge(id) {
  if (!confirm('确定删除该知识条目？')) return;

  invoke('delete_project_knowledge', { id }).then(result => {
    if (result.success) {
      showToast('删除成功');
      loadProjectKnowledge();
    } else {
      showToast('删除失败: ' + result.message, 'error');
    }
  }).catch(e => showToast('删除失败: ' + e, 'error'));
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
