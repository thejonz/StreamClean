from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from server.config import OMDB_API_KEY, ROOT, TMDB_API_KEY, VIDANGEL_PROVIDERS, is_configured_key
from server.omdb import _empty_scores, fetch_rt_scores
from pydantic import BaseModel

from server.tmdb import TmdbError, discover_movies, enrich_by_title, enrich_movie

STATIC_DIR = ROOT / "static"
app = FastAPI(title="StreamClean", description="VidAngel-ready movies sorted by audience score")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


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
    }


@app.get("/api/movies")
async def movies(
    sort: str = Query("audience", pattern="^(audience|rt|title|year|popular)$"),
    provider: str | None = Query(None),
    page: int = Query(1, ge=1, le=500),
):
    provider_ids = None
    if provider and provider in VIDANGEL_PROVIDERS:
        provider_ids = [VIDANGEL_PROVIDERS[provider]]

    try:
        async with httpx.AsyncClient() as client:
            sem = asyncio.Semaphore(16)

            async def enrich_one(raw: dict) -> dict | None:
                async with sem:
                    base = await enrich_movie(client, raw)
                    if not base:
                        return None
                    scores = await fetch_rt_scores(client, base.get("imdb_id"))
                    return {**base, **scores}

            raw_movies, total_pages = await discover_movies(
                client, provider_ids=provider_ids, page=page
            )
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
    }


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
                    return {**base, **extras, **scores}
                except (httpx.HTTPError, TmdbError):
                    return fallback

        results = await asyncio.gather(*(enrich_one(m) for m in body.movies))

    return {
        "movies": list(results),
        "tmdb_configured": is_configured_key(TMDB_API_KEY),
        "omdb_configured": is_configured_key(OMDB_API_KEY),
    }


def _sort_movies(movies: list[dict], sort: str) -> list[dict]:
    if sort in ("audience", "rt"):
        return sorted(movies, key=lambda m: (m.get("audience_score") is None, -(m.get("audience_score") or 0)))
    if sort == "title":
        return sorted(movies, key=lambda m: m.get("title", "").lower())
    if sort == "year":
        return sorted(movies, key=lambda m: m.get("year") or "", reverse=True)
    return movies
