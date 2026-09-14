# Segment annotator

A local Flask app for putting **multiple layers of segment annotations** on
multi-camera robot video. Built against the LeRobotDataset v3 on-disk layout.

Target browser: **Firefox**.

```
┌──────────────────────────────────────────────────────────────┐
│ File  View        dataset · chunk-000/file-000               │
├───────────────────────────────────┬──────────────────────────┤
│  view 1        │      view 2      │  Clip inspector          │
│                │                  │  Stats                   │
│                │                  │                          │
├───────────────────────────────────┤                          │
│ ◀| ▶ |▶  00:00:11.089 / 00:00:24  │                          │
├───────────────┬───────────────────┴──────────────────────────┤
│ − Fit +       │ ruler · episode markers · playhead           │
│ 1 [phase  ▾]  │      ▐████ reach for cube ████▌              │
│ 2 [outcome▾]  │              ▐███ success ███▌               │
│ 3 [notes  ▾]  │                                              │
│ + Add layer   │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

## Quick start

```bash
pip install -r requirements.txt
python -m annotator.app --data-root ~/.cache/huggingface/lerobot
# → http://127.0.0.1:5111
```

Then **File → Open dataset**, pick a folder containing `meta/info.json`, and
choose which video file to annotate.

Useful flags:

| flag | what it does |
| --- | --- |
| `--data-root PATH` | folder the Open dialog starts in (repeatable) |
| `--annotations-dir PATH` | where annotation JSON is written (default `./annotations`) |
| `--port 5111` | port |
| `--no-debug` | turn off the reloader |

Debug mode is **on by default**, so edits to Python reload automatically and
edits to JS/CSS just need a refresh. There is no build step: the frontend is
four plain `<script>` files.

## How you annotate

A **style** is a kind of annotation (`phase`, `outcome`, `notes`, …). A
**layer** is one row of the timeline, and each layer is set to one style via
the dropdown on its left. Several layers can share a style — that is how you
get overlapping annotations of the same kind, since clips can't overlap within
a single layer.

- **Drag** across a layer to mark a segment. A dashed ghost shows the range.
- **C** / **Enter** / **Create clip** turns the ghost into a clip.
- Type the annotation text in the inspector on the right. Saves as you type.
- **Click** empty space on any layer to move the global playhead there.
- Drag a clip body to move it, drag its edges to resize. Both are clamped by
  neighbouring clips. Hold **Alt** to disable snapping.
- **+ Add layer** at the bottom of the layer list; **×** on a layer removes it.

Edges snap to the playhead, other clip edges, and episode boundaries.

### Shortcuts

`Space` play/pause · `←`/`→` step a frame (`Shift` = a second) · `I`/`O` mark in/out
at the playhead · `C` create clip · `Delete` delete selected clip · `1`–`9` focus
a layer · `+`/`-`/`F` zoom in/out/fit · `S` save now · `Esc` clear selection ·
`Ctrl`+wheel zooms around the cursor.

## Input: what it expects on disk

A dataset is any folder with `meta/info.json`. Videos are discovered by walking
`videos/` for `file-NNN.mp4`, so both of these work:

```
videos/<video_key>/chunk-000/file-000.mp4     # v3 canonical
videos/chunk-000/<video_key>/file-000.mp4     # also accepted
```

The `chunk-NNN` path component sets the chunk index, `file-NNN.mp4` sets the
file index, and **everything left over is the view key**. One annotation
session = one `(chunk, file)` pair with all of its camera views side by side.
That is the unit precisely because v3 concatenates many episodes into one mp4;
for a 3-hour dataset you move between files with the dropdown in the top bar
rather than loading everything at once.

`meta/episodes/**/*.parquet` is read if pandas + pyarrow are installed, and
episode boundaries appear as markers on the ruler and faint lines in each
layer. Column names are matched by suffix (`*/from_timestamp`), so prefix
changes between LeRobot releases don't break it. If it can't be read you lose
the markers and nothing else.

`lerobot` itself is imported only if present, only for fps/metadata, and any
failure is swallowed (`dataset.py: _enrich_with_lerobot`). Nothing else depends
on it — the app works on a partially downloaded or hand-made dataset.

## Output: the intermediate format

One file per `(dataset, chunk, file)`, at
`annotations/<dataset>-<hash>/chunk-000_file-000.json`. Written with `indent=2`
and replaced atomically, so it diffs cleanly and never lands half-written.

```json
{
  "format": "segment-annotations",
  "version": 1,
  "dataset": { "root": "...", "chunk_index": 0, "file_index": 0, "fps": 30 },
  "duration": 24.0,
  "views": ["observation.images.top", "observation.images.wrist"],
  "styles": [{ "id": "st_phase", "name": "phase", "color": "#6EA8FF" }],
  "layers": [
    { "id": "ly_1", "style_id": "st_phase", "clips": [
      { "id": "cl_1", "start": 2.376, "end": 8.515, "text": "reach for cube" }
    ]}
  ]
}
```

**All times are seconds from the start of the video file**, not the episode.
Subtract an episode's `from_timestamp` to get episode-relative times.

`File → Export` currently offers the same JSON plus a flat CSV of clips
(`store.py: to_csv_rows`). A real LeRobot export — writing labels back as a
feature column per frame — is the obvious next step and belongs in `store.py`.

## Where things live

```
annotator/
  app.py          routes; nothing clever, ~10 endpoints
  dataset.py      disk scanning, ffprobe, episode parquet
  store.py        the JSON format, defaults, CSV flattening
  static/js/
    util.js       timecodes, DOM helper, fetch wrapper, toast
    player.js     MultiView — N <video> elements on one clock
    timeline.js   layers, clips, ruler, playhead, all drag handling
    app.js        wiring: session load, inspector, stats, autosave
```

Things worth knowing before you change something:

- **`/media` serves video with `conditional=True`**, which is what provides HTTP
  range support. Without it, seeking a 3-hour file downloads the whole thing.
- **The project object in the browser is exactly what gets POSTed** to
  `/api/project`. Mutate `state.project`, call `markDirty()`, done. It autosaves
  700 ms after the last change.
- **The timeline is DOM, not canvas.** Clip counts are in the hundreds and real
  elements give hit-testing and focus for free. If you push into tens of
  thousands of clips, virtualise `renderLanes` before reaching for canvas.
- **View 1 is the master clock.** Others are snapped to it when drift exceeds
  60 ms (`MultiView.DRIFT_SNAP`). Sync is checked on a `requestAnimationFrame`
  loop rather than `requestVideoFrameCallback`, which Firefox does not
  implement.
- **If no view decodes**, the player falls back to a wall-clock timer over the
  server-reported duration, so the timeline stays usable instead of freezing at
  zero. You will see a warning toast and a hatched video panel.

## Known limits

- No undo. Deleting a layer asks for confirmation; deleting a clip does not.
- One selection at a time; no multi-select or copy/paste of clips.
- Clips can't overlap within a layer by design — add a layer instead.
- The Open dialog browses the server's filesystem, which is fine for a local
  tool and would not be for anything exposed on a network. Bind to localhost.
- Export is a stub. See above.
