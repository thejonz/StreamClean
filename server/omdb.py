from __future__ import annotations

import re
from urllib.parse import quote_plus

import httpx

from server.config import OMDB_API_KEY, OMDB_BASE, is_configured_key




# One OMDb request per enriched title dominates latency; caching imdb lookups helps pagination / rewinds.
_RT_SCORE_CACHE: dict[str, dict] = {}
_RT_CACHE_ALARM = 3072


def _imdb_norm(imdb_id: str) -> str:
    return imdb_id.strip().lower()


def _cache_scores(imdb_norm: str, payload: dict) -> None:
    _RT_SCORE_CACHE[imdb_norm] = payload
    if len(_RT_SCORE_CACHE) > _RT_CACHE_ALARM:
        _RT_SCORE_CACHE.pop(next(iter(_RT_SCORE_CACHE)))  # naive bound against unbounded RAM

    pass


def _critic_score_from_ratings(data: dict) -> int | None:
    """OMDb often returns tomatoMeter=N/A while the Tomatometer lives in Ratings."""
    ratings = data.get("Ratings") or []
    for entry in ratings:
        if entry.get("Source") == "Rotten Tomatoes":
            value = str(entry.get("Value", "")).strip()
            match = re.search(r"(\d+)\s*%", value)
            if match:
                return int(match.group(1))
            return None
    return None


async def fetch_rt_scores(client: httpx.AsyncClient, imdb_id: str | None, *, title: str | None = None, year: str | None = None) -> dict:
    try:
        if imdb_id and is_configured_key(OMDB_API_KEY):
            imdb_key = _imdb_norm(imdb_id)
            if imdb_key in _RT_SCORE_CACHE:
                return dict(_RT_SCORE_CACHE[imdb_key])

            try:
                response = await client.get(
                    OMDB_BASE,
                    params={"i": imdb_id, "apikey": OMDB_API_KEY, "tomatoes": "true"},
                    timeout=15.0,
                )
                response.raise_for_status()
                data = response.json()
                if data.get("Response") == "True":
                    out = _scores_from_omdb(data)
                    canon = data.get("imdbID")
                    _cache_scores(_imdb_norm(canon) if canon else imdb_key, out)
                    return out
            except httpx.HTTPError:
                pass

        if title and is_configured_key(OMDB_API_KEY):
            params: dict[str, str] = {"t": title, "apikey": OMDB_API_KEY, "tomatoes": "true", "type": "movie"}
            if year:
                params["y"] = year
            response = await client.get(OMDB_BASE, params=params, timeout=15.0)
            response.raise_for_status()
            data = response.json()
            if data.get("Response") == "True":
                out = _scores_from_omdb(data)
                canon = data.get("imdbID")
                if canon:
                    _cache_scores(_imdb_norm(canon), out)
                return out
    except httpx.HTTPError:
        pass

    return _empty_scores()


def _audience_rating_from_omdb(data: dict) -> str | None:
    raw = (data.get("tomatoUserRating") or "").strip().lower()
    if raw == "upright":
        return "upright"
    if raw == "spilled":
        return "spilled"
    return None


def _scores_from_omdb(data: dict) -> dict:
    critic = _parse_int(data.get("tomatoMeter"))
    if critic is None:
        critic = _critic_score_from_ratings(data)

    audience = _parse_int(data.get("tomatoUserMeter"))

    rt_rating_value = ""
    for entry in data.get("Ratings") or []:
        if entry.get("Source") == "Rotten Tomatoes":
            rt_rating_value = str(entry.get("Value", ""))
            break

    image = data.get("tomatoImage") or ""
    certified = image == "certified" or "certified fresh" in rt_rating_value.lower()
    if certified:
        rating = "certified"
    elif critic is not None:
        rating = "fresh" if critic >= 60 else "rotten"
    else:
        rating = None

    tomato_link = (data.get("tomatoURL") or "").strip()
    if tomato_link.startswith("http"):
        rt_url = tomato_link
    else:
        rt_url = f"https://www.rottentomatoes.com/search?search={quote_plus(data.get('Title', ''))}"

    consensus = data.get("tomatoConsensus")
    if consensus in (None, "N/A", ""):
        consensus = None

    audience_rating = _audience_rating_from_omdb(data)

    return {
        "critic_score": critic,
        "audience_score": audience,
        "critic_rating": rating,
        "audience_rating": audience_rating,
        "consensus": consensus,
        "rt_url": rt_url or None,
    }


def _parse_int(value: str | int | None) -> int | None:
    if value is None or value == "N/A":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _empty_scores() -> dict:
    return {
        "critic_score": None,
        "audience_score": None,
        "critic_rating": None,
        "audience_rating": None,
        "consensus": None,
        "rt_url": None,
    }
