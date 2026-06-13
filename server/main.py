from __future__ import annotations

import asyncio
from urllib.parse import quote_plus

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from server.config import (
    BACKDROP_BASE,
    OMDB_API_KEY,
    POSTER_BASE,
    ROOT,
    TMDB_API_KEY,
    VIDANGEL_PROVIDERS,
    cache_enabled as disk_cache_enabled,
    cache_ttl_seconds,
    is_configured_key,
)
from server.long_cache import get_movie_merges_bulk, put_movie_merge
from server.omdb import _empty_scores, fetch_rt_scores
from server.tmdb import TmdbError, discover_movies, enrich_by_title, enrich_movie

STATIC_DIR = ROOT / "static"
app = FastAPI(title="StreamClean", description="VidAngel-ready movies sorted by Tomatometer or audience score")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _discover_skeleton(raw: dict) -> dict:
    """Poster + synopsis from TMDB discover only (no enrichment round-trips)."""
    pid = raw.get("id")
    poster_path = raw.get("poster_path")
    backdrop_path = raw.get("backdrop_path")
    title = raw.get("title") or raw.get("name") or "Unknown"
    rel = raw.get("release_date") or ""
    return {
        "tmdb_id": pid,
        "title": title,
        "year": (rel[:4] if rel else None) or None,
        "overview": raw.get("overview") or "",
        "poster_url": f"{POSTER_BASE}{poster_path}" if poster_path else None,
        "backdrop_url": f"{BACKDROP_BASE}{backdrop_path}" if backdrop_path else None,
        "imdb_id": None,
        "trailer_key": None,
        "providers": [],
        "vidangel_url": f"https://www.vidangel.com/search?q={quote_plus(title)}",
        "tmdb_url": f"https://www.themoviedb.org/movie/{pid}" if pid else None,
        **_empty_scores(),
    }


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "tmdb_configured": is_configured_key(TMDB_API_KEY),
        "omdb_configured": is_configured_key(OMDB_API_KEY),
        "providers": list(VIDANGEL_PROVIDERS.keys()),
        "sqlite_cache_enabled": disk_cache_enabled(),
        "sqlite_cache_ttl_seconds": cache_ttl_seconds() if disk_cache_enabled() else None,
    }


@app.get("/api/movies")
async def movies(
    sort: str = Query(
        "tomatometer",
        pattern="^(tomatometer|audience|rt|title|year|popular|none)$",
    ),
    provider: str | None = Query(None),
    page: int = Query(1, ge=1, le=500),
    enrich: bool = Query(True, description="If false, only discover payloads (instant posters). Hydrate via POST."),
):
    provider_ids = None
    if provider and provider in VIDANGEL_PROVIDERS:
        provider_ids = [VIDANGEL_PROVIDERS[provider]]

    raw_movies: list[dict] = []
    try:
        async with httpx.AsyncClient() as client:
            raw_movies, total_pages = await discover_movies(
                client, provider_ids=provider_ids, page=page
            )

            if not enrich:
                skeletons = [_discover_skeleton(r) for r in raw_movies if r.get("id") is not None]
                skeletons = _sort_movies(skeletons, sort)
                return {
                    "movies": skeletons,
                    "sort": sort,
                    "discover_page": page,
                    "discover_total_pages": total_pages,
                    "discover_results_raw": len(raw_movies),
                    "enriched": False,
                }

            sem = asyncio.Semaphore(16)

            prefetch_ids = [row.get("id") for row in raw_movies if row.get("id") is not None]
            prefetch = (
                await asyncio.to_thread(get_movie_merges_bulk, prefetch_ids) if prefetch_ids else {}
            )

            async def enrich_one(raw: dict) -> dict | None:
                tid_raw = raw.get("id")

                if tid_raw is not None:
                    try:
                        merged_hit = prefetch.get(int(tid_raw))
                        if merged_hit is not None:
                            return merged_hit
                    except (TypeError, ValueError):
                        pass

                async with sem:
                    base = await enrich_movie(client, raw)
                    if not base:
                        return None
                    scores = await fetch_rt_scores(client, base.get("imdb_id"))
                    merged = {**base, **scores}
                    stash_id = tid_raw if tid_raw is not None else merged.get("tmdb_id")
                    await asyncio.to_thread(put_movie_merge, stash_id, merged)
                    return merged

            enriched = await asyncio.gather(*(enrich_one(m) for m in raw_movies))
            results = [m for m in enriched if m is not None]

    except TmdbError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Upstream API error: {exc}") from exc

    results = _sort_movies(results, sort)
    return {
        "movies": results,
        "sort": sort,
        "discover_page": page,
        "discover_total_pages": total_pages,
        "discover_results_raw": len(raw_movies),
        "enriched": True,
    }


