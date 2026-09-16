"""Reading/writing the intermediate annotation format.

One JSON file per annotation scope:
    annotations/<dataset>-<hash>/dataset.json              (whole recording)
    annotations/<dataset>-<hash>/chunk-000_file-000.json   (single file mode)

Written with indent=2 and replaced atomically, so it diffs cleanly in git and
never lands half-written. These files are meant to be read and edited by hand.

Schema (version 2):

{
  "format": "segment-annotations",
  "version": 2,
  "scope": "dataset",
  "dataset": {"root": ..., "name": ..., "fps": 30},
  "duration": 10804.5,
  "views": ["observation.images.top", "observation.images.wrist"],
  "timeline": {
    "observation.images.top": [
      {"chunk_index": 0, "file_index": 0, "path": "videos/.../file-000.mp4",
       "start": 0.0, "end": 842.3}
    ]
  },
  "episodes": [{"episode_index": 0, "global_start": 0.0, "global_end": 21.4}],
  "styles": [{"id": "st_1", "name": "phase", "color": "#6EA8FF"}],
  "layers": [{"id": "ly_1", "style_id": "st_1", "clips": [
      {"id": "cl_1", "start": 3.2, "end": 7.9, "text": "reach for cube"}]}]
}

Clip times are seconds on the GLOBAL axis: the whole recording, with each
view's files concatenated in (chunk, file) order. `timeline` is written into
the file precisely so a reader can map a global time back to a specific mp4 and
an offset inside it without re-scanning the dataset - see `locate`.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FORMAT = "segment-annotations"
VERSION = 2

# Categorical palette for new styles: distinct hues, legible on the dark
# timeline, roughly matched in perceived lightness.
DEFAULT_COLORS = [
    "#6EA8FF", "#7ED9A7", "#E2A0FF", "#F2B45C",
    "#7FD6E8", "#FF9BA8", "#B9CE6A", "#C3A1F0",
]

DEFAULT_STYLES = [
    {"id": "st_main", "name": "main", "color": DEFAULT_COLORS[0]},
    {"id": "st_recovery", "name": "recovery", "color": DEFAULT_COLORS[1]},
    {"id": "st_gripper", "name": "gripper", "color": DEFAULT_COLORS[2]},
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-") or "dataset"


def dataset_key(root: Path) -> str:
    """Stable id that survives the same dataset name existing in two places."""
    digest = hashlib.sha1(str(root.resolve()).encode()).hexdigest()[:8]
    return f"{slug(root.name)}-{digest}"


class ProjectStore:
    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, root: Path, scope: str = "dataset",
                 chunk_index: int = 0, file_index: int = 0) -> Path:
        folder = self.base_dir / dataset_key(root)
        if scope == "dataset":
            return folder / "dataset.json"
        return folder / f"chunk-{chunk_index:03d}_file-{file_index:03d}.json"

    def load(self, root: Path, scope: str = "dataset",
             chunk_index: int = 0, file_index: int = 0) -> dict[str, Any] | None:
        path = self.path_for(root, scope, chunk_index, file_index)
        if not path.is_file():
            return None
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save(self, project: dict[str, Any]) -> Path:
        ds = project.get("dataset", {})
        path = self.path_for(
            Path(ds.get("root", ".")),
            project.get("scope", "dataset"),
            ds.get("chunk_index", 0),
            ds.get("file_index", 0),
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        project["format"] = FORMAT
        project["version"] = VERSION
        project["updated_at"] = now()
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(project, f, indent=2)
            f.write("\n")
        tmp.replace(path)
        return path

    def new_project(self, root: Path, timeline: dict[str, Any], scope: str,
                    name: str, chunk_index: int = 0, file_index: int = 0) -> dict[str, Any]:
        dataset: dict[str, Any] = {"root": str(root), "name": name, "fps": timeline["fps"]}
        if scope != "dataset":
            dataset["chunk_index"] = chunk_index
            dataset["file_index"] = file_index
        return {
            "format": FORMAT,
            "version": VERSION,
            "scope": scope,
            "created_at": now(),
            "updated_at": now(),
            "dataset": dataset,
            "duration": timeline["duration"],
            "views": list(timeline["views"].keys()),
            "timeline": timeline_summary(timeline),
            "episodes": timeline["episodes"],
            "styles": [dict(s) for s in DEFAULT_STYLES],
            "layers": [
                {"id": "ly_1", "style_id": DEFAULT_STYLES[0]["id"], "clips": []},
                {"id": "ly_2", "style_id": DEFAULT_STYLES[1]["id"], "clips": []},
                {"id": "ly_3", "style_id": DEFAULT_STYLES[2]["id"], "clips": []},
            ],
        }


def timeline_summary(timeline: dict[str, Any]) -> dict[str, Any]:
    """The global-time -> file mapping, trimmed for storage."""
    return {
        key: [
            {
                "chunk_index": s["chunk_index"],
                "file_index": s["file_index"],
                "path": s["path"],
                "start": s["start"],
                "end": s["end"],
            }
            for s in plan["segments"]
        ]
        for key, plan in timeline["views"].items()
    }


def locate(project: dict[str, Any], t: float, view_key: str | None = None) -> dict[str, Any]:
    """Map a global time back to (file, time inside that file) for one view."""
    timeline = project.get("timeline") or {}
    if not timeline:
        return {}
    key = view_key or next(iter(timeline))
    for seg in timeline.get(key, []):
        if seg["start"] <= t < seg["end"]:
            return {
                "view": key,
                "chunk_index": seg["chunk_index"],
                "file_index": seg["file_index"],
                "path": seg["path"],
                "local_time": round(t - seg["start"], 3),
            }
    return {}


def episode_at(project: dict[str, Any], t: float) -> int | None:
    for ep in project.get("episodes", []):
        end = ep.get("global_end")
        if ep["global_start"] <= t and (end is None or t < end):
            return ep["episode_index"]
    return None


def to_csv_rows(project: dict[str, Any]) -> list[list[str]]:
    """One row per clip, resolved back to episode and source file."""
    styles = {s["id"]: s for s in project.get("styles", [])}
    rows = [[
        "style", "layer_id", "clip_id", "start_s", "end_s", "duration_s",
        "episode_index", "view", "chunk_index", "file_index", "file_time_s", "text",
    ]]
    for layer in project.get("layers", []):
        style = styles.get(layer.get("style_id"), {})
        for clip in layer.get("clips", []):
            start, end = float(clip["start"]), float(clip["end"])
            where = locate(project, start)
            ep = episode_at(project, start)
            rows.append([
                style.get("name", "untitled"),
                layer.get("id", ""),
                clip.get("id", ""),
                f"{start:.3f}", f"{end:.3f}", f"{end - start:.3f}",
                "" if ep is None else str(ep),
                where.get("view", ""),
                str(where.get("chunk_index", "")),
                str(where.get("file_index", "")),
                f"{where['local_time']:.3f}" if where else "",
                (clip.get("text") or "").replace("\n", " "),
            ])
    return rows
