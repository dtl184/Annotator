"""Write annotations back into a LeRobot v3 dataset as `language_persistent`,
and read them back out again.

Export path
-----------
Mirrors what `lerobot-annotate` itself does: stage rows per episode as JSONL,
run LeRobot's own `StagingValidator`, then let `LanguageColumnsWriter` rewrite
`data/chunk-*/file-*.parquet`. We never build the parquet struct ourselves, so
the schema, key order and info.json sync match the library exactly.

Three things about that library contract drive the design here:

1. **Styles are a closed set.** `column_for_style()` raises on anything outside
   `PERSISTENT_STYLES` ({subtask, plan, memory, motion, task_aug}) or
   `EVENT_ONLY_STYLES`. Timeline style names are arbitrary, so each one either
   maps onto a canonical style or gets registered through the documented
   `EXTENDED_STYLES` hook (see `_register_styles`). Registration is in-place
   mutation of the module's sets, which is what makes the writer - which
   imported `PERSISTENT_STYLES` by reference - see it too.

2. **The persistent slice is per-episode, not per-frame.** The writer sorts an
   episode's rows once and broadcasts that identical list across every frame of
   the episode. So one clip becomes one row, and the whole episode carries the
   full list.

3. **The rewrite is total, not incremental.** `_rewrite_one` rebuilds both
   language columns for every episode in each shard it touches, taking rows
   only from the staging tree. Episodes we don't stage are written with `[]`,
   clearing whatever they held before. That is why `plan_write_back` reports
   the episodes it is about to clear and why `backup=True` is the default.

`language_events` is left empty for every frame: we only ever stage into the
"plan" module bucket, and routing to the two columns is decided by style.

Import path
-----------
Only needs pyarrow. Persistent rows are timestamps, not spans, so a row's
segment runs until the next row of the same style (LeRobot's own
`reconstruct_subtask_spans` does this for `subtask`; we do it per style) and
the last one runs to the end of the episode.
"""

from __future__ import annotations

import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

# Canonical persistent styles, duplicated here so the dry-run report can be
# produced without importing lerobot (it is only needed to actually write).
CANONICAL_PERSISTENT_STYLES = {"subtask", "plan", "memory", "motion", "task_aug"}
LANGUAGE_PERSISTENT = "language_persistent"
DEFAULT_ROLE = "assistant"
# The staging module bucket persistent rows are conventionally written to.
# Not the "plan" *style* - a different thing that happens to share the name.
STAGING_MODULE = "plan"


class ExportError(RuntimeError):
    pass


def as_text(value: Any) -> str:
    """Coerce an annotation body to a string.

    `content` is a string in the canonical schema, but a row written by
    another producer can hold a list or dict there. Passing that through
    untouched is how a UI ends up rendering "[object Object]", so anything
    non-scalar is JSON-encoded rather than stringified by chance.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    try:
        import json

        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


# --------------------------------------------------------------------------
# episode placement
# --------------------------------------------------------------------------

def _episode_spans(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Episodes as (index, global_start, global_end), gaps closed by the next
    episode's start when `to_timestamp` was missing."""
    eps = sorted(
        (e for e in project.get("episodes", []) if e.get("global_start") is not None),
        key=lambda e: e["global_start"],
    )
    spans = []
    for i, ep in enumerate(eps):
        end = ep.get("global_end")
        if end is None:
            end = eps[i + 1]["global_start"] if i + 1 < len(eps) else None
        spans.append({
            "episode_index": ep["episode_index"],
            "start": float(ep["global_start"]),
            "end": None if end is None else float(end),
        })
    return spans


def _find_episode(spans: list[dict[str, Any]], t: float) -> dict[str, Any] | None:
    for span in spans:
        if span["start"] <= t and (span["end"] is None or t < span["end"]):
            return span
    return None


def resolve_styles(project: dict[str, Any], style_map: dict[str, str] | None) -> dict[str, str]:
    """timeline style name -> lerobot style name."""
    style_map = style_map or {}
    out = {}
    for style in project.get("styles", []):
        name = style["name"]
        out[name] = style_map.get(name, name)
    return out


