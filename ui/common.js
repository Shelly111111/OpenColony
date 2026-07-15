// ==================== 公共工具 ====================

// Tauri invoke 封装
async function invoke(cmd, args) {
  if (typeof window.__TAURI__ !== 'undefined') {
    return await window.__TAURI__.invoke(cmd, args);
  }
  throw new Error('Tauri 未就绪（请在 Tauri 环境中运行）');
}

// 全局配置变量
let systemConfig = null;

// ==================== 页面切换 ====================

function switchPage(pageName) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`);
  });

  if (pageName === 'roles') loadAgentRoles();
  else if (pageName === 'settings') loadSettings();
  else if (pageName === 'tasks') loadTaskList();
  else if (pageName === 'skills') loadSkillsFromConfig();
}

// ==================== 通用工具函数 ====================

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

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ==================== 系统状态刷新 ====================

async function updateSystemStatus() {
  try {
    const status = await invoke('get_system_status', {});
    document.getElementById('agentCount').textContent = status.agent_count;
    document.getElementById('taskQueue').textContent = status.task_queue;
    document.getElementById('sessionId').textContent = status.session_id;

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
  document.querySelectorAll('#lastUpdate, #lastSync').forEach(el => { if (el) el.textContent = timeStr; });
}

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', () => {
  renderMessages();
  loadSettings();
  updateSystemStatus();
  if (typeof initSchedulerListeners === 'function') initSchedulerListeners();
  setInterval(updateSystemStatus, 5000);
});
