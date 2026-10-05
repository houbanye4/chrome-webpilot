/**
 * panel.js — 侧边栏 UI 逻辑
 */

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const port = chrome.runtime.connect({ name: 'panel' });

// ---------- UI 状态 ----------

let streamingEl = null; // 当前流式输出元素
let running = false;

function addMsg(cls, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addToolEntry(name, args) {
  const details = document.createElement('details');
  details.className = 'tool';
  const summary = document.createElement('summary');
  summary.innerHTML = `<span class="tname">🔧 ${escapeHtml(name)}</span><span class="targs"></span>`;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'tbody';
  details.appendChild(body);
  chat.appendChild(details);
  chat.scrollTop = chat.scrollHeight;
  return { summary, body };
}

function addStepDivider(text) {
  const div = document.createElement('div');
  div.className = 'step-divider';
  div.textContent = text;
  chat.appendChild(div);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setRunning(v) {
  running = v;
  $('runBtn').disabled = v;
  $('stopBtn').classList.toggle('hidden', !v);
  $('status').textContent = v ? '智能体执行中…' : '';
}

// ---------- 与 background 通信 ----------

port.onMessage.addListener((msg) => {
  if (msg.type !== 'EVENT') return;
  const e = msg.event;
  switch (e.kind) {
    case 'run_start':
      addMsg('user', e.task);
      setRunning(true);
      break;
    case 'step':
      addStepDivider(`第 ${e.step}/${e.max} 步`);
      streamingEl = null;
      break;
    case 'delta': {
      if (!streamingEl) streamingEl = addMsg('ai', '');
      streamingEl.textContent += e.text;
      chat.scrollTop = chat.scrollHeight;
      break;
    }
    case 'tool_start': {
      streamingEl = null;
      const entry = addToolEntry(e.name, e.args);
      entry.summary.querySelector('.targs').textContent = summarizeArgs(e.args);
      entry.dataset.args = JSON.stringify(e.args ?? {});
      currentToolBody = entry.body;
      break;
    }
    case 'tool_result': {
      if (currentToolBody) {
        currentToolBody.textContent = e.result;
        currentToolBody = null;
      }
      break;
    }
    case 'mcp_log':
      addStepDivider(e.msg);
      break;
    case 'ask_user':
      showAsk(e.id, e.question);
      break;
    case 'skill_saved':
      addStepDivider(`🧩 新技能已学会：「${e.title}」（可在设置→技能库管理）`);
      break;
    case 'final':
      addMsg('final', `✅ ${e.text}`);
      setRunning(false);
      streamingEl = null;
      break;
    case 'error':
      addMsg('error', `⚠️ ${e.msg}`);
      setRunning(false);
      break;
  }
});

let currentToolBody = null;

function summarizeArgs(args) {
  if (!args || !Object.keys(args).length) return '';
  const s = JSON.stringify(args);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

// ---------- 用户操作 ----------

$('runBtn').onclick = () => {
  const task = $('taskInput').value.trim();
  if (!task || running) return;
  $('taskInput').value = '';
  port.postMessage({ type: 'AGENT_RUN', task });
};

$('stopBtn').onclick = () => port.postMessage({ type: 'AGENT_STOP' });

$('taskInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('runBtn').click(); }
});

document.querySelectorAll('.quick').forEach((btn) => {
  btn.onclick = () => { $('taskInput').value = btn.dataset.task; };
});

$('settingsBtn').onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });

// ask_user 回复
function showAsk(id, question) {
  $('askBar').classList.remove('hidden');
  $('askQuestion').textContent = question;
  $('askInput').focus();
  const send = () => {
    const answer = $('askInput').value.trim() || '好的，继续';
    chrome.runtime.sendMessage({ type: 'ASK_ANSWER', id, answer });
    addMsg('user', answer);
    $('askInput').value = '';
    $('askBar').classList.add('hidden');
  };
  $('askSend').onclick = send;
  $('askInput').onkeydown = (e) => { if (e.key === 'Enter') send(); };
}

// ---------- 初始化：显示当前模型 ----------

chrome.storage.sync.get(['model', 'baseUrl'], ({ model, baseUrl }) => {
  if (model) {
    $('modelBadge').textContent = model;
    $('modelBadge').title = `${model} @ ${baseUrl}`;
  } else {
    $('modelBadge').textContent = '点⚙配置';
  }
});

addMsg('ai', '👋 我是 WebPilot，可以自动操作浏览器完成任务。\n\n首次使用请点右上角 ⚙ 配置 API（默认网关为 Rqu AI，需要填入你的 API Key）。');
