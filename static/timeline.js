/* Timeline: the layer stack, the clips, the ruler, and the one global playhead.
 *
 * Interaction model
 * -----------------
 *   click on a lane (no drag)  -> move the playhead
 *   drag on a lane             -> mark a selection on that lane (a "ghost")
 *   C / Enter / Create clip    -> turn the selection into a clip
 *   drag a clip body           -> move it   (clamped by its neighbours)
 *   drag a clip edge           -> resize it (clamped by its neighbours)
 *   click a clip               -> select it for editing in the inspector
 *
 * Clips never overlap within a lane. If you want overlapping annotations, add
 * another layer - that is what layers are for.
 *
 * DOM over canvas is deliberate: clip counts here are in the hundreds, and
 * real elements give us hit-testing, focus, and accessibility for free.
 */

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const DRAG_THRESHOLD = 4;   // px before a click becomes a drag
const SNAP_PX = 7;          // px within which edges snap
const EDGE_PX = 6;          // width of a resize handle

class Timeline {
  constructor(opts) {
    Object.assign(this, opts);
    this.pxPerSec = 20;
    this.duration = 0;
    this.playhead = 0;
    this.activeLayerId = null;
    this.selectedClipId = null;
    this.selection = null;      // {layerId, start, end}
    this._drag = null;
    this._laneEls = new Map();  // layerId -> lane element

    this.bodyEl.addEventListener('scroll', () => {
      this.headLanesEl.style.transform = `translateY(${-this.bodyEl.scrollTop}px)`;
      // Ruler and grid are drawn for the visible window only - see renderRuler.
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = null;
        this.renderRuler();
        this.renderGrid();
      });
    });
    this.rulerEl.addEventListener('mousedown', (e) => this._startScrub(e));
    this.lanesEl.addEventListener('mousedown', (e) => this._onLaneMouseDown(e));
    this.lanesEl.addEventListener('dblclick', (e) => {
      const clipEl = e.target.closest('.clip');
      if (clipEl) this.onEditClip && this.onEditClip();
    });
    this.bodyEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;      // trackpad pinch / ctrl+wheel
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
    }, { passive: false });

    window.addEventListener('resize', U.debounce(() => this.renderRuler(), 120));
  }

  /* ---------------- timeline data ---------------- */

  /** timeline: the server's {duration, views:{key:{segments}}, episodes}. */
  setTimeline(timeline) {
    this.episodes = timeline.episodes || [];
    // Every view has its own file boundaries, because v3 splits each video key
    // independently by size. Showing all of them makes the misalignment
    // visible instead of surprising.
    this.fileMarks = [];
    for (const [key, plan] of Object.entries(timeline.views || {})) {
      for (const seg of plan.segments) {
        if (seg.start <= 0) continue;
        this.fileMarks.push({
          t: seg.start,
          view: key,
          label: `file-${String(seg.file_index).padStart(3, '0')}`,
        });
      }
    }
    this.fileMarks.sort((a, b) => a.t - b.t);
    this.setDuration(timeline.duration || 0);
  }

  /* ---------------- geometry ---------------- */

  get project() { return this.getProject(); }
  timeToX(t) { return t * this.pxPerSec; }
  xToTime(x) { return x / this.pxPerSec; }

  eventTime(e) {
    const rect = this.scrollEl.getBoundingClientRect();
    return U.clamp(this.xToTime(e.clientX - rect.left), 0, this.duration || 0);
  }

  /** One screen of margin either side, so scrolling never shows blank ruler. */
  visibleRange() {
    const margin = this.bodyEl.clientWidth;
    const t0 = Math.max(0, this.xToTime(this.bodyEl.scrollLeft - margin));
    const t1 = Math.min(this.duration || 0,
      this.xToTime(this.bodyEl.scrollLeft + this.bodyEl.clientWidth + margin));
    return [t0, t1];
  }

  setDuration(d) {
    this.duration = d || 0;
    if (!this._fitted && this.duration) { this.fit(); this._fitted = true; }
    else this.render();
  }

  fit() {
    const w = Math.max(200, this.bodyEl.clientWidth - 12);
    this.pxPerSec = this.duration ? w / this.duration : 20;
    this.render();
  }

  zoom(factor, anchorClientX) {
    const rect = this.bodyEl.getBoundingClientRect();
    const anchorX = (anchorClientX ?? rect.left + rect.width / 2) - rect.left;
    const tAnchor = this.xToTime(this.bodyEl.scrollLeft + anchorX);
    const minPps = this.duration ? (this.bodyEl.clientWidth - 12) / this.duration / 4 : 0.01;
    this.pxPerSec = U.clamp(this.pxPerSec * factor, Math.max(0.01, minPps), 800);
    this.render();
    this.bodyEl.scrollLeft = this.timeToX(tAnchor) - anchorX;
  }

  /* ---------------- rendering ---------------- */

  render() {
    this.renderHeads();
    this.renderRuler();
    this.renderLanes();
    this.renderGrid();
    this.renderPlayhead();
  }

  renderRuler() {
    const width = Math.max(this.timeToX(this.duration), this.bodyEl.clientWidth);
    this.scrollEl.style.width = `${width}px`;
    this.rulerEl.style.width = `${width}px`;
    this.rulerEl.innerHTML = '';
    if (!this.duration) return;

    // Only the visible window is drawn. A 3h recording at high zoom would
    // otherwise mean hundreds of thousands of tick elements.
    const [t0, t1] = this.visibleRange();
    const step = STEPS.find((s) => s * this.pxPerSec >= 72) || STEPS[STEPS.length - 1];
    const minor = step / (step * this.pxPerSec >= 180 ? 5 : 2);
    const frag = document.createDocumentFragment();

    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
      const t = i * minor;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      const x = this.timeToX(t);
      frag.appendChild(U.el('div', { class: `tick${isMajor ? '' : ' minor'}`, style: { left: `${x}px` } }));
      if (isMajor) {
        frag.appendChild(U.el('div', { class: 'tlabel', style: { left: `${x}px` }, text: U.tc(t, step < 1) }));
      }
    }

    // Episode numbers, but only when they are far enough apart to read.
    const eps = (this.episodes || []).filter((e) => e.global_start >= t0 && e.global_start <= t1);
    if (eps.length && (t1 - t0) / eps.length * this.pxPerSec > 34) {
      for (const ep of eps) {
        frag.appendChild(U.el('div', {
          class: 'ep-label', style: { left: `${this.timeToX(ep.global_start)}px` },
          text: `ep ${ep.episode_index}`,
        }));
      }
    }
    this.rulerEl.appendChild(frag);
  }

  /** Episode and file-boundary lines, drawn once across all lanes. */
  renderGrid() {
    if (!this.gridEl) return;
    this.gridEl.innerHTML = '';
    if (!this.duration) return;
    const [t0, t1] = this.visibleRange();
    const frag = document.createDocumentFragment();

    const eps = (this.episodes || []).filter((e) => e.global_start >= t0 && e.global_start <= t1);
    // Below ~3px apart, episode lines are a solid smear; skip them.
    if (eps.length <= 1 || (t1 - t0) / eps.length * this.pxPerSec > 3) {
      for (const ep of eps) {
        frag.appendChild(U.el('div', {
          class: 'ep-line', style: { left: `${this.timeToX(ep.global_start)}px` },
          title: `episode ${ep.episode_index}`,
        }));
      }
    }

    for (const mark of (this.fileMarks || [])) {
      if (mark.t < t0 || mark.t > t1) continue;
      frag.appendChild(U.el('div', {
        class: 'file-line', style: { left: `${this.timeToX(mark.t)}px` },
        title: `${mark.view} starts ${mark.label} here`,
      }));
    }
    this.gridEl.appendChild(frag);
  }

  renderHeads() {
    const project = this.project;
    this.headLanesEl.innerHTML = '';
    if (!project) return;

    project.layers.forEach((layer, i) => {
      const style = this.styleOf(layer);
      const select = U.el('select', {
        title: 'Annotation style for this layer',
        onchange: (e) => {
          if (e.target.value === '__new__') {
            const name = prompt('Name the new style');
            if (name) this.onAddStyle(name.trim(), layer);
            this.renderHeads();
            return;
          }
          layer.style_id = e.target.value;
          this.onChange('style');
          this.render();
        },
      });
      for (const s of project.styles) {
        select.appendChild(U.el('option', { value: s.id, text: s.name, selected: s.id === layer.style_id }));
      }
      select.appendChild(U.el('option', { value: '__new__', text: 'New style…' }));

      const head = U.el('div', {
        class: `lane-head${layer.id === this.activeLayerId ? ' active' : ''}`,
        style: { '--style-color': style.color },
        onmousedown: () => this.setActiveLayer(layer.id),
      }, [
        U.el('div', { class: 'grip' }),
        U.el('span', { class: 'idx', text: String(i + 1) }),
        select,
        U.el('span', { class: 'count', text: String(layer.clips.length) }),
        U.el('button', {
          class: 'kill', type: 'button', title: 'Delete layer', text: '×',
          onclick: (e) => { e.stopPropagation(); this.removeLayer(layer.id); },
        }),
      ]);
      this.headLanesEl.appendChild(head);
    });

    this.headLanesEl.appendChild(U.el('button', {
      class: 'lane-add', type: 'button', text: '+  Add layer',
      onclick: () => this.addLayer(),
    }));
  }

  renderLanes() {
    const project = this.project;
    this.lanesEl.innerHTML = '';
    this._laneEls.clear();
    if (!project) return;

    for (const layer of project.layers) {
      const color = this.styleOf(layer).color;
      const lane = U.el('div', {
        class: `lane${layer.id === this.activeLayerId ? ' active' : ''}`,
        'data-layer': layer.id,
      });

      for (const clip of layer.clips) lane.appendChild(this.clipEl(clip, color));

      this._laneEls.set(layer.id, lane);
      this.lanesEl.appendChild(lane);
    }
    this.renderSelection();
  }

  clipEl(clip, color) {
    const x = this.timeToX(clip.start);
    const w = Math.max(2, this.timeToX(clip.end) - x);
    const text = (clip.text || '').trim();
    return U.el('div', {
      class: `clip${clip.id === this.selectedClipId ? ' selected' : ''}${text ? '' : ' empty'}`,
      'data-clip': clip.id,
      title: `${U.tc(clip.start)} → ${U.tc(clip.end)}  (${U.dur(clip.end - clip.start)})`,
      style: { left: `${x}px`, width: `${w}px`, '--clip': color },
    }, [
      U.el('div', { class: 'handle l' }),
      U.el('div', { class: 'label', text: text || 'untitled' }),
      U.el('div', { class: 'handle r' }),
    ]);
  }

  renderSelection() {
    this.lanesEl.querySelectorAll('.ghost').forEach((n) => n.remove());
    if (!this.selection) return;
    const lane = this._laneEls.get(this.selection.layerId);
    if (!lane) return;
    const { start, end } = this.selection;
    const x = this.timeToX(Math.min(start, end));
    const w = Math.max(1, Math.abs(this.timeToX(end) - this.timeToX(start)));
    lane.appendChild(U.el('div', { class: 'ghost', style: { left: `${x}px`, width: `${w}px` } }, [
      U.el('div', { class: 'dur', text: U.dur(Math.abs(end - start)) }),
    ]));
  }

  renderPlayhead() {
    this.playheadEl.style.transform = `translateX(${this.timeToX(this.playhead)}px)`;
  }

  setPlayhead(t, follow = false) {
    this.playhead = t;
    this.renderPlayhead();
    if (follow) this.ensureVisible(t);
  }

  ensureVisible(t) {
    const x = this.timeToX(t);
    const left = this.bodyEl.scrollLeft;
    const w = this.bodyEl.clientWidth;
    if (x < left + 40 || x > left + w - 60) this.bodyEl.scrollLeft = x - w * 0.35;
  }

  /* ---------------- model helpers ---------------- */

  styleOf(layer) {
    const project = this.project;
    return (project.styles.find((s) => s.id === layer.style_id))
      || { id: null, name: 'untitled', color: '#6EA8FF' };
  }

  layerById(id) { return this.project.layers.find((l) => l.id === id); }

  findClip(id) {
    for (const layer of this.project.layers) {
      const clip = layer.clips.find((c) => c.id === id);
      if (clip) return { clip, layer };
    }
    return null;
  }

  setActiveLayer(id) {
    if (this.activeLayerId === id) return;
    this.activeLayerId = id;
    this.renderHeads();
    this.lanesEl.querySelectorAll('.lane').forEach((l) => {
      l.classList.toggle('active', l.dataset.layer === id);
    });
  }

  addLayer() {
    const project = this.project;
    const style = project.styles[project.layers.length % project.styles.length] || project.styles[0];
    const layer = { id: U.uid('ly'), style_id: style ? style.id : null, clips: [] };
    project.layers.push(layer);
    this.activeLayerId = layer.id;
    this.onChange('add-layer');
    this.render();
  }

  removeLayer(id) {
    const project = this.project;
    const layer = this.layerById(id);
    if (!layer) return;
    if (layer.clips.length && !confirm(`Delete this layer and its ${layer.clips.length} clip(s)?`)) return;
    project.layers = project.layers.filter((l) => l.id !== id);
    if (this.activeLayerId === id) this.activeLayerId = project.layers[0]?.id || null;
    if (this.selection?.layerId === id) this.setSelection(null);
    this.onChange('remove-layer');
    this.render();
  }

  /** Free window around time t on this layer, ignoring one clip. */
  freeWindow(layer, t, ignoreId) {
    let lo = 0;
    let hi = this.duration || Infinity;
    for (const c of layer.clips) {
      if (c.id === ignoreId) continue;
      if (c.end <= t) lo = Math.max(lo, c.end);
      else if (c.start >= t) hi = Math.min(hi, c.start);
    }
    return [lo, hi];
  }

  /** Candidate times to snap to, in seconds. */
  snapTargets(layer, ignoreId) {
    const out = [0, this.duration, this.playhead];
    for (const c of layer.clips) {
      if (c.id === ignoreId) continue;
      out.push(c.start, c.end);
    }
    for (const ep of (this.episodes || [])) {
      out.push(ep.global_start);
      if (ep.global_end != null) out.push(ep.global_end);
    }
    for (const mark of (this.fileMarks || [])) out.push(mark.t);
    return out;
  }

  snap(t, layer, ignoreId, disabled) {
    if (disabled) return t;
    const tol = SNAP_PX / this.pxPerSec;
    let best = t;
    let bestD = tol;
    for (const target of this.snapTargets(layer, ignoreId)) {
      const d = Math.abs(target - t);
      if (d < bestD) { bestD = d; best = target; }
    }
    return best;
  }

  setSelection(sel) {
    this.selection = sel;
    this.renderSelection();
    this.onSelectionChange && this.onSelectionChange(sel);
  }

  /** Extend/start the selection at the playhead. edge is 'in' or 'out'. */
  mark(edge) {
    const layerId = this.selection?.layerId || this.activeLayerId || this.project?.layers[0]?.id;
    if (!layerId) return;
    const cur = this.selection && this.selection.layerId === layerId
      ? this.selection
      : { layerId, start: this.playhead, end: this.playhead };
    const next = { ...cur };
    if (edge === 'in') next.start = this.playhead;
    else next.end = this.playhead;
    if (next.end < next.start) [next.start, next.end] = [next.end, next.start];
    this.setSelection(next);
  }

  autoAnnotateSegment() {
    const sel = this.selection;
    if (!sel) { U.toast('Drag on a layer to mark a segment first'); return null; }
    const layer = this.layerById(sel.layerId);
    if (!layer) return null;

    let start = Math.min(sel.start, sel.end);
    let end = Math.max(sel.start, sel.end);
    if (end - start < 1e-3) { U.toast('That segment is too short'); return null; }
  }

  /** Turn the current selection into a real clip. */
  createClip(text = '') {
    const sel = this.selection;
    if (!sel) { U.toast('Drag on a layer to mark a segment first'); return null; }
    const layer = this.layerById(sel.layerId);
    if (!layer) return null;

    let start = Math.min(sel.start, sel.end);
    let end = Math.max(sel.start, sel.end);
    if (end - start < 1e-3) { U.toast('That segment is too short'); return null; }

    // Trim against anything already on this lane rather than rejecting outright:
    // push the start past any clip it lands inside, then stop at the next one.
    const inside = layer.clips.find((c) => c.start <= start && c.end > start);
    if (inside) start = inside.end;
    const next = layer.clips
      .filter((c) => c.start > start)
      .sort((a, b) => a.start - b.start)[0];
    if (next) end = Math.min(end, next.start);
    if (end - start < 1e-3) { U.toast('That space is already taken on this layer'); return null; }

    const clip = {
      id: U.uid('cl'),
      start: +start.toFixed(3),
      end: +end.toFixed(3),
      text,
      created_at: new Date().toISOString(),
    };
    layer.clips.push(clip);
    layer.clips.sort((a, b) => a.start - b.start);
    this.selectedClipId = clip.id;
    this.setSelection(null);
    this.onChange('create-clip');
    this.render();
    this.onSelectClip && this.onSelectClip(clip, layer, true);
    return clip;
  }

  deleteClip(id) {
    const found = this.findClip(id || this.selectedClipId);
    if (!found) return;
    found.layer.clips = found.layer.clips.filter((c) => c.id !== found.clip.id);
    if (this.selectedClipId === found.clip.id) this.selectedClipId = null;
    this.onChange('delete-clip');
    this.render();
    this.onSelectClip && this.onSelectClip(null, null);
  }

  selectClip(id, focusEditor = false) {
    this.selectedClipId = id;
    const found = id ? this.findClip(id) : null;
    this.lanesEl.querySelectorAll('.clip').forEach((n) => {
      n.classList.toggle('selected', n.dataset.clip === id);
    });
    if (found) this.setActiveLayer(found.layer.id);
    this.onSelectClip && this.onSelectClip(found?.clip || null, found?.layer || null, focusEditor);
  }

  /* ---------------- interaction ---------------- */

  _releaseFocus() {
    if (U.typing()) document.activeElement.blur();
  }

  _startScrub(e) {
    if (e.button !== 0) return;
    this._releaseFocus();
    const move = (ev) => this.onSeek(this.eventTime(ev));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
    };
    document.body.classList.add('dragging');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    move(e);
  }

  _onLaneMouseDown(e) {
    if (e.button !== 0) return;
    // We preventDefault below to keep drags clean, which would otherwise leave
    // focus parked in the inspector textarea and swallow C / space / arrows.
    this._releaseFocus();
    const laneEl = e.target.closest('.lane');
    if (!laneEl) return;
    const layer = this.layerById(laneEl.dataset.layer);
    if (!layer) return;
    this.setActiveLayer(layer.id);

    const clipEl = e.target.closest('.clip');
    const t0 = this.eventTime(e);

    if (clipEl) {
      const clip = layer.clips.find((c) => c.id === clipEl.dataset.clip);
      if (!clip) return;
      this.selectClip(clip.id);
      const rect = clipEl.getBoundingClientRect();
      const nearL = e.clientX - rect.left <= EDGE_PX;
      const nearR = rect.right - e.clientX <= EDGE_PX;
      this._drag = {
        kind: nearL ? 'resize-l' : nearR ? 'resize-r' : 'move',
        layer, clip, clipEl, t0, x0: e.clientX, moved: false,
        start0: clip.start, end0: clip.end,
      };
    } else {
      this._drag = { kind: 'marquee', layer, laneEl, t0, x0: e.clientX, moved: false };
    }

    const move = (ev) => this._onDragMove(ev);
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
      this._onDragEnd(ev);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('dragging');
    e.preventDefault();
  }

  _onDragMove(e) {
    const d = this._drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_THRESHOLD) return;
    d.moved = true;
    this._autoScroll(e);

    const t = this.eventTime(e);
    const noSnap = e.altKey;

    if (d.kind === 'marquee') {
      const start = Math.min(d.t0, t);
      const end = Math.max(d.t0, t);
      this.setSelection({
        layerId: d.layer.id,
        start: this.snap(start, d.layer, null, noSnap),
        end: this.snap(end, d.layer, null, noSnap),
      });
      return;
    }

    const clip = d.clip;
    if (d.kind === 'move') {
      const len = d.end0 - d.start0;
      let start = this.snap(d.start0 + (t - d.t0), d.layer, clip.id, noSnap);
      const [lo, hi] = this.freeWindow(d.layer, (d.start0 + d.end0) / 2, clip.id);
      start = U.clamp(start, lo, Math.max(lo, hi - len));
      clip.start = start;
      clip.end = start + len;
    } else if (d.kind === 'resize-l') {
      const [lo] = this.freeWindow(d.layer, (d.start0 + d.end0) / 2, clip.id);
      clip.start = U.clamp(this.snap(t, d.layer, clip.id, noSnap), lo, clip.end - 1 / 30);
    } else {
      const [, hi] = this.freeWindow(d.layer, (d.start0 + d.end0) / 2, clip.id);
      clip.end = U.clamp(this.snap(t, d.layer, clip.id, noSnap), clip.start + 1 / 30, hi);
    }

    // Cheap live update: move the one element instead of re-rendering the lane.
    d.clipEl.style.left = `${this.timeToX(clip.start)}px`;
    d.clipEl.style.width = `${Math.max(2, this.timeToX(clip.end - clip.start))}px`;
    this.onClipPreview && this.onClipPreview(clip);
  }

  _onDragEnd(e) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;

    if (!d.moved) {
      // A plain click: on empty lane space that means "put the playhead here".
      if (d.kind === 'marquee') {
        this.setSelection(null);
        this.onSeek(d.t0);
      }
      return;
    }

    if (d.kind === 'marquee') {
      this.onSelectionChange && this.onSelectionChange(this.selection);
      if (this.autoCreate) this.createClip();
    } else {
      d.clip.start = +d.clip.start.toFixed(3);
      d.clip.end = +d.clip.end.toFixed(3);
      d.clip.updated_at = new Date().toISOString();
      d.layer.clips.sort((a, b) => a.start - b.start);
      this.onChange('edit-clip');
      this.selectClip(d.clip.id);
      this.render();
    }
  }

  _autoScroll(e) {
    const rect = this.bodyEl.getBoundingClientRect();
    const margin = 36;
    if (e.clientX > rect.right - margin) this.bodyEl.scrollLeft += 14;
    else if (e.clientX < rect.left + margin) this.bodyEl.scrollLeft -= 14;
  }
}