# --------------------------------------------------------------------------
# export: plan
# --------------------------------------------------------------------------

def plan_write_back(
    project: dict[str, Any],
    style_map: dict[str, str] | None = None,
    role: str = DEFAULT_ROLE,
) -> dict[str, Any]:
    """Work out exactly what would be written, without importing lerobot.

    Returned verbatim as the dry-run report, and reused by the real write so
    the preview and the write can never disagree.
    """
    spans = _episode_spans(project)
    styles = resolve_styles(project, style_map)
    style_by_id = {s["id"]: s["name"] for s in project.get("styles", [])}

    report: dict[str, Any] = {
        "ok": True,
        # Filled in at the end from the styles that actually produce rows, so
        # the preview (and the style registration) never mention a style that
        # has no clips.
        "styles": {},
        "custom_styles": [],
        "rows": 0,
        "clips": 0,
        "skipped": [],
        "warnings": [],
        "per_episode": [],
        "episodes_total": len(spans),
    }

    if not spans:
        report["ok"] = False
        report["warnings"].append(
            "This dataset has no episode metadata, so clips cannot be placed inside an "
            "episode. meta/episodes/*.parquet is required for the LeRobot export."
        )
        return report

    staged: dict[int, list[dict[str, Any]]] = {}
    used_styles: dict[str, str] = {}
    for layer in project.get("layers", []):
        timeline_style = style_by_id.get(layer.get("style_id"), "untitled")
        lerobot_style = styles.get(timeline_style, timeline_style)
        for clip in layer.get("clips", []):
            report["clips"] += 1
            text = as_text(clip.get("text")).strip()
            if not text:
                report["skipped"].append({"clip": clip.get("id"), "reason": "no annotation text"})
                continue
            span = _find_episode(spans, float(clip["start"]))
            if span is None:
                report["skipped"].append({
                    "clip": clip.get("id"),
                    "reason": f"starts at {float(clip['start']):.3f}s, outside every episode",
                })
                continue
            if span["end"] is not None and float(clip["end"]) > span["end"] + 1e-6:
                report["warnings"].append(
                    f"Clip {clip.get('id')} runs past the end of episode {span['episode_index']}; "
                    "it is filed under the episode its start falls in."
                )
            used_styles[timeline_style] = lerobot_style
            staged.setdefault(span["episode_index"], []).append({
                "role": role,
                "content": text,
                "style": lerobot_style,
                # Episode-relative; snapped to a real frame timestamp at write time.
                "timestamp": round(float(clip["start"]) - span["start"], 6),
                "tool_calls": None,
                "_clip": clip.get("id"),
                # Carried separately: the library writer drops unknown keys, so
                # the end is stamped onto the parquet afterwards (_add_span_fields).
                "_end": round(float(clip["end"]) - span["start"], 6),
            })

    for ep_index in sorted(staged):
        rows = sorted(staged[ep_index], key=lambda r: r["timestamp"])
        staged[ep_index] = rows
        report["rows"] += len(rows)
        report["per_episode"].append({
            "episode_index": ep_index,
            "rows": len(rows),
            "styles": sorted({r["style"] for r in rows}),
        })

    report["styles"] = dict(sorted(used_styles.items()))
    report["custom_styles"] = sorted(
        {v for v in used_styles.values() if v not in CANONICAL_PERSISTENT_STYLES}
    )
    unused = [s["name"] for s in project.get("styles", []) if s["name"] not in used_styles]
    if unused:
        report["warnings"].append(
            "Styles " + ", ".join(sorted(unused)) + " have no clips with text and are not written."
        )

    cleared = [s["episode_index"] for s in spans if s["episode_index"] not in staged]
    report["episodes_annotated"] = len(staged)
    report["episodes_cleared"] = len(cleared)
    if cleared:
        report["warnings"].append(
            f"{len(cleared)} episode(s) have no clips. The writer rebuilds the language "
            "columns for every episode in each shard it touches, so those episodes will be "
            "written with an empty list, clearing any existing language_persistent."
        )
    if report["custom_styles"]:
        report["warnings"].append(
            "Styles " + ", ".join(report["custom_styles"]) + " are not LeRobot persistent "
            "styles. They will be registered through EXTENDED_STYLES so they land in "
            "language_persistent, but any other tool reading this dataset must register "
            "them too or column_for_style() will raise on them."
        )
    report["_staged"] = staged
    return report


