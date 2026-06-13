import {
  catalogMapFromFilters,
  connectedCatalogs,
  dedupeMovies,
  filterByProvider,
  flattenMovieWorks,
  getBrowseMovies,
  getServiceFilters,
  getStoredUser,
  selectedCatalogIds,
  isLoggedIn,
  login,
  logout,
  restoreSession,
  sortMovies,
} from "./vidangel.js";

const grid = document.getElementById("grid");
const status = document.getElementById("status");
const sortSelect = document.getElementById("sort");
const providerSelect = document.getElementById("provider");
const modal = document.getElementById("modal");
const trailerEl = document.getElementById("trailer");
const modalTitle = document.getElementById("modal-title");
const modalScores = document.getElementById("modal-scores");
const modalOverview = document.getElementById("modal-overview");
const modalProviders = document.getElementById("modal-providers");
const linkVidangel = document.getElementById("link-vidangel");
const linkRt = document.getElementById("link-rt");
const authBar = document.getElementById("auth-bar");
const loginDialog = document.getElementById("login-dialog");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const heroLead = document.getElementById("hero-lead");
const pagerPrev = document.getElementById("pager-prev");
const pagerNext = document.getElementById("pager-next");
const pagerStatus = document.getElementById("pager-status");
const pagerPrevTop = document.getElementById("pager-prev-top");
const pagerNextTop = document.getElementById("pager-next-top");
const pagerStatusTop = document.getElementById("pager-status-top");
const loadHint = document.getElementById("load-hint");

const PROVIDER_PREF_KEY = "streamclean_provider";
const SORT_PREF_KEY = "streamclean_sort";

/** Movies per VidAngel enrichment batch (pairs with pager). */
const VA_PAGE_SIZE = 24;

let browseDiscoverPage = 1;
let browseDiscoverTotalPages = 1;
let browseVaPage = 1;
let browseVaTotalPages = 1;
let browseVaFilteredCount = 0;
/** Deduped VidAngel carousel (unfiltered); cleared on logout or explicit invalidate. */
let browseVaFullCatalog = null;
let lastDiscoverRawCount = 0;
let hydrateGen = 0;
const DISCOVER_ENRICH_BATCH = 80;
/** Keeps modal in sync while the visible row hydrates TMDB/trailer/scores after open. */
let modalBoundMovie = null;

function restoreProviderPreference() {
  try {
    const saved = localStorage.getItem(PROVIDER_PREF_KEY);
    if (saved == null) return;
    const valid = [...providerSelect.options].some((o) => o.value === saved);
    if (valid) providerSelect.value = saved;
  } catch {
    /* private mode */
  }
}

function persistProviderPreference() {
  try {
    localStorage.setItem(PROVIDER_PREF_KEY, providerSelect.value);
  } catch {
    /* ignore */
  }
}

function restoreSortPreference() {
  try {
    const allowed = [...sortSelect.options].map((o) => o.value);
    const saved = localStorage.getItem(SORT_PREF_KEY);
    if (saved != null && allowed.includes(saved)) sortSelect.value = saved;
    else sortSelect.value = allowed.includes("tomatometer") ? "tomatometer" : allowed[0] || sortSelect.value;
  } catch {
    /* private mode — keep markup default */
  }
}

function persistSortPreference() {
  try {
    localStorage.setItem(SORT_PREF_KEY, sortSelect.value);
  } catch {
    /* ignore */
  }
}

function resetBrowsePaging() {
  browseDiscoverPage = 1;
  browseVaPage = 1;
}

function invalidateVidAngelCatalogMemory() {
  browseVaFullCatalog = null;
}

function refreshPagerChrome() {
  const vaFlow = useVidAngel && isLoggedIn();
  const pagerLine = vaFlow
    ? `VidAngel · page ${browseVaPage} / ${browseVaTotalPages} · ${browseVaFilteredCount} matched`
    : `TMDB · page ${browseDiscoverPage} / ${browseDiscoverTotalPages} (${lastDiscoverRawCount} raw)`;
  pagerStatus.textContent = pagerLine;
  if (pagerStatusTop) pagerStatusTop.textContent = pagerLine;
  const atStart = vaFlow ? browseVaPage <= 1 : browseDiscoverPage <= 1;
  const atEnd = vaFlow ? browseVaPage >= browseVaTotalPages : browseDiscoverPage >= browseDiscoverTotalPages;
  pagerPrev.disabled = atStart;
  pagerNext.disabled = atEnd;
  if (pagerPrevTop) pagerPrevTop.disabled = atStart;
  if (pagerNextTop) pagerNextTop.disabled = atEnd;
}

