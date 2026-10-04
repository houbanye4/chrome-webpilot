/**
 * agent-content.js — 注入页面的感知与操作层
 * 职责：
 *  1. SNAPSHOT：把可交互元素序列化为带编号 [n] 的清单（token 友好）
 *  2. CLICK / TYPE / SCROLL / FIND / READ_TEXT：执行动作
 *  3. HIGHLIGHT：高亮目标元素，让用户看到智能体在做什么
 * 幂等注入：重复注入不产生重复监听。
 */
(() => {
  if (window.__webpilotLoaded) return;
  window.__webpilotLoaded = true;

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
    '[role="radio"]', '[role="combobox"]', '[onclick]', 'option',
  ].join(', ');

  const MAX_ELEMENTS = 150;
  const TEXT_PREVIEW = 3000;
  const READ_LIMIT = 8000;

  // ---------- 元素描述 ----------

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      (el.tagName === 'INPUT' && el.labels?.[0]?.innerText.trim().slice(0, 40)) ||
      '';
    const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const href = tag === 'a' && el.getAttribute('href') ? ` → ${el.getAttribute('href').slice(0, 80)}` : '';
    const parts = [`<${tag}${type ? ` type=${type}` : ''}>`];
    if (text) parts.push(`"${text}"`);
    if (label && label !== text) parts.push(`(label: ${label.slice(0, 40)})`);
    if (tag === 'input' && !label && !text) parts.push('(空输入框)');
    parts.push(href);
    return parts.filter(Boolean).join(' ');
  }

  function collectInteractive() {
    document.querySelectorAll('[data-aid]').forEach((el) => el.removeAttribute('data-aid'));
    const els = [...document.querySelectorAll(INTERACTIVE_SELECTOR)].filter(isVisible);
    const lines = [];
    els.slice(0, MAX_ELEMENTS).forEach((el, i) => {
      const aid = i + 1;
      el.setAttribute('data-aid', String(aid));
      lines.push(`[${aid}] ${describe(el)}`);
    });
    return { els, lines };
  }

  // ---------- 高亮 ----------

  function highlight(aid) {
    const el = document.querySelector(`[data-aid="${aid}"]`);
    if (!el) return;
    const old = document.querySelector('.__webpilot_hl');
    old?.remove();
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = '__webpilot_hl';
    box.style.cssText = [
      'position:fixed', `left:${rect.left - 2}px`, `top:${rect.top - 2}px`,
      `width:${rect.width + 4}px`, `height:${rect.height + 4}px`,
      'border:2px solid #7c5cff', 'border-radius:4px', 'pointer-events:none',
      'z-index:2147483647', 'box-shadow:0 0 0 3px rgba(124,92,255,.25)',
      'transition:all .15s',
    ].join(';');
    const tag = document.createElement('div');
    tag.textContent = `#${aid}`;
    tag.style.cssText = [
      'position:absolute', 'top:-22px', 'left:0', 'background:#7c5cff', 'color:#fff',
      'font:600 12px/18px sans-serif', 'padding:1px 7px', 'border-radius:4px',
    ].join(';');
    box.appendChild(tag);
    document.documentElement.appendChild(box);
    setTimeout(() => box.remove(), 1500);
  }

  // ---------- 动作 ----------

  function nativeSetValue(el, text) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function doClick(aid) {
    const el = document.querySelector(`[data-aid="${aid}"]`);
    if (!el) return { ok: false, error: `页面中找不到元素 #${aid}（页面可能已变化，请重新 get_page_state）` };
    // 触发完整鼠标事件序列，兼容大多数框架
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    if (typeof el.click === 'function') { try { el.click(); } catch { /* 已派发 */ } }
    return { ok: true, desc: describe(el) };
  }

  function doType(aid, text, submit) {
    const el = document.querySelector(`[data-aid="${aid}"]`);
    if (!el) return { ok: false, error: `找不到输入框 #${aid}` };
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && el.getAttribute('role') !== 'combobox') {
      return { ok: false, error: `元素 #${aid} 不是输入框（${el.tagName}）` };
    }
    el.focus();
    nativeSetValue(el, text);
    if (submit) {
      const form = el.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }
    return { ok: true };
  }

  function doFind(query) {
    const bodyText = document.body.innerText;
    const lines = bodyText.split('\n');
    const q = query.toLowerCase();
    const hits = [];
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(q) && hits.length < 20) {
        hits.push(`L${i}: ${line.trim().slice(0, 160)}`);
      }
    });
    return { ok: true, hits: hits.length ? hits.join('\n') : '' };
  }

  // ---------- 消息处理 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.type) {
        case 'PING':
          sendResponse({ ok: true });
          return false;
        case 'SNAPSHOT': {
          const { lines } = collectInteractive();
          sendResponse({
            ok: true,
            url: location.href,
            title: document.title,
            elements: lines.join('\n'),
            text: (document.body.innerText || '').trim().slice(0, TEXT_PREVIEW),
          });
          return false;
        }
        case 'HIGHLIGHT':
          highlight(msg.aid);
          sendResponse({ ok: true });
          return false;
        case 'CLICK':
          sendResponse(doClick(msg.aid));
          return false;
        case 'TYPE':
          sendResponse(doType(msg.aid, msg.text, msg.submit));
          return false;
        case 'SCROLL': {
          const amount = msg.amount ?? 600;
          const dirs = {
            up: () => scrollBy({ top: -amount, behavior: 'smooth' }),
            down: () => scrollBy({ top: amount, behavior: 'smooth' }),
            top: () => scrollTo({ top: 0, behavior: 'smooth' }),
            bottom: () => scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
          };
          (dirs[msg.direction] ?? dirs.down)();
          sendResponse({ ok: true });
          return false;
        }
        case 'FIND':
          sendResponse(doFind(msg.query));
          return false;
        case 'READ_TEXT':
          sendResponse({
            ok: true,
            text: (document.body.innerText || '').trim().slice(0, READ_LIMIT),
          });
          return false;
        default:
          return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message ?? e) });
      return false;
    }
  });
})();
