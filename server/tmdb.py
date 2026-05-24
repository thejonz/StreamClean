from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote_plus

import httpx

from server.config import (
    BACKDROP_BASE,
    POSTER_BASE,
    TMDB_API_KEY,
    TMDB_BASE,
    VIDANGEL_PROVIDERS,
    is_configured_key,
)


class TmdbError(Exception):
    pass


async def _get(client: httpx.AsyncClient, path: str, params: dict | None = None) -> Any:
    if not is_configured_key(TMDB_API_KEY):
        raise TmdbError(
            "TMDB_API_KEY is not set. Edit ~/Projects/StreamClean/.env and paste your key from "
            "https://www.themoviedb.org/settings/api"
        )
    query = {"api_key": TMDB_API_KEY, **(params or {})}
    response = await client.get(f"{TMDB_BASE}{path}", params=query, timeout=30.0)
    if response.status_code == 401:
        raise TmdbError(
            "TMDB rejected your API key (401). Edit .env — use the v3 API key from "
            "https://www.themoviedb.org/settings/api (not the example placeholder)."
        )
    response.raise_for_status()
    return response.json()


async def discover_movies(
    client: httpx.AsyncClient,
    *,
    provider_ids: list[int] | None = None,
    page: int = 1,
) -> tuple[list[dict], int]:
    """TMDB discover (US watch providers filter). Returns (results_this_page, total_pages)."""
    ids = provider_ids or list(VIDANGEL_PROVIDERS.values())
    provider_filter = "|".join(str(i) for i in ids)
    data = await _get(
        client,
        "/discover/movie",
        {
            "with_watch_providers": provider_filter,
            "watch_region": "US",
            "sort_by": "popularity.desc",
            "page": page,
            "include_adult": "false",
            "vote_count.gte": 50,
        },
    )
    results = data.get("results") or []
    try:
        total_pages = max(1, int(data.get("total_pages") or 1))
    except (TypeError, ValueError):
        total_pages = 1
    return results, total_pages


async def movie_external_ids(client: httpx.AsyncClient, tmdb_id: int) -> dict:
    return await _get(client, f"/movie/{tmdb_id}/external_ids")


async def movie_videos(client: httpx.AsyncClient, tmdb_id: int) -> list[dict]:
    data = await _get(client, f"/movie/{tmdb_id}/videos")
    return data.get("results", [])


async def movie_watch_providers(client: httpx.AsyncClient, tmdb_id: int) -> dict[str, dict]:
    data = await _get(client, f"/movie/{tmdb_id}/watch/providers")
    us = data.get("results", {}).get("US", {})
    flatrate = us.get("flatrate") or []
    provider_names = {p["provider_id"]: p["provider_name"] for p in flatrate}
    matched = []
    for key, pid in VIDANGEL_PROVIDERS.items():
        if pid in provider_names:
            matched.append({"id": key, "name": provider_names[pid]})
    return matched


def pick_trailer(videos: list[dict]) -> str | None:
    trailers = [v for v in videos if v.get("site") == "YouTube" and v.get("type") == "Trailer"]
    if not trailers:
        teasers = [v for v in videos if v.get("site") == "YouTube" and v.get("type") == "Teaser"]
        trailers = teasers
    if not trailers:
        return None
    official = next((v for v in trailers if v.get("official")), trailers[0])
    return official.get("key")


async def search_movie(client: httpx.AsyncClient, title: str, year: str | None = None) -> dict | None:
    params: dict[str, Any] = {"query": title, "include_adult": "false"}
    if year:
        params["year"] = year
    data = await _get(client, "/search/movie", params)
    results = data.get("results") or []
    if not results:
        return None
    if year:
        for item in results:
            if (item.get("release_date") or "")[:4] == year:
                return item
    return results[0]


async def enrich_by_title(
    client: httpx.AsyncClient,
    *,
    title: str,
    year: str | None = None,
    poster_url: str | None = None,
    overview: str | None = None,
) -> dict:
    if not is_configured_key(TMDB_API_KEY):
        return {
            "imdb_id": None,
            "trailer_key": None,
            "poster_url": poster_url,
            "overview": overview or "",
        }

    try:
        hit = await search_movie(client, title, year)
    except (TmdbError, httpx.HTTPError):
        return {
            "imdb_id": None,
            "trailer_key": None,
            "poster_url": poster_url,
            "overview": overview or "",
        }
    if not hit:
        return {
            "imdb_id": None,
            "trailer_key": None,
            "poster_url": poster_url,
            "overview": overview or "",
        }

    tmdb_id = hit["id"]
    try:
        external, videos = await asyncio.gather(
            movie_external_ids(client, tmdb_id),
            movie_videos(client, tmdb_id),
        )
    except httpx.HTTPError:
        return {
            "imdb_id": None,
            "trailer_key": None,
            "poster_url": poster_url,
            "overview": overview or hit.get("overview") or "",
            "tmdb_id": tmdb_id,
        }
    poster_path = hit.get("poster_path")
    return {
        "imdb_id": external.get("imdb_id"),
        "trailer_key": pick_trailer(videos),
        "poster_url": poster_url or (f"{POSTER_BASE}{poster_path}" if poster_path else None),
        "overview": overview or hit.get("overview") or "",
        "tmdb_id": tmdb_id,
    }