let movies = [];
let vaFilters = null;
let useVidAngel = false;

function setStatus(message, type = "") {
  status.textContent = message;
  status.className = `status ${type}`.trim();
}

function rtLabel(score) {
  return score != null ? `${score}%` : "—";
}

function rtClass(rating, score) {
  if (rating === "certified") return "certified";
  if (score == null) return "unknown";
  return score >= 60 ? "fresh" : "rotten";
}

/** Popcornmeter-style badge: upright/spilled vs numeric %. */
function audienceClass(audienceRating, audienceScore) {
  if (audienceRating === "upright") return "fresh";
  if (audienceRating === "spilled") return "rotten";
  if (audienceScore == null) return "unknown";
  return audienceScore >= 60 ? "fresh" : "rotten";
}

function audienceLabel(movie) {
  if (movie.audience_score != null) return rtLabel(movie.audience_score);
  if (movie.audience_rating === "upright") return "Upright";
  if (movie.audience_rating === "spilled") return "Spilled";
  return "—";
}

function hasCriticDisplay(movie) {
  return movie.critic_score != null || movie.critic_rating;
}

function hasAudienceDisplay(movie) {
  return movie.audience_score != null || movie.audience_rating;
}

/** Card overlays: match sort emphasis — audience sort favors 🍿, Tomatometer sort favors 🍅; other sorts show both when available. */
function formatCardScores(movie) {
  if (movie._scoresPending) {
    return `<div class="card-score-badges"><span class="rt-badge unknown pending-scores" title="">Scores loading…</span></div>`;
  }
  const mode = sortSelect.value;

  function pushTomato() {
    const c = rtClass(movie.critic_rating, movie.critic_score);
    badges.push(`<span class="rt-badge ${c}" title="Tomatometer">🍅 ${rtLabel(movie.critic_score)}</span>`);
  }

  function pushPopcorn() {
    const a = audienceClass(movie.audience_rating, movie.audience_score);
    badges.push(`<span class="rt-badge ${a}" title="Audience score">🍿 ${audienceLabel(movie)}</span>`);
  }

  const badges = [];
  const criticSort = mode === "tomatometer" || mode === "rt";
  const audienceSort = mode === "audience";

  if (audienceSort) {
    if (hasAudienceDisplay(movie)) pushPopcorn();
    else if (hasCriticDisplay(movie)) pushTomato();
  } else if (criticSort) {
    if (hasCriticDisplay(movie)) pushTomato();
    else if (hasAudienceDisplay(movie)) pushPopcorn();
  } else {
    if (hasCriticDisplay(movie)) pushTomato();
    if (hasAudienceDisplay(movie)) pushPopcorn();
  }

  if (badges.length === 0) {
    badges.push('<span class="rt-badge unknown" title="No scores from OMDb">Scores —</span>');
  }
  return `<div class="card-score-badges">${badges.join("")}</div>`;
}

function providerLabel(id) {
  const labels = {
    netflix: "Netflix",
    prime: "Prime",
    "amazon-prime": "Prime",
    "amazon-prime-video": "Prime",
    apple: "Apple TV+",
    "apple-tv-plus": "Apple TV+",
    peacock: "Peacock",
    paramount: "Paramount+",
    "paramount-plus": "Paramount+",
  };
  return labels[id] || id.replace(/-/g, " ");
}

