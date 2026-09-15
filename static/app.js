/* App wiring: menus, the Open dialog, the inspector, stats, autosave.
 *
 * State lives in one object. The project object IS the thing we POST back to
 * the server, so whatever you see in annotations/*.json is exactly what the UI
 * is holding. Mutate it, call markDirty(), done.
 */

const state = {
  root: null,
  scope: 'dataset',   // 'dataset' = the whole recording, 'file' = one mp4
  chunk: 0,
  file: 0,
  session: null,
  project: null,
  browsePath: null,
  browseDataset: null,
};

// Must match API_VERSION in app.py. See checkApi() for why this exists.
const API_VERSION = 2;

const $ = (id) => document.getElementById(id);
const player = new MultiView($('views'));

const timeline = new Timeline({
  bodyEl: $('tl-body'),
  scrollEl: $('tl-scroll'),
  rulerEl: $('ruler'),
  lanesEl: $('lanes'),
  headLanesEl: $('lane-heads'),
  playheadEl: $('playhead'),
  gridEl: $('grid'),
  getProject: () => state.project,
  onChange: () => { markDirty(); renderStats(); },
  onSeek: (t) => player.seek(t),
  onSelectClip: (clip, layer, focusEditor) => renderInspector(clip, layer, focusEditor),
  onSelectionChange: () => refreshCreateButton(),
  onClipPreview: (clip) => updateInspectorTimes(clip),
  onEditClip: () => { const ta = $('clip-text'); if (ta) { ta.focus(); ta.select(); } },
  onAddStyle: (name, layer) => addStyle(name, layer),
});

/* ---------------- saving ---------------- */

let saveState = 'idle';
function setSaveState(next, detail) {
  saveState = next;
  const node = $('save-state');
  node.dataset.state = next;
  node.textContent = { idle: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: detail || 'Save failed' }[next];
}

const saveSoon = U.debounce(() => saveNow(), 700);

function markDirty() {
  if (!state.project) return;
  setSaveState('dirty');
  saveSoon();
}

async function saveNow() {
  if (!state.project) return;
  setSaveState('saving');
  try {
    await U.api('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.project),
    });
    setSaveState('idle');
  } catch (err) {
    setSaveState('error', err.message);
    U.toast(`Could not save: ${err.message}`, true);
  }
}

window.addEventListener('beforeunload', (e) => {
  if (saveState === 'dirty' || saveState === 'saving') { e.preventDefault(); e.returnValue = ''; }
});

/* ---------------- session ---------------- */

/** Catch the server and the frontend being different versions of this app.
 *  Without this you get a TypeError on session.timeline, several frames away
 *  from the actual cause. */
function checkApi(session) {
  if (session && session.api === API_VERSION) return;
  const got = session && session.api ? `v${session.api}` : 'an older response format';
  throw new Error(
    `The server is running a different version of this app (${got}, this page needs v${API_VERSION}). `
    + 'Restart the Flask process to pick up the current code.');
}

async function openSession(root, scope = 'dataset', chunk = 0, file = 0) {
  try {
    const q = `root=${encodeURIComponent(root)}&scope=${scope}&chunk=${chunk}&file=${file}`;
    const session = await U.api(`/api/session?${q}`);
    checkApi(session);
    Object.assign(state, { root, scope: session.scope, chunk, file, session, project: session.project });

    const tl = session.timeline;
    const label = session.scope === 'dataset'
      ? `whole recording · ${U.dur(tl.duration)}`
      : `chunk-${pad3(chunk)}/file-${pad3(file)}`;
    $('ds-name').textContent = `${session.dataset.name} · ${label}`;
    document.title = `${session.dataset.name} — segment annotator`;
    history.replaceState(null, '', `/?${q}`);

    renderScopeSelect(session);

    // Each view is its own playlist: v3 splits every video key independently
    // by file size, so the two cameras' file boundaries do not line up.
    const plan = Object.entries(tl.views).map(([key, p]) => ({
      key,
      segments: p.segments.map((seg) => ({
        start: seg.start,
        end: seg.end,
        label: `chunk-${pad3(seg.chunk_index)}/file-${pad3(seg.file_index)}`,
        url: `/media?root=${encodeURIComponent(root)}&path=${encodeURIComponent(seg.path)}`,
      })),
    }));

    timeline.activeLayerId = state.project.layers[0]?.id || null;
    timeline.selectedClipId = null;
    timeline.selection = null;
    timeline._fitted = false;
    timeline.setTimeline(tl);

    $('duration').textContent = `/ ${U.tc(tl.duration)}`;
    await player.load(plan, tl.fps, tl.duration);
    player.setRate(parseFloat($('rate').value));

    renderInspector(null, null);
    renderStats();
    setSaveState('idle');

    const files = Object.values(tl.views).reduce((n, p) => n + p.segments.length, 0);
    U.toast(`${session.dataset.name}: ${plan.length} view(s), ${files} file(s), ${U.dur(tl.duration)}`);
    for (const w of (tl.warnings || [])) U.toast(w, true);
  } catch (err) {
    U.toast(err.message, true);
  }
}

