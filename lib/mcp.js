/**
 * mcp.js — MCP (Model Context Protocol) 客户端
 * 实现 Streamable HTTP 传输（JSON-RPC over HTTP POST，兼容 SSE 响应）。
 * 通过它可以把外部 MCP Server 的工具动态注入智能体。
 *
 * 配置示例（设置页）：
 * [{ "name": "fetch", "url": "http://localhost:8931/mcp" }]
 */

const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  /** @param {{name:string, url:string, headers?:object}} server */
  constructor(server) {
    this.name = server.name;
    this.url = server.url;
    this.headers = server.headers ?? {};
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  async _rpc(method, params, { notification = false } = {}) {
    const payload = { jsonrpc: '2.0', method };
    if (!notification) payload.id = this.nextId++;
    if (params !== undefined) payload.params = params;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(payload),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!res.ok) throw new Error(`MCP ${this.name} ${method} 失败: HTTP ${res.status}`);
    if (notification) return null;

    const ct = res.headers.get('content-type') ?? '';
    let text = await res.text();
    if (ct.includes('text/event-stream')) {
      // SSE：取最后一个 data 行的 JSON
      const datas = text.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      text = datas[datas.length - 1] ?? '';
    }
    const json = JSON.parse(text);
    if (json.error) throw new Error(`MCP ${this.name} ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
    return json.result;
  }

  async init() {
    if (this.initialized) return;
    await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'WebPilot-AI', version: '0.1.0' },
    });
    await this._rpc('notifications/initialized', undefined, { notification: true });
    this.initialized = true;
  }

  /** @returns {Promise<Array<{name, description?, inputSchema?}>>} */
  async listTools() {
    await this.init();
    const result = await this._rpc('tools/list', {});
    return result?.tools ?? [];
  }

  async callTool(toolName, args) {
    const result = await this._rpc('tools/call', { name: toolName, arguments: args ?? {} });
    if (result?.isError) {
      const text = _contentToText(result.content);
      throw new Error(text || 'MCP 工具执行出错');
    }
    return _contentToText(result?.content);
  }
}

function _contentToText(content) {
  if (!Array.isArray(content)) return JSON.stringify(content ?? {});
  return content
    .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n');
}

/**
 * 连接所有已配置的 MCP Server，返回
 * { tools: OpenAI schema[], call: (qualifiedName, args)=>Promise<string>, clients: McpClient[] }
 */
export async function connectMcpServers(servers = [], log = () => {}) {
  const clients = [];
  const toolMap = new Map(); // qualifiedName -> {client, toolName}
  for (const server of servers) {
    try {
      const client = new McpClient(server);
      const tools = await client.listTools();
      for (const t of tools) {
        const qname = `mcp__${server.name}__${t.name}`;
        toolMap.set(qname, { client, toolName: t.name });
      }
      clients.push(client);
      log(`MCP [${server.name}] 已连接，加载 ${tools.length} 个工具`);
    } catch (e) {
      log(`MCP [${server.name}] 连接失败: ${e.message}`);
    }
  }
  return {
    clients,
    async call(qualifiedName, args) {
      const entry = toolMap.get(qualifiedName);
      if (!entry) return `未找到 MCP 工具: ${qualifiedName}`;
      return entry.client.callTool(entry.toolName, args);
    },
  };
}
