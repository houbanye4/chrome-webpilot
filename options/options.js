/** options.js — 设置页逻辑 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  baseUrl: 'https://api.rqu.cn/v1',
  model: 'gpt-4o-mini',
  maxSteps: 20,
  confirmDangerous: true,
  mcpServers: [],
};

// ---------- MCP 服务器管理 ----------

async function renderMcp() {
  const { mcpServers = [] } = await chrome.storage.sync.get('mcpServers');
  const box = $('mcpList');
  box.innerHTML = mcpServers.length ? '' : '<div class="hint">尚未添加服务器</div>';
  for (const s of mcpServers) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f1f5;';
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">🌐 ${s.name} <span id="mcp-state-${s.name}" style="font-weight:400;font-size:12px;color:#9ca3af"></span></div>
        <div style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.url}</div>
      </div>
      <button class="ghost" data-mtest="${s.name}" style="padding:4px 10px;font-size:12px">测试</button>
      <button class="ghost" data-mdel="${s.name}" style="padding:4px 10px;font-size:12px">删除</button>`;
    box.appendChild(row);
  }
  box.querySelectorAll('[data-mtest]').forEach((btn) => {
    btn.onclick = async () => {
      const server = mcpServers.find((x) => x.name === btn.dataset.mtest);
      testMcp(server);
    };
  });
  box.querySelectorAll('[data-mdel]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`删除 MCP 服务器「${btn.dataset.mdel}」？`)) return;
      const left = mcpServers.filter((x) => x.name !== btn.dataset.mdel);
      await chrome.storage.sync.set({ mcpServers: left });
      renderMcp();
    };
  });
}

function mcpTip(msg, ok = true) {
  const tip = $('mcpTip');
  tip.textContent = msg;
  tip.style.color = ok ? '#16a34a' : '#dc2626';
  setTimeout(() => (tip.textContent = ''), 6000);
}

function setMcpState(name, text, color) {
  const el = document.getElementById(`mcp-state-${name}`);
  if (el) { el.textContent = text; el.style.color = color; }
}

/** 测试连接：走 background（避免 CORS），列出发现的工具 */
async function testMcp(server) {
  if (!server) return;
  mcpTip(`正在连接 ${server.name}…`);
  setMcpState(server.name, '连接中…', '#9ca3af');
  chrome.runtime.sendMessage({ type: 'MCP_TEST', server }, (res) => {
    if (chrome.runtime.lastError) {
      setMcpState(server.name, '✗ 通信失败', '#dc2626');
      return mcpTip(chrome.runtime.lastError.message, false);
    }
    if (res.ok) {
      setMcpState(server.name, `✓ ${res.count} 个工具`, '#16a34a');
      mcpTip(`✓ ${server.name} 连接成功，发现 ${res.count} 个工具：${res.tools.slice(0, 8).join(', ')}${res.count > 8 ? ' …' : ''}`);
    } else {
      setMcpState(server.name, '✗ 连接失败', '#dc2626');
      mcpTip(`✗ ${server.name}: ${res.error}（本地 server 检查是否已启动；CORS 拦截时用 mcp-proxy 转发）`, false);
    }
  });
}

$('mcpTest').onclick = () => {
  const server = readMcpForm();
  if (!server) return;
  testMcp(server);
};

$('mcpAdd').onclick = async () => {
  const server = readMcpForm();
  if (!server) return;
  const { mcpServers = [] } = await chrome.storage.sync.get('mcpServers');
  if (mcpServers.some((x) => x.name === server.name)) {
    return mcpTip(`名称「${server.name}」已存在`, false);
  }
  mcpServers.push(server);
  await chrome.storage.sync.set({ mcpServers });
  $('mcpName').value = ''; $('mcpUrl').value = ''; $('mcpHeaders').value = '';
  mcpTip('已添加');
  renderMcp();
};

function readMcpForm() {
  const name = $('mcpName').value.trim();
  const url = $('mcpUrl').value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(name)) {
    mcpTip('名称需为小写字母/数字/连字符（≤20 位）', false);
    return null;
  }
  if (!/^https?:\/\//.test(url)) {
    mcpTip('URL 必须以 http:// 或 https:// 开头', false);
    return null;
  }
  let headers = {};
  const raw = $('mcpHeaders').value.trim();
  if (raw) {
    try { headers = JSON.parse(raw); } catch { mcpTip('Headers 不是合法 JSON', false); return null; }
  }
  return { name, url, headers };
}

// ---------- 自动化任务 ----------