function renderAuthBar() {
  if (isLoggedIn()) {
    const user = getStoredUser();
    const name = user?.first_name || user?.email || "Signed in";
    const services = vaFilters
      ? connectedCatalogs(vaFilters)
          .map((c) => c.name)
          .slice(0, 5)
          .join(", ")
      : "";

    authBar.innerHTML = `
      <div class="auth-signed-in">
        <span class="auth-badge">VidAngel</span>
        <span class="auth-user">${escapeHtml(name)}</span>
        ${services ? `<span class="auth-services">${escapeHtml(services)}</span>` : ""}
        <button type="button" class="btn btn-ghost btn-sm" id="btn-logout">Sign out</button>
      </div>
    `;
    document.getElementById("btn-logout").addEventListener("click", handleLogout);
    heroLead.innerHTML =
      "Showing movies from <strong>your VidAngel catalog</strong>. Poster badges match your sort (🍿 audience vs 🍅 Tomatometer). Preferences are remembered in this browser.";
  } else {
    authBar.innerHTML = `
      <button type="button" class="btn btn-secondary btn-sm" id="btn-login">Sign in to VidAngel</button>
      <span class="auth-hint">Uses your real catalog · password stays in your browser</span>
    `;
    document.getElementById("btn-login").addEventListener("click", openLogin);
    heroLead.innerHTML = `
      Skip the tab-hopping. Browse <strong>Netflix, Prime, Apple TV+, Peacock &amp; Paramount+</strong>
      estimates — or <strong>sign in to VidAngel</strong>. Sort by Tomatometer or audience; each card highlights the score you're sorting by.
    `;
  }
}

function openLogin() {
  loginError.textContent = "";
  loginForm.reset();
  loginDialog.showModal();
}

function closeLogin() {
  loginDialog.close();
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  loginError.textContent = "";
  const email = loginForm.email.value;
  const password = loginForm.password.value;
  const btn = loginForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    await login(email, password);
    useVidAngel = true;
    closeLogin();
    renderAuthBar();
    await loadMovies({ resetPaging: true, invalidateVaCatalog: true });
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

function handleLogout() {
  logout();
  vaFilters = null;
  useVidAngel = false;
  renderAuthBar();
  loadMovies({ resetPaging: true, invalidateVaCatalog: true });
}

function modalMovieMatches(a, b) {
  const ta = a?.tmdb_id != null ? Number(a.tmdb_id) : NaN;
  const tb = b?.tmdb_id != null ? Number(b.tmdb_id) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta === tb) return true;
  const ta2 = String(a?.title ?? "")
    .trim()
    .toLowerCase();
  const tb2 = String(b?.title ?? "")
    .trim()
    .toLowerCase();
  if (!ta2 || ta2 !== tb2) return false;
  const yA = a?.year != null ? String(a.year) : "";
  const yB = b?.year != null ? String(b.year) : "";
  return yA === yB;
}

function applyModalContent(movie, opts = {}) {
  const trailerAutoplay = opts.trailerAutoplay !== false;

  modalTitle.textContent = movie.title + (movie.year ? ` (${movie.year})` : "");
  modalOverview.textContent = movie.overview || "No description available.";

  if (movie._scoresPending) {
    modalScores.innerHTML = `
      <div class="score-pill unknown">
        <span class="label">Tomatometer</span>
        <span class="value">Loading…</span>
      </div>
      <div class="score-pill unknown">
        <span class="label">Audience score</span>
        <span class="value">Loading…</span>
      </div>
    `;
  } else {
    const criticRt = rtClass(movie.critic_rating, movie.critic_score);
    const auPill = audienceClass(movie.audience_rating, movie.audience_score);
    modalScores.innerHTML = `
      <div class="score-pill ${criticRt}">
        <span class="label">Tomatometer</span>
        <span class="value">${rtLabel(movie.critic_score)}</span>
      </div>
      <div class="score-pill ${auPill}">
        <span class="label">Audience score</span>
        <span class="value">${audienceLabel(movie)}</span>
      </div>
    `;
  }

  modalProviders.innerHTML = (movie.providers || [])
    .map((p) => `<span class="chip">${escapeHtml(providerLabel(p.id || p.name))}</span>`)
    .join("");

  linkVidangel.href =
    movie.vidangel_url ||
    `https://www.vidangel.com/search?q=${encodeURIComponent(movie.title ?? "")}`;
  linkRt.href = movie.rt_url || `https://www.rottentomatoes.com/search?search=${encodeURIComponent(movie.title)}`;
  const showRtLink =
    movie._scoresPending ||
    movie.critic_score != null ||
    movie.audience_score != null ||
    movie.audience_rating ||
    movie.rt_url;
  linkRt.style.display = showRtLink ? "" : "none";

  if (movie.trailer_key) {
    trailerEl.innerHTML = `<iframe
      src="https://www.youtube.com/embed/${movie.trailer_key}?${trailerAutoplay ? "autoplay=1&" : ""}rel=0"
      title="Trailer for ${escapeAttr(movie.title)}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen></iframe>`;
  } else if (movie._scoresPending) {
    trailerEl.innerHTML =
      `<div class="no-trailer trailer-pending"><span aria-hidden="true">▶</span>Fetching trailer preview…</div>`;
  } else {
    trailerEl.innerHTML = `<div class="no-trailer">No trailer available</div>`;
  }
}

