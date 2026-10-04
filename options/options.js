/** options.js — 设置页逻辑 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  baseUrl: 'https://api.rqu.cn/v1',
  model: 'gpt-4o-mini',
  maxSteps: 20,
  confirmDangerous: true,
  mcpServers: [],
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
  $('mcpServers').value = JSON.stringify(s.mcpServers ?? [], null, 2);
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
  let mcpServers = [];
  try {
    mcpServers = JSON.parse($('mcpServers').value || '[]');
  } catch {
    return alert('MCP Servers 不是合法的 JSON');
  }
  await chrome.storage.sync.set({
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value || DEFAULTS.model,
    maxSteps: Math.max(3, parseInt($('maxSteps').value, 10) || DEFAULTS.maxSteps),
    confirmDangerous: $('confirmDangerous').checked,
    mcpServers,
  });
  $('saveTip').classList.add('show');
  setTimeout(() => $('saveTip').classList.remove('show'), 2000);
};

load();
