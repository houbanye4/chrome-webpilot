/**
 * llm.js — OpenAI 兼容 API 客户端（流式 + tool_calls 聚合）
 * 兼容任何 OpenAI 格式端点：官方 / 聚合网关（默认 Rqu AI: https://api.rqu.cn/v1）
 */

/**
 * 流式对话，逐 delta yield。
 * @param {object} opts {baseUrl, apiKey, model, messages, tools, temperature, signal}
 */
export async function* streamChat(opts) {
  const { baseUrl, apiKey, model, messages, tools, temperature = 0.2, signal } = opts;
  const body = { model, messages, temperature, stream: true };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API 请求失败 ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta) yield delta;
      } catch { /* 忽略无法解析的行 */ }
    }
  }
}

/**
 * 非流式封装：聚合一次完整响应（文本 + tool_calls）。
 * @param {object} opts 同 streamChat
 * @param {(delta:string)=>void} [onDelta] 文本增量回调（用于 UI 实时显示）
 * @returns {Promise<{content:string, toolCalls:Array, assistantMsg:object, usage:object|null}>}
 */
export async function chatOnce(opts, onDelta) {
  let content = '';
  const toolCalls = new Map(); // index -> call
  let usage = null;

  for await (const delta of streamChat(opts)) {
    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = toolCalls.get(i) ?? {
        id: '', type: 'function', function: { name: '', arguments: '' },
      };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      toolCalls.set(i, cur);
    }
    // 部分网关在最后一个 chunk 带 usage
    if (delta.usage) usage = delta.usage;
  }

  const calls = [...toolCalls.values()];
  const assistantMsg = { role: 'assistant', content: content || null };
  if (calls.length) assistantMsg.tool_calls = calls;
  return { content, toolCalls: calls, assistantMsg, usage };
}

/**
 * 拉取网关的模型列表（用于设置页）。
 */
export async function listModels(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`获取模型列表失败 ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id).sort();
}
