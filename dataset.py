"""Discovery and timeline construction for LeRobotDataset (v3) directories.

The important thing this module knows
------------------------------------
In v3, **each video key is split into files independently, by size**
(`video_files_size_in_mb`, default 200MB; `chunks_size`, default 1000 files per
chunk - both recorded in meta/info.json). A wrist camera with more motion
compresses worse than an overhead camera, so `observation.images.wrist/file-000`
and `observation.images.top/file-000` do **not** cover the same span of time.

So there is no such thing as "the (chunk, file) pair across all views". Instead
we build one global time axis for the whole recording and, for each view
separately, a list of segments mapping global time -> (that view's file, local
timestamp inside it). Views stay aligned because each is mapped on its own.

Everything else here is deliberately dependency-light: `lerobot` is used only if
importable, pandas/pyarrow only for episode markers, and every optional path
fails soft.

Layouts accepted (the chunk-NNN component may sit on either side of the key):
    videos/<video_key>/chunk-000/file-000.mp4     <- v3 canonical
    videos/chunk-000/<video_key>/file-000.mp4
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CHUNK_RE = re.compile(r"^chunk-(\d+)$")
FILE_RE = re.compile(r"^file-(\d+)\.mp4$", re.IGNORECASE)

# Views whose total durations differ by more than this are probably not two
# recordings of the same session; worth telling the user about.
VIEW_MISMATCH_TOLERANCE = 1.0


@dataclass
class VideoFileGroup:
    """One mp4 file index across every camera key.

    Only used by the (optional) single-file mode and the Open dialog listing.
    Do not treat the grouping as time-aligned - see the module docstring.
    """

    chunk_index: int
    file_index: int
    views: dict[str, str] = field(default_factory=dict)
    duration: float | None = None
    episodes: list[dict[str, Any]] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"chunk-{self.chunk_index:03d}/file-{self.file_index:03d}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_index": self.chunk_index,
            "file_index": self.file_index,
            "key": self.key,
            "views": self.views,
            "duration": self.duration,
            "episodes": self.episodes,
        }


def is_dataset(path: Path) -> bool:
    try:
        return (path / "meta" / "info.json").is_file()
    except OSError:
        return False


def read_info(root: Path) -> dict[str, Any]:
    try:
        with open(root / "meta" / "info.json") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# --------------------------------------------------------------------------
# scanning
# --------------------------------------------------------------------------

def scan_video_files(root: Path) -> dict[str, list[dict[str, Any]]]:
    """view key -> ordered list of {chunk_index, file_index, path}."""
    videos_dir = root / "videos"
    if not videos_dir.is_dir():
        return {}

    views: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(videos_dir.rglob("*.mp4")):
        rel = path.relative_to(videos_dir)
        parts = list(rel.parts)
        m = FILE_RE.match(parts[-1])
        if not m:
            continue
        file_index = int(m.group(1))

        chunk_index: int | None = None
        key_parts: list[str] = []
        for part in parts[:-1]:
            cm = CHUNK_RE.match(part)
            if cm and chunk_index is None:
                chunk_index = int(cm.group(1))
            else:
                key_parts.append(part)
        if chunk_index is None:
            chunk_index = 0

        view_key = "/".join(key_parts) or "video"
        views.setdefault(view_key, []).append({
            "chunk_index": chunk_index,
            "file_index": file_index,
            "path": str(path.relative_to(root)),
        })

    for files in views.values():
        files.sort(key=lambda f: (f["chunk_index"], f["file_index"]))
    return dict(sorted(views.items()))


def scan_video_groups(root: Path) -> list[VideoFileGroup]:
    """Same files, bucketed by (chunk, file). For the Open dialog only."""
    buckets: dict[tuple[int, int], dict[str, str]] = {}
    for key, files in scan_video_files(root).items():
        for f in files:
            buckets.setdefault((f["chunk_index"], f["file_index"]), {})[key] = f["path"]
    return [
        VideoFileGroup(chunk_index=c, file_index=i, views=dict(sorted(v.items())))
        for (c, i), v in sorted(buckets.items())
    ]


# --------------------------------------------------------------------------
# durations (ffprobe, cached - a 3h dataset can be 60+ files)
# --------------------------------------------------------------------------

class DurationCache:
    """Caches ffprobe results keyed by (path, size, mtime)."""

    def __init__(self, path: Path | None):
        self.path = Path(path) if path else None
        self.data: dict[str, Any] = {}
        self.dirty = False
        if self.path and self.path.is_file():
            try:
                self.data = json.load(open(self.path))
            except (OSError, ValueError):
                self.data = {}

    def get(self, file_path: Path) -> float | None:
        try:
            st = file_path.stat()
        except OSError:
            return None
        key = str(file_path)
        hit = self.data.get(key)
        if hit and hit.get("size") == st.st_size and hit.get("mtime") == int(st.st_mtime):
            return hit["duration"]

        duration = probe_duration(file_path)
        if duration is not None:
            self.data[key] = {"size": st.st_size, "mtime": int(st.st_mtime), "duration": duration}
            self.dirty = True
        return duration

    def flush(self) -> None:
        if not (self.path and self.dirty):
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            json.dump(self.data, open(tmp, "w"))
            os.replace(tmp, self.path)
            self.dirty = False
        except OSError:
            pass


def probe_duration(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return round(float(out.stdout.strip()), 3)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


# --------------------------------------------------------------------------
# episodes
# --------------------------------------------------------------------------

def read_episodes(root: Path) -> list[dict[str, Any]]:
    """Episodes with their per-video-key file placement.

    v3 stores, for every video key: videos/<key>/chunk_index, /file_index,
    /from_timestamp, /to_timestamp. Timestamps are relative to the mp4 file
    that key landed in, which is why we keep them per key rather than
    flattening to one pair of numbers.
    """
    meta_dir = root / "meta" / "episodes"
    if not meta_dir.is_dir():
        return []
    try:
        import pandas as pd
    except ImportError:
        return []

    files = sorted(meta_dir.rglob("*.parquet"))
    if not files:
        return []
    try:
        df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    except Exception:
        return []

    cols = list(df.columns)
    # Match by suffix so a prefix rename between releases doesn't break us.
    ts_cols = [c for c in cols if c.endswith("from_timestamp")]
    keys: list[tuple[str, str]] = []  # (video_key, prefix)
    for c in ts_cols:
        if "/" in c:
            prefix = c.rsplit("/", 1)[0]
            video_key = prefix.split("/", 1)[1] if "/" in prefix else prefix
        else:
            prefix, video_key = "", ""
        keys.append((video_key, prefix))

    episodes: list[dict[str, Any]] = []
    for i, row in df.iterrows():
        ep: dict[str, Any] = {"episode_index": int(row.get("episode_index", i))}
        if "length" in cols:
            try:
                ep["length"] = int(row["length"])
            except (TypeError, ValueError):
                pass
        if "tasks" in cols:
            try:
                ep["tasks"] = [str(t) for t in list(row["tasks"])]
            except TypeError:
                ep["tasks"] = [str(row["tasks"])]

        placements: dict[str, dict[str, Any]] = {}
        for video_key, prefix in keys:
            def col(name: str) -> str:
                return f"{prefix}/{name}" if prefix else name
            try:
                placements[video_key] = {
                    "chunk_index": int(row[col("chunk_index")]) if col("chunk_index") in cols else 0,
                    "file_index": int(row[col("file_index")]) if col("file_index") in cols else 0,
                    "from_timestamp": float(row[col("from_timestamp")]),
                    "to_timestamp": float(row[col("to_timestamp")]) if col("to_timestamp") in cols else None,
                }
            except (TypeError, ValueError, KeyError):
                continue
        ep["videos"] = placements
        episodes.append(ep)

    episodes.sort(key=lambda e: e["episode_index"])
    return episodes


# --------------------------------------------------------------------------
# the global timeline
# --------------------------------------------------------------------------

def build_timeline(root: Path, cache: DurationCache | None = None) -> dict[str, Any]:
    """One time axis for the whole recording, plus a per-view segment map.

    Global time = concatenation of each view's own files in (chunk, file)
    order. Each view carries its own offsets, so views whose files roll over at
    different points still line up.
    """
    info = read_info(root)
    fps = float(info.get("fps", 30) or 30)
    cache = cache or DurationCache(None)
    warnings: list[str] = []

    views: dict[str, Any] = {}
    for key, files in scan_video_files(root).items():
        offset = 0.0
        segments = []
        for f in files:
            duration = cache.get(root / f["path"])
            if duration is None:
                warnings.append(f"Could not read the duration of {f['path']}; skipped.")
                continue
            segments.append({
                "chunk_index": f["chunk_index"],
                "file_index": f["file_index"],
                "path": f["path"],
                "duration": duration,
                "start": round(offset, 3),
                "end": round(offset + duration, 3),
            })
            offset += duration
        views[key] = {"total": round(offset, 3), "segments": segments}
    cache.flush()

    totals = {k: v["total"] for k, v in views.items() if v["segments"]}
    duration = max(totals.values()) if totals else 0.0
    if len(totals) > 1:
        spread = max(totals.values()) - min(totals.values())
        if spread > VIEW_MISMATCH_TOLERANCE:
            longest = max(totals, key=totals.get)
            shortest = min(totals, key=totals.get)
            warnings.append(
                f"Views differ in total length by {spread:.1f}s "
                f"({longest} {totals[longest]:.1f}s vs {shortest} {totals[shortest]:.1f}s). "
                "They may not be the same recording."
            )

    episodes = _globalize_episodes(read_episodes(root), views, fps, warnings)

    return {
        "fps": fps,
        "duration": round(duration, 3),
        "views": views,
        "view_keys": list(views.keys()),
        "episodes": episodes,
        "totals": totals,
        "warnings": warnings,
        "video_files_size_in_mb": info.get("video_files_size_in_mb"),
        "chunks_size": info.get("chunks_size"),
    }


def _globalize_episodes(
    episodes: list[dict[str, Any]],
    views: dict[str, Any],
    fps: float,
    warnings: list[str],
) -> list[dict[str, Any]]:
    """Place each episode on the global axis using its own video key's files."""
    if not episodes or not views:
        return []

    def offset_of(view_key: str, chunk_index: int, file_index: int) -> float | None:
        plan = views.get(view_key)
        if not plan:
            return None
        for seg in plan["segments"]:
            if seg["chunk_index"] == chunk_index and seg["file_index"] == file_index:
                return seg["start"]
        return None

    out: list[dict[str, Any]] = []
    unplaced = 0
    for ep in episodes:
        placed = None
        for view_key, p in (ep.get("videos") or {}).items():
            base = offset_of(view_key, p["chunk_index"], p["file_index"])
            if base is None:
                continue
            start = base + p["from_timestamp"]
            end = base + p["to_timestamp"] if p.get("to_timestamp") is not None else None
            if end is None and ep.get("length"):
                end = start + ep["length"] / fps
            placed = {
                "episode_index": ep["episode_index"],
                "global_start": round(start, 3),
                "global_end": round(end, 3) if end is not None else None,
                "anchor_view": view_key,
            }
            if ep.get("tasks"):
                placed["tasks"] = ep["tasks"]
            break
        if placed:
            out.append(placed)
        else:
            unplaced += 1

    if unplaced:
        warnings.append(f"{unplaced} episode(s) could not be matched to a video file.")
    out.sort(key=lambda e: e["global_start"])
    return out


