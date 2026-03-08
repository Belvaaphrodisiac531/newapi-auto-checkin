// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  renderSites();
  setupEventListeners();
});

function setupEventListeners() {
  document.getElementById('checkInBtn').addEventListener('click', handleManualCheckIn);
  document.getElementById('showAddBtn').addEventListener('click', () => {
    document.getElementById('addForm').classList.toggle('show');
    document.getElementById('newDomain').focus();
  });
  document.getElementById('confirmAddBtn').addEventListener('click', handleAddSite);
  document.getElementById('cancelAddBtn').addEventListener('click', () => {
    document.getElementById('addForm').classList.remove('show');
    document.getElementById('newDomain').value = '';
  });
  document.getElementById('newDomain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSite();
  });

  // 导出/导入
  document.getElementById('exportBtn').addEventListener('click', handleExport);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', handleImport);
}

// 加载签到状态
function loadStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) updateStats(response.checkInResults || {});
    if (response?.lastCheckInTime) {
      document.getElementById('lastCheck').textContent =
        `上次签到: ${formatDateTime(new Date(response.lastCheckInTime))}`;
    }
  });
}

// 渲染站点列表
async function renderSites(results) {
  const sites = await loadRawSites();
  const sitesList = document.getElementById('sitesList');
  sitesList.innerHTML = '';

  document.getElementById('totalSites').textContent = sites.filter(s => s.enabled !== false).length;

  // 如果没传 results，从 storage 读取上次结果
  if (!results) {
    const data = await chrome.storage.local.get('checkInResults');
    results = data.checkInResults || {};
  }

  sites.forEach((site, index) => {
    const siteId = site.domain.replace(/\./g, '_');
    const result = results[siteId];
    const enabled = site.enabled !== false;

    const item = document.createElement('div');
    item.className = 'site-item';
    if (!enabled) item.style.opacity = '0.5';

    // 开关
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle';
    toggle.checked = enabled;
    toggle.title = enabled ? '点击禁用' : '点击启用';
    toggle.addEventListener('change', () => toggleSite(index, toggle.checked));

    // 站点名
    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = site.name || site.domain;

    // 状态
    const status = document.createElement('span');
    status.className = 'site-status';
    if (result) {
      if (result.status === 'success') {
        status.classList.add('success');
        status.textContent = '成功';
      } else if (result.status === 'already') {
        status.classList.add('already');
        status.textContent = '已签';
      } else {
        status.classList.add('failed');
        status.textContent = '失败';
      }
    } else {
      status.classList.add('pending');
      status.textContent = enabled ? '待签' : '禁用';
    }

    // 删除按钮
    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '\u00d7';
    del.title = '删除站点';
    del.addEventListener('click', () => removeSite(index));

    item.appendChild(toggle);
    item.appendChild(name);
    item.appendChild(status);
    item.appendChild(del);
    sitesList.appendChild(item);
  });
}

// 更新统计数字
function updateStats(results) {
  const vals = Object.values(results);
  document.getElementById('successCount').textContent = vals.filter(r => r.status === 'success').length;
  document.getElementById('alreadyCount').textContent = vals.filter(r => r.status === 'already').length;
  document.getElementById('failedCount').textContent = vals.filter(r => r.status === 'failed').length;
}

// 添加站点
async function handleAddSite() {
  const input = document.getElementById('newDomain');
  let domain = input.value.trim().toLowerCase();

  // 清理输入：去掉协议和路径
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  if (!domain || !domain.includes('.')) {
    alert('请输入有效的域名，如 example.com');
    return;
  }

  const sites = await loadRawSites();
  if (sites.some(s => s.domain === domain)) {
    alert('该站点已存在');
    return;
  }

  sites.push({ domain, name: domain, enabled: true });
  await saveSitesConfig(sites);

  input.value = '';
  document.getElementById('addForm').classList.remove('show');
  renderSites();
}

// 切换启用/禁用
async function toggleSite(index, enabled) {
  const sites = await loadRawSites();
  if (sites[index]) {
    sites[index].enabled = enabled;
    await saveSitesConfig(sites);
    renderSites();
  }
}

// 删除站点
async function removeSite(index) {
  const sites = await loadRawSites();
  const site = sites[index];
  if (!site) return;

  if (!confirm(`确定删除 ${site.domain}？`)) return;

  sites.splice(index, 1);
  await saveSitesConfig(sites);
  renderSites();
}

// 手动签到
async function handleManualCheckIn() {
  const btn = document.getElementById('checkInBtn');
  const btnText = document.getElementById('btnText');

  btn.disabled = true;
  btnText.textContent = '签到中...';
  showLoading();

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'manualCheckIn' }, (response) => {
        if (response?.success) resolve(response.results);
        else reject(new Error(response?.error || '签到失败'));
      });
    });

    updateStats(response);
    renderSites(response);
    document.getElementById('lastCheck').textContent = `上次签到: ${formatDateTime(new Date())}`;
  } catch (error) {
    alert('签到失败: ' + error.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = '立即签到';
  }
}

function showLoading() {
  document.getElementById('sitesList').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div>正在签到...</div>
    </div>
  `;
}

function formatDateTime(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${m}-${d} ${h}:${min}`;
}

// 导出配置
async function handleExport() {
  const sites = await loadRawSites();

  const config = {
    version: '1.0',
    exportTime: new Date().toISOString(),
    sites: sites
  };

  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `checkin-sites-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 导入配置
async function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const config = JSON.parse(text);

    // 验证配置格式
    if (!config.sites || !Array.isArray(config.sites)) {
      alert('配置文件格式错误');
      return;
    }

    // 验证每个站点的格式
    const validSites = config.sites.filter(site => {
      return site.domain && typeof site.domain === 'string';
    });

    if (validSites.length === 0) {
      alert('配置文件中没有有效的站点');
      return;
    }

    // 询问是否覆盖
    const currentSites = await loadRawSites();
    let confirmMsg = `将导入 ${validSites.length} 个站点`;
    if (currentSites.length > 0) {
      confirmMsg += `\n当前有 ${currentSites.length} 个站点，是否覆盖？\n\n点击"确定"覆盖，点击"取消"合并`;
    }

    const shouldReplace = confirm(confirmMsg);

    let finalSites;
    if (shouldReplace || currentSites.length === 0) {
      // 覆盖模式
      finalSites = validSites;
    } else {
      // 合并模式：去重
      const existingDomains = new Set(currentSites.map(s => s.domain));
      const newSites = validSites.filter(s => !existingDomains.has(s.domain));
      finalSites = [...currentSites, ...newSites];

      if (newSites.length === 0) {
        alert('所有站点都已存在，无需导入');
        return;
      }
      alert(`成功导入 ${newSites.length} 个新站点`);
    }

    await saveSitesConfig(finalSites);
    renderSites();
  } catch (error) {
    alert('导入失败: ' + error.message);
  } finally {
    // 清空文件选择
    event.target.value = '';
  }
}
