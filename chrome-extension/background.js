// 导入配置
importScripts('config.js');

// 安装时初始化
chrome.runtime.onInstalled.addListener(() => {
  console.log('多网站自动签到助手已安装');

  chrome.alarms.create('dailyCheckIn', {
    when: getNextCheckInTime(),
    periodInMinutes: 24 * 60
  });

  chrome.storage.local.set({
    lastCheckInTime: null,
    checkInResults: {}
  });
});

// 监听定时器
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyCheckIn') {
    console.log('开始执行定时签到');
    executeAllCheckIns();
  }
});

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'manualCheckIn') {
    executeAllCheckIns().then(results => {
      sendResponse({ success: true, results });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'getStatus') {
    chrome.storage.local.get(['lastCheckInTime', 'checkInResults'], (data) => {
      sendResponse(data);
    });
    return true;
  }
});

// 执行所有站点签到
async function executeAllCheckIns() {
  console.log('开始批量签到');
  const results = {};
  const sites = await loadSitesConfig();
  const enabledSites = sites.filter(s => s.enabled);
  const total = enabledSites.length;
  let current = 0;

  // 设置初始badge
  chrome.action.setBadgeBackgroundColor({ color: '#667eea' });
  chrome.action.setBadgeText({ text: '0/' + total });

  for (const site of sites) {
    if (!site.enabled) {
      console.log(`跳过禁用站点: ${site.siteName}`);
      continue;
    }

    current++;
    // 更新badge进度
    chrome.action.setBadgeText({ text: `${current}/${total}` });

    try {
      console.log(`开始签到: ${site.siteName}`);
      const result = await checkInSite(site);
      results[site.siteId] = result;
      console.log(`${site.siteName} 签到结果:`, result);
    } catch (error) {
      console.error(`${site.siteName} 签到失败:`, error);
      results[site.siteId] = {
        status: 'failed',
        message: error.message
      };
    }

    await sleep(2000);
  }

  chrome.storage.local.set({
    lastCheckInTime: new Date().toISOString(),
    checkInResults: results
  });

  // 显示最终结果badge
  const successCount = Object.values(results).filter(r => r.status === 'success').length;
  const alreadyCount = Object.values(results).filter(r => r.status === 'already').length;
  const failedCount = Object.values(results).filter(r => r.status === 'failed').length;

  if (failedCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#dc3545' });
    chrome.action.setBadgeText({ text: '✗' + failedCount });
  } else if (successCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#28a745' });
    chrome.action.setBadgeText({ text: '✓' });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#17a2b8' });
    chrome.action.setBadgeText({ text: '✓' });
  }

  // 5秒后清除badge
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
  }, 5000);

  return results;
}