const pad3 = (n) => String(n).padStart(3, '0');

function renderScopeSelect(session) {
  const select = $('file-select');
  select.innerHTML = '';
  const total = session.groups.length;
  select.appendChild(U.el('option', {
    value: 'dataset', text: `Whole recording (${total} file${total === 1 ? '' : 's'})`,
    selected: state.scope === 'dataset',
  }));
  for (const g of session.groups) {
    select.appendChild(U.el('option', {
      value: `file:${g.chunk_index}:${g.file_index}`,
      text: `Only ${g.key}`,
      selected: state.scope === 'file' && g.chunk_index === state.chunk && g.file_index === state.file,
    }));
  }
  select.onchange = () => {
    saveSoon.flush();
    if (select.value === 'dataset') return openSession(state.root, 'dataset');
    const [, c, f] = select.value.split(':');
    openSession(state.root, 'file', Number(c), Number(f));
  };
}

/* ---------------- global time -> source file ---------------- */

/** Mirror of store.locate(): which mp4 covers this global time, and where. */
function locate(t, viewKey) {
  const map = (state.project && state.project.timeline) || {};
  const key = viewKey || Object.keys(map)[0];
  for (const seg of (map[key] || [])) {
    if (seg.start <= t && t < seg.end) {
      return { view: key, seg, local: t - seg.start };
    }
  }
  return null;
}

function episodeAt(t) {
  for (const ep of (state.project?.episodes || [])) {
    if (ep.global_start <= t && (ep.global_end == null || t < ep.global_end)) return ep;
  }
  return null;
}

function sourceLine(t) {
  const where = locate(t);
  const ep = episodeAt(t);
  const bits = [];
  if (ep) bits.push(`episode ${ep.episode_index}`);
  if (where) {
    bits.push(`${where.view.split('.').pop()} chunk-${pad3(where.seg.chunk_index)}/file-${pad3(where.seg.file_index)}`);
    bits.push(`at ${U.tc(where.local)}`);
  }
  return bits.join(' · ');
}

/* ---------------- inspector ---------------- */

function renderInspector(clip, layer, focusEditor) {
  const host = $('inspector');
  host.innerHTML = '';
  if (!clip) {
    host.appendChild(U.el('p', {
      class: 'muted',
      text: 'Select a clip to edit it, or drag on a layer to mark a segment.',
    }));
    return;
  }
  const style = timeline.styleOf(layer);

  const timeField = (which) => U.el('input', {
    type: 'text', class: 'num', id: `clip-${which}`, value: clip[which].toFixed(3),
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (!isFinite(v)) { e.target.value = clip[which].toFixed(3); return; }
      const next = { ...clip, [which]: v };
      if (next.end - next.start < 1e-3) { e.target.value = clip[which].toFixed(3); return; }
      clip[which] = +v.toFixed(3);
      layer.clips.sort((a, b) => a.start - b.start);
      timeline.onChange('edit-clip');
      timeline.render();
      renderInspector(clip, layer);
    },
  });

  const text = U.el('textarea', {
    id: 'clip-text', placeholder: 'What happens in this segment?', spellcheck: 'true',
    oninput: (e) => {
      clip.text = e.target.value;
      clip.updated_at = new Date().toISOString();
      const node = timeline.lanesEl.querySelector(`.clip[data-clip="${clip.id}"]`);
      if (node) {
        node.querySelector('.label').textContent = clip.text.trim() || 'untitled';
        node.classList.toggle('empty', !clip.text.trim());
      }
      markDirty();
    },
  });
  text.value = clip.text || '';

  host.append(
    U.el('div', { class: 'row' }, [
      U.el('span', { class: 'style-tag' }, [
        U.el('span', { class: 'swatch', style: { background: style.color } }),
        U.el('span', { text: style.name }),
      ]),
      U.el('span', { class: 'muted', style: { marginLeft: 'auto' }, text: U.dur(clip.end - clip.start) }),
    ]),
    U.el('div', { class: 'row' }, [U.el('label', { text: 'Start' }), timeField('start'),
      U.el('button', {
        class: 'btn small', type: 'button', text: '↧', title: 'Set start to playhead',
        onclick: () => { clip.start = Math.min(+timeline.playhead.toFixed(3), clip.end - 0.01); timeline.onChange('edit'); timeline.render(); renderInspector(clip, layer); },
      })]),
    U.el('div', { class: 'row' }, [U.el('label', { text: 'End' }), timeField('end'),
      U.el('button', {
        class: 'btn small', type: 'button', text: '↧', title: 'Set end to playhead',
        onclick: () => { clip.end = Math.max(+timeline.playhead.toFixed(3), clip.start + 0.01); timeline.onChange('edit'); timeline.render(); renderInspector(clip, layer); },
      })]),
    text,
    U.el('div', { class: 'muted', style: { fontSize: '11px' }, text: sourceLine(clip.start) }),
    U.el('div', { class: 'row' }, [
      U.el('button', { class: 'btn', type: 'button', text: 'Go to start', onclick: () => player.seek(clip.start) }),
      U.el('button', {
        class: 'btn', type: 'button', text: 'Delete clip',
        style: { marginLeft: 'auto', color: 'var(--danger)' },
        onclick: () => timeline.deleteClip(clip.id),
      }),
    ]),
  );

  if (focusEditor) text.focus();
}

