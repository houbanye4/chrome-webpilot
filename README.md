# WebPilot AI — 浏览器智能体 Chrome 插件

<div align="center">

🌐 **让 AI 替你操作浏览器：自动浏览网页、填表单、查信息、执行多步骤任务**

[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../pulls)

**一个开源的 browser-use 智能体，直接住进你的 Chrome 侧边栏。**
接入任意 OpenAI 兼容 API —— 默认配置 [Rqu AI](https://www.rqu.cn) 聚合网关，一个 Key 驱动 GPT / Claude / Gemini / DeepSeek。

</div>

---

## ✨ 它能做什么

> *"在这个页面找到最便宜的机票，告诉我价格和航班号"*
> *"打开 Bing 搜索今日科技新闻，把前 3 条的标题和链接整理给我"*
> *"帮我把这个表单填了（每填一项前先问我）"*

WebPilot 是一个 **ReAct 式智能体**：拿到任务后自主规划 → 观察页面 → 调用工具（点击/输入/滚动/跳转）→ 根据结果调整 → 直到完成任务并汇报。全过程在侧边栏实时可视化。

**核心特性：**

- 🤖 **自主多步执行** — 基于 function calling 的智能体循环，平均 5~15 步完成一个网页任务
- 👁️ **页面感知** — 把 DOM 序列化为带编号的元素清单（token 友好），模型"看得懂"页面结构
- 🖱️ **真实操作** — 点击、输入（兼容 React 受控组件）、滚动、跳转、多标签页切换，操作时高亮目标元素
- 🔌 **任意 OpenAI 兼容端点** — 官方 API 或任意聚合网关，改一个 URL 即可切换
- 🧩 **MCP 支持** — 通过 Streamable HTTP 接入 MCP Server，外部工具自动注入智能体
- 🛡️ **人在回路** — 登录/支付/提交表单等敏感动作默认弹窗向你确认；内置 `ask_user` 工具随时提问
- 💬 **侧边栏可视化** — 每一步的模型思考、工具调用参数与结果全部展开可查

## 🚀 5 分钟上手

### 第 1 步：加载插件

```bash
git clone https://github.com/your-name/chrome-webpilot.git
```

Chrome 打开 `chrome://extensions` → 右上角开启 **开发者模式** → **加载已解压的扩展程序** → 选择本项目目录。

### 第 2 步：拿到 API Key（默认网关：Rqu AI）

1. 打开 [rqu.cn](https://www.rqu.cn) 注册账号
2. 控制台 → 充值（¥10 起步，够用很久）→ 创建 API Key
3. 复制 `sk-` 开头的密钥

> 💡 为什么默认接入 Rqu AI？见下文[「关于默认网关」](#-关于默认网关-rqu-ai)。你也可以用任何 OpenAI 兼容端点（含官方 API），插件不锁定服务商。

### 第 3 步：配置并开跑

点击插件图标打开侧边栏 → 右上角 ⚙ → 粘贴 API Key → 点「获取模型列表」选一个支持工具调用的模型（推荐 `gpt-4o-mini`）→ 保存。

回到侧边栏，输入任务，回车。🎬 看它干活。

## 🧩 MCP：给智能体外挂工具

WebPilot 内置 **MCP（Model Context Protocol）客户端**（Streamable HTTP 传输）。在设置页填入 MCP Server 配置，其工具会自动注入智能体：

```json
[
  { "name": "fetch", "url": "http://localhost:8931/mcp" },
  { "name": "search", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer xxx" } }
]
```

> 本地 stdio 型 MCP Server（如官方 filesystem server）可通过 [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) 一行命令转为 HTTP：
> `mcp-proxy --port 8931 -- npx -y @modelcontextprotocol/server-filesystem ~/Documents`

接入后模型可直接调用 `mcp__fetch__fetch` 等工具，配合浏览器操作能力做更复杂的事——比如抓取本地文件内容填进网页表单。

## 🏗️ 架构

```
┌─────────────────── Chrome ───────────────────┐
│  ┌─ Side Panel ──────┐   ┌─ Service Worker ─┐ │
│  │  聊天 UI / 确认栏  │◀─▶│  Agent 循环       │ │
│  └───────────────────┘   │  ├─ llm.js (流式) │ │
│                          │  ├─ tools.js      │ │──▶ OpenAI 兼容 API
│  ┌─ Content Script ──┐   │  └─ mcp.js ──────────▶ MCP Servers (HTTP)
│  │  DOM 序列化/编号   │◀─▶│                   │ │
│  │  点击/输入/高亮    │   └──────────────────┘ │
│  └───────────────────┘                        │
└───────────────────────────────────────────────┘
```

**一轮工具调用的生命周期**：

1. Agent 把「系统提示词 + 任务 + 历史」发给 LLM（附带工具 schema）
2. LLM 返回 `tool_calls`，如 `get_page_state` → `click_element {n: 12}`
3. Service Worker 通过 `chrome.scripting` 确保 content script 注入，转发动作
4. Content script 在页面里执行，返回结果
5. 结果回填 `role: "tool"` 消息，进入下一轮，直到模型调用 `done`

## ⚙️ 内置工具清单

| 工具 | 说明 |
|---|---|
| `get_page_state` | 获取 URL、标题、可交互元素清单（带编号）、正文摘要 |
| `click_element {n}` | 点击编号元素（完整鼠标事件序列，兼容前端框架） |
| `type_text {n, text, submit?}` | 输入文本（原生 setter，触发 input/change 事件），可回车提交 |
| `scroll_page {direction}` | 上/下/顶/底滚动 |
| `navigate {url}` / `open_tab` / `switch_tab` | 导航与多标签页管理 |
| `find_in_page {query}` / `read_page_text` | 页内搜索 / 读全文 |
| `ask_user {question}` | 人在回路：向用户提问并等待答复 |
| `done {summary}` | 任务完成汇报 |
| `mcp__server__tool` | 所有已连接 MCP Server 的工具（自动注入） |

## 🔒 安全与隐私

- **敏感操作确认**：默认开启「提交表单前确认」，登录、支付类动作会先问你
- **验证码不碰**：系统提示词明确要求智能体不绕过验证码与反自动化机制——遇拦截会如实告诉你
- **数据去向**：页面内容只发给你配置的 LLM 端点，无任何第三方上报；Key 存在 `chrome.storage.sync`（仅你自己的浏览器账号同步）
- **开源透明**：全部代码 ~1500 行，无构建步骤、无混淆、无遥测，可审计

## 🤝 关于默认网关 Rqu AI

本项目由 [Rqu AI](https://www.rqu.cn) 社区发起维护。默认配置指向 Rqu AI 聚合网关的原因很实际：

1. **一个 Key 调所有模型** — 智能体跑任务时经常想给规划用强模型、给页面摘要用便宜模型，聚合网关下一个端点全搞定；
2. **国内直连**，微信/支付宝充值，无需海外卡；
3. **按量计费**，跑一个网页任务通常几分钱。

当然，**插件不锁定任何服务商**——把 base_url 换成 `https://api.openai.com/v1` 或自部署的 one-api，一样能跑。

## 🗺️ Roadmap

- [ ] Vision 模式：截图感知（支持 GPT-4o / Claude 视觉能力的端点）
- [ ] 任务录制回放：把一次成功执行保存为可复用脚本
- [ ] 多任务并行（多标签页同时执行）
- [ ] stdio MCP 直连（Native Messaging）

欢迎 PR！提交前请跑通：加载插件 → 用 `总结本页` 快捷指令验证基础链路。

## 📄 免责声明

本项目仅用于学习与个人效率提升。使用自动化操作网站时请遵守目标网站的服务条款与当地法律法规，因滥用造成的后果由使用者自行承担。

## ⭐ 支持项目

如果 WebPilot 帮你省了时间，点个 Star ⭐ 再走～

## License

[MIT](LICENSE)