// 单个站点签到
async function checkInSite(site) {
  // 1. 优先使用缓存的认证头
  let authHeaders = await getCachedHeaders(site.siteId);
  let tabToCleanup = null;

  if (authHeaders) {
    console.log(`${site.siteName} 使用缓存认证头`);
  } else {
    // 没有缓存，先尝试自动 OAuth 登录
    console.log(`${site.siteName} 无缓存认证头，尝试自动 OAuth 登录...`);
    const oauthResult = await autoOAuthLogin(site.cookieDomain);

    if (oauthResult) {
      authHeaders = oauthResult.headers;
      await cacheHeaders(site.siteId, authHeaders);
      tabToCleanup = oauthResult.tabId;
      console.log(`${site.siteName} OAuth 登录成功`);
    } else {
      // OAuth 失败，回退到标签页捕获
      console.log(`${site.siteName} OAuth 失败，尝试从已有标签页捕获...`);
      const tab = await getOrCreateTab(site.cookieDomain);
      console.log(`${site.siteName} 使用标签页 ${tab.id} (${tab.url})`);

      authHeaders = await captureAuthHeaders(site.cookieDomain, tab.id);
      if (!authHeaders || Object.keys(authHeaders).length === 0) {
        if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
        throw new Error('无法捕获认证头，请先登录 linux.do 后重试');
      }
      await cacheHeaders(site.siteId, authHeaders);
      if (tab._autoCreated) tabToCleanup = tab.id;
    }
  }

  // 2. 执行签到
  const execResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, authHeaders);
  console.log(`${site.siteName} 签到响应:`, execResult);

  // 3. 检测 Cloudflare 错误（cf_clearance 过期或被拦截）
  const isCloudflareError =
    (execResult.httpStatus === 403 && (execResult.error?.includes('Just a moment') || execResult.error?.includes('<!DOCTYPE html>'))) ||
    (execResult.error?.includes('<!DOCTYPE') && execResult.error?.includes('is not valid JSON'));

  if (isCloudflareError) {
    console.log(`${site.siteName} 检测到 Cloudflare 防护，清除缓存并重新登录...`);
    await clearCachedHeaders(site.siteId);

    const oauthResult = await autoOAuthLogin(site.cookieDomain);
    if (oauthResult) {
      // 标记该站点需要在标签页中执行（绕过 Cloudflare）
      oauthResult.headers._needsTabExecution = true;
      await cacheHeaders(site.siteId, oauthResult.headers);
      const retryResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, oauthResult.headers);
      console.log(`${site.siteName} OAuth 重试签到响应:`, retryResult);

      try { await chrome.tabs.remove(oauthResult.tabId); } catch (e) {}
      if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}
      return formatResult(retryResult);
    }

    // OAuth 失败，回退到标签页捕获
    const tab = await getOrCreateTab(site.cookieDomain);
    const freshHeaders = await captureAuthHeaders(site.cookieDomain, tab.id);

    if (freshHeaders && Object.keys(freshHeaders).length > 0) {
      // 标记该站点需要在标签页中执行（绕过 Cloudflare）
      freshHeaders._needsTabExecution = true;
      await cacheHeaders(site.siteId, freshHeaders);
      const retryResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, freshHeaders);
      console.log(`${site.siteName} 重试签到响应:`, retryResult);
      if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
      if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}
      return formatResult(retryResult);
    }

    if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
    if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}
    throw new Error('Cloudflare 验证失败，重新登录失败');
  }

  // 4. 如果 401，尝试 OAuth 重新登录
  if (execResult.httpStatus === 401) {
    console.log(`${site.siteName} 认证过期，尝试 OAuth 重新登录...`);
    await clearCachedHeaders(site.siteId);

    const oauthResult = await autoOAuthLogin(site.cookieDomain);
    if (oauthResult) {
      await cacheHeaders(site.siteId, oauthResult.headers);
      const retryResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, oauthResult.headers);
      console.log(`${site.siteName} OAuth 重试签到响应:`, retryResult);

      try { await chrome.tabs.remove(oauthResult.tabId); } catch (e) {}
      if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}
      return formatResult(retryResult);
    }

    // OAuth 失败，回退到标签页捕获
    const tab = await getOrCreateTab(site.cookieDomain);
    const freshHeaders = await captureAuthHeaders(site.cookieDomain, tab.id);

    if (freshHeaders && Object.keys(freshHeaders).length > 0) {
      await cacheHeaders(site.siteId, freshHeaders);
      const retryResult = await doCheckInRequest(site.signExecUrl, site.signExecMethod, site.signExecParams, freshHeaders);
      console.log(`${site.siteName} 重试签到响应:`, retryResult);
      if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
      if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}
      return formatResult(retryResult);
    }

    if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
    if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}
    throw new Error('认证已过期，OAuth 重新登录失败');
  }

  // 4. 查询验证
  let queryVerified = false;
  const isSuccess = execResult.success || execResult.alreadyCheckedIn;
  if (site.signQueryUrl && isSuccess) {
    await sleep(1000);
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const queryUrl = `${site.signQueryUrl}?month=${currentMonth}`;
      const queryResult = await doFetchWithHeaders(queryUrl, 'GET', null, authHeaders);
      queryVerified = queryResult.data?.data?.stats?.checked_in_today || false;
    } catch (e) {
      console.warn(`${site.siteName} 查询失败:`, e);
    }
  }

  if (tabToCleanup) try { await chrome.tabs.remove(tabToCleanup); } catch (e) {}

  const result = formatResult(execResult);
  result.queryVerified = queryVerified;
  return result;
}

function formatResult(execResult) {
  if (execResult.error) {
    return { status: 'failed', message: execResult.error };
  }
  if (execResult.alreadyCheckedIn) {
    return { status: 'already', message: execResult.message };
  }
  return {
    status: execResult.success ? 'success' : 'failed',
    message: execResult.message
  };
}