function updateInspectorTimes(clip) {
  if (!clip || timeline.selectedClipId !== clip.id) return;
  const s = $('clip-start');
  const e = $('clip-end');
  if (s) s.value = clip.start.toFixed(3);
  if (e) e.value = clip.end.toFixed(3);
}

/* ---------------- stats ---------------- */

function renderStats() {
  const host = $('stats');
  host.innerHTML = '';
  const p = state.project;
  if (!p) return;

  const styles = new Map(p.styles.map((s) => [s.id, s]));
  const files = Object.values(p.timeline || {}).reduce((n, segs) => n + segs.length, 0);
  const rows = [
    ['Duration', U.tc(p.duration || 0, false)],
    ['Frame rate', `${p.dataset.fps} fps`],
    ['Views', String(p.views.length)],
    ['Video files', String(files)],
    ['Episodes', String((p.episodes || []).length)],
    ['Layers', String(p.layers.length)],
  ];

  let total = 0;
  let covered = 0;
  for (const layer of p.layers) {
    total += layer.clips.length;
    for (const c of layer.clips) covered += c.end - c.start;
  }
  rows.push(['Clips', String(total)]);
  rows.push(['Annotated', `${U.dur(covered)}`]);

  for (const [k, v] of rows) {
    host.append(U.el('dt', { text: k }), U.el('dd', { text: v }));
  }

  // Per-style breakdown with a coverage bar against the file duration.
  const perStyle = new Map();
  for (const layer of p.layers) {
    const s = styles.get(layer.style_id);
    if (!s) continue;
    const agg = perStyle.get(s.id) || { style: s, count: 0, seconds: 0 };
    for (const c of layer.clips) { agg.count += 1; agg.seconds += c.end - c.start; }
    perStyle.set(s.id, agg);
  }
  for (const { style, count, seconds } of perStyle.values()) {
    if (!count) continue;
    host.append(
      U.el('dt', {}, [U.el('span', { class: 'swatch', style: { background: style.color, display: 'inline-block', marginRight: '6px' } }), style.name]),
      U.el('dd', { text: `${count} · ${U.dur(seconds)}` }),
      U.el('div', { class: 'bar' }, [
        U.el('span', {
          style: { width: `${Math.min(100, (seconds / (p.duration || 1)) * 100)}%`, background: style.color },
        }),
      ]),
    );
  }
}

function addStyle(name, layer) {
  const p = state.project;
  const palette = ['#6EA8FF', '#7ED9A7', '#E2A0FF', '#F2B45C', '#7FD6E8', '#FF9BA8', '#B9CE6A', '#C3A1F0'];
  const style = { id: U.uid('st'), name, color: palette[p.styles.length % palette.length] };
  p.styles.push(style);
  if (layer) layer.style_id = style.id;
  timeline.onChange('add-style');
  timeline.render();
}

/* ---------------- open dialog ---------------- */

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

