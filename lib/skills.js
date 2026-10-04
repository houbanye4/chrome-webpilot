/**
 * skills.js — 技能系统：可安装、可分享、可自学习的指令包
 *
 * 技能格式（webpilot-skill/v1）：
 * {
 *   "format": "webpilot-skill/v1",
 *   "name": "daily-report",          // 唯一标识（小写字母数字连字符）
 *   "title": "每日资讯报告",
 *   "description": "收集多个新闻站要闻并汇总",
 *   "instructions": "……给智能体的行为指令……",
 *   "author": "…", "version": "1.0"
 * }
 *
 * 安装途径：
 *  1. 用户从 URL / 粘贴 JSON 导入（installFromSource）
 *  2. 智能体执行任务成功后自行总结生成（saveSkill，即"自己安装 skills"）
 *  3. 出厂预置技能（PRESET_SKILLS，首次启动写入）
 */

const SKILL_FORMAT = 'webpilot-skill/v1';
const STORAGE_KEY = 'wp_skills';
const BOOTSTRAP_KEY = 'wp_skills_bootstrapped';

/** 出厂预置技能 */
export const PRESET_SKILLS = [
  {
    format: SKILL_FORMAT,
    name: 'deep-research',
    title: '深度调研',
    description: '跨多个网页收集信息并输出结构化报告',
    instructions: `执行本任务时遵循"深度调研"流程：
1. 先用 open_tab 依次打开 3~5 个相关来源（搜索页或已知站点），不要只看一个页面；
2. 每个来源用 get_page_state + read_page_text 提取关键事实，用 find_in_page 定位数据；
3. 交叉核对：不同来源说法不一致时，在报告中注明分歧；
4. 最终用 done 输出结构化报告：## 核心结论（3 条以内）→ ## 详细发现（分点）→ ## 来源列表（标题+URL）。`,
    author: 'WebPilot 内置',
    version: '1.0',
  },
  {
    format: SKILL_FORMAT,
    name: 'form-filler',
    title: '表单填写助手',
    description: '逐字段核对语义后填写表单，敏感字段必先确认',
    instructions: `执行本任务时遵循"表单填写"规范：
1. 先 get_page_state 通读全部字段与 label，列出"需要用户提供的字段清单"；
2. 用 ask_user 一次性向用户收集缺失信息，不要逐个字段反复提问；
3. 逐字段 type_text，每次输入前确认 [n] 编号对应的字段语义匹配；
4. 涉及手机号/身份证/密码的字段，必须 ask_user 得到明确确认后才输入；
5. 提交前把所有已填内容汇总给用户确认，得到"允许"后 submit。`,
    author: 'WebPilot 内置',
    version: '1.0',
  },
  {
    format: SKILL_FORMAT,
    name: 'price-hunter',
    title: '比价猎手',
    description: '在电商/票务页面寻找最低价并给出对比表',
    instructions: `执行本任务时遵循"比价"流程：
1. 打开至少 2 个可比价来源（或同一站点的多个筛选页）；
2. 提取：商品名/规格、价格、优惠、链接，注意区分原价与到手价；
3. 用 ask_user 确认用户在意"最低价"还是"性价比"；
4. 用 done 输出对比表（markdown 表格）+ 最优推荐 + 每项的直达链接。`,
    author: 'WebPilot 内置',
    version: '1.0',
  },
];

/** 读取全部技能 */
export async function listSkills() {
  const bootstrapped = (await chrome.storage.local.get(BOOTSTRAP_KEY))[BOOTSTRAP_KEY];
  if (!bootstrapped) {
    // 首次启动：写入预置技能
    const existing = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? [];
    const names = new Set(existing.map((s) => s.name));
    const merged = [...existing, ...PRESET_SKILLS.filter((s) => !names.has(s.name))];
    await chrome.storage.local.set({ [STORAGE_KEY]: merged, [BOOTSTRAP_KEY]: true });
    return merged;
  }
  return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? [];
}

async function writeAll(skills) {
  await chrome.storage.local.set({ [STORAGE_KEY]: skills });
}

/** 校验并规范化技能对象，不合格抛错 */
export function validateSkill(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('技能必须是 JSON 对象');
  if (raw.format !== SKILL_FORMAT) throw new Error(`format 必须为 "${SKILL_FORMAT}"`);
  const name = String(raw.name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) {
    throw new Error('name 必须为 2~40 位小写字母/数字/连字符');
  }
  const title = String(raw.title ?? '').trim();
  const instructions = String(raw.instructions ?? '').trim();
  if (!title) throw new Error('缺少 title');
  if (instructions.length < 20) throw new Error('instructions 太短（至少 20 字符）');
  return {
    format: SKILL_FORMAT,
    name,
    title,
    description: String(raw.description ?? '').trim(),
    instructions,
    author: String(raw.author ?? '未知').trim(),
    version: String(raw.version ?? '1.0'),
    learned: !!raw.learned, // 是否为智能体自学生成
  };
}

/** 安装/更新技能（按 name 去重） */
export async function installSkill(raw, { learned = false } = {}) {
  const skill = validateSkill({ ...raw, learned });
  const skills = await listSkills();
  const idx = skills.findIndex((s) => s.name === skill.name);
  if (idx >= 0) skills[idx] = skill;
  else skills.push(skill);
  await writeAll(skills);
  return skill;
}

/** 从 URL 安装技能包（支持单技能 JSON 或 {skills:[...]} 合集） */
export async function installFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data) ? data : data.skills ?? [data];
  const results = [];
  for (const raw of items) results.push(await installSkill(raw));
  return results;
}

/** 智能体自学：保存新技能 */
export async function saveLearnedSkill(args) {
  return installSkill(
    {
      format: SKILL_FORMAT,
      name: args.name,
      title: args.title,
      description: args.description,
      instructions: args.instructions,
      author: '智能体自学',
      version: '1.0',
    },
    { learned: true }
  );
}

export async function deleteSkill(name) {
  const skills = (await listSkills()).filter((s) => s.name !== name);
  await writeAll(skills);
}

export async function toggleSkill(name, enabled) {
  const skills = await listSkills();
  const s = skills.find((x) => x.name === name);
  if (!s) return;
  s.enabled = enabled;
  await writeAll(skills);
}

/** 拼接进 system prompt 的已启用技能文本 */
export async function renderActiveSkills() {
  const skills = await listSkills();
  const active = skills.filter((s) => s.enabled !== false); // 默认启用
  if (!active.length) return '';
  return (
    '\n\n【已安装技能】以下是用户安装的技能指令，若当前任务与某技能相关，严格按其流程执行：\n' +
    active.map((s) => `\n◆ 技能「${s.title}」（${s.name}）\n${s.instructions}`).join('\n')
  );
}