// 通过 webRequest 捕获页面真实请求头
function captureAuthHeaders(domain, tabId) {
  return new Promise(async (resolve) => {
    let resolved = false;

    function onCapture(headers) {
      if (resolved) return;
      resolved = true;
      chrome.webRequest.onSendHeaders.removeListener(listener);
      headers._tabId = tabId; // 保存tabId用于后续在标签页中执行请求
      resolve(headers);
    }

    function listener(details) {
      if (resolved || details.tabId !== tabId) return;

      const headers = {};
      for (const h of (details.requestHeaders || [])) {
        headers[h.name] = h.value;
      }

      console.log(`[webRequest] 捕获到 ${details.url} 的请求头:`, Object.keys(headers));
      onCapture(headers);
    }

    // 监听目标域名的 API 请求
    chrome.webRequest.onSendHeaders.addListener(
      listener,
      { urls: [`https://${domain}/api/*`], tabId: tabId },
      ['requestHeaders', 'extraHeaders']
    );

    // 检查当前URL，如果是登录页面，先导航到登录页
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && (tab.url.includes('/login') || tab.url.includes('expired=true'))) {
        console.log(`[webRequest] 标签页在登录页面，先导航到登录页...`);
        await chrome.tabs.update(tabId, { url: `https://${domain}/login` });
        await sleep(20000); // 等待Cloudflare验证完成（20秒）
      }
    } catch (e) {
      console.warn('检查标签页URL失败:', e);
    }

    // 刷新页面以触发 API 请求
    console.log(`[webRequest] 刷新标签页 ${tabId} 以捕获请求头...`);
    try {
      await chrome.tabs.reload(tabId);
    } catch (e) {
      console.warn('刷新标签页失败:', e);
    }

    // 等待页面加载完成 + API 请求发出（增加到25秒）
    await sleep(25000);

    // 超时
    if (!resolved) {
      resolved = true;
      chrome.webRequest.onSendHeaders.removeListener(listener);
      console.warn(`[webRequest] 超时未捕获到 ${domain} 的 API 请求`);
      resolve(null);
    }
  });
}

// 用捕获的头发起签到请求（从 service worker 发起）
async function doCheckInRequest(url, method, params, capturedHeaders) {
  // 优先使用 service worker fetch（更快），只有在需要时才使用标签页
  // 如果有 _needsTabExecution 标记，说明该站点需要在标签页中执行
  const needsTabExecution = capturedHeaders._needsTabExecution;
  let tabId = capturedHeaders._tabId;

  // 检查标签页是否存在
  if (tabId && needsTabExecution) {
    try {
      await chrome.tabs.get(tabId);
      // 标签页存在，可以使用
    } catch (e) {
      // 标签页不存在，移除 tabId
      console.log(`[fetch-in-tab] 标签页 ${tabId} 不存在，回退到 service worker fetch`);
      tabId = null;
    }
  }

  if (tabId && needsTabExecution) {
    console.log(`[fetch-in-tab] 站点需要 Cloudflare 绕过，在标签页 ${tabId} 中执行: ${method} ${url}`);

    // 提取认证相关的头
    const headers = { 'Content-Type': 'application/json' };
    const authKeys = ['authorization', 'cookie', 'session', 'token', 'x-token', 'x-auth', 'new-api'];

    for (const [name, value] of Object.entries(capturedHeaders)) {
      if (name === '_tabId') continue; // 跳过临时标记
      const lower = name.toLowerCase();
      if (authKeys.some(k => lower.includes(k))) {
        headers[name] = value;
      }
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: async (fetchUrl, fetchMethod, fetchParams, fetchHeaders) => {
          try {
            const options = {
              method: fetchMethod,
              headers: fetchHeaders,
              credentials: 'include'
            };
            if (fetchMethod === 'POST' && fetchParams && Object.keys(fetchParams).length > 0) {
              options.body = JSON.stringify(fetchParams);
            }

            const response = await fetch(fetchUrl, options);
            const text = await response.text();

            // 尝试解析JSON
            let data;
            try {
              data = JSON.parse(text);
            } catch (e) {
              return { error: 'Response is not JSON: ' + text.substring(0, 100), httpStatus: response.status };
            }

            const success = data.success === true || data.status === 'success' || data.ret === 1 || data.code === 0;
            const message = data.message || data.msg || data.data || '签到完成';
            const msgStr = typeof message === 'string' ? message : JSON.stringify(message);

            const alreadyKeywords = ['已签到', '已经签到', 'already', '重复签到'];
            const alreadyCheckedIn = !success && alreadyKeywords.some(k => msgStr.includes(k));

            return {
              success: success || alreadyCheckedIn,
              alreadyCheckedIn,
              message: msgStr,
              httpStatus: response.status,
              data
            };
          } catch (e) {
            return { error: e.message, success: false, httpStatus: 0 };
          }
        },
        args: [url, method, params, headers]
      });

      const result = results[0]?.result;
      console.log(`[fetch-in-tab] 结果:`, result);
      return result || { error: 'No result from tab', success: false };
    } catch (e) {
      console.error(`[fetch-in-tab] 失败:`, e);
      // 回退到background fetch
    }
  }

  // 回退：在background中执行
  return doFetchWithHeaders(url, method, params, capturedHeaders);
}