async function browse(path) {
  try {
    const data = await U.api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    state.browsePath = data.path;
    $('browse-path').value = data.path;
    const list = $('browse-list');
    list.innerHTML = '';

    if (data.recent.length && !path) {
      list.appendChild(U.el('div', { class: 'group-head', text: 'Recent' }));
      for (const r of data.recent.slice(0, 5)) {
        list.appendChild(U.el('button', {
          class: 'row-item', type: 'button', onclick: () => pickDataset(r),
        }, [U.el('span', { text: r.split('/').pop() }), U.el('span', { class: 'meta', text: r })]));
      }
      list.appendChild(U.el('div', { class: 'group-head', text: data.path }));
    }

    if (data.is_dataset) {
      list.appendChild(U.el('button', {
        class: 'row-item', type: 'button', onclick: () => pickDataset(data.path),
      }, [U.el('span', { text: 'Use this folder' }), U.el('span', { class: 'tag', text: 'dataset' })]));
    }

    for (const entry of data.entries) {
      list.appendChild(U.el('button', {
        class: 'row-item', type: 'button',
        onclick: () => (entry.is_dataset ? pickDataset(entry.path) : browse(entry.path)),
      }, [
        U.el('span', { text: entry.name }),
        entry.is_dataset ? U.el('span', { class: 'tag', text: 'dataset' }) : null,
      ]));
    }
    if (!data.entries.length && !data.is_dataset) {
      list.appendChild(U.el('p', { class: 'muted pad', text: 'Nothing to open in this folder.' }));
    }
    $('browse-status').textContent = data.is_dataset ? 'LeRobot dataset' : `${data.entries.length} folders`;
  } catch (err) {
    U.toast(err.message, true);
  }
}

async function pickDataset(root) {
  const host = $('group-list');
  host.innerHTML = '<p class="muted pad">Reading dataset…</p>';
  try {
    const data = await U.api(`/api/dataset?root=${encodeURIComponent(root)}`);
    state.browseDataset = data;
    host.innerHTML = '';
    host.appendChild(U.el('div', {
      class: 'group-head',
      text: `${data.name} · ${data.video_keys.length} view(s) · ${data.groups.length} file(s)`,
    }));
    if (!data.groups.length) {
      host.appendChild(U.el('p', { class: 'muted pad', text: 'No videos found under videos/.' }));
      return;
    }
    host.appendChild(U.el('button', {
      class: 'row-item', type: 'button',
      onclick: () => { closeModal('open-modal'); openSession(root, 'dataset'); },
    }, [
      U.el('span', { text: 'Whole recording' }),
      U.el('span', { class: 'tag', text: 'all files' }),
      U.el('span', { class: 'meta', text: `${data.groups.length} file(s) per view` }),
    ]));
    for (const g of data.groups) {
      host.appendChild(U.el('button', {
        class: 'row-item', type: 'button',
        onclick: () => { closeModal('open-modal'); openSession(root, 'file', g.chunk_index, g.file_index); },
      }, [
        U.el('span', { text: g.key }),
        U.el('span', { class: 'meta', text: `${Object.keys(g.views).length} views${g.episodes.length ? ` · ${g.episodes.length} ep` : ''}` }),
      ]));
    }
  } catch (err) {
    host.innerHTML = '';
    host.appendChild(U.el('p', { class: 'muted pad', text: err.message }));
  }
}

/* ---------------- actions ---------------- */

function refreshCreateButton() {
  const btn = document.querySelector('[data-action="create-clip"]');
  if (btn) btn.disabled = !timeline.selection;
}

function refreshAutoAnnotateSegment() {
  console.log("refreshAutoAnnotateSegment");
  const btn = document.querySelector('[data-action="auto-annotate-segment"]');
  if (btn) btn.disabled = !timeline.selection;
}

const actions = {
  open: () => { openModal('open-modal'); browse(state.browsePath); },
  save: () => { saveSoon.flush(); },
  'export-json': () => exportAs('json'),
  'export-csv': () => exportAs('csv'),
  reveal: () => U.toast(state.session ? state.session.project_path : 'Nothing open yet'),
  fit: () => timeline.fit(),
  'zoom-in': () => timeline.zoom(1.4),
  'zoom-out': () => timeline.zoom(1 / 1.4),
  shortcuts: () => openModal('shortcuts-modal'),
  play: () => player.toggle(),
  'step-back': () => player.step(-1),
  'step-fwd': () => player.step(1),
  'auto-annotate-segment': () => { timeline.autoAnnotateSegment(); refreshAutoAnnotateSegment(); },
  'mark-in': () => { timeline.mark('in'); refreshCreateButton(); },
  'mark-out': () => { timeline.mark('out'); refreshCreateButton(); },
  'create-clip': () => { timeline.createClip(); refreshCreateButton(); },
};

