"""Flask app for multi-layer video segment annotation over LeRobot v3 datasets.

Run:  python -m annotator.app --data-root ~/.cache/huggingface/lerobot
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_file,
)

import dataset as ds
from store import ProjectStore, to_csv_rows

app = Flask(__name__)
# Keep the logical field order in responses; these JSON files are meant to be read.
app.json.sort_keys = False

# Populated by main(); safe defaults so `flask --app annotator.app run` works too.
app.config.setdefault("DATA_ROOTS", [Path.home() / ".cache" / "huggingface" / "lerobot", Path.home()])
app.config.setdefault("ANNOTATIONS_DIR", Path.cwd() / "annotations")
app.config.setdefault("RECENT_FILE", Path.cwd() / "annotations" / ".recent.json")


def store() -> ProjectStore:
    return ProjectStore(Path(app.config["ANNOTATIONS_DIR"]))

def cache_for(root: Path) -> ds.DurationCache:
    """Duration cache lives beside the annotations, one file per dataset."""
    path = Path(app.config["ANNOTATIONS_DIR"]) / dataset_key(root) / ".durations.json"
    return ds.DurationCache(path)
# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _safe_root(raw: str | None) -> Path:
    if not raw:
        abort(400, "Missing dataset root")
    root = Path(os.path.expanduser(raw)).resolve()
    if not root.is_dir():
        abort(404, f"No such directory: {root}")
    return root


def _remember(root: Path) -> None:
    path = Path(app.config["RECENT_FILE"])
    path.parent.mkdir(parents=True, exist_ok=True)
    items: list[str] = []
    if path.is_file():
        try:
            items = json.load(open(path))
        except (OSError, ValueError):
            items = []
    items = [str(root)] + [i for i in items if i != str(root)]
    try:
        json.dump(items[:12], open(path, "w"), indent=2)
    except OSError:
        pass


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------

@app.get("/")
def index() -> str:
    return render_template("index.html")


# --------------------------------------------------------------------------
# api: browsing the filesystem for datasets
# --------------------------------------------------------------------------

@app.get("/api/browse")
def api_browse() -> Response:
    """List subdirectories of `path`, flagging which ones are datasets."""
    raw = request.args.get("path")
    if raw:
        current = Path(os.path.expanduser(raw)).resolve()
    else:
        roots = [Path(p).expanduser() for p in app.config["DATA_ROOTS"]]
        current = next((r for r in roots if r.is_dir()), Path.home())

    if not current.is_dir():
        abort(404, f"No such directory: {current}")

    entries = []
    try:
        for child in sorted(current.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith(".") or not child.is_dir():
                continue
            entries.append({"name": child.name, "path": str(child), "is_dataset": ds.is_dataset(child)})
    except PermissionError:
        abort(403, f"Permission denied: {current}")

    recent: list[str] = []
    rf = Path(app.config["RECENT_FILE"])
    if rf.is_file():
        try:
            recent = json.load(open(rf))
        except (OSError, ValueError):
            recent = []

    return jsonify({
        "path": str(current),
        "parent": str(current.parent) if current.parent != current else None,
        "is_dataset": ds.is_dataset(current),
        "entries": entries,
        "recent": recent,
        "shortcuts": [str(Path(p).expanduser()) for p in app.config["DATA_ROOTS"]],
    })


@app.get("/api/dataset")
def api_dataset() -> Response:
    """Summary for the Open dialog. probe=1 also totals up the duration."""
    root = _safe_root(request.args.get("root"))
    if not ds.is_dataset(root):
        abort(400, f"Not a LeRobot dataset (no meta/info.json): {root}")
    cache = cache_for(root) if request.args.get("probe") == "1" else None
    summary = ds.describe_dataset(root, cache)
    _remember(root)
    return jsonify(summary)



# --------------------------------------------------------------------------
# sessions
# --------------------------------------------------------------------------

def _file_scope_timeline(root: Path, chunk: int, file_index: int,
                         cache: ds.DurationCache) -> dict[str, Any]:
    """Single-file mode, shaped exactly like the whole-dataset timeline.

    Each view gets only its own (chunk, file) starting at zero. Note that this
    is NOT guaranteed to keep views aligned - v3 splits each video key
    independently by size - which is why dataset scope is the default.
    """
    info = ds.read_info(root)
    fps = float(info.get("fps", 30) or 30)
    views: dict[str, Any] = {}
    duration = 0.0
    for key, files in ds.scan_video_files(root).items():
        match = next((f for f in files
                      if f["chunk_index"] == chunk and f["file_index"] == file_index), None)
        if not match:
            continue
        d = cache.get(root / match["path"]) or 0.0
        views[key] = {"total": d, "segments": [{
            "chunk_index": chunk, "file_index": file_index, "path": match["path"],
            "duration": d, "start": 0.0, "end": round(d, 3),
        }]}
        duration = max(duration, d)
    cache.flush()
    if not views:
        abort(404, f"No video for chunk-{chunk:03d}/file-{file_index:03d}")

    return {
        "fps": fps,
        "duration": round(duration, 3),
        "views": views,
        "view_keys": list(views),
        "episodes": [],
        "totals": {k: v["total"] for k, v in views.items()},
        "warnings": ["Single-file mode: views are not guaranteed to be time-aligned."],
    }

@app.get("/api/session")
def api_session() -> Response:
    root = _safe_root(request.args.get("root"))
    chunk = int(request.args.get("chunk", 0))
    file_index = int(request.args.get("file", 0))

    group = ds.find_group(root, chunk, file_index)
    if group is None:
        abort(404, f"No video file for chunk-{chunk:03d}/file-{file_index:03d}")

    info = ds.read_info(root)
    fps = float(info.get("fps", 30) or 30)

    st = store()
    project = st.load(root, chunk, file_index)
    if project is None:
        project = st.new_project(root, group, fps, root.name)
        st.save(project)
    else:
        # Keep derived fields fresh without clobbering annotations.
        project.setdefault("dataset", {})["fps"] = fps
        project["views"] = list(group.views.keys())
        project["episodes"] = group.episodes
        if group.duration:
            project["duration"] = group.duration

    all_groups = [
        {"chunk_index": g.chunk_index, "file_index": g.file_index, "key": g.key, "views": len(g.views)}
        for g in ds.scan_video_groups(root)
    ]

    return jsonify({
        "dataset": {
            "root": str(root),
            "name": root.name,
            "fps": fps,
            "robot_type": info.get("robot_type"),
            "codebase_version": info.get("codebase_version"),
        },
        "group": group.to_dict(),
        "groups": all_groups,
        "project": project,
        "project_path": str(st.path_for(root, chunk, file_index)),
    })


@app.post("/api/project")
def api_save_project() -> Response:
    project = request.get_json(silent=True)
    if not isinstance(project, dict) or "dataset" not in project:
        abort(400, "Body must be a project object")
    path = store().save(project)
    return jsonify({"ok": True, "path": str(path), "updated_at": project.get("updated_at")})


# --------------------------------------------------------------------------
# diagnostics
# --------------------------------------------------------------------------

@app.get("/api/scan")
def api_scan() -> Response:
    """What the server actually sees on disk: every view, every file, every
    duration, plus where each view's file boundaries land on the global axis.

    If two views disagree about the recording length, or a file's boundaries
    look wrong, this is the endpoint to read. Also available as `--scan PATH`
    on the command line.
    """
    root = _safe_root(request.args.get("root"))
    timeline = ds.build_timeline(root, cache_for(root))
    return jsonify({
        "root": str(root),
        "duration": timeline["duration"],
        "fps": timeline["fps"],
        "totals": timeline["totals"],
        "episode_count": len(timeline["episodes"]),
        "warnings": timeline["warnings"],
        "views": {
            key: [
                {"file": f"chunk-{s['chunk_index']:03d}/file-{s['file_index']:03d}",
                 "duration": s["duration"], "start": s["start"], "end": s["end"]}
                for s in plan["segments"]
            ]
            for key, plan in timeline["views"].items()
        },
    })



# --------------------------------------------------------------------------
# media
# --------------------------------------------------------------------------

@app.get("/media")
def media() -> Response:
    """Serve an mp4 from inside the dataset root.

    `conditional=True` gives us HTTP Range support, which is what makes
    scrubbing a 3-hour file feel instant instead of downloading the whole thing.
    """
    root = _safe_root(request.args.get("root"))
    rel = request.args.get("path", "")
    target = (root / rel).resolve()
    if root not in target.parents:
        abort(403, "Path escapes dataset root")
    if not target.is_file():
        abort(404, f"No such file: {rel}")
    return send_file(target, mimetype="video/mp4", conditional=True)


# --------------------------------------------------------------------------
# export (stubs - the readable JSON is the source of truth for now)
# --------------------------------------------------------------------------

@app.get("/api/export/<fmt>")
def api_export(fmt: str) -> Response:
    root = _safe_root(request.args.get("root"))
    chunk = int(request.args.get("chunk", 0))
    file_index = int(request.args.get("file", 0))
    project = store().load(root, chunk, file_index)
    if project is None:
        abort(404, "Nothing saved for this file yet")

    stem = f"{root.name}_chunk-{chunk:03d}_file-{file_index:03d}"

    if fmt == "json":
        body = json.dumps(project, indent=2) + "\n"
        return Response(body, mimetype="application/json", headers={
            "Content-Disposition": f'attachment; filename="{stem}.json"'
        })

    if fmt == "csv":
        buf = io.StringIO()
        csv.writer(buf).writerows(to_csv_rows(project))
        return Response(buf.getvalue(), mimetype="text/csv", headers={
            "Content-Disposition": f'attachment; filename="{stem}.csv"'
        })

    abort(400, f"Unknown export format: {fmt}")


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
def json_errors(err: Any) -> tuple[Response, int]:
    return jsonify({"error": getattr(err, "description", str(err))}), getattr(err, "code", 500)


# --------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-layer video segment annotator")
    parser.add_argument("--data-root", action="append", default=None,
                        help="Directory to show first in Open (repeatable)")
    parser.add_argument("--annotations-dir", default=str(Path.cwd() / "annotations"),
                        help="Where the annotation JSON files live")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5111)
    parser.add_argument("--no-debug", action="store_true")
    args = parser.parse_args()

    roots = args.data_root or [
        str(Path.home() / ".cache" / "huggingface" / "lerobot"),
        str(Path.home()),
    ]
    app.config["DATA_ROOTS"] = [Path(os.path.expanduser(r)) for r in roots]
    app.config["ANNOTATIONS_DIR"] = Path(os.path.expanduser(args.annotations_dir))
    app.config["RECENT_FILE"] = app.config["ANNOTATIONS_DIR"] / ".recent.json"
    app.config["ANNOTATIONS_DIR"].mkdir(parents=True, exist_ok=True)

    print(f"  annotations -> {app.config['ANNOTATIONS_DIR']}")
    print(f"  http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=not args.no_debug, threaded=True)


if __name__ == "__main__":
    main()