function syncHydratedMovieIntoModal(movie) {
  if (!modal.open || !modalBoundMovie) return;
  if (!modalMovieMatches(modalBoundMovie, movie)) return;
  modalBoundMovie = { ...movie };
  applyModalContent(modalBoundMovie);
}

function renderCard(movie) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "card";
  btn.setAttribute("aria-label", `Open ${movie.title}`);

  const poster = movie.poster_url
    ? `<img src="${movie.poster_url}" alt="" loading="lazy" width="300" height="450">`
    : `<div class="placeholder">${escapeHtml(movie.title)}</div>`;

  const chips = (movie.providers || [])
    .map((p) => `<span class="chip">${escapeHtml(providerLabel(p.id || p.name))}</span>`)
    .join("");

  const showPlayHint =
    Boolean(movie.trailer_key) ||
    Boolean(movie._scoresPending);

  btn.innerHTML = `
    <div class="card-poster">
      ${poster}
      ${formatCardScores(movie)}
      ${showPlayHint
        ? `<div class="play-hint ${movie.trailer_key ? "" : "play-hint-pending"}"><span>▶</span></div>`
        : ""}
    </div>
    <div class="card-meta">
      <h3 class="card-title">${escapeHtml(movie.title)}</h3>
      <p class="card-year">${movie.year || ""}</p>
      <div class="provider-chips">${chips}</div>
    </div>
  `;

  btn.addEventListener("click", () => openModal(movie));
  return btn;
}

function openModal(movie) {
  modalBoundMovie = { ...movie };
  applyModalContent(modalBoundMovie);
  modal.showModal();
}

function closeModal() {
  modalBoundMovie = null;
  trailerEl.innerHTML = "";
  modal.close();
}

modal.querySelectorAll("[data-close]").forEach((el) => {
  el.addEventListener("click", closeModal);
});

modal.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeModal();
});

loginDialog.querySelectorAll("[data-close]").forEach((el) => {
  el.addEventListener("click", closeLogin);
});

loginForm.addEventListener("submit", handleLoginSubmit);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

function replaceCardAt(rowIndex, movie) {
  const prev = grid.querySelectorAll("button.card")[rowIndex];
  if (!prev) return;
  prev.replaceWith(renderCard(movie));
  syncHydratedMovieIntoModal(movie);
}

function finalizeBrowseChrome(count, sort, { hydratingScores = false } = {}) {
  refreshPagerChrome();
  const source = useVidAngel && isLoggedIn() ? "VidAngel catalog" : "streaming estimates";
  const pageNote =
    useVidAngel && isLoggedIn()
      ? `page ${browseVaPage}/${browseVaTotalPages}`
      : `page ${browseDiscoverPage}/${browseDiscoverTotalPages}`;
  let msg = `${count} titles · ${pageNote} · ${source} · sorted by ${sortLabel(sort)}`;
  if (hydratingScores) msg += " · scores loading";
  setStatus(msg);
  if (useVidAngel && isLoggedIn()) {
    loadHint.textContent = hydratingScores
      ? "Posters first; VidAngel TMDB enrichment next, then Tomato scores (OMDb) as a separate pass."
      : "Why it feels slow: every title still triggers TMDB (match trailer + IDs) plus OMDb for Rotten Tomatoes. We only fetch one catalog page at a time so the wall-clock cost is obvious instead of freezing for a mega-batch.";
  } else {
    loadHint.textContent = hydratingScores
      ? "Discovery order loads posters immediately, trailers on the next request, then Tomato scores via OMDb."
      : "Why it feels slow: each poster triggers ~one TMDB request (trailers/external IDs/US providers bundled) plus OMDb. Pagination swaps ~20 originals per hop so waits stay predictable.";
  }
}

