# StreamClean

Browse **VidAngel-ready** movies sorted by **Rotten Tomatoes** score, watch trailers, and jump straight to VidAngel — without tab-hopping through Netflix, Prime, RT, and VidAngel separately.

**Why a website (not an iPhone app)?** You get something usable today on iPhone Safari, iPad, and desktop. No App Store wait, no separate Android build. Add it to your home screen for an app-like experience (PWA-friendly layout).

## What it does

1. Finds movies streaming on services **VidAngel links to**: Netflix, Prime Video, Apple TV+, Peacock, Paramount+
2. Fetches **Tomatometer** and audience scores (via OMDb → Rotten Tomatoes data)
3. Sorts by critic score (default), popularity, title, or year
4. Plays **YouTube trailers** in-app
5. **Open on VidAngel** button for each title

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

Open **http://127.0.0.1:8765** in your browser. On iPhone: open in Safari → Share → **Add to Home Screen**.

## Project layout

```
StreamClean/
├── run.py              # Dev server entry point
├── server/
│   ├── main.py         # FastAPI routes
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
- Native iPhone app (SwiftUI) sharing the same backend

## License

Your project — add a license as you prefer. Movie metadata © TMDB contributors. Not affiliated with VidAngel, Netflix, Amazon, or Rotten Tomatoes.