async function renderTasks() {
  const { listTasks, getHistory, describeTrigger } = await import('../lib/tasks.js');
  const [tasks, history] = await Promise.all([listTasks(), getHistory()]);
  const box = $('taskList');
  box.innerHTML = tasks.length ? '' : '<div class="hint">暂无任务</div>';
  for (const t of tasks) {
    const statusText = t.lastStatus === 'ok' ? '✓ 上次成功' : t.lastStatus === 'error' ? '✗ 上次失败' : t.lastStatus === 'running' ? '⏳ 执行中' : '';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f1f5;';
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">⏱️ ${t.name} <span style="color:#9ca3af;font-weight:400;font-size:12px">${describeTrigger(t.trigger)} ${statusText}</span></div>
        <div style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.prompt.replace(/</g, '&lt;')}</div>
      </div>
      <label style="margin:0;font-weight:400;font-size:12px;display:flex;gap:4px;align-items:center">
        <input type="checkbox" ${t.enabled ? 'checked' : ''} data-tenable="${t.id}" />启用
      </label>
      <button class="ghost" data-trun="${t.id}" style="padding:4px 10px;font-size:12px">立即运行</button>
      <button class="ghost" data-tdel="${t.id}" style="padding:4px 10px;font-size:12px">删除</button>`;
    box.appendChild(row);
  }
  $('taskHistory').innerHTML = history.slice(0, 10).map((h) =>
    `<div>${new Date(h.time).toLocaleString()} · ${h.name} · ${h.status}${h.detail ? ` · ${h.detail}` : ''}</div>`
  ).join('') || '（暂无记录）';

  box.querySelectorAll('[data-tenable]').forEach((cb) => {
    cb.onchange = async () => {
      const mod = await import('../lib/tasks.js');
      await mod.toggleTask(cb.dataset.tenable, cb.checked);
      await mod.scheduleAll();
    };
  });
  box.querySelectorAll('[data-trun]').forEach((btn) => {
    btn.onclick = async () => {
      const t = tasks.find((x) => x.id === btn.dataset.trun);
      chrome.runtime.sendMessage({ type: 'RUN_TASK_NOW', taskId: t.id });
      taskTipMsg('已触发，请在侧边栏查看执行过程');
    };
  });
  box.querySelectorAll('[data-tdel]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('删除该任务？')) return;
      const mod = await import('../lib/tasks.js');
      await mod.deleteTask(btn.dataset.tdel);
      await mod.scheduleAll();
      renderTasks();
    };
  });
}

function taskTipMsg(msg) {
  $('taskTip').textContent = msg;
  setTimeout(() => ($('taskTip').textContent = ''), 3000);
}

$('taskTriggerType').onchange = () => {
  const type = $('taskTriggerType').value;
  $('taskTime').style.display = type === 'interval' ? 'none' : '';
  $('taskMinutes').style.display = type === 'interval' ? '' : 'none';
};

$('taskAdd').onclick = async () => {
  const type = $('taskTriggerType').value;
  const trigger = { type };
  if (type === 'daily') {
    const [h, m] = $('taskTime').value.split(':').map(Number);
    trigger.hour = h ?? 9; trigger.minute = m ?? 0;
  } else if (type === 'interval') {
    trigger.minutes = parseInt($('taskMinutes').value, 10) || 60;
  } else if (type === 'once') {
    const [h, m] = $('taskTime').value.split(':').map(Number);
    const at = new Date(); at.setHours(h, m, 0, 0);
    if (at <= new Date()) at.setDate(at.getDate() + 1);
    trigger.at = at.getTime();
  }
  try {
    const mod = await import('../lib/tasks.js');
    await mod.saveTask({
      name: $('taskName').value,
      trigger,
      prompt: $('taskPrompt').value,
      enabled: true,
    });
    await mod.scheduleAll();
    $('taskName').value = ''; $('taskPrompt').value = '';
    taskTipMsg('✓ 已创建并启用');
    renderTasks();
  } catch (e) {
    taskTipMsg(e.message);
  }
};

// ---------- 网站凭据 ----------

async function renderCreds() {
  const { listCredentials } = await import('../lib/tasks.js');
  const creds = await listCredentials();
  const box = $('credList');
  box.innerHTML = creds.length ? '' : '<div class="hint">暂无保存的凭据</div>';
  for (const c of creds) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f0f1f5;';
    row.innerHTML = `
      <div style="flex:1">🔑 <b>${c.site}</b> · ${c.username}</div>
      <button class="ghost" data-cdel="${c.site}" style="padding:4px 10px;font-size:12px">删除</button>`;
    box.appendChild(row);
  }
  box.querySelectorAll('[data-cdel]').forEach((btn) => {
    btn.onclick = async () => {
      const mod = await import('../lib/tasks.js');
      await mod.deleteCredential(btn.dataset.cdel);
      renderCreds();
    };
  });
}

$('credAdd').onclick = async () => {
  try {
    const mod = await import('../lib/tasks.js');
    await mod.saveCredential({
      site: $('credSite').value,
      username: $('credUser').value,
      password: $('credPass').value,
    });
    $('credSite').value = ''; $('credUser').value = ''; $('credPass').value = '';
    renderCreds();
  } catch (e) {
    alert(e.message);
  }
};

// ---------- 技能管理 ----------

async function renderSkills() {
  const { listSkills } = await import('../lib/skills.js');
  const skills = await listSkills();
  const box = $('skillList');
  if (!skills.length) {
    box.innerHTML = '<div class="hint">暂无技能</div>';
    return;
  }
  box.innerHTML = '';
  for (const s of skills) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f1f5;';
    const enabled = s.enabled !== false;
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${s.learned ? '🤖 ' : '🧩 '}${s.title} <span style="color:#9ca3af;font-weight:400;font-size:12px">${s.name} · v${s.version}</span></div>
        <div style="color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.description || '（无描述）'}</div>
      </div>
      <label style="margin:0;font-weight:400;display:flex;align-items:center;gap:4px;font-size:12px">
        <input type="checkbox" ${enabled ? 'checked' : ''} data-toggle="${s.name}" /> 启用
      </label>
      <button class="ghost" data-del="${s.name}" style="padding:4px 10px;font-size:12px">删除</button>`;
    box.appendChild(row);
  }
  box.querySelectorAll('[data-toggle]').forEach((cb) => {
    cb.onchange = async () => {
      const { toggleSkill } = await import('../lib/skills.js');
      await toggleSkill(cb.dataset.toggle, cb.checked);
    };
  });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`确定删除技能「${btn.dataset.del}」？`)) return;
      const { deleteSkill } = await import('../lib/skills.js');
      await deleteSkill(btn.dataset.del);
      renderSkills();
    };
  });
}