# --------------------------------------------------------------------------
# summaries
# --------------------------------------------------------------------------

def _enrich_with_lerobot(root: Path, summary: dict[str, Any]) -> None:
    """Optional: pull metadata from the lerobot package if it is installed."""
    try:
        from lerobot.datasets.lerobot_dataset import LeRobotDatasetMetadata  # type: ignore
    except Exception:
        try:
            from lerobot.common.datasets.lerobot_dataset import (  # type: ignore
                LeRobotDatasetMetadata,
            )
        except Exception:
            return
    try:
        meta = LeRobotDatasetMetadata(repo_id=root.name, root=root)
        summary["fps"] = float(getattr(meta, "fps", summary.get("fps")) or summary.get("fps") or 30)
        summary["total_episodes"] = int(getattr(meta, "total_episodes", 0)) or summary.get("total_episodes")
        summary["lerobot_metadata"] = True
    except Exception:
        summary["lerobot_metadata"] = False


def describe_dataset(root: Path, cache: DurationCache | None = None) -> dict[str, Any]:
    """What the Open dialog needs: the whole-dataset option plus the file list."""
    info = read_info(root)
    files_by_view = scan_video_files(root)
    groups = scan_video_groups(root)

    summary: dict[str, Any] = {
        "root": str(root),
        "name": root.name,
        "codebase_version": info.get("codebase_version"),
        "fps": info.get("fps", 30),
        "robot_type": info.get("robot_type"),
        "total_episodes": info.get("total_episodes"),
        "total_frames": info.get("total_frames"),
        "video_keys": list(files_by_view.keys()),
        "file_counts": {k: len(v) for k, v in files_by_view.items()},
        "groups": [g.to_dict() for g in groups],
    }
    if cache is not None:
        tl = build_timeline(root, cache)
        summary["duration"] = tl["duration"]
        summary["warnings"] = tl["warnings"]
        summary["episode_count"] = len(tl["episodes"])
    _enrich_with_lerobot(root, summary)
    return summary


def find_group(root: Path, chunk_index: int, file_index: int,
               cache: DurationCache | None = None) -> VideoFileGroup | None:
    for g in scan_video_groups(root):
        if g.chunk_index == chunk_index and g.file_index == file_index:
            if g.views:
                first = root / next(iter(g.views.values()))
                g.duration = cache.get(first) if cache else probe_duration(first)
            return g
    return None
