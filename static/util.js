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
  function toast(message, isError = false) {
    const node = document.getElementById('toast');
    node.textContent = message;
    node.classList.toggle('error', !!isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 5200 : 2400);
  }

  /** True when focus is somewhere the user is typing, so shortcuts back off. */
  function typing() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }

  return { tc, dur, clamp, el, uid, debounce, api, toast, typing };
})();