function skillTip(msg, ok = true) {
  const tip = $('skillTip');
  tip.textContent = msg;
  tip.style.color = ok ? '#16a34a' : '#dc2626';
  setTimeout(() => (tip.textContent = ''), 3000);
}

$('skillInstallUrl').onclick = async () => {
  const url = $('skillUrl').value.trim();
  if (!url) return;
  try {
    const { installFromUrl } = await import('../lib/skills.js');
    const installed = await installFromUrl(url);
    skillTip(`已安装 ${installed.length} 个技能`);
    $('skillUrl').value = '';
    renderSkills();
  } catch (e) {
    skillTip(`安装失败：${e.message}`, false);
  }
};

$('skillInstallJson').onclick = async () => {
  try {
    const data = JSON.parse($('skillJson').value);
    const { installSkill } = await import('../lib/skills.js');
    const items = Array.isArray(data) ? data : data.skills ?? [data];
    for (const raw of items) await installSkill(raw);
    skillTip(`已导入 ${items.length} 个技能`);
    $('skillJson').value = '';
    renderSkills();
  } catch (e) {
    skillTip(`导入失败：${e.message}`, false);
  }
};

$('skillExport').onclick = async () => {
  const { listSkills } = await import('../lib/skills.js');
  const skills = await listSkills();
  const blob = new Blob([JSON.stringify({ format: 'webpilot-skill/v1', skills }, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'webpilot-skills.json';
  a.click();
};

// ---------- 基础设置 ----------

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
  $('baseUrl').value = s.baseUrl;
  $('apiKey').value = s.apiKey ?? '';
  $('maxSteps').value = s.maxSteps;
  $('confirmDangerous').checked = s.confirmDangerous;
  $('mcpServers') && ($('mcpServers').value = JSON.stringify(s.mcpServers ?? [], null, 2));
  if (s.model) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = s.model;
    $('model').appendChild(opt);
    $('model').value = s.model;
  }
}

$('loadModels').onclick = async () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return alert('请先填写 API Key');
  $('loadModels').textContent = '获取中…';
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = (json.data ?? []).map((m) => m.id).sort();
    const sel = $('model');
    sel.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join('');
    if (models.length === 0) sel.innerHTML = '<option value="">端点未返回模型</option>';
  } catch (e) {
    alert(`获取失败：${e.message}\n请检查 API 地址与 Key 是否正确。`);
  } finally {
    $('loadModels').textContent = '获取模型列表';
  }
};

$('save').onclick = async () => {
  await chrome.storage.sync.set({
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value || DEFAULTS.model,
    maxSteps: Math.max(3, parseInt($('maxSteps').value, 10) || DEFAULTS.maxSteps),
    confirmDangerous: $('confirmDangerous').checked,
  });
  $('saveTip').classList.add('show');
  setTimeout(() => $('saveTip').classList.remove('show'), 2000);
};

load();
renderSkills();
renderMcp();
renderTasks();
renderCreds();