async function doFetchWithHeaders(url, method, params, capturedHeaders) {
  // 提取认证相关的头
  const headers = { 'Content-Type': 'application/json' };
  const authKeys = ['authorization', 'cookie', 'session', 'token', 'x-token', 'x-auth', 'new-api'];

  for (const [name, value] of Object.entries(capturedHeaders)) {
    const lower = name.toLowerCase();
    if (authKeys.some(k => lower.includes(k))) {
      headers[name] = value;
    }
  }

  // 也保留 user-agent 和 referer
  if (capturedHeaders['User-Agent']) headers['User-Agent'] = capturedHeaders['User-Agent'];
  if (capturedHeaders['Referer']) headers['Referer'] = capturedHeaders['Referer'];

  console.log(`[fetch] ${method} ${url} 使用头:`, Object.keys(headers));
  console.log(`[fetch] 详细请求头:`, JSON.stringify(headers, null, 2).substring(0, 500));

  const options = { method, headers };
  if (method === 'POST' && params && Object.keys(params).length > 0) {
    options.body = JSON.stringify(params);
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    console.log(`[fetch] 响应状态: ${response.status}, 数据:`, JSON.stringify(data).substring(0, 200));

    const success = data.success === true || data.status === 'success' || data.ret === 1 || data.code === 0;
    const message = data.message || data.msg || data.data || '签到完成';
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);

    // "今日已签到" 视为已完成（不是失败）
    const alreadyKeywords = ['已签到', '已经签到', 'already', '重复签到'];
    const alreadyCheckedIn = !success && alreadyKeywords.some(k => msgStr.includes(k));

    return {
      success: success || alreadyCheckedIn,
      alreadyCheckedIn,
      message: msgStr,
      httpStatus: response.status,
      data
    };
  } catch (e) {
    console.error(`[fetch] 请求失败:`, e);
    return { error: e.message, success: false, httpStatus: 0 };
  }
}

// 缓存/读取认证头
async function cacheHeaders(siteId, headers) {
  const data = await chrome.storage.local.get('authHeadersCache');
  const cache = data.authHeadersCache || {};
  cache[siteId] = { headers, cachedAt: Date.now() };
  await chrome.storage.local.set({ authHeadersCache: cache });
}

async function getCachedHeaders(siteId) {
  const data = await chrome.storage.local.get('authHeadersCache');
  const cache = data.authHeadersCache || {};
  const entry = cache[siteId];
  if (!entry) return null;

  // 缓存 7 天过期（401 时会自动刷新）
  if (Date.now() - entry.cachedAt > 7 * 24 * 60 * 60 * 1000) {
    return null;
  }
  return entry.headers;
}

async function clearCachedHeaders(siteId) {
  const data = await chrome.storage.local.get('authHeadersCache');
  const cache = data.authHeadersCache || {};
  delete cache[siteId];
  await chrome.storage.local.set({ authHeadersCache: cache });
}

// ============== Auto OAuth Login ==============

// 等待标签页加载完成
function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false;
    function finish(val) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(val);
    }
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => {
      if (t.status === 'complete') finish(true);
    }).catch(() => finish(false));
    setTimeout(() => finish(false), timeout);
  });
}

// 等待标签页 URL 匹配目标域名
function waitForTabUrlMatch(tabId, domain, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    function finish(val) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(val);
    }
    function listener(id, info, tab) {
      if (id === tabId && tab.url && tab.url.includes(domain)) finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => {
      if (t.url && t.url.includes(domain)) finish(true);
    }).catch(() => {});
    setTimeout(() => finish(false), timeout);
  });
}

