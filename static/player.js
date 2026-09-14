/* MultiView: N camera views driven as one continuous recording.
 *
 * Each view is its OWN playlist of mp4 files. This matters: LeRobot v3 splits
 * every video key independently by file size, so file-003 of the wrist camera
 * and file-003 of the overhead camera cover different spans of time. Each
 * track therefore carries its own segment list with its own offsets, and the
 * only shared thing is the global clock.
 *
 *   global time  ->  per-track: segment (a file) + local time inside it
 *
 * Track 0 is the master clock. Slaves are re-pointed at the right file and
 * corrected toward the master whenever drift exceeds DRIFT_SNAP. When the
 * master's file ends we roll into the next segment automatically, which is
 * what makes playback continuous across file boundaries.
 *
 * Fallback clock: if nothing decodes, we run a wall-clock timer over the
 * server-reported duration so the timeline stays usable.
 */

class MultiView {
  static DRIFT_SNAP = 0.06;
  static SYNC_EVERY = 0.35;
  static ROLLOVER_LEAD = 0.05;   // how close to a file's end counts as done

  constructor(container) {
    this.container = container;
    this.tracks = [];
    this.fps = 30;
    this.totalDuration = 0;
    this._t = 0;
    this._rate = 1;
    this._virtual = false;
    this._vPlaying = false;
    this._vLast = 0;
    this._lastSync = -1;
    this._raf = null;
    this._listeners = { tick: [], ready: [], state: [], error: [], segment: [] };
  }

  on(event, fn) { this._listeners[event].push(fn); return this; }
  _emit(event, ...args) { for (const fn of this._listeners[event]) fn(...args); }

  /** plan: [{key, segments: [{start, end, url, label}]}] in global seconds. */
  load(plan, fps, totalDuration) {
    this.stopLoop();
    this.fps = fps || 30;
    this.totalDuration = totalDuration || 0;
    this._t = 0;
    this._virtual = false;
    this._vPlaying = false;
    this.container.innerHTML = '';

    this.tracks = plan.map((view, i) => {
      const video = U.el('video', { preload: 'auto', playsinline: true });
      video.muted = true;   // the attribute alone only seeds defaultMuted
      const label = U.el('div', { class: 'view-label' });
      const wrap = U.el('div', { class: 'view' }, [video, label]);
      this.container.appendChild(wrap);

      const track = {
        key: view.key, video, label, wrap,
        segments: view.segments, seg: null, idx: -1,
        switching: false, token: 0, master: i === 0,
      };

      video.addEventListener('waiting', () => wrap.classList.add('stalled'));
      video.addEventListener('playing', () => wrap.classList.remove('stalled'));
      video.addEventListener('canplay', () => wrap.classList.remove('stalled'));
      video.addEventListener('error', () => {
        if (track.switching) return;
        wrap.classList.add('failed');
        this._emit('error', view.key, video.error);
      });
      video.addEventListener('ended', () => {
        // The file ran out, not the recording: step into the next one.
        if (track.master && track.seg) this.seek(track.seg.end + 0.001, true);
      });
      return track;
    });

    if (!this.tracks.length) return Promise.resolve(0);

    const first = this.tracks.map((tr) => this._switch(tr, 0, false));
    return Promise.all(first).then(() => {
      const m = this.tracks[0];
      this._virtual = !m || !isFinite(m.video.duration) || m.video.duration <= 0;
      this.setRate(this._rate);
      this._emit('ready', this.totalDuration, this._virtual);
      this.startLoop();
      return this.totalDuration;
    });
  }

  /* ---------------- segment mapping ---------------- */

  _indexAt(track, t) {
    const segs = track.segments;
    if (!segs.length) return -1;
    for (let i = 0; i < segs.length; i++) {
      if (t < segs[i].end - 1e-6) return i;
    }
    return segs.length - 1;
  }

