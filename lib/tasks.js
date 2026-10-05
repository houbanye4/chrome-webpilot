/**
 * tasks.js — 自动化任务：定时调度 + 运行历史
 *
 * 任务模型：
 * {
 *   id, name,
 *   trigger: { type: 'daily'|'interval'|'once', hour?, minute?, minutes? , at? },
 *   prompt: "任务描述（写给智能体，可提示使用某技能/凭据）",
 *   enabled: true,
 *   confirmBeforePost: true,   // 发布类动作前要求用户在面板确认（无人值守时跳过执行）
 *   lastRun: timestamp, lastStatus: 'ok'|'error'|'running'
 * }
 *
 * 无人值守限制：验证码、人工审核类站点无法自动通过；ask_user 在无人值守时
 * 会收到"采用保守默认方案"的回复，confirmBeforePost 的任务若遇发布确认将安全中止。
 */

const TASKS_KEY = 'wp_tasks';
const HISTORY_KEY = 'wp_task_history';
const HISTORY_LIMIT = 50;

// ---------- CRUD ----------

export async function listTasks() {
  return (await chrome.storage.local.get(TASKS_KEY))[TASKS_KEY] ?? [];
}

async function writeTasks(tasks) {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}

export async function saveTask(task) {
  const tasks = await listTasks();
  const t = {
    id: task.id ?? `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(task.name ?? '').trim() || '未命名任务',
    trigger: task.trigger ?? { type: 'daily', hour: 9, minute: 0 },
    prompt: String(task.prompt ?? '').trim(),
    enabled: task.enabled ?? true,
    confirmBeforePost: task.confirmBeforePost ?? true,
    lastRun: task.lastRun ?? null,
    lastStatus: task.lastStatus ?? null,
  };
  if (!t.prompt) throw new Error('任务描述不能为空');
  const idx = tasks.findIndex((x) => x.id === t.id);
  if (idx >= 0) tasks[idx] = t; else tasks.push(t);
  await writeTasks(tasks);
  return t;
}

export async function deleteTask(id) {
  await writeTasks((await listTasks()).filter((t) => t.id !== id));
}

export async function toggleTask(id, enabled) {
  const tasks = await listTasks();
  const t = tasks.find((x) => x.id === id);
  if (t) { t.enabled = enabled; await writeTasks(tasks); }
}

export async function markRun(id, status) {
  const tasks = await listTasks();
  const t = tasks.find((x) => x.id === id);
  if (t) { t.lastRun = Date.now(); t.lastStatus = status; await writeTasks(tasks); }
}

// ---------- 调度（chrome.alarms） ----------

function nextDailyAt(hour, minute) {
  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** 同步所有启用任务的 chrome.alarms（增删改后都应调用） */
export async function scheduleAll() {
  const all = await chrome.alarms.getAll();
  for (const a of all) {
    if (a.name.startsWith('task_')) await chrome.alarms.clear(a.name);
  }
  for (const t of await listTasks()) {
    if (!t.enabled) continue;
    const name = `task_${t.id}`;
    const tr = t.trigger;
    if (tr.type === 'daily') {
      await chrome.alarms.create(name, {
        when: nextDailyAt(tr.hour ?? 9, tr.minute ?? 0),
        periodInMinutes: 1440,
      });
    } else if (tr.type === 'interval') {
      const minutes = Math.max(1, parseInt(tr.minutes ?? 60, 10));
      await chrome.alarms.create(name, { periodInMinutes: minutes });
    } else if (tr.type === 'once' && tr.at) {
      await chrome.alarms.create(name, { when: tr.at });
    }
  }
}

export function describeTrigger(tr = {}) {
  if (tr.type === 'daily') return `每天 ${String(tr.hour).padStart(2, '0')}:${String(tr.minute).padStart(2, '0')}`;
  if (tr.type === 'interval') return `每 ${tr.minutes} 分钟`;
  if (tr.type === 'once') return `一次性：${new Date(tr.at).toLocaleString()}`;
  return '手动';
}

// ---------- 运行历史 ----------

export async function getHistory() {
  return (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] ?? [];
}

export async function pushHistory(entry) {
  const history = await getHistory();
  history.unshift({ ...entry, time: Date.now() });
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, HISTORY_LIMIT) });
}

// ---------- 凭据库（本机存储，用于自动登录） ----------

const CREDS_KEY = 'wp_credentials';

export async function listCredentials() {
  return (await chrome.storage.local.get(CREDS_KEY))[CREDS_KEY] ?? [];
}

export async function saveCredential({ site, username, password, note }) {
  if (!site || !username) throw new Error('站点与用户名必填');
  const creds = await listCredentials();
  const item = { site: site.trim(), username: username.trim(), password: password ?? '', note: note ?? '' };
  const idx = creds.findIndex((c) => c.site === item.site);
  if (idx >= 0) creds[idx] = item; else creds.push(item);
  await chrome.storage.local.set({ [CREDS_KEY]: creds });
  return item;
}

export async function deleteCredential(site) {
  const creds = (await listCredentials()).filter((c) => c.site !== site);
  await chrome.storage.local.set({ [CREDS_KEY]: creds });
}

export async function findCredential(siteKeyword) {
  const kw = String(siteKeyword).toLowerCase();
  return (await listCredentials()).find(
    (c) => c.site.toLowerCase().includes(kw) || (c.note ?? '').toLowerCase().includes(kw)
  ) ?? null;
}