# --------------------------------------------------------------------------
# export: write
# --------------------------------------------------------------------------

def _register_styles(custom: list[str]) -> None:
    """Declare project-local styles as persistent, the documented way.

    The sets are mutated in place rather than rebound: writer.py and
    validator.py imported these objects by reference at import time, so
    rebinding the module attribute would leave them looking at the old set.
    """
    from lerobot.datasets import language

    for name in custom:
        language.EXTENDED_STYLES.add(name)
        language.PERSISTENT_STYLES.add(name)
        language.STYLE_REGISTRY.add(name)


def _backup_data(root: Path, backup_root: Path) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = backup_root / f"{root.name}-data-{stamp}"
    shutil.copytree(root / "data", dest)
    return str(dest)


def write_back(
    project: dict[str, Any],
    root: Path,
    *,
    style_map: dict[str, str] | None = None,
    role: str = DEFAULT_ROLE,
    backup: bool = True,
    backup_root: Path | None = None,
    spans: bool = True,
) -> dict[str, Any]:
    """Stage, validate, and rewrite the parquet shards in place.

    `spans=True` adds `start_timestamp` / `end_timestamp` to each persistent
    row after the library writer has run, so clip ends survive the round trip
    (see `_add_span_fields` for why it cannot be done during staging).
    """
    report = plan_write_back(project, style_map, role)
    if not report["ok"]:
        raise ExportError("; ".join(report["warnings"]) or "Nothing to write")
    staged = report.pop("_staged")
    if not staged:
        raise ExportError("No clips with text fall inside an episode, so there is nothing to write.")

    try:
        from lerobot.annotations.steerable_pipeline.reader import iter_episodes, snap_to_frame
        from lerobot.annotations.steerable_pipeline.staging import EpisodeStaging
        from lerobot.annotations.steerable_pipeline.validator import StagingValidator
        from lerobot.annotations.steerable_pipeline.writer import LanguageColumnsWriter
    except ImportError as err:  # pragma: no cover - depends on the environment
        raise ExportError(
            f"The LeRobot export needs the `lerobot` package importable in this "
            f"environment ({err}). The JSON and CSV exports do not."
        ) from err

    _register_styles(report["custom_styles"])

    records = list(iter_episodes(root))
    by_index = {r.episode_index: r for r in records}
    missing = sorted(set(staged) - set(by_index))
    if missing:
        raise ExportError(
            f"Episodes {missing} are in the annotation file but not in {root}/data. "
            "Is this the dataset the annotations were made against?"
        )

    if backup:
        report["backup"] = _backup_data(root, Path(backup_root or root.parent))

    staging_dir = Path(tempfile.mkdtemp(prefix="annotator-staging-"))
    # (episode, style, snapped start) -> snapped end, for _add_span_fields.
    ends: dict[int, dict[tuple[str, float], float]] = {}
    try:
        for ep_index, rows in staged.items():
            record = by_index[ep_index]
            out_rows = []
            for row in rows:
                row = dict(row)
                row.pop("_clip", None)
                end_rel = row.pop("_end", None)
                # Rows must sit on a real frame timestamp or the writer's
                # per-frame lookup never matches them.
                row["timestamp"] = snap_to_frame(
                    record.frame_timestamps[0] + row["timestamp"], record.frame_timestamps
                )
                if end_rel is not None:
                    end_ts = snap_to_frame(
                        record.frame_timestamps[0] + end_rel, record.frame_timestamps
                    )
                    ends.setdefault(ep_index, {})[
                        (row["style"], round(float(row["timestamp"]), 6))
                    ] = end_ts
                out_rows.append(row)
            EpisodeStaging(staging_dir, ep_index).write(STAGING_MODULE, out_rows)

        validation = StagingValidator(dataset_camera_keys=None).validate(records, staging_dir)
        report["validator"] = validation.summary()
        for warning in validation.warnings:
            report["warnings"].append(f"validator: {warning}")
        if not validation.ok:
            raise ExportError("Staging validation failed:\n" + "\n".join(validation.errors))

        written = LanguageColumnsWriter().write_all(records, staging_dir, root)
        report["written"] = [str(p) for p in written]
        report["spans"] = bool(spans)
        if spans:
            _add_span_fields(written, ends)
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    _sync_info(root)
    return report


