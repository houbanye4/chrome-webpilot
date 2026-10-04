/**
 * tools.js — 内置工具定义与执行
 * 工具通过 chrome.scripting 注入的 content script（content/agent-content.js）操作页面，
 * 通过 chrome.tabs 完成导航与标签页管理。
 */

// ---------- 工具 Schema（OpenAI function calling 格式） ----------

export const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_page_state',
      description: '获取当前标签页的状态：URL、标题、可交互元素清单（带编号 [n]）、正文摘要。每次操作前后都应调用以了解页面。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: '点击页面上编号为 n 的元素（编号来自 get_page_state 的 [n]）。',
      parameters: {
        type: 'object',
        properties: { n: { type: 'integer', description: '元素编号' } },
        required: ['n'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: '向编号为 n 的输入框输入文本。submit=true 时按回车提交（如搜索框）。',
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: '输入框编号' },
          text: { type: 'string', description: '要输入的文本' },
          submit: { type: 'boolean', description: '是否回车提交，默认 false' },
        },
        required: ['n', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: '滚动页面。direction: up/down/top/bottom，amount 像素（默认 600）。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
          amount: { type: 'integer' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: '让当前标签页跳转到指定 URL。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 URL，含 https://' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_tab',
      description: '新开一个标签页并导航到 URL，返回新标签页 id。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_tab',
      description: '切换到指定 id 的标签页。',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'integer' } },
        required: ['tabId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_in_page',
      description: '在页面正文中搜索关键词，返回命中行及上下文。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page_text',
      description: '读取页面完整正文文本（截断到 8000 字符）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '向用户提问并等待答复。用于：缺少必要信息（账号、偏好）、执行敏感操作前（登录、支付、删除）确认。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '任务完成时调用，给出结果总结。之后立即停止执行。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '任务结果总结' } },
        required: ['summary'],
      },
    },
  },
];

// ---------- 工具执行 ----------

/** 等待标签页加载完成 */
function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(true); }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); }
    chrome.tabs.onUpdated.addListener(listener);
    // 立即检查一次，避免"注册监听前已加载完成"的竞态
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') { cleanup(); resolve(true); }
    }).catch(() => { cleanup(); resolve(false); });
  });
}

export class ToolContext {
  /**
   * @param {object} opts {settings, emit}
   * emit(event) 用于向 UI 推送 ask_user 等事件
   */
  constructor({ settings, emit }) {
    this.settings = settings;
    this.emit = emit;
    this.tabId = null; // 当前工作标签页，由 start(task) 决定
    this.finished = false;
    this.summary = null;
  }

  async _ensureContentScript() {
    const tabId = await this._activeTabId();
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/agent-content.js'],
      });
    }
    return tabId;
  }

  async _activeTabId() {
    if (this.tabId != null) return this.tabId;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('没有活动标签页');
    this.tabId = tab.id;
    return tab.id;
  }

  async _sendToPage(msg) {
    const tabId = await this._ensureContentScript();
    return chrome.tabs.sendMessage(tabId, msg);
  }

  async execute(name, args) {
    args = args ?? {};
    switch (name) {
      case 'get_page_state': {
        const r = await this._sendToPage({ type: 'SNAPSHOT' });
        return `URL: ${r.url}\n标题: ${r.title}\n\n可交互元素：\n${r.elements || '（无）'}\n\n正文摘要：\n${r.text}`;
      }
      case 'click_element': {
        await this._sendToPage({ type: 'HIGHLIGHT', aid: args.n });
        const r = await this._sendToPage({ type: 'CLICK', aid: args.n });
        await new Promise((s) => setTimeout(s, 800)); // 等页面反应
        return r.ok ? `已点击元素 [${args.n}]：${r.desc ?? ''}` : `点击失败：${r.error}`;
      }
      case 'type_text': {
        if (args.submit && this.settings.confirmDangerous) {
          const ans = await this._askUser(`智能体想要向输入框 [${args.n}] 提交文本："${args.text}"，是否允许？(允许/拒绝)`);
          if (!/允许|yes|ok|好/i.test(ans)) return '用户拒绝了该提交操作。';
        }
        await this._sendToPage({ type: 'HIGHLIGHT', aid: args.n });
        const r = await this._sendToPage({ type: 'TYPE', aid: args.n, text: args.text, submit: !!args.submit });
        return r.ok ? `已在 [${args.n}] 输入文本${args.submit ? '并提交' : ''}` : `输入失败：${r.error}`;
      }
      case 'scroll_page': {
        const r = await this._sendToPage({ type: 'SCROLL', direction: args.direction, amount: args.amount });
        return r.ok ? '已滚动' : '滚动失败';
      }
      case 'navigate': {
        const tabId = await this._activeTabId();
        await chrome.tabs.update(tabId, { url: args.url });
        await waitTabComplete(tabId);
        await new Promise((s) => setTimeout(s, 500));
        return `已导航到 ${args.url}`;
      }
      case 'open_tab': {
        const tab = await chrome.tabs.create({ url: args.url, active: false });
        await waitTabComplete(tab.id);
        this.tabId = tab.id; // 后续操作切到新标签页
        return `已在新标签页打开 ${args.url}（tabId=${tab.id}）`;
      }
      case 'switch_tab': {
        await chrome.tabs.get(args.tabId); // 校验存在
        await chrome.tabs.update(args.tabId, { active: true });
        chrome.windows.update((await chrome.tabs.get(args.tabId)).windowId, { focused: true });
        this.tabId = args.tabId;
        return `已切换到标签页 ${args.tabId}`;
      }
      case 'find_in_page': {
        const r = await this._sendToPage({ type: 'FIND', query: args.query });
        return r.ok ? (r.hits || '页面中未找到该关键词') : '查找失败';
      }
      case 'read_page_text': {
        const r = await this._sendToPage({ type: 'READ_TEXT' });
        return r.ok ? r.text : '读取失败';
      }
      case 'ask_user': {
        const answer = await this._askUser(args.question);
        return `用户回答：${answer}`;
      }
      case 'done': {
        this.finished = true;
        this.summary = args.summary ?? '任务完成';
        return '完成';
      }
      default:
        return `未知工具: ${name}`;
    }
  }

  /** 通过 UI 事件向用户提问，返回 Promise<答案> */
  _askUser(question) {
    return new Promise((resolve) => {
      const id = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const listener = (msg) => {
        if (msg.type === 'ASK_ANSWER' && msg.id === id) {
          chrome.runtime.onMessage.removeListener(listener);
          resolve(msg.answer);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      this.emit({ kind: 'ask_user', id, question });
    });
  }
}

/** 把 MCP 工具包装进统一 schema 列表 */
export function mcpToolToSchema(serverName, tool) {
  return {
    type: 'function',
    function: {
      name: `mcp__${serverName}__${tool.name}`,
      description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
      parameters: tool.inputSchema ?? { type: 'object', properties: {}, required: [] },
    },
  };
}
