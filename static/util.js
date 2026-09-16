/* Shared helpers. Plain globals on purpose: no build step, no bundler,
   just reload the page. */

const U = (() => {
  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

  /** 01:23:45.678 - always full hours so columns line up while scrubbing. */
  function tc(seconds, ms = true) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
    return ms ? `${base}.${pad(Math.round((seconds % 1) * 1000), 3)}` : base;
  }

  /** Compact duration for labels: 4.2s, 1:04, 1:02:03 */
  function dur(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') {
        // Object.assign silently drops "--custom" properties; setProperty is required.
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) node.style.setProperty(prop, val);
          else node.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /** Never let an object reach textContent - that is what renders as
   *  "[object Object]". Objects and arrays are shown as JSON instead. */
  function asText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  }

  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function debounce(fn, ms) {
    let t;
    const wrapped = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
    return wrapped;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error page */ }
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    return data;
  }

  let toastTimer = null;
  function toast(message, isError = false, detail = '') {
    const node = document.getElementById('toast');
    if (!node) { console[isError ? 'error' : 'log'](message, detail); return; }
    node.innerHTML = '';
    node.appendChild(el('div', { text: message }));
    if (detail) node.appendChild(el('div', { class: 'loc', text: detail }));
    node.classList.toggle('error', !!isError);
    node.hidden = false;
    node.onclick = () => { node.hidden = true; };
    clearTimeout(toastTimer);
    // Errors carry a location worth reading; give them longer on screen.
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 12000 : 2400);
  }

  /** "app.js:98:32" - the first frame of the stack that names one of our files.
   *  Firefox frames look like `openSession@http://host/static/js/app.js:98:32`,
   *  Chrome's like `    at openSession (http://host/static/js/app.js:98:32)`;
   *  the file:line:col tail is the same in both. */
  function origin(err) {
    const stack = (err && err.stack) || '';
    for (const line of stack.split('\n')) {
      const m = line.match(/([\w.-]+\.js):(\d+):(\d+)/);
      if (m) return `${m[1]}:${m[2]}:${m[3]}`;
    }
    return '';
  }

  /** Report a caught error usefully: full object to the console (so the
   *  stack is one click away), message + file:line to the toast. */
  function fail(err, context = '') {
    console.error(context ? `${context}:` : 'error:', err);
    const message = (err && err.message) || String(err);
    const loc = origin(err);
    const fn = (err && err.stack || '').match(/(?:at |^)\s*([\w.$<>]+)\s*[@(]/m);
    const detail = [loc, fn && fn[1] !== 'Object' ? `in ${fn[1]}()` : ''].filter(Boolean).join('  ');
    toast(context ? `${context}: ${message}` : message, true, detail);
  }

  /** Nothing should reach the user as a bare TypeError with no location. */
  function installErrorReporting() {
    window.addEventListener('error', (e) => {
      if (e.error) fail(e.error, 'Uncaught');
      else toast(`Uncaught: ${e.message}`, true, `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener('unhandledrejection', (e) => fail(e.reason, 'Unhandled promise rejection'));
  }

  /** True when focus is somewhere the user is typing, so shortcuts back off. */
  function typing() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }

  return { tc, dur, clamp, el, uid, debounce, api, toast, typing, asText, fail, origin, installErrorReporting };
})();