def _add_span_fields(
    paths: list[Path],
    ends: dict[int, dict[tuple[str, float], float]],
) -> None:
    """Add `start_timestamp` / `end_timestamp` to every persistent row.

    This has to happen after `LanguageColumnsWriter`, not during staging:
    `_normalize_row` rebuilds each row from a fixed whitelist
    (role, content, style, timestamp, camera, tool_calls) and silently drops
    anything else, and `_normalize_persistent_row` raises if `timestamp` is
    missing. So the canonical `timestamp` stays (it is the clip start, and it
    is what stock LeRobot readers such as `reconstruct_subtask_spans` key off),
    and the two span fields are appended to the struct here.

    That makes the struct a superset of LeRobot's schema. Readers that select
    named fields are unaffected; anything asserting the exact struct type will
    see two extra fields. Pass `spans=False` to stay byte-identical to what
    `lerobot-annotate` produces.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    from lerobot.datasets.io_utils import write_table_one_row_group_per_episode

    for path in paths:
        table = pq.read_table(path)
        if LANGUAGE_PERSISTENT not in table.column_names:
            continue
        episodes = table.column("episode_index").to_pylist()
        column = table.column(LANGUAGE_PERSISTENT).to_pylist()

        # The slice is identical on every frame of an episode, so build the
        # augmented list once per episode and reuse the reference.
        per_episode: dict[int, list[dict[str, Any]]] = {}
        out: list[list[dict[str, Any]]] = []
        for ep_index, rows in zip(episodes, column):
            if ep_index not in per_episode:
                lookup = ends.get(ep_index, {})
                built = []
                for row in rows or []:
                    row = dict(row)
                    start = float(row["timestamp"])
                    row["start_timestamp"] = start
                    row["end_timestamp"] = float(
                        lookup.get((row.get("style"), round(start, 6)), start)
                    )
                    built.append(row)
                per_episode[ep_index] = built
            out.append(per_episode[ep_index])

        index = table.column_names.index(LANGUAGE_PERSISTENT)
        table = table.set_column(index, LANGUAGE_PERSISTENT, pa.array(out))
        write_table_one_row_group_per_episode(table, Path(path))


def _sync_info(root: Path) -> None:
    """Declare the language features and the `say` tool in meta/info.json,
    exactly as the pipeline's executor does after writing."""
    from lerobot.datasets.io_utils import load_info, write_info
    from lerobot.datasets.language import SAY_TOOL_SCHEMA, language_feature_info

    if not (root / "meta" / "info.json").exists():
        return
    info = load_info(root)
    changed = False

    merged = {**info.features, **language_feature_info()}
    if merged != info.features:
        info.features = merged
        changed = True

    existing = info.tools or []
    names = {(t.get("function") or {}).get("name") for t in existing if isinstance(t, dict)}
    if SAY_TOOL_SCHEMA["function"]["name"] not in names:
        info.tools = [*existing, SAY_TOOL_SCHEMA]
        changed = True

    if changed:
        write_info(info, root)


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------

