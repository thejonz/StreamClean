# StreamClean

Browse **VidAngel-ready** movies with **Tomatometer** or **audience score** sorting (your choice is saved in `localStorage`), watch trailers, and jump straight to VidAngel — without tab-hopping through Netflix, Prime, RT, and VidAngel separately.

**Why mostly a web app?** Same UI runs on iPhone Safari, iPad, and desktop; add StreamClean to your home screen (PWA-style) **or** use the optional Xcode shell under **`ios/`** (loads this server in `WKWebView`). The Python backend is always required unless you redesign for static hosting only.

## What it does

1. Finds movies streaming on services **VidAngel links to**: Netflix, Prime Video, Apple TV+, Peacock, Paramount+
2. Fetches **Tomatometer** and **audience** scores via OMDb (cards and detail show whichever fields are returned — often critic % is present when audience is N/A on the free tier)
3. Sorts by **Tomatometer**, **audience score**, popularity, title, year, or **discovery order (no sort)** — in that mode posters load immediately and Rotten Tomatoes scores fill in afterward; sort mode persists in this browser (`streamclean_sort`)
4. Plays **YouTube trailers** in-app
5. **Open on VidAngel** button for each title
6. **Pagination** loads VidAngel movies in enrichment chunks (~24 titles) and walks TMDB discover **one TMDB page (~20 originals)** at a time in anonymous browse. **Discovery order (no sort)** and deferred VidAngel pages hydrate in **two phases**: **`POST /api/hydrate_discover_tmdb`** (or VidAngel **`POST /api/enrich_catalog_tmdb`**) for trailers and TMDB details, then **`POST /api/hydrate_scores`** for OMDb / Rotten Tomatoes so trailers can show up before Tomato scores finish

**Why it can feel slow:** each survivor title runs one bundled TMDB `/movie/{id}` request plus one OMDb request for tomato scores — network latency stacks across the batch.

**Long-term cache (solo installs):** the server writes a WAL SQLite DB under `.cache/streamclean.sqlite` (gitignored): full enrichment rows keyed by TMDB ID, plus OMDb score blobs keyed by IMDb. Default TTL **90 days** (`STREAMCLEAN_CACHE_DAYS`); toggle with `STREAMCLEAN_CACHE=0`. Clearing stale rows happens automatically when the TTL lapses.

**Why it can feel faster on repeat visits:** paging the same discovers or VidAngel batches mostly hits SQLite + RAM instead of upstream APIs.

> **Note:** VidAngel has no public catalog API. StreamClean shows movies on VidAngel-compatible streaming services. Most titles on those services have VidAngel filters, but always confirm on VidAngel before subscribing to watch.

## VidAngel sign-in (optional)

Click **Sign in to VidAngel** in the header. Your password goes **directly to VidAngel** from your browser — StreamClean's server never receives it. The auth token is stored in **sessionStorage** only (cleared when you close the tab).

When signed in, StreamClean loads your real VidAngel movie catalog filtered to your connected streaming services, then enriches titles with Rotten Tomatoes scores and trailers.

Link Netflix/Prime/etc. at [vidangel.com/services](https://www.vidangel.com/services) before signing in — StreamClean can read which services are connected but cannot link them for you.

## Quick start

### 1. API keys (free)

| Service | Sign up | Used for |
|---------|---------|----------|
| [TMDB](https://www.themoviedb.org/settings/api) | Free API key (v3) | Posters, trailers, streaming availability |
| [OMDb](https://www.omdbapi.com/apikey.aspx) | Free tier (1,000/day) | Rotten Tomatoes scores |

### 2. Configure

```bash
cd ~/Projects/StreamClean
cp .env.example .env
# Edit .env and paste your TMDB_API_KEY and OMDB_API_KEY
```

### 3. Install & run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Open **http://127.0.0.1:8765** in your browser. On iPhone without the Xcode app: open in Safari → Share → **Add to Home Screen**. For **`ios/`** WKWebView build steps, see **[ios/README.md](ios/README.md)**.

## Project layout

```
StreamClean/
├── ios/               # Xcode / SwiftUI shell (loads this server in WKWebView)
├── run.py              # Dev server entry point
├── server/
│   ├── main.py         # FastAPI routes
│   ├── long_cache.py   # SQLite persistent cache (.cache/streamclean.sqlite)
│   ├── tmdb.py         # TMDB discover + trailers
│   └── omdb.py         # Rotten Tomatoes scores
└── static/
    ├── index.html
    ├── styles.css
    ├── app.js
    └── vidangel.js   # Client-side VidAngel auth + catalog
```

## Name: StreamClean

**StreamClean** fits the VidAngel use case: stream the shows you already pay for, but *clean* (filtered). Alternatives considered: CleanStream, FilterFirst, AngelBrowse — StreamClean is short, memorable, and describes the workflow.

## Roadmap ideas

- Cache scores locally to reduce OMDb calls
- Parse VidAngel sitemap for exact catalog cross-reference
- User watchlist / seen list

## License

Your project — add a license as you prefer. Movie metadata © TMDB contributors. Not affiliated with VidAngel, Netflix, Amazon, or Rotten Tomatoes.
