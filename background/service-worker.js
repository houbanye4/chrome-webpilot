/**
 * service-worker.js — 消息路由 / 右键菜单 / Agent 会话管理
 */

import { Agent, getSettings } from '../lib/agent.js';
import { listTasks, scheduleAll, markRun, pushHistory, describeTrigger } from '../lib/tasks.js';

let currentAgent = null;
let keepAliveTimer = null;
const panelPorts = new Set();

// ---- 侧边栏 Port 连接 ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'AGENT_RUN') return startRun(msg.task);
    if (msg.type === 'AGENT_STOP') return stopRun();
  });
});

function emit(event) {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'EVENT', event }); } catch { /* port 关闭 */ }
  }
}

async function startRun(task, { auto = false, taskId = null, taskName = '', trigger = null } = {}) {
  if (currentAgent) {
    if (auto) { await markRun(taskId, 'error'); await pushHistory({ taskId, name: taskName, status: 'skipped', detail: '有任务正在执行，本次跳过' }); return; }
    emit({ kind: 'error', msg: '已有任务在执行中，请先停止' });
    return;
  }
  const settings = await getSettings();
  if (!settings.apiKey) {
    if (auto) { await markRun(taskId, 'error'); await pushHistory({ taskId, name: taskName, status: 'error', detail: '未配置 API Key' }); return; }
    emit({ kind: 'error', msg: '请先在设置页配置 API Key（点击面板右上角 ⚙）' });
    return;
  }
  currentAgent = new Agent({ settings, emit, auto });
  startKeepAlive();
  emit({ kind: 'run_start', task });
  if (auto) await pushHistory({ taskId, name: taskName, status: 'running', detail: `定时触发（${describeTrigger(trigger)}）` });
  try {
    await currentAgent.run(task);
    if (auto) { await markRun(taskId, 'ok'); await pushHistory({ taskId, name: taskName, status: 'done', detail: '执行完成' }); }
  } catch (e) {
    if (e.name === 'AbortError' || /手动停止/.test(e.message)) {
      emit({ kind: 'final', text: '任务已停止。' });
      if (auto) { await markRun(taskId, 'error'); await pushHistory({ taskId, name: taskName, status: 'error', detail: '手动停止' }); }
    } else {
      emit({ kind: 'error', msg: e.message });
      if (auto) { await markRun(taskId, 'error'); await pushHistory({ taskId, name: taskName, status: 'error', detail: e.message.slice(0, 200) }); }
    }
  } finally {
    currentAgent = null;
    stopKeepAlive();
  }
}

/** MV3 Service Worker 空闲 30s 会被回收，长任务期间用心跳保活 */
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// ---- 自动化任务定时触发 ----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('task_')) return;
  const id = alarm.name.slice(5);
  const tasks = await listTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t || !t.enabled) return;
  await startRun(t.prompt, { auto: true, taskId: id, taskName: t.name, trigger: t.trigger });
  await scheduleAll(); // 重建 daily 的 when
});

function stopRun() {
  currentAgent?.stop();
}

// ---- ask_user 答复转发（panel 用普通消息回复） ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 设置页测试 MCP 连接：在 background 里跑（避开 CORS 与页面生命周期问题）
  if (msg.type === 'MCP_TEST') {
    (async () => {
      try {
        const { McpClient } = await import('../lib/mcp.js');
        const client = new McpClient(msg.server);
        const tools = await client.listTools();
        sendResponse({ ok: true, count: tools.length, tools: tools.map((t) => t.name) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // 异步响应
  }
  return false;
});

// ---- 立即运行某个自动化任务（设置页触发） ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RUN_TASK_NOW') {
    (async () => {
      const { listTasks } = await import('../lib/tasks.js');
      const t = (await listTasks()).find((x) => x.id === msg.taskId);
      if (t) await startRun(t.prompt, { auto: false, taskId: t.id, taskName: t.name });
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

// ---- 工具栏图标点击 → 打开侧边栏 ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  scheduleAll(); // 重建自动化任务的 alarms

  // 右键菜单：用 AI 处理选中内容
  chrome.contextMenus.create({
    id: 'webpilot-selection',
    title: 'WebPilot：用 AI 处理选中文本',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'webpilot-selection') return;
  const sel = info.selectionText ?? '';
  // 打开侧边栏并自动发起任务
  if (chrome.sidePanel?.open) await chrome.sidePanel.open({ windowId: tab.windowId });
  setTimeout(() => startRun(`请处理我在网页上选中的内容：\n\n${sel}`), 600);
});

// ---- 快捷打开设置页 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
  return false;
});
