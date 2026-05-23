from __future__ import annotations

import httpx

from server.config import OMDB_API_KEY, OMDB_BASE, is_configured_key


class OmdbError(Exception):
    pass


async def fetch_rt_scores(client: httpx.AsyncClient, imdb_id: str | None, *, title: str | None = None, year: str | None = None) -> dict:
    try:
        if imdb_id and is_configured_key(OMDB_API_KEY):
            scores = await _fetch_rt_by_imdb(client, imdb_id)
            if scores.get("critic_score") is not None:
                return scores

        if title and is_configured_key(OMDB_API_KEY):
            params: dict[str, str] = {"t": title, "apikey": OMDB_API_KEY, "tomatoes": "true", "type": "movie"}
            if year:
                params["y"] = year
            response = await client.get(OMDB_BASE, params=params, timeout=15.0)
            response.raise_for_status()
            data = response.json()
            if data.get("Response") == "True":
                return _scores_from_omdb(data)
    except httpx.HTTPError:
        pass

    return _empty_scores()


async def _fetch_rt_by_imdb(client: httpx.AsyncClient, imdb_id: str) -> dict:
    if not is_configured_key(OMDB_API_KEY):
        return _empty_scores()

    try:
        response = await client.get(
            OMDB_BASE,
            params={"i": imdb_id, "apikey": OMDB_API_KEY, "tomatoes": "true"},
            timeout=15.0,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("Response") != "True":
            return _empty_scores()
        return _scores_from_omdb(data)
    except httpx.HTTPError:
        return _empty_scores()


def _scores_from_omdb(data: dict) -> dict:
    critic = _parse_int(data.get("tomatoMeter"))
    audience = _parse_int(data.get("tomatoUserMeter"))
    image = data.get("tomatoImage") or ""
    rating = "certified" if image == "certified" else ("fresh" if critic and critic >= 60 else "rotten" if critic else None)

    return {
        "critic_score": critic,
        "audience_score": audience,
        "critic_rating": rating,
        "consensus": data.get("tomatoConsensus") or None,
        "rt_url": f"https://www.rottentomatoes.com/search?search={data.get('Title', '')}",
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
        "consensus": None,
        "rt_url": None,
    }
