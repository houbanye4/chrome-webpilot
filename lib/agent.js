/**
 * agent.js — 智能体主循环：ReAct 式 工具调用循环
 */

import { chatOnce } from './llm.js';
import { BUILTIN_TOOLS, ToolContext, mcpToolToSchema } from './tools.js';
import { connectMcpServers } from './mcp.js';
import { renderActiveSkills, saveLearnedSkill } from './skills.js';

export const SYSTEM_PROMPT = `你是运行在用户 Chrome 浏览器中的智能体 WebPilot。你可以通过工具查看和操作浏览器标签页，自主完成用户交给你的网页任务。

工作准则：
1. 动手前先用 get_page_state 了解当前页面；每次点击/输入/跳转后，再调用 get_page_state 验证结果。
2. 只操作编号明确的元素：点击和输入使用的编号必须来自最近一次 get_page_state 的输出 [n]。
3. 表单任务逐字段进行，输入前先看清字段的 label/placeholder 语义。
4. 遇到以下情况必须用 ask_user 询问用户：缺少账号/验证码/支付信息；要执行登录、支付、删除、发送消息等敏感操作；页面出现验证码或反自动化拦截（此时如实告知用户，不得尝试绕过）。
5. 如果某个操作连续失败 2 次，换一种思路或向用户求助，不要死循环重试。
6. 任务完成后调用 done 工具，用中文总结结果（包含关键信息，如找到的价格、填写的内容）。
7. 严格遵守目标网站的服务条款，不抓取绕过权限的内容。

【技能自学习】如果本次任务的完成流程对未来的类似任务有复用价值（如一套有效的搜索-提取-汇总步骤、某类网站的填写套路），在调用 done 之前先用 save_skill 工具把它沉淀为技能：
- name: 体现场景的小写短横线名（如 price-hunter）
- title/description: 一句话说明适用场景
- instructions: 面向未来的你写的通用流程（不要包含本次任务的临时信息如具体网址、具体价格）
- 仅在流程确实可复用时保存；不要为一次性任务保存技能。`;

export const DEFAULTS = {
  baseUrl: 'https://api.rqu.cn/v1',
  model: 'gpt-4o-mini',
  maxSteps: 20,
  temperature: 0.2,
  confirmDangerous: true,
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULTS, ...stored };
}

/** save_skill 工具 schema（执行在 agent 循环内拦截，走 skills.js） */
const SKILL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_skill',
      description: '把本次任务中可复用的通用流程保存为技能（用户可在技能库查看/启用，下次同类任务自动应用）。仅在流程确实可复用时调用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能标识：2~40 位小写字母/数字/连字符，如 price-hunter' },
          title: { type: 'string', description: '技能标题' },
          description: { type: 'string', description: '一句话说明适用场景' },
          instructions: { type: 'string', description: '面向未来的通用流程指令，不含本次任务的临时信息（具体网址/价格）' },
        },
        required: ['name', 'title', 'instructions'],
      },
    },
  },
];

async function skillsPrompt() {
  try { return await renderActiveSkills(); } catch { return ''; }
}

export class Agent {
  /**
   * @param {object} opts { settings, emit(event), askAnswer 处理已由 ToolContext 内建 }
   * emit(event) 把过程事件推给 UI：{kind:'step'|'delta'|'tool_start'|'tool_result'|'mcp_log'|'final'|'error', ...}
   */
  constructor({ settings, emit, auto = false }) {
    this.settings = settings;
    this.emit = emit;
    this.auto = auto; // 无人值守模式（定时任务）
    this.abort = new AbortController();
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  async run(task) {
    const { settings, emit } = this;
    const ctx = new ToolContext({ settings, emit, auto: this.auto });

    // 连接 MCP servers（失败不影响主流程）
    let mcp = { tools: [], call: async () => 'MCP 未连接' };
    try {
      mcp = await connectMcpServers(settings.mcpServers ?? [], (msg) =>
        emit({ kind: 'mcp_log', msg })
      );
    } catch (e) {
      emit({ kind: 'mcp_log', msg: `MCP 初始化失败: ${e.message}` });
    }
    const tools = [
      ...BUILTIN_TOOLS,
      ...SKILL_TOOLS,
      ...((settings.mcpServers ?? []).length ? await this._mcpSchemas(settings) : []),
    ];

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + (await skillsPrompt()) },
      { role: 'user', content: `请帮我完成以下任务：\n${task}` },
    ];

    let finalText = null;
    for (let step = 1; step <= settings.maxSteps; step++) {
      if (this.stopped) throw new Error('已手动停止');

      emit({ kind: 'step', step, max: settings.maxSteps });
      const { content, toolCalls, assistantMsg } = await chatOnce(
        {
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          messages,
          tools,
          temperature: settings.temperature,
          signal: this.abort.signal,
        },
        (delta) => emit({ kind: 'delta', text: delta })
      );

      if (!toolCalls.length) {
        finalText = content;
        break;
      }

      messages.push(assistantMsg);
      for (const call of toolCalls) {
        let name = call.function.name;
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 保持 {} */ }

        emit({ kind: 'tool_start', name, args });

        let result;
        try {
          if (name === 'done') {
            result = await ctx.execute('done', args);
          } else if (name === 'save_skill') {
            const skill = await saveLearnedSkill(args);
            result = `技能「${skill.title}」已保存到技能库，用户可在设置中管理。`;
            emit({ kind: 'skill_saved', title: skill.title, name: skill.name });
          } else if (name.startsWith('mcp__')) {
            result = await mcp.call(name, args);
          } else {
            result = await ctx.execute(name, args);
          }
        } catch (e) {
          result = `工具执行出错: ${e.message}`;
        }
        emit({ kind: 'tool_result', name, result: String(result).slice(0, 500) });

        if (ctx.finished) {
          emit({ kind: 'final', text: ctx.summary });
          return ctx.summary;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
    }

    if (!finalText && ctx.summary) finalText = ctx.summary;
    emit({
      kind: 'final',
      text: finalText ?? `已达到最大步数（${settings.maxSteps}）而停止。可以在设置中调高步数后继续。`,
    });
    return finalText;
  }

  async _mcpSchemas(settings) {
    const schemas = [];
    for (const server of settings.mcpServers ?? []) {
      try {
        const { McpClient } = await import('./mcp.js');
        const client = new McpClient(server);
        const tools = await client.listTools();
        for (const t of tools) schemas.push(mcpToolToSchema(server.name, t));
      } catch { /* connectMcpServers 已记录日志 */ }
    }
    return schemas;
  }
}
