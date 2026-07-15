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

    document.getElementById('runModeSelect').value = config.run_mode || 'sdk';
    document.getElementById('runModeDisplay').textContent = `模式: ${(config.run_mode || 'sdk').toUpperCase()}`;
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
  };

  try {
    const result = await invoke('save_system_config', { config });
    if (result.success) {
      alert(`✅ ${result.message}\n路径: ${result.data || ''}`);
      systemConfig = config;
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