def read_persistent(root: Path) -> dict[int, list[dict[str, Any]]]:
    """episode_index -> its persistent rows, straight from the parquet shards.

    The slice is identical on every frame of an episode, so we only read the
    first row of each episode rather than the whole column.
    """
    try:
        import pyarrow.parquet as pq
    except ImportError as err:
        raise ExportError(f"Reading annotations back needs pyarrow ({err}).") from err

    data_dir = root / "data"
    if not data_dir.is_dir():
        raise ExportError(f"No data/ directory in {root}")

    out: dict[int, list[dict[str, Any]]] = {}
    for path in sorted(data_dir.rglob("*.parquet")):
        schema = pq.read_schema(path)
        if LANGUAGE_PERSISTENT not in schema.names or "episode_index" not in schema.names:
            continue
        table = pq.read_table(path, columns=["episode_index", LANGUAGE_PERSISTENT])
        episodes = table.column("episode_index").to_pylist()
        rows = table.column(LANGUAGE_PERSISTENT).to_pylist()
        for ep_index, value in zip(episodes, rows):
            if ep_index in out:
                continue
            out[int(ep_index)] = value or []
    return out


def spans_from_rows(rows: list[dict[str, Any]], episode_end: float | None) -> list[dict[str, Any]]:
    """Persistent rows are points in time; turn them back into spans.

    Same rule as LeRobot's `reconstruct_subtask_spans`, but applied per style
    so two styles annotated over the same stretch don't truncate each other.
    """
    by_style: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_style.setdefault(row.get("style") or "untitled", []).append(row)

    spans: list[dict[str, Any]] = []
    for style, style_rows in by_style.items():
        ordered = sorted(style_rows, key=lambda r: float(r.get("start_timestamp", r["timestamp"])))
        for i, row in enumerate(ordered):
            start = float(row.get("start_timestamp", row["timestamp"]))
            exact = row.get("end_timestamp")
            if exact is not None and float(exact) > start:
                # Written by this app: the real clip end, no inference needed.
                end = float(exact)
            elif i + 1 < len(ordered):
                end = float(ordered[i + 1]["timestamp"])
            else:
                end = episode_end if episode_end is not None else start
            spans.append({
                "style": style,
                "start": start,
                "end": end,
                "text": as_text(row.get("content")),
                "role": row.get("role"),
                "exact_end": exact is not None and float(exact) > start,
            })
    return spans


def plan_import(project: dict[str, Any], root: Path) -> dict[str, Any]:
    """Build timeline layers from a dataset's existing language_persistent."""
    per_episode = read_persistent(root)
    spans_by_index = {s["episode_index"]: s for s in _episode_spans(project)}

    found: dict[str, list[dict[str, Any]]] = {}
    warnings: list[str] = []
    skipped = 0
    exact_ends = 0

    for ep_index, rows in sorted(per_episode.items()):
        if not rows:
            continue
        placement = spans_by_index.get(ep_index)
        if placement is None:
            skipped += len(rows)
            continue
        ep_start = placement["start"]
        ep_len = None if placement["end"] is None else placement["end"] - ep_start
        for span in spans_from_rows(rows, ep_len):
            if span["exact_end"]:
                exact_ends += 1
            found.setdefault(span["style"], []).append({
                "start": round(ep_start + span["start"], 3),
                "end": round(ep_start + span["end"], 3),
                "text": as_text(span["text"]),
                "episode_index": ep_index,
                "exact_end": span["exact_end"],
            })

    if skipped:
        warnings.append(
            f"{skipped} row(s) belong to episodes this annotation file doesn't know about; skipped."
        )
    total = sum(len(v) for v in found.values())
    if total and exact_ends < total:
        warnings.append(
            f"{total - exact_ends} of {total} segment(s) carry no end_timestamp, so their end is "
            "inferred: each runs until the next annotation of the same style, or the end of its "
            "episode. Rows written by this app carry exact ends."
        )
    return {
        "styles": sorted(found),
        "clips_by_style": found,
        "clips": total,
        "exact_ends": exact_ends,
        "episodes": len([e for e, r in per_episode.items() if r]),
        "warnings": warnings,
    }