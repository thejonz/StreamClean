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
const loadHint = document.getElementById("load-hint");

const PROVIDER_PREF_KEY = "streamclean_provider";

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

function resetBrowsePaging() {
  browseDiscoverPage = 1;
  browseVaPage = 1;
}

function invalidateVidAngelCatalogMemory() {
  browseVaFullCatalog = null;
}

function refreshPagerChrome() {
  const vaFlow = useVidAngel && isLoggedIn();
  pagerStatus.textContent = vaFlow
    ? `VidAngel · page ${browseVaPage} / ${browseVaTotalPages} · ${browseVaFilteredCount} matched`
    : `TMDB · page ${browseDiscoverPage} / ${browseDiscoverTotalPages} (${lastDiscoverRawCount} raw)`;
  pagerPrev.disabled = vaFlow ? browseVaPage <= 1 : browseDiscoverPage <= 1;
  pagerNext.disabled = vaFlow ? browseVaPage >= browseVaTotalPages : browseDiscoverPage >= browseDiscoverTotalPages;
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

/** Card overlays: tomato + popcorn when available, else whichever exists, else neutral. */
function formatCardScores(movie) {
  const badges = [];
  if (hasCriticDisplay(movie)) {
    const c = rtClass(movie.critic_rating, movie.critic_score);
    badges.push(`<span class="rt-badge ${c}" title="Tomatometer">🍅 ${rtLabel(movie.critic_score)}</span>`);
  }
  if (hasAudienceDisplay(movie)) {
    const a = audienceClass(movie.audience_rating, movie.audience_score);
    badges.push(`<span class="rt-badge ${a}" title="Audience score">🍿 ${audienceLabel(movie)}</span>`);
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
      "Showing movies from <strong>your VidAngel catalog</strong> on your connected services, ranked by audience score where available. Preview trailers — cards show Tomatometer and audience scores when OMDb returns them. Use paging to enrich the rest without loading everything at once.";
  } else {
    authBar.innerHTML = `
      <button type="button" class="btn btn-secondary btn-sm" id="btn-login">Sign in to VidAngel</button>
      <span class="auth-hint">Uses your real catalog · password stays in your browser</span>
    `;
    document.getElementById("btn-login").addEventListener("click", openLogin);
    heroLead.innerHTML = `
      Skip the tab-hopping. Browse movies on <strong>Netflix, Prime, Apple TV+, Peacock &amp; Paramount+</strong>
      — or <strong>sign in to VidAngel</strong> for your exact catalog — default sort uses audience score; cards show critic and audience scores whenever OMDb returns them. Pages map to TMDB discover pages.
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

  btn.innerHTML = `
    <div class="card-poster">
      ${poster}
      ${formatCardScores(movie)}
      ${movie.trailer_key ? '<div class="play-hint"><span>▶</span></div>' : ""}
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
  modalTitle.textContent = movie.title + (movie.year ? ` (${movie.year})` : "");
  modalOverview.textContent = movie.overview || "No description available.";

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

  modalProviders.innerHTML = (movie.providers || [])
    .map((p) => `<span class="chip">${escapeHtml(providerLabel(p.id || p.name))}</span>`)
    .join("");

  linkVidangel.href = movie.vidangel_url;
  linkRt.href = movie.rt_url || `https://www.rottentomatoes.com/search?search=${encodeURIComponent(movie.title)}`;
  const showRtLink =
    movie.critic_score != null ||
    movie.audience_score != null ||
    movie.audience_rating ||
    movie.rt_url;
  linkRt.style.display = showRtLink ? "" : "none";

  if (movie.trailer_key) {
    trailerEl.innerHTML = `<iframe
      src="https://www.youtube.com/embed/${movie.trailer_key}?autoplay=1&rel=0"
      title="Trailer for ${escapeAttr(movie.title)}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen></iframe>`;
  } else {
    trailerEl.innerHTML = `<div class="no-trailer">No trailer available</div>`;
  }

  modal.showModal();
}

function closeModal() {
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

async function loadVidAngelMovies() {
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
  const rawChunk = dedupeMovies(working.slice(start, start + VA_PAGE_SIZE));

  if (rawChunk.length === 0) {
    lastDiscoverRawCount = 0;
    return [];
  }

  lastDiscoverRawCount = rawChunk.length;

  setStatus(`Enriching ${rawChunk.length} titles with scores & trailers…`, "loading");
  try {
    const enriched = await enrichMovies(rawChunk);
    if (!enriched.tmdb && !enriched.omdb) {
      setStatus("Add TMDB/OMDb keys to .env for trailers and Rotten Tomatoes scores.", "error");
    }
    return dedupeMovies(enriched.movies);
  } catch {
    setStatus("Scores/trailers unavailable — showing VidAngel catalog without enrichment.", "error");
    return rawChunk;
  }
}

async function loadTmdbMovies() {
  const sort = sortSelect.value;
  const provider = providerSelect.value;
  const params = new URLSearchParams({ sort, page: String(browseDiscoverPage) });
  if (provider) params.set("provider", provider);

  const res = await fetch(`/api/movies?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Failed to load movies");
  browseDiscoverTotalPages = Number(data.discover_total_pages) || 1;
  if (browseDiscoverPage > browseDiscoverTotalPages) {
    browseDiscoverPage = browseDiscoverTotalPages;
  }
  lastDiscoverRawCount = Number(data.discover_results_raw) || 0;
  return data.movies || [];
}

async function loadMovies(opts = {}) {
  const resetPaging = Boolean(opts.resetPaging);
  const invalidateVaCatalog = Boolean(opts.invalidateVaCatalog);
  if (invalidateVaCatalog) invalidateVidAngelCatalogMemory();
  if (resetPaging) resetBrowsePaging();

  const sort = sortSelect.value;
  setStatus("Loading movies…", "loading");
  grid.innerHTML = "";

  try {
    let list;
    if (useVidAngel && isLoggedIn()) {
      list = await loadVidAngelMovies();
    } else {
      list = await loadTmdbMovies();
    }

    movies = sortMovies(dedupeMovies(list), sort);

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

    refreshPagerChrome();
    const source = useVidAngel && isLoggedIn() ? "VidAngel catalog" : "streaming estimates";
    const pageNote =
      useVidAngel && isLoggedIn()
        ? `page ${browseVaPage}/${browseVaTotalPages}`
        : `page ${browseDiscoverPage}/${browseDiscoverTotalPages}`;
    setStatus(`${movies.length} titles · ${pageNote} · ${source} · sorted by ${sortLabel(sort)}`);
    loadHint.textContent =
      useVidAngel && isLoggedIn()
        ? "Why it feels slow: every title still triggers TMDB (match trailer + IDs) plus OMDb for Rotten Tomatoes. We only fetch one catalog page at a time so the wall-clock cost is obvious instead of freezing for a mega-batch."
        : "Why it feels slow: each poster triggers ~one TMDB request (trailers/external IDs/US providers bundled) plus OMDb. Pagination swaps ~20 originals per hop so waits stay predictable.";
  } catch (err) {
    setStatus(err.message, "error");
    refreshPagerChrome();
    loadHint.textContent = "";
  }
}

function sortLabel(sort) {
  return (
    {
      audience: "Audience score",
      rt: "Audience score",
      popular: "popularity",
      title: "title",
      year: "release year",
    }[sort] || sort
  );
}

pagerPrev.addEventListener("click", () => {
  if (useVidAngel && isLoggedIn()) browseVaPage = Math.max(1, browseVaPage - 1);
  else browseDiscoverPage = Math.max(1, browseDiscoverPage - 1);
  loadMovies({});
});

pagerNext.addEventListener("click", () => {
  if (useVidAngel && isLoggedIn()) {
    if (browseVaPage < browseVaTotalPages) browseVaPage++;
  } else if (browseDiscoverPage < browseDiscoverTotalPages) {
    browseDiscoverPage++;
  }
  loadMovies({});
});

sortSelect.addEventListener("change", () => loadMovies({ resetPaging: true }));
providerSelect.addEventListener("change", () => {
  persistProviderPreference();
  loadMovies({ resetPaging: true });
});

async function init() {
  restoreProviderPreference();
  renderAuthBar();
  const user = await restoreSession();
  if (user) {
    useVidAngel = true;
    renderAuthBar();
  }
  await loadMovies({});
}

init();
