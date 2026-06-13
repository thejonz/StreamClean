import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Long-lived enrichment cache on disk (~/.cache under repo root; ignored by git)
CACHE_DB_PATH = ROOT / ".cache" / "streamclean.sqlite"


def cache_enabled() -> bool:
    v = os.getenv("STREAMCLEAN_CACHE")
    if v is None or v.strip() == "":
        return True
    return v.strip().lower() not in {"0", "false", "no", "off"}


def cache_ttl_seconds() -> float:
    raw = os.getenv("STREAMCLEAN_CACHE_DAYS", "90").strip()
    try:
        days = int(raw)
    except ValueError:
        days = 90
    days = max(1, days)
    return float(days * 86400)

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "")
OMDB_API_KEY = os.getenv("OMDB_API_KEY", "")


def is_configured_key(key: str) -> bool:
    """True when a real API key appears to be set (not the .env.example placeholder)."""
    if not key or not key.strip():
        return False
    lower = key.strip().lower()
    if "your_" in lower and "_here" in lower:
        return False
    if lower.startswith("paste_") or lower in {"changeme", "xxx", "test"}:
        return False
    return True

# Streaming services VidAngel links to (TMDB provider IDs, US region)
VIDANGEL_PROVIDERS = {
    "netflix": 8,
    "prime": 9,
    "apple": 350,
    "peacock": 386,
    "paramount": 531,
}

TMDB_BASE = "https://api.themoviedb.org/3"
OMDB_BASE = "https://www.omdbapi.com"
POSTER_BASE = "https://image.tmdb.org/t/p/w500"
BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280"