function scoresStillNeeded(m) {
  if (
    m.critic_score != null ||
    m.critic_rating ||
    m.audience_score != null ||
    m.audience_rating ||
    (typeof m.rt_url === "string" && m.rt_url.trim())
  ) {
    return false;
  }
  return true;
}

async function hydrateDiscoverBatch(skeletonRows, gen) {
  try {
    let offset = 0;
    while (offset < skeletonRows.length) {
      if (gen !== hydrateGen) return;

      const batch = skeletonRows.slice(offset, offset + DISCOVER_ENRICH_BATCH);
      const ids = [];
      const idxInBatch = [];
      batch.forEach((row, i) => {
        const tid = Number(row.tmdb_id);
        if (Number.isFinite(tid)) {
          ids.push(tid);
          idxInBatch.push(i);
        }
      });

      if (ids.length === 0) {
        offset += DISCOVER_ENRICH_BATCH;
        continue;
      }

      const snapshots = batch.map((b) => ({ ...b }));

      const res1 = await fetch("/api/hydrate_discover_tmdb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const payload1 = await res1.json();
      if (!res1.ok) throw new Error(payload1.detail || "TMDB hydrate failed");

      const tmdbRows = payload1.movies || [];
      tmdbRows.forEach((row, hi) => {
        const bi = idxInBatch[hi];
        if (bi === undefined) return;
        const merged = { ...snapshots[bi], ...row };
        merged._scoresPending = scoresStillNeeded(merged);
        snapshots[bi] = merged;
        replaceCardAt(offset + bi, merged);
      });

      if (gen !== hydrateGen) return;

      const res2 = await fetch("/api/hydrate_scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const payload2 = await res2.json();
      if (!res2.ok) throw new Error(payload2.detail || "Score hydrate failed");

      const scored = payload2.movies || [];
      scored.forEach((row, hi) => {
        const bi = idxInBatch[hi];
        if (bi === undefined) return;
        const merged = { ...snapshots[bi], ...row };
        delete merged._scoresPending;
        snapshots[bi] = merged;
        replaceCardAt(offset + bi, merged);
      });

      offset += DISCOVER_ENRICH_BATCH;
    }

    if (gen !== hydrateGen) return;
    finalizeBrowseChrome(skeletonRows.length, sortSelect.value, { hydratingScores: false });
  } catch (err) {
    if (gen !== hydrateGen) return;
    setStatus(err.message || "Could not load scores", "error");
  }
}

async function hydrateVidAngelDeferred(chunk, gen) {
  try {
    const payload = chunk.map(({ _scoresPending: _sp, ...rest }) => rest);
    const res1 = await fetch("/api/enrich_catalog_tmdb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movies: payload }),
    });
    const data1 = await res1.json();
    if (!res1.ok) throw new Error(data1.detail || "VidAngel TMDB enrich failed");

    if (!data1.tmdb_configured && !data1.omdb_configured && gen === hydrateGen) {
      setStatus("Add TMDB/OMDb keys to .env for trailers and Rotten Tomatoes scores.", "error");
    }

    const afterTmdb = data1.movies || [];
    for (let i = 0; i < chunk.length; i++) {
      const merged = { ...chunk[i], ...(afterTmdb[i] || {}) };
      merged._scoresPending = scoresStillNeeded(merged);
      replaceCardAt(i, merged);
    }

    if (gen !== hydrateGen) return;

    const ids = afterTmdb
      .map((row) => Number(row?.tmdb_id))
      .filter((n) => Number.isFinite(n));
    const runScores = ids.length > 0 && Boolean(data1.omdb_configured);
    if (runScores) {
      const res2 = await fetch("/api/hydrate_scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data2 = await res2.json();
      if (!res2.ok) throw new Error(data2.detail || "Score hydrate failed");
      const scoreRows = data2.movies || [];
      const scoreByTmdb = new Map(ids.map((id, idx) => [id, scoreRows[idx]]));
      for (let i = 0; i < chunk.length; i++) {
        const step1 = { ...chunk[i], ...(afterTmdb[i] || {}) };
        const tid = Number(step1.tmdb_id);
        const sco = Number.isFinite(tid) ? scoreByTmdb.get(tid) : undefined;
        const merged = { ...step1, ...(sco || {}) };
        delete merged._scoresPending;
        replaceCardAt(i, merged);
      }
    } else {
      for (let i = 0; i < chunk.length; i++) {
        const merged = { ...chunk[i], ...(afterTmdb[i] || {}) };
        delete merged._scoresPending;
        replaceCardAt(i, merged);
      }
    }

    finalizeBrowseChrome(chunk.length, sortSelect.value, { hydratingScores: false });
  } catch {
    if (gen !== hydrateGen) return;
    setStatus("Scores/trailers unavailable — showing VidAngel catalog without enrichment.", "error");
    for (let i = 0; i < chunk.length; i++) {
      const fallback = { ...chunk[i] };
      delete fallback._scoresPending;
      replaceCardAt(i, fallback);
    }
    finalizeBrowseChrome(chunk.length, sortSelect.value, { hydratingScores: false });
  }
}


async function enrichMovies(rawMovies) {
  const res = await fetch("/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ movies: rawMovies }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Failed to enrich movies");
  return {
    movies: data.movies || [],
    tmdb: data.tmdb_configured,
    omdb: data.omdb_configured,
  };
}

async function loadVidAngelMovies(opts = {}) {
  const { deferScores = false, hydrateGeneration = 0 } = opts;
  vaFilters = await getServiceFilters();
  if (!vaFilters) {
    throw new Error("Could not load your VidAngel service filters. Try signing out and back in.");
  }

  const catalogIds = selectedCatalogIds(vaFilters);
  const catalogMap = catalogMapFromFilters(vaFilters);

  if (!browseVaFullCatalog) {
    const categories = await getBrowseMovies(catalogIds);
    browseVaFullCatalog = dedupeMovies(flattenMovieWorks(categories, catalogMap));
  }

  let working = [...browseVaFullCatalog];
  const provider = providerSelect.value;
  if (provider) {
    working = dedupeMovies(filterByProvider(working, provider));
  }

  browseVaFilteredCount = working.length;
  browseVaTotalPages = browseVaFilteredCount === 0 ? 1 : Math.ceil(browseVaFilteredCount / VA_PAGE_SIZE);
  if (browseVaPage > browseVaTotalPages) browseVaPage = browseVaTotalPages;
  if (browseVaPage < 1) browseVaPage = 1;

  const start = (browseVaPage - 1) * VA_PAGE_SIZE;
  const chunk = dedupeMovies(working.slice(start, start + VA_PAGE_SIZE));

  if (chunk.length === 0) {
    lastDiscoverRawCount = 0;
    return [];
  }

  lastDiscoverRawCount = chunk.length;

  if (deferScores) {
    void hydrateVidAngelDeferred(chunk, hydrateGeneration);
    return chunk.map((m) => ({ ...m, _scoresPending: true }));
  }

  setStatus(`Enriching ${chunk.length} titles with scores & trailers…`, "loading");
  try {
    const enriched = await enrichMovies(chunk);
    if (!enriched.tmdb && !enriched.omdb) {
      setStatus("Add TMDB/OMDb keys to .env for trailers and Rotten Tomatoes scores.", "error");
    }
    return dedupeMovies(enriched.movies);
  } catch {
    setStatus("Scores/trailers unavailable — showing VidAngel catalog without enrichment.", "error");
    return chunk;
  }
}

async function loadTmdbMovies(gen) {
  const sort = sortSelect.value;
  const provider = providerSelect.value;
  const params = new URLSearchParams({ sort, page: String(browseDiscoverPage) });
  if (provider) params.set("provider", provider);

  const defer = sort === "none";
  if (defer) params.set("enrich", "false");

  const res = await fetch(`/api/movies?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Failed to load movies");
  browseDiscoverTotalPages = Number(data.discover_total_pages) || 1;
  if (browseDiscoverPage > browseDiscoverTotalPages) {
    browseDiscoverPage = browseDiscoverTotalPages;
  }
  lastDiscoverRawCount = Number(data.discover_results_raw) || 0;
  const rows = dedupeMovies(data.movies || []);
  if (defer && data.enriched === false) {
    void hydrateDiscoverBatch(rows, gen);
    return rows.map((m) => ({ ...m, _scoresPending: true }));
  }
  return rows;
}

async function loadMovies(opts = {}) {
  const resetPaging = Boolean(opts.resetPaging);
  const invalidateVaCatalog = Boolean(opts.invalidateVaCatalog);
  if (invalidateVaCatalog) invalidateVidAngelCatalogMemory();
  if (resetPaging) resetBrowsePaging();

  const sort = sortSelect.value;
  setStatus("Loading movies…", "loading");
  grid.innerHTML = "";

  hydrateGen += 1;
  const gen = hydrateGen;

  try {
    let list;
    if (useVidAngel && isLoggedIn()) {
      list = await loadVidAngelMovies({ deferScores: sort === "none", hydrateGeneration: gen });
    } else {
      list = await loadTmdbMovies(gen);
    }

    movies =
      sort === "none"
        ? sortMovies(list, sort)
        : sortMovies(dedupeMovies(list), sort);

    if (movies.length === 0) {
      setStatus(
        useVidAngel && isLoggedIn()
          ? "No movies found for your connected services. Link services at vidangel.com/services"
          : "No movies found. Check your API keys in .env or sign in to VidAngel."
      );
      refreshPagerChrome();
      loadHint.textContent = useVidAngel && isLoggedIn()
        ? "VidAngel paging still needs TMDB + OMDb for each batch (that is why flipping pages waits several seconds)."
        : "Browsing pulls ~20 TMDB discover rows per page, runs one bundled TMDB lookup + one OMDb lookup per survivor — network latency dominates.";
      return;
    }

    movies.forEach((m) => grid.appendChild(renderCard(m)));
    const hydrating = movies.some((m) => m._scoresPending);
    finalizeBrowseChrome(movies.length, sort, { hydratingScores: hydrating });
  } catch (err) {
    setStatus(err.message, "error");
    refreshPagerChrome();
    loadHint.textContent = "";
  }
}

function sortLabel(sort) {
  return (
    {
      tomatometer: "Tomatometer",
      rt: "Tomatometer",
      audience: "Audience score",
      popular: "popularity",
      title: "title",
      year: "release year",
      none: "discovery order",
    }[sort] || sort
  );
}

function handlePagerPrev() {
  if (useVidAngel && isLoggedIn()) browseVaPage = Math.max(1, browseVaPage - 1);
  else browseDiscoverPage = Math.max(1, browseDiscoverPage - 1);
  loadMovies({});
}

function handlePagerNext() {
  if (useVidAngel && isLoggedIn()) {
    if (browseVaPage < browseVaTotalPages) browseVaPage++;
  } else if (browseDiscoverPage < browseDiscoverTotalPages) {
    browseDiscoverPage++;
  }
  loadMovies({});
}

[pagerPrev, pagerPrevTop].forEach((el) => {
  if (el) el.addEventListener("click", handlePagerPrev);
});
[pagerNext, pagerNextTop].forEach((el) => {
  if (el) el.addEventListener("click", handlePagerNext);
});

sortSelect.addEventListener("change", () => {
  persistSortPreference();
  loadMovies({ resetPaging: true });
});
providerSelect.addEventListener("change", () => {
  persistProviderPreference();
  loadMovies({ resetPaging: true });
});

async function init() {
  restoreProviderPreference();
  restoreSortPreference();
  renderAuthBar();
  const user = await restoreSession();
  if (user) {
    useVidAngel = true;
    renderAuthBar();
  }
  await loadMovies({});
}

init();