async def enrich_movie(client: httpx.AsyncClient, raw: dict) -> dict | None:
    """One TMDB `/movie/{id}` bundles external IDs, trailers, providers (~3× fewer round-trips vs three endpoints)."""
    tmdb_id = raw["id"]
    try:
        data = await _get(
            client,
            f"/movie/{tmdb_id}",
            {"append_to_response": "external_ids,videos,watch/providers"},
        )
    except httpx.HTTPError:
        return await _enrich_movie_parallel_fallback(client, raw)

    ext = data.get("external_ids") or {}
    vid_block = data.get("videos") or {}
    videos = vid_block.get("results") if isinstance(vid_block, dict) else []
    if videos is None:
        videos = []

    wp_flat = (
        data.get("watch/providers")
        if isinstance(data.get("watch/providers"), dict)
        else data.get("watch_providers")
    )
    if not isinstance(wp_flat, dict):
        wp_flat = {}
    wp_results = wp_flat.get("results") or {}
    if not isinstance(wp_results, dict):
        wp_results = {}
    us = wp_results.get("US", {})
    flatrate = us.get("flatrate") or []
    provider_names = {p["provider_id"]: p["provider_name"] for p in flatrate}
    matched: list[dict] = []
    for key, pid in VIDANGEL_PROVIDERS.items():
        if pid in provider_names:
            matched.append({"id": key, "name": provider_names[pid]})

    if not matched:
        return await _enrich_movie_parallel_fallback(client, raw)

    poster_path = raw.get("poster_path") or data.get("poster_path")
    backdrop_path = raw.get("backdrop_path") or data.get("backdrop_path")
    title = raw.get("title") or raw.get("name") or data.get("title") or data.get("name") or "Unknown"
    overview = raw.get("overview") or data.get("overview") or ""
    yr = raw.get("release_date") or data.get("release_date") or ""
    year = (yr[:4] if yr else None) or None
    return {
        "tmdb_id": tmdb_id,
        "title": title,
        "year": year,
        "overview": overview,
        "poster_url": f"{POSTER_BASE}{poster_path}" if poster_path else None,
        "backdrop_url": f"{BACKDROP_BASE}{backdrop_path}" if backdrop_path else None,
        "imdb_id": ext.get("imdb_id"),
        "trailer_key": pick_trailer(videos if isinstance(videos, list) else []),
        "providers": matched,
        "vidangel_url": f"https://www.vidangel.com/search?q={quote_plus(title)}",
        "tmdb_url": f"https://www.themoviedb.org/movie/{tmdb_id}",
    }


async def _enrich_movie_parallel_fallback(client: httpx.AsyncClient, raw: dict) -> dict | None:
    """If append-to-response fails or parses unexpectedly, fall back to three parallel TMDB endpoints."""
    tmdb_id = raw["id"]
    try:
        external, videos, providers = await asyncio.gather(
            movie_external_ids(client, tmdb_id),
            movie_videos(client, tmdb_id),
            movie_watch_providers(client, tmdb_id),
        )
    except httpx.HTTPError:
        return None

    if not providers:
        return None

    poster_path = raw.get("poster_path")
    backdrop_path = raw.get("backdrop_path")
    title = raw.get("title") or raw.get("name") or "Unknown"
    return {
        "tmdb_id": tmdb_id,
        "title": title,
        "year": (raw.get("release_date") or "")[:4] or None,
        "overview": raw.get("overview") or "",
        "poster_url": f"{POSTER_BASE}{poster_path}" if poster_path else None,
        "backdrop_url": f"{BACKDROP_BASE}{backdrop_path}" if backdrop_path else None,
        "imdb_id": external.get("imdb_id"),
        "trailer_key": pick_trailer(videos),
        "providers": providers,
        "vidangel_url": f"https://www.vidangel.com/search?q={quote_plus(title)}",
        "tmdb_url": f"https://www.themoviedb.org/movie/{tmdb_id}",
    }
