import {
  catalogMapFromFilters,
  connectedCatalogs,
  filterByProvider,
  flattenMovieWorks,
  getBrowseMovies,
  getServiceFilters,
  getStoredProfile,
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

let movies = [];
let vaFilters = null;
let useVidAngel = false;

function setStatus(message, type = "") {
  status.textContent = message;
  status.className = `status ${type}`.trim();
}

function rtClass(rating, score) {
  if (rating === "certified") return "certified";
  if (score == null) return "unknown";
  return score >= 60 ? "fresh" : "rotten";
}

function rtLabel(score) {
  return score != null ? `${score}%` : "—";
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
      "Showing movies from <strong>your VidAngel catalog</strong> on your connected services, ranked by Tomatometer. Preview trailers, then open on VidAngel.";
  } else {
    authBar.innerHTML = `
      <button type="button" class="btn btn-secondary btn-sm" id="btn-login">Sign in to VidAngel</button>
      <span class="auth-hint">Uses your real catalog · password stays in your browser</span>
    `;
    document.getElementById("btn-login").addEventListener("click", openLogin);
    heroLead.innerHTML = `
      Skip the tab-hopping. Browse movies on <strong>Netflix, Prime, Apple TV+, Peacock &amp; Paramount+</strong>
      — or <strong>sign in to VidAngel</strong> for your exact catalog — ranked by critic score.
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
    await loadMovies();
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
  loadMovies();
}

function renderCard(movie) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "card";
  btn.setAttribute("aria-label", `Open ${movie.title}`);

  const rt = rtClass(movie.critic_rating, movie.critic_score);
  const poster = movie.poster_url
    ? `<img src="${movie.poster_url}" alt="" loading="lazy" width="300" height="450">`
    : `<div class="placeholder">${escapeHtml(movie.title)}</div>`;

  const chips = (movie.providers || [])
    .map((p) => `<span class="chip">${escapeHtml(providerLabel(p.id || p.name))}</span>`)
    .join("");

  btn.innerHTML = `
    <div class="card-poster">
      ${poster}
      <span class="rt-badge ${rt}">🍅 ${rtLabel(movie.critic_score)}</span>
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
  modalScores.innerHTML = `
    <div class="score-pill ${criticRt}">
      <span class="label">Tomatometer</span>
      <span class="value">${rtLabel(movie.critic_score)}</span>
    </div>
    <div class="score-pill">
      <span class="label">Audience</span>
      <span class="value">${rtLabel(movie.audience_score)}</span>
    </div>
  `;

  modalProviders.innerHTML = (movie.providers || [])
    .map((p) => `<span class="chip">${escapeHtml(providerLabel(p.id || p.name))}</span>`)
    .join("");

  linkVidangel.href = movie.vidangel_url;
  linkRt.href = movie.rt_url || `https://www.rottentomatoes.com/search?search=${encodeURIComponent(movie.title)}`;
  linkRt.style.display = movie.critic_score != null ? "" : "none";

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
  renderAuthBar();

  const catalogIds = selectedCatalogIds(vaFilters);
  const categories = await getBrowseMovies(catalogIds);
  const catalogMap = catalogMapFromFilters(vaFilters);
  let raw = flattenMovieWorks(categories, catalogMap);

  const provider = providerSelect.value;
  if (provider) {
    raw = filterByProvider(raw, provider);
  }

  if (raw.length === 0) {
    return [];
  }

  setStatus(`Enriching ${raw.length} titles with scores & trailers…`, "loading");
  try {
    const enriched = await enrichMovies(raw.slice(0, 36));
    if (!enriched.tmdb && !enriched.omdb) {
      setStatus("Add TMDB/OMDb keys to .env for trailers and Tomatometer scores.", "error");
    }
    return enriched.movies;
  } catch {
    setStatus("Scores/trailers unavailable — showing VidAngel catalog without enrichment.", "error");
    return raw.slice(0, 36);
  }
}

async function loadTmdbMovies() {
  const sort = sortSelect.value;
  const provider = providerSelect.value;
  const params = new URLSearchParams({ sort, limit: "36" });
  if (provider) params.set("provider", provider);

  const res = await fetch(`/api/movies?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Failed to load movies");
  return data.movies || [];
}

async function loadMovies() {
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

    movies = sortMovies(list, sort);

    if (movies.length === 0) {
      setStatus(
        useVidAngel
          ? "No movies found for your connected services. Link services at vidangel.com/services"
          : "No movies found. Check your API keys in .env or sign in to VidAngel."
      );
      return;
    }

    movies.forEach((m) => grid.appendChild(renderCard(m)));
    const source = useVidAngel ? "VidAngel catalog" : "streaming estimates";
    setStatus(`${movies.length} movies · ${source} · sorted by ${sortLabel(sort)}`);
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function sortLabel(sort) {
  return {
    rt: "Tomatometer",
    popular: "popularity",
    title: "title",
    year: "release year",
  }[sort] || sort;
}

sortSelect.addEventListener("change", loadMovies);
providerSelect.addEventListener("change", loadMovies);

async function init() {
  renderAuthBar();
  const user = await restoreSession();
  if (user) {
    useVidAngel = true;
    renderAuthBar();
  }
  await loadMovies();
}

init();
