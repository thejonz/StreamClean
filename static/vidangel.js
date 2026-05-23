/** Client-side VidAngel API — token stays in sessionStorage only. */

const TOKEN_KEY = "streamclean_va_token";
const PROFILE_KEY = "streamclean_va_profile_id";
const PROFILE_DATA_KEY = "streamclean_va_profile_data";
const USER_KEY = "streamclean_va_user";

const API_BASE = "https://api.vidangel.com";
const API_CONTENT_BASE = `${API_BASE}/api`;
const APP_VERSION = "2026-05-22_07-35-15";

export function isLoggedIn() {
  return Boolean(sessionStorage.getItem(TOKEN_KEY));
}

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PROFILE_KEY);
  sessionStorage.removeItem(PROFILE_DATA_KEY);
  sessionStorage.removeItem(USER_KEY);
}

export function getStoredProfile() {
  const raw = sessionStorage.getItem(PROFILE_DATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function unwrapPayload(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data;
  if (data.data != null && typeof data.data === "object") return data.data;
  return data;
}

function unwrapList(data) {
  const payload = unwrapPayload(data);
  if (Array.isArray(payload)) return payload;
  if (payload?.results) return payload.results;
  return [];
}

function authHeaders() {
  const token = getToken();
  const headers = {
    Accept: "application/json",
    AppPlatform: "web",
    AppVersion: APP_VERSION,
  };
  if (token) headers.Authorization = `Token ${token}`;
  const profileId = sessionStorage.getItem(PROFILE_KEY);
  if (profileId) headers["X-Profile"] = profileId;
  return headers;
}

async function parseJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await parseJson(res);
  if (!res.ok) {
    const msg = data?.message || data?.detail || data?.data?.username?.[0] || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function contentFetch(path, options = {}) {
  const res = await fetch(`${API_CONTENT_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(data?.message || `Content request failed (${res.status})`);
  }
  if (res.status === 204 || data == null) {
    return null;
  }
  return data;
}

async function fetchCategories(catalogIds) {
  const params = new URLSearchParams({ media_type: "movies" });
  const ids = (catalogIds || []).filter((id) => id != null && id !== -1);
  if (ids.length > 0) {
    params.set("catalogs", ids.join(","));
    params.set("restrict", "yes");
  }
  const raw = await contentFetch(`/categories-v2/?${params}`);
  return normalizeCategories(raw);
}

export async function getBrowseMovies(catalogIds) {
  let categories = await fetchCategories(catalogIds);
  const hadCatalogFilter = (catalogIds || []).some((id) => id != null && id !== -1);
  if (categories.length === 0 && hadCatalogFilter) {
    categories = await fetchCategories([]);
  }
  return categories;
}

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/api-token-auth/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      AppPlatform: "web",
      AppVersion: APP_VERSION,
    },
    body: JSON.stringify({ username: email.trim(), password }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    const msg =
      data?.data?.username?.[0] ||
      data?.data?.password?.[0] ||
      data?.message ||
      "Login failed";
    throw new Error(msg);
  }
  sessionStorage.setItem(TOKEN_KEY, data.token);
  await loadSession();
  return getStoredUser();
}

async function loadSession() {
  const user = await apiFetch("/api/users/current/");
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));

  try {
    const profiles = await apiFetch("/api/profiles/");
    const list = Array.isArray(profiles) ? profiles : profiles?.results || [];
    const primary = list.find((p) => p.is_primary) || list[0];
    if (primary?.id) {
      sessionStorage.setItem(PROFILE_KEY, String(primary.id));
      sessionStorage.setItem(PROFILE_DATA_KEY, JSON.stringify(primary));
    } else {
      sessionStorage.removeItem(PROFILE_DATA_KEY);
    }
  } catch {
    sessionStorage.removeItem(PROFILE_KEY);
    sessionStorage.removeItem(PROFILE_DATA_KEY);
  }
}

async function fetchAllCatalogs() {
  const raw = await contentFetch("/catalogs/");
  return unwrapList(raw);
}

async function buildServiceFiltersFallback() {
  let profile = getStoredProfile();
  if (!profile) {
    try {
      const profiles = await apiFetch("/api/profiles/");
      const list = Array.isArray(profiles) ? profiles : profiles?.results || [];
      profile = list.find((p) => p.is_primary) || list[0];
      if (profile?.id) {
        sessionStorage.setItem(PROFILE_KEY, String(profile.id));
        sessionStorage.setItem(PROFILE_DATA_KEY, JSON.stringify(profile));
      }
    } catch {
      /* profile optional for catalog fallback */
    }
  }

  let catalogs = [];
  try {
    catalogs = await fetchAllCatalogs();
  } catch {
    /* browse without catalog metadata if needed */
  }

  const selected = profile?.selected_catalogs || [];

  return {
    all_catalogs: catalogs,
    selected_catalogs: selected.length > 0 ? selected : [-1],
  };
}

export async function getServiceFilters() {
  const raw = await contentFetch("/content/service-filters/");
  const data = unwrapPayload(raw);
  if (data?.all_catalogs?.length) {
    return data;
  }
  return buildServiceFiltersFallback();
}

function normalizeCategories(response) {
  const payload = unwrapPayload(response);
  if (Array.isArray(payload)) return payload;
  if (payload?.categories) return payload.categories;
  return [];
}

export function catalogMapFromFilters(filters) {
  const map = {};
  if (!filters) return map;
  for (const c of filters.all_catalogs || []) {
    map[c.id] = c;
    if (c.slug) map[c.slug] = c;
  }
  return map;
}

export function connectedCatalogs(filters) {
  if (!filters) return [];
  const selected = new Set(filters.selected_catalogs || []);
  if (selected.has(-1) || selected.size === 0) {
    return (filters.all_catalogs || []).filter((c) => c.display !== false);
  }
  return (filters.all_catalogs || []).filter((c) => selected.has(c.id));
}

export function selectedCatalogIds(filters) {
  if (!filters) return [];
  const selected = filters.selected_catalogs || [];
  if (selected.length > 0) return selected;
  return connectedCatalogs(filters).map((c) => c.id);
}

export function flattenMovieWorks(categories, catalogMap) {
  const seen = new Set();
  const movies = [];

  for (const category of categories || []) {
    for (const work of category.works || []) {
      if (seen.has(work.id)) continue;
      if (!isMovieWork(work)) continue;
      seen.add(work.id);
      movies.push(normalizeWork(work, catalogMap));
    }
  }
  return movies;
}

function isMovieWork(work) {
  const kind = work.type || work.item_type || work.media_type;
  if (!kind) return true;
  return kind === "movie" || kind === "movies";
}

function normalizeWork(work, catalogMap) {
  const providers = [];
  const seen = new Set();

  const catalogEntries = (work.offering_groups || []).flatMap((g) => g.catalogs || []);
  for (const cat of catalogEntries) {
    const id = cat.slug || catalogMap[cat.id]?.slug || String(cat.id);
    if (seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      name: cat.name || catalogMap[cat.id]?.name || id,
    });
  }

  for (const offer of work.offers || []) {
    const id = typeof offer === "string" ? offer : offer.slug || String(offer.id);
    if (seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      name: catalogMap[id]?.name || id,
    });
  }

  const title = work.title || work.name || "Unknown";
  const slug = work.slug || "";

  return {
    source: "vidangel",
    va_id: work.id,
    title,
    year: work.release_year || (work.release_date || "").slice(0, 4) || null,
    overview: work.description || work.synopsis || work.overview || "",
    poster_url: work.poster_url || work.poster || null,
    slug,
    vidangel_url: slug ? `https://www.vidangel.com/movie/${slug}/` : `https://www.vidangel.com/search?q=${encodeURIComponent(title)}`,
    providers,
  };
}

export function filterByProvider(movies, providerSlug) {
  if (!providerSlug) return movies;
  return movies.filter((m) =>
    (m.providers || []).some((p) => p.id === providerSlug || p.id.includes(providerSlug))
  );
}

export function sortMovies(movies, sort) {
  const list = [...movies];
  if (sort === "rt") {
    return list.sort(
      (a, b) =>
        (a.critic_score == null) - (b.critic_score == null) ||
        (b.critic_score || 0) - (a.critic_score || 0)
    );
  }
  if (sort === "title") {
    return list.sort((a, b) => a.title.localeCompare(b.title));
  }
  if (sort === "year") {
    return list.sort((a, b) => (b.year || "").localeCompare(a.year || ""));
  }
  return list;
}

/** Restore session from stored token (page refresh). */
export async function restoreSession() {
  if (!isLoggedIn()) return null;
  try {
    await loadSession();
    return getStoredUser();
  } catch {
    logout();
    return null;
  }
}
