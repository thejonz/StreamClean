"""
Persistent SQLite cache for TMDB enrichment + merged RT scores.

Uses one shared connection and serialized access — the previous implementation opened a
new DB + reapplied DDL on every single-row lookup (`get_movie_merge`), which made page ≥2 absurdly slow.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from server.config import CACHE_DB_PATH, cache_enabled, cache_ttl_seconds

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def _now() -> float:
    return time.time()


def _ensure_conn_locked() -> sqlite3.Connection:
    """Must hold _lock. Lazily allocate one process-wide SQLite connection."""
    global _conn
    if _conn is not None:
        return _conn

    CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    cx = sqlite3.connect(str(CACHE_DB_PATH), timeout=60.0, check_same_thread=False)
    cx.execute("PRAGMA journal_mode=WAL")
    cx.execute("PRAGMA synchronous=NORMAL")
    cx.executescript(
        """
        CREATE TABLE IF NOT EXISTS movie_merge (
            tmdb_id INTEGER PRIMARY KEY,
            merged_json TEXT NOT NULL,
            updated_unix REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scores_imdb (
            imdb_key TEXT PRIMARY KEY,
            scores_json TEXT NOT NULL,
            updated_unix REAL NOT NULL
        );
        """
    )
    cx.commit()
    _conn = cx
    return cx


def _fresh(updated: float | None, ttl: float | None = None) -> bool:
    if updated is None:
        return False
    ttl = cache_ttl_seconds() if ttl is None else ttl
    return (_now() - float(updated)) < ttl


def db_run(fn):  # type: ignore[no-untyped-def]
    """Run `fn(connection)` holding the process lock (safe with asyncio thread pool)."""
    with _lock:
        cx = _ensure_conn_locked()
        return fn(cx)


def get_movie_merges_bulk(tmdb_ids: list[Any], *, ttl_secs: float | None = None) -> dict[int, dict[str, Any]]:
    """Return `{tmdb_id: merged_movie}` cache hits — fresh TTL only. One round-trip."""
    out: dict[int, dict[str, Any]] = {}
    if not cache_enabled() or not tmdb_ids:
        return out

    parsed: list[int] = []
    for x in tmdb_ids:
        try:
            parsed.append(int(x))
        except (TypeError, ValueError):
            continue
    seen: set[int] = set()
    ids: list[int] = []
    for i in parsed:
        if i not in seen:
            seen.add(i)
            ids.append(i)
    if not ids:
        return out

    ttl = cache_ttl_seconds() if ttl_secs is None else ttl_secs

    def work(cx: sqlite3.Connection) -> dict[int, dict[str, Any]]:
        local: dict[int, dict[str, Any]] = {}
        stale_rows: list[int] = []
        qmarks = ",".join("?" * len(ids))
        rows = cx.execute(
            f"SELECT tmdb_id, merged_json, updated_unix FROM movie_merge WHERE tmdb_id IN ({qmarks})",
            ids,
        ).fetchall()

        for tmdb_row, merged_json, updated_unix in rows:
            ts = float(updated_unix)
            if not _fresh(ts, ttl):
                stale_rows.append(int(tmdb_row))
                continue
            try:
                local[int(tmdb_row)] = dict(json.loads(merged_json))
            except (TypeError, json.JSONDecodeError, ValueError):
                stale_rows.append(int(tmdb_row))

        if stale_rows:
            uqmarks = ",".join("?" * len(stale_rows))
            cx.execute(f"DELETE FROM movie_merge WHERE tmdb_id IN ({uqmarks})", stale_rows)

        cx.commit()
        return local

    try:
        return db_run(work)
    except (OSError, sqlite3.Error, TypeError, ValueError):
        return out


def get_movie_merge(tmdb_id: int | None, *, ttl_secs: float | None = None) -> dict[str, Any] | None:
    if not cache_enabled() or tmdb_id is None:
        return None
    try:
        tid = int(tmdb_id)
    except (TypeError, ValueError):
        return None
    m = get_movie_merges_bulk([tid], ttl_secs=ttl_secs)
    return m.get(tid)


def put_movie_merge(tmdb_id: int | None, merged: dict[str, Any]) -> None:
    if not cache_enabled() or not merged or tmdb_id is None:
        return
    try:
        tid = int(tmdb_id)
    except (TypeError, ValueError):
        return
    blob = json.dumps(merged, separators=(",", ":"), default=str)

    def work(cx: sqlite3.Connection) -> None:
        cx.execute(
            "INSERT INTO movie_merge (tmdb_id, merged_json, updated_unix) "
            "VALUES (?, ?, ?) ON CONFLICT(tmdb_id) DO UPDATE SET "
            "merged_json = excluded.merged_json, updated_unix = excluded.updated_unix",
            (tid, blob, _now()),
        )
        cx.commit()

    try:
        db_run(work)
    except (OSError, sqlite3.Error, TypeError):
        pass


def get_scores_imdb(imdb_key_norm: str, *, ttl_secs: float | None = None) -> dict[str, Any] | None:
    if not cache_enabled():
        return None
    k = imdb_key_norm.strip().lower()
    if not k:
        return None

    ttl = cache_ttl_seconds() if ttl_secs is None else ttl_secs

    def work(cx: sqlite3.Connection) -> dict[str, Any] | None:
        row = cx.execute(
            "SELECT scores_json, updated_unix FROM scores_imdb WHERE imdb_key = ?",
            (k,),
        ).fetchone()
        if not row:
            return None
        payload, ts = row[0], float(row[1])
        if not _fresh(ts, ttl):
            cx.execute("DELETE FROM scores_imdb WHERE imdb_key = ?", (k,))
            cx.commit()
            return None
        try:
            return dict(json.loads(payload))
        except (TypeError, json.JSONDecodeError, ValueError):
            cx.execute("DELETE FROM scores_imdb WHERE imdb_key = ?", (k,))
            cx.commit()
            return None

    try:
        return db_run(work)
    except (OSError, sqlite3.Error):
        return None


def put_scores_imdb(imdb_key_norm: str, scores: dict[str, Any]) -> None:
    if not cache_enabled():
        return
    k = imdb_key_norm.strip().lower()
    if not k:
        return
    blob = json.dumps(scores, separators=(",", ":"), default=str)

    def work(cx: sqlite3.Connection) -> None:
        cx.execute(
            "INSERT INTO scores_imdb (imdb_key, scores_json, updated_unix) "
            "VALUES (?, ?, ?) ON CONFLICT(imdb_key) DO UPDATE SET "
            "scores_json = excluded.scores_json, updated_unix = excluded.updated_unix",
            (k, blob, _now()),
        )
        cx.commit()

    try:
        db_run(work)
    except (OSError, sqlite3.Error, TypeError):
        pass