class DiscoverHydrateIdsRequest(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=80)


async def _discover_tid_tmdb_only(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    prefetch: dict[int, dict],
    tmdb_id: int,
) -> dict:
    """TMDB enrichment + empty score placeholders; persists partial cache row for phase 2."""
    hit = prefetch.get(int(tmdb_id))
    if hit is not None:
        return dict(hit)

    raw_stub = {"id": tmdb_id}
    async with sem:
        base = await enrich_movie(client, raw_stub)
        if not base:
            sk = _discover_skeleton(
                {
                    "id": tmdb_id,
                    "title": f"Movie {tmdb_id}",
                    "overview": "",
                    "release_date": "",
                }
            )
            return sk
        partial = {**base, **_empty_scores()}
        await asyncio.to_thread(put_movie_merge, tmdb_id, partial)
        return partial


async def _hydrate_tid_scores(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    prefetch: dict[int, dict],
    tmdb_id: int,
) -> dict:
    """OMDb Rotten Tomatoes layer on top of an existing TMDB merge (from phase 1 or SQLite)."""
    row = prefetch.get(int(tmdb_id))
    if row is None:
        raw_stub = {"id": tmdb_id}
        async with sem:
            base = await enrich_movie(client, raw_stub)
        if base:
            row = {**base, **_empty_scores()}
            await asyncio.to_thread(put_movie_merge, tmdb_id, row)
        else:
            row = _discover_skeleton(
                {
                    "id": tmdb_id,
                    "title": f"Movie {tmdb_id}",
                    "overview": "",
                    "release_date": "",
                }
            )

    imdb_id = row.get("imdb_id")
    title_kw = row.get("title") if isinstance(row.get("title"), str) else None
    yr = row.get("year")
    year_kw = str(yr) if yr not in (None, "") else None

    async with sem:
        scores = await fetch_rt_scores(client, imdb_id, title=title_kw, year=year_kw)
    merged = {**row, **scores}
    await asyncio.to_thread(put_movie_merge, tmdb_id, merged)
    return merged


@app.post("/api/hydrate_discover_tmdb")
async def hydrate_discover_tmdb(body: DiscoverHydrateIdsRequest):
    """Phase 1: trailers, providers, IMDb id — Rotten Tomato fields left empty."""
    try:
        async with httpx.AsyncClient() as client:
            sem = asyncio.Semaphore(16)
            prefetch = await asyncio.to_thread(get_movie_merges_bulk, body.ids)
            movies = await asyncio.gather(
                *(_discover_tid_tmdb_only(client, sem, prefetch, i) for i in body.ids)
            )
    except TmdbError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Upstream API error: {exc}") from exc

    return {"movies": list(movies)}


@app.post("/api/hydrate_scores")
async def hydrate_scores(body: DiscoverHydrateIdsRequest):
    """Phase 2: fill Rotten Tomatoes / OMDb fields for titles already keyed by TMDB id."""
    try:
        async with httpx.AsyncClient() as client:
            sem = asyncio.Semaphore(16)
            prefetch = await asyncio.to_thread(get_movie_merges_bulk, body.ids)
            movies = await asyncio.gather(*(_hydrate_tid_scores(client, sem, prefetch, i) for i in body.ids))
    except TmdbError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Upstream API error: {exc}") from exc

    return {"movies": list(movies)}