// 自动通过 linux.do OAuth 登录目标站点
async function autoOAuthLogin(domain) {
  console.log(`[OAuth] 开始自动登录: ${domain}`);

  // 1. 获取 linuxdo_client_id（在标签页上下文中执行以绕过 Cloudflare）
  let clientId;
  let tab;
  try {
    // 创建或获取标签页
    tab = await getOrCreateTab(domain);

    // 在标签页中执行 fetch 请求
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          const resp = await fetch('/api/status');
          const data = await resp.json();
          return { success: true, data: data };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
    });

    const result = results[0]?.result;
    if (!result?.success) {
      console.warn(`[OAuth] 获取 status 失败:`, result?.error);
      if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return null;
    }

    clientId = result.data?.data?.linuxdo_client_id || result.data?.linuxdo_client_id;
    if (!clientId) {
      console.warn(`[OAuth] ${domain} 无 linuxdo_client_id`);
      if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return null;
    }
    console.log(`[OAuth] client_id: ${clientId}`);
  } catch (e) {
    console.warn(`[OAuth] 获取 status 失败:`, e);
    if (tab?._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
    return null;
  }

  // 2. 检查 linux.do 登录状态
  const ldCookies = await chrome.cookies.getAll({ domain: 'linux.do' });
  if (ldCookies.length === 0) {
    console.warn('[OAuth] linux.do 未登录');
    if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
    return null;
  }
  console.log(`[OAuth] linux.do cookies: ${ldCookies.length} 个`);

  // 2.5. 获取 OAuth state (CSRF 保护) - 在标签页中执行以绕过 Cloudflare
  let state;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          const resp = await fetch('/api/oauth/state', { credentials: 'include' });
          const data = await resp.json();
          return { success: true, data: data };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
    });

    const result = results[0]?.result;
    if (!result?.success || !result?.data?.success || !result?.data?.data) {
      console.warn('[OAuth] 获取 state 失败:', result);
      if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return null;
    }
    state = result.data.data;
    console.log(`[OAuth] 获取 state: ${state}`);
  } catch (e) {
    console.warn('[OAuth] 获取 state 异常:', e);
    if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
    return null;
  }

  // 3. 在同一个标签页中打开 OAuth 授权页面
  const oauthUrl = `https://connect.linux.do/oauth2/authorize?response_type=code&client_id=${clientId}&state=${state}`;
  console.log(`[OAuth] 打开: ${oauthUrl}`);
  try {
    await chrome.tabs.update(tab.id, { url: oauthUrl });
    console.log(`[OAuth] 使用标签页 ${tab.id} 进行 OAuth 授权`);
  } catch (e) {
    console.error('[OAuth] 更新标签页失败:', e);
    if (tab._autoCreated) try { await chrome.tabs.remove(tab.id); } catch (e) {}
    return null;
  }

  try {
    // 4. 等待页面加载
    await waitForTabComplete(tab.id, 15000);
    await sleep(1000);

    let tabInfo = await chrome.tabs.get(tab.id);
    console.log(`[OAuth] 页面加载完成: ${tabInfo.url}`);

    // 5. 如果还在授权页面，尝试点击"允许"按钮
    if (tabInfo.url && tabInfo.url.includes('connect.linux.do')) {
      console.log('[OAuth] 在授权页面，点击允许按钮...');
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // 搜索所有可能的按钮元素（包括 a.btn-pill 等链接按钮）
            const btns = document.querySelectorAll('button, input[type="submit"], a[class*="btn"], [role="button"]');
            for (const btn of btns) {
              const text = (btn.textContent || btn.value || '').trim();
              if (/allow|允许|授权|approve|accept|Authorize|同意/i.test(text)) {
                btn.click();
                return 'clicked: ' + text;
              }
            }
            // 回退：查找包含允许文本的任意链接
            const links = document.querySelectorAll('a[href*="approve"], a[href*="authorize"]');
            for (const link of links) {
              link.click();
              return 'clicked approve link: ' + link.href;
            }
            // 回退：提交表单
            const form = document.querySelector('form');
            if (form) {
              const sub = form.querySelector('[type="submit"], button');
              if (sub) { sub.click(); return 'clicked form submit'; }
            }
            return 'no button found';
          }
        });
        console.log('[OAuth] 点击结果:', results[0]?.result);
      } catch (e) {
        console.warn('[OAuth] 注入脚本失败:', e);
      }

      // 等待重定向到目标域名
      const redirected = await waitForTabUrlMatch(tab.id, domain, 20000);
      if (!redirected) {
        console.warn('[OAuth] 重定向超时');
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
        return null;
      }
      await waitForTabComplete(tab.id, 15000);
    }

    // 6. 验证已到达目标域名
    tabInfo = await chrome.tabs.get(tab.id);
    if (!tabInfo.url || !tabInfo.url.includes(domain)) {
      console.warn(`[OAuth] 未到达目标域: ${tabInfo.url}`);
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return null;
    }
    console.log(`[OAuth] 登录完成: ${tabInfo.url}`);

    // 7. 等待前端 JS 处理 OAuth 回调（交换 code、保存 token 到 localStorage/cookie）
    console.log('[OAuth] 等待前端处理 OAuth 回调...');

    // 7.5. 手动触发 OAuth 回调处理（某些站点的前端 JS 可能不会自动执行）
    console.log('[OAuth] 手动调用 OAuth 回调 API...');
    const oauthUrl = new URL(tabInfo.url);
    const code = oauthUrl.searchParams.get('code');
    if (code) {
      try {
        const callbackResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (authCode) => {
            try {
              // 手动调用 OAuth 回调 API
              const resp = await fetch(`/api/oauth/linuxdo?code=${authCode}`, {
                method: 'GET',
                credentials: 'include'
              });
              const data = await resp.json();
              console.log('[OAuth 回调] API 响应:', data);

              // 如果登录成功,将用户数据写入 localStorage
              if (data.success && data.data) {
                localStorage.setItem('user', JSON.stringify(data.data));
                console.log('[OAuth 回调] 已将用户数据写入 localStorage');
              }

              // 等待一下让浏览器处理 Set-Cookie
              await new Promise(r => setTimeout(r, 1000));

              // 检查 localStorage
              const hasUser = localStorage.getItem('user') !== null;
              return { success: true, apiResponse: data, hasUser: hasUser };
            } catch (e) {
              return { success: false, error: e.message };
            }
          },
          args: [code]
        });
        const callbackResult = callbackResults[0]?.result;
        console.log('[OAuth] 回调 API 结果:', JSON.stringify(callbackResult).substring(0, 300));
      } catch (e) {
        console.warn('[OAuth] 手动调用回调 API 失败:', e.message);
      }
    }

    // 7.6. 验证 session 是否已建立（在页面上下文中检查）
    let sessionEstablished = false;
    for (let retry = 0; retry < 5; retry++) {
      await sleep(2000);
      console.log(`[OAuth] 验证 session 是否建立 (尝试 ${retry + 1}/5)...`);

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            try {
              // 检查 localStorage 中是否有 user 键（表示已登录）
              const hasUser = localStorage.getItem('user') !== null;
              const resp = await fetch('/api/status');
              const data = await resp.json();
              return { success: true, hasUser: hasUser, data: data };
            } catch (e) {
              return { success: false, error: e.message };
            }
          }
        });
        const result = results[0]?.result;
        console.log(`[OAuth] 页面上下文检查结果:`, JSON.stringify(result).substring(0, 300));
        console.log(`[OAuth] localStorage 有 user 键: ${result?.hasUser}`);

        // 必须同时满足: API 返回成功 且 localStorage 有 user 键
        if (result?.success && result?.data?.success && result?.hasUser) {
          sessionEstablished = true;
          console.log('[OAuth] session 已建立且用户已登录');
          break;
        } else if (result?.success && !result?.hasUser) {
          console.log('[OAuth] API 返回成功但 localStorage 无 user 键，继续等待...');
        }
      } catch (e) {
        console.warn(`[OAuth] 验证失败:`, e.message);
      }
    }

    if (!sessionEstablished) {
      console.warn('[OAuth] session 未建立，OAuth 可能失败');
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return null;
    }

    // 7.6. 在 OAuth 回调页面刷新，强制浏览器写入新 cookie
    console.log('[OAuth] 在 OAuth 回调页面刷新以写入 cookie...');
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id, 15000);
    await sleep(2000);

    // 8. 导航到登录页以捕获认证头（session 已在 OAuth 回调页面建立）
    console.log('[OAuth] 导航到登录页以捕获认证头...');
    await chrome.tabs.update(tab.id, { url: `https://${domain}/login` });
    await waitForTabComplete(tab.id, 15000);
    await sleep(2000);

    // 9. 捕获认证头（刷新首页触发正常的 API 请求，携带有效 session）
    const headers = await captureAuthHeaders(domain, tab.id);
    if (!headers || Object.keys(headers).length === 0) {
      console.warn('[OAuth] 未捕获到认证头');
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return null;
    }
    console.log('[OAuth] 捕获到的请求头:', JSON.stringify(Object.keys(headers)));

    // 10. 如果没有捕获到 Cookie，尝试从 chrome.cookies API 读取
    if (!headers['Cookie'] && !headers['cookie']) {
      console.log('[OAuth] 未捕获到 Cookie，尝试从 cookies API 读取...');
      const cookies = await chrome.cookies.getAll({ domain: domain });
      console.log(`[OAuth] cookies API 返回 ${cookies.length} 个 cookie:`, cookies.map(c => c.name));
      if (cookies.length > 0) {
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        headers['Cookie'] = cookieStr;
        console.log(`[OAuth] 设置 Cookie 头: ${cookieStr.substring(0, 100)}...`);
      }
    } else {
      console.log('[OAuth] 已捕获到 Cookie 头');
    }

    // 11. 尝试从 localStorage 读取 token（某些站点使用 localStorage 而非 cookie）
    try {
      console.log('[OAuth] 尝试从 localStorage 读取 token...');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const token = localStorage.getItem('token') || localStorage.getItem('access_token') || localStorage.getItem('auth_token');
          const allKeys = Object.keys(localStorage);
          return { token, allKeys };
        }
      });
      const result = results[0]?.result;
      console.log('[OAuth] localStorage 所有 key:', result?.allKeys);
      const token = result?.token;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        console.log('[OAuth] 从 localStorage 读取到 token:', token.substring(0, 20) + '...');
      } else {
        console.log('[OAuth] localStorage 中未找到 token');
      }
    } catch (e) {
      console.warn('[OAuth] 读取 localStorage 失败:', e);
    }

    // 12. 验证捕获的认证头是否有效（测试 /api/status 接口）
    console.log('[OAuth] 验证认证头有效性...');
    console.log('[OAuth] 当前请求头:', JSON.stringify(Object.keys(headers)));
    try {
      const testResult = await doFetchWithHeaders(`https://${domain}/api/status`, 'GET', null, headers);
      console.log('[OAuth] 验证请求返回状态:', testResult.httpStatus);
      console.log('[OAuth] 验证请求返回数据:', JSON.stringify(testResult.data));
      if (testResult.httpStatus === 401) {
        console.warn('[OAuth] 认证头无效（401），可能需要更长等待时间');
        // 再等待一段时间后重试
        await sleep(3000);
        console.log('[OAuth] 等待 3 秒后重新捕获认证头...');
        const retryHeaders = await captureAuthHeaders(domain, tab.id);
        if (retryHeaders && Object.keys(retryHeaders).length > 0) {
          console.log('[OAuth] 重新捕获认证头成功，请求头:', JSON.stringify(Object.keys(retryHeaders)));
          return { headers: retryHeaders, tabId: tab.id };
        } else {
          console.warn('[OAuth] 重新捕获认证头失败');
        }
      } else {
        console.log('[OAuth] 认证头验证通过');
      }
    } catch (e) {
      console.warn('[OAuth] 验证认证头失败:', e);
    }

    return { headers, tabId: tab.id };
  } catch (e) {
    console.error('[OAuth] 失败:', e);
    try { await chrome.tabs.remove(tab.id); } catch (e2) {}
    return null;
  }
}

// 获取或创建标签页
async function getOrCreateTab(domain) {
  const tabs = await chrome.tabs.query({ url: `https://${domain}/*` });
  if (tabs.length > 0) {
    return tabs[0];
  }

  console.log(`未找到 ${domain} 的标签页，后台打开...`);
  const tab = await chrome.tabs.create({
    url: `https://${domain}/`,
    active: false
  });

  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  await sleep(3000);
  tab._autoCreated = true;
  return tab;
}

// 发送通知
// 发送单个站点签到结果通知
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNextCheckInTime() {
  const now = new Date();
  const [hours, minutes] = GLOBAL_CONFIG.autoSignTime.split(':').map(Number);
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}