  /** Point a track at whichever of its files covers global time t. */
  _switch(track, t, resume) {
    const idx = this._indexAt(track, t);
    const seg = track.segments[idx];
    if (!seg) return Promise.resolve();

    const local = U.clamp(t - seg.start, 0, Math.max(0, seg.end - seg.start - 1e-3));
    if (track.idx === idx && !track.switching) {
      this._setLocal(track, local);
      return Promise.resolve();
    }

    const token = ++track.token;
    track.idx = idx;
    track.seg = seg;
    track.switching = true;
    track.wrap.classList.remove('failed');
    track.label.textContent = `${track.key} · ${seg.label}`;
    this._emit('segment', track.key, seg);

    return new Promise((resolve) => {
      const done = (ok) => {
        if (token !== track.token) return resolve();
        track.switching = false;
        if (ok) {
          this._setLocal(track, local);
          if (resume) track.video.play().catch(() => {});
        }
        resolve();
      };
      track.video.addEventListener('loadedmetadata', () => done(true), { once: true });
      track.video.addEventListener('error', () => {
        track.wrap.classList.add('failed');
        track.label.textContent = `${track.key} · ${seg.label} — cannot decode`;
        this._emit('error', track.key, track.video.error);
        done(false);
      }, { once: true });
      track.video.src = seg.url;
      track.video.load();
    });
  }

  _setLocal(track, local) {
    const v = track.video;
    if (!isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = Math.min(local, Math.max(0, v.duration - 1e-3));
  }

  /* ---------------- clock ---------------- */

  get master() { return this.tracks[0] || null; }
  get duration() { return this.totalDuration; }
  get currentTime() { return this._t; }
  get playing() {
    if (this._virtual) return this._vPlaying;
    const m = this.master;
    return !!m && !m.video.paused && !m.switching;
  }

  /** Where each view currently is, for the UI. */
  get positions() {
    return this.tracks.map((tr) => ({ key: tr.key, segment: tr.seg ? tr.seg.label : null }));
  }

  _readMaster() {
    const m = this.master;
    if (!m || !m.seg || m.switching) return this._t;
    const v = m.video;
    if (!isFinite(v.duration) || v.duration <= 0) return this._t;
    return m.seg.start + v.currentTime;
  }

  seek(t, resume = null) {
    const keepPlaying = resume === null ? this.playing : resume;
    const limit = this.totalDuration ? Math.max(0, this.totalDuration - 1e-3) : t;
    this._t = U.clamp(t, 0, limit);
    this._vLast = performance.now();
    for (const track of this.tracks) this._switch(track, this._t, keepPlaying);
    this._emit('tick', this._t);
    return this._t;
  }

  step(frames) { return this.seek(this._t + frames / this.fps, false); }

  async play() {
    if (this._virtual) {
      this._vPlaying = true;
      this._vLast = performance.now();
      this._emit('state', true);
      return;
    }
    try {
      await Promise.all(this.tracks.map((tr) => (tr.switching ? null : tr.video.play())));
    } catch (err) {
      U.toast(`Playback blocked: ${err.message}`, true);
    }
    this._emit('state', true);
  }

  pause() {
    this._vPlaying = false;
    for (const tr of this.tracks) tr.video.pause();
    this._emit('state', false);
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  setRate(rate) {
    this._rate = rate;
    for (const tr of this.tracks) tr.video.playbackRate = rate;
  }

  /** Keep every slave on the right file, and on the master's clock. */
  sync(force = false) {
    if (this._virtual) return;
    const t = this._t;
    for (let i = 1; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      if (track.switching) continue;
      const idx = this._indexAt(track, t);
      if (idx !== track.idx) {
        this._switch(track, t, this.playing);   // this view's file rolled over
        continue;
      }
      const v = track.video;
      if (!isFinite(v.duration) || v.duration <= 0) continue;
      const local = t - track.seg.start;
      if (force || Math.abs(v.currentTime - local) > MultiView.DRIFT_SNAP) {
        this._setLocal(track, local);
      }
    }
  }

  startLoop() {
    if (this._raf) return;
    const frame = () => {
      if (this._virtual && this._vPlaying) {
        const now = performance.now();
        this._t += ((now - this._vLast) / 1000) * this._rate;
        this._vLast = now;
        if (this.totalDuration && this._t >= this.totalDuration) {
          this._t = this.totalDuration;
          this.pause();
        }
      } else if (!this._virtual) {
        this._t = this._readMaster();
        const m = this.master;
        // Roll into the next file slightly before the current one runs dry;
        // 'ended' alone can be late enough to show a frozen frame.
        if (this.playing && m && m.seg && !m.switching
            && this._t >= m.seg.end - MultiView.ROLLOVER_LEAD
            && m.idx < m.segments.length - 1) {
          this.seek(m.seg.end + 0.001, true);
        }
        if (this.playing && Math.abs(this._t - this._lastSync) > MultiView.SYNC_EVERY) {
          this._lastSync = this._t;
          this.sync();
        }
      }
      this._emit('tick', this._t);
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}