class EnrichItem(BaseModel):
    title: str
    year: str | None = None
    overview: str | None = None
    poster_url: str | None = None
    vidangel_url: str | None = None
    providers: list[dict] | None = None
    slug: str | None = None
    va_id: int | None = None
    source: str | None = None


class EnrichRequest(BaseModel):
    movies: list[EnrichItem]


@app.post("/api/enrich_catalog_tmdb")
async def enrich_catalog_tmdb(body: EnrichRequest):
    """Phase 1 (VidAngel rows): TMDB match + trailers; RT fields empty. Follow with POST /api/hydrate_scores."""
    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        sem = asyncio.Semaphore(10)

        async def enrich_one(item: EnrichItem) -> dict:
            base = item.model_dump()
            fallback = {
                **base,
                **_empty_scores(),
                "imdb_id": None,
                "trailer_key": None,
            }
            if not is_configured_key(TMDB_API_KEY):
                return fallback

            async with sem:
                try:
                    extras = await enrich_by_title(
                        client,
                        title=item.title,
                        year=item.year,
                        poster_url=item.poster_url,
                        overview=item.overview,
                    )
                    merged = {**base, **extras, **_empty_scores()}
                    stash_id = extras.get("tmdb_id")
                    if stash_id is not None:
                        await asyncio.to_thread(put_movie_merge, stash_id, merged)
                    return merged
                except (httpx.HTTPError, TmdbError):
                    return fallback

        results = await asyncio.gather(*(enrich_one(m) for m in body.movies))

    return {
        "movies": list(results),
        "tmdb_configured": is_configured_key(TMDB_API_KEY),
        "omdb_configured": is_configured_key(OMDB_API_KEY),
    }


@app.post("/api/enrich")
async def enrich(body: EnrichRequest):
    """Add RT scores and trailers to VidAngel catalog items (no VidAngel credentials on server)."""
    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        sem = asyncio.Semaphore(10)

        async def enrich_one(item: EnrichItem) -> dict:
            base = item.model_dump()
            fallback = {
                **base,
                **_empty_scores(),
                "imdb_id": None,
                "trailer_key": None,
            }
            if not is_configured_key(TMDB_API_KEY) and not is_configured_key(OMDB_API_KEY):
                return fallback

            async with sem:
                try:
                    extras = await enrich_by_title(
                        client,
                        title=item.title,
                        year=item.year,
                        poster_url=item.poster_url,
                        overview=item.overview,
                    )
                    scores = await fetch_rt_scores(
                        client, extras.get("imdb_id"), title=item.title, year=item.year
                    )
                    merged = {**base, **extras, **scores}
                    stash_id = extras.get("tmdb_id")
                    if stash_id is not None:
                        await asyncio.to_thread(put_movie_merge, stash_id, merged)
                    return merged
                except (httpx.HTTPError, TmdbError):
                    return fallback

        results = await asyncio.gather(*(enrich_one(m) for m in body.movies))

    return {
        "movies": list(results),
        "tmdb_configured": is_configured_key(TMDB_API_KEY),
        "omdb_configured": is_configured_key(OMDB_API_KEY),
    }


def _sort_movies(movies: list[dict], sort: str) -> list[dict]:
    if sort in ("tomatometer", "rt"):
        return sorted(movies, key=lambda m: (m.get("critic_score") is None, -(m.get("critic_score") or 0)))
    if sort == "audience":
        return sorted(movies, key=lambda m: (m.get("audience_score") is None, -(m.get("audience_score") or 0)))
    if sort == "title":
        return sorted(movies, key=lambda m: m.get("title", "").lower())
    if sort == "year":
        return sorted(movies, key=lambda m: m.get("year") or "", reverse=True)
    # popular, none, unknown — keep discover / carousel insertion order
    return movies
