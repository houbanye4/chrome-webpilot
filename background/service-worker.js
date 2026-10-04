/**
 * service-worker.js — 消息路由 / 右键菜单 / Agent 会话管理
 */

import { Agent, getSettings } from '../lib/agent.js';

let currentAgent = null;
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

async function startRun(task) {
  if (currentAgent) {
    emit({ kind: 'error', msg: '已有任务在执行中，请先停止' });
    return;
  }
  const settings = await getSettings();
  if (!settings.apiKey) {
    emit({ kind: 'error', msg: '请先在设置页配置 API Key（点击面板右上角 ⚙）' });
    return;
  }
  currentAgent = new Agent({ settings, emit });
  emit({ kind: 'run_start', task });
  try {
    await currentAgent.run(task);
  } catch (e) {
    if (e.name === 'AbortError' || /手动停止/.test(e.message)) {
      emit({ kind: 'final', text: '任务已停止。' });
    } else {
      emit({ kind: 'error', msg: e.message });
    }
  } finally {
    currentAgent = null;
  }
}

function stopRun() {
  currentAgent?.stop();
}

// ---- ask_user 答复转发（panel 用普通消息回复） ----
chrome.runtime.onMessage.addListener((msg) => {
  // ToolContext 自己监听 ASK_ANSWER，这里无需处理
  if (msg.type === 'PING_BG') return true;
});

// ---- 工具栏图标点击 → 打开侧边栏 ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