function exportAs(fmt) {
  if (!state.root) { U.toast('Open a dataset first'); return; }
  saveSoon.flush();
  const url = `/api/export/${fmt}?root=${encodeURIComponent(state.root)}`
    + `&scope=${state.scope}&chunk=${state.chunk}&file=${state.file}`;
  setTimeout(() => window.open(url, '_blank'), 250);
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.menu-trigger');
  document.querySelectorAll('.menu').forEach((m) => {
    m.classList.toggle('open', trigger ? m.contains(trigger) && !m.classList.contains('open') : false);
  });

  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) {
    e.preventDefault();
    actions[btn.dataset.action]();
    document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
  }
  if (e.target.closest('[data-close]')) {
    e.target.closest('.overlay').hidden = true;
  }
});

/* ---------------- player <-> timeline ---------------- */

player.on('tick', (t) => {
  timeline.setPlayhead(t, player.playing);
  $('timecode').textContent = U.tc(t);
});
player.on('state', (playing) => {
  const btn = document.querySelector('[data-action="play"]');
  if (btn) btn.innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
});
let decodeWarned = false;
player.on('error', (key) => {
  if (decodeWarned) return;
  decodeWarned = true;
  U.toast(`${key} will not decode. The timeline still runs on a fallback clock.`, true);
});

$('rate').addEventListener('change', (e) => player.setRate(parseFloat(e.target.value)));

/* ---------------- keyboard ---------------- */

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.overlay:not([hidden])').forEach((o) => { o.hidden = true; });
    if (U.typing()) document.activeElement.blur();
    timeline.setSelection(null);
    refreshCreateButton();
    return;
  }
  if (U.typing() || e.metaKey || e.ctrlKey) return;

  const step = e.shiftKey ? player.fps : 1;
  switch (e.key) {
    case ' ': e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft': e.preventDefault(); player.step(-step); break;
    case 'ArrowRight': e.preventDefault(); player.step(step); break;
    case 'i': case 'I': actions['mark-in'](); break;
    case 'o': case 'O': actions['mark-out'](); break;
    // preventDefault matters: creating a clip focuses the text box, and
    // without this the 'c' keypress lands in it as the first character.
    case 'c': case 'C': case 'Enter': e.preventDefault(); actions['create-clip'](); break;
    case 'Delete': case 'Backspace':
      if (timeline.selectedClipId) { e.preventDefault(); timeline.deleteClip(); }
      break;
    case 'f': case 'F': timeline.fit(); break;
    case '+': case '=': timeline.zoom(1.4); break;
    case '-': case '_': timeline.zoom(1 / 1.4); break;
    case 's': case 'S': saveSoon.flush(); break;
    case '?': openModal('shortcuts-modal'); break;
    default:
      if (/^[1-9]$/.test(e.key) && state.project) {
        const layer = state.project.layers[Number(e.key) - 1];
        if (layer) timeline.setActiveLayer(layer.id);
      }
  }
});

/* ---------------- open dialog controls ---------------- */

$('browse-up').addEventListener('click', () => {
  const parts = (state.browsePath || '/').split('/').filter(Boolean);
  parts.pop();
  browse(`/${parts.join('/')}`);
});
$('browse-go').addEventListener('click', () => browse($('browse-path').value.trim()));
$('browse-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') browse(e.target.value.trim());
});

/* ---------------- timeline height splitter ---------------- */

$('hsplit').addEventListener('mousedown', (e) => {
  const startY = e.clientY;
  const startH = $('timeline').getBoundingClientRect().height;
  const move = (ev) => {
    const h = U.clamp(startH - (ev.clientY - startY), 140, window.innerHeight - 260);
    document.body.style.setProperty('--tl-h', `${h}px`);
    timeline.renderRuler();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
  };
  document.body.classList.add('resizing');
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

/* ---------------- boot ---------------- */

// Handy in the Firefox console: window.player / window.timeline / window.state.
window.player = player;
window.timeline = timeline;
window.state = state;

(function boot() {
  refreshCreateButton();
  const params = new URLSearchParams(location.search);
  const root = params.get('root');
  if (root) {
    openSession(root, params.get('scope') || 'dataset',
      Number(params.get('chunk') || 0), Number(params.get('file') || 0));
  }
  else { openModal('open-modal'); browse(null); }
})();