"use strict";

// Helpers de sanitização
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanString(value, max = 300) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

function cleanStringArray(value, maxItems = 100, maxLen = 120) {
  if (!Array.isArray(value)) return [];
  return value.map(v => cleanString(v, maxLen)).filter(Boolean).slice(0, maxItems);
}

function validateServiceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length > 300) throw new Error("URL muito longa");
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL deve usar http ou https");
  if (parsed.username || parsed.password) throw new Error("URL não deve conter credenciais");
  return parsed.toString().replace(/\/+$/, "");
}

function safeServiceUrl(value) {
  try { return validateServiceUrl(value); }
  catch { return ""; }
}

// Prefs padrão e normalização
function defaultPrefs() {
  return {
    indexers:        ["all"],
    categories:      ["movie", "series"],
    weights:         { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5 },
    maxResults:      20,
    slowThreshold:   8000,
    skipBadReleases: true,
    priorityLang:    "pt-br",
    onlyDubbed:      false,
    dedupe:          true,
    debrid:          false,
    debridConfig:    null,
    keywordBoost:           "",
    priorityIndexers:       [],
    rdExcludeKeywords:      "",
    rdExcludeQualities:     "",
    rdExcludeIndexers:      "",
    rdExcludeGroups:        "",
    maxResultsPerIndexer:   0,
    enableP2P:       true,
    qbitMode:        "off",
    enableCatalog:   true,
    rssIndexers:     [],
    token:           "",
  };
}

function sanitizeUserPrefs(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};

  const rawIndexers = Array.isArray(src.indexers)
    ? src.indexers
    : String(src.indexers || "").split(",").map(s => s.trim()).filter(Boolean);
  const indexers = cleanStringArray(rawIndexers, 200, 120);
  out.indexers = indexers.length ? indexers : ["all"];
  const categories = cleanStringArray(src.categories, 10, 20).filter(c => ["movie", "series", "anime"].includes(c));
  out.categories = categories.length ? [...new Set(categories)] : ["movie", "series"];

  if (src.weights && typeof src.weights === "object" && !Array.isArray(src.weights)) {
    out.weights = {
      language: clampNumber(src.weights.language, 40, 0, 100),
      resolution: clampNumber(src.weights.resolution, 30, 0, 100),
      seeders: clampNumber(src.weights.seeders, 20, 0, 100),
      size: clampNumber(src.weights.size, 5, 0, 100),
      codec: clampNumber(src.weights.codec, 5, 0, 100),
    };
  }

  out.maxResults = clampNumber(src.maxResults, 20, 1, 100);
  out.slowThreshold = clampNumber(src.slowThreshold, 8000, 1000, 60000);
  out.skipBadReleases = src.skipBadReleases !== false;
  out.priorityLang = ["", "pt-br", "en", "es", "fr"].includes(src.priorityLang) ? src.priorityLang : "pt-br";
  out.onlyDubbed = src.onlyDubbed === true;
  out.dedupe = src.dedupe !== false;
  out.debrid = src.debrid === true;
  out.keywordBoost = cleanString(src.keywordBoost, 500);
  const rawPriorityIndexers = Array.isArray(src.priorityIndexers)
    ? src.priorityIndexers
    : String(src.priorityIndexers || "").split(",").map(s => s.trim()).filter(Boolean);
  out.priorityIndexers = cleanStringArray(rawPriorityIndexers, 100, 120);
  out.rdExcludeKeywords = cleanString(src.rdExcludeKeywords, 500);
  out.rdExcludeQualities = cleanString(src.rdExcludeQualities, 300);
  out.rdExcludeIndexers = cleanString(src.rdExcludeIndexers, 300);
  out.rdExcludeGroups = cleanString(src.rdExcludeGroups, 300);
  out.maxResultsPerIndexer = clampNumber(src.maxResultsPerIndexer, 0, 0, 200);
  out.enableP2P = src.enableP2P !== false;
  out.qbitMode = ["off", "private", "always"].includes(src.qbitMode) ? src.qbitMode : "off";
  out.enableCatalog = src.enableCatalog !== false;
  out.rssIndexers = cleanStringArray(src.rssIndexers, 100, 120);
  out.token = cleanString(src.token, 200);
  out.addonName = cleanString(src.addonName, 80);

  if (src.jackett && typeof src.jackett === "object" && !Array.isArray(src.jackett)) {
    const url = src.jackett.url ? safeServiceUrl(src.jackett.url) : "";
    if (url) out.jackett = { url, key: cleanString(src.jackett.key, 300) };
  }

  if (src.debridConfig && typeof src.debridConfig === "object" && !Array.isArray(src.debridConfig)) {
    const torboxKey = cleanString(src.debridConfig.torboxKey, 600);
    const rdKey = cleanString(src.debridConfig.rdKey, 600);
    if (torboxKey || rdKey) {
      out.debridConfig = {
        mode: torboxKey && rdKey ? "dual" : torboxKey ? "torbox" : "realdebrid",
        torboxKey,
        rdKey,
      };
      out.debrid = true;
    }
  }

  if (src.stConfig && typeof src.stConfig === "object" && !Array.isArray(src.stConfig)) {
    const url = src.stConfig.url ? safeServiceUrl(src.stConfig.url) : "";
    const allowedStores = new Set(["torbox", "realdebrid", "alldebrid", "premiumize", "debridlink", "offcloud"]);
    const stores = (Array.isArray(src.stConfig.stores) ? src.stConfig.stores : [])
      .map(store => ({
        c: cleanString(store?.c, 40).toLowerCase(),
        t: cleanString(store?.t, 1000),
      }))
      .filter(store => allowedStores.has(store.c) && store.t)
      .slice(0, 2);
    if (url && stores.length) {
      out.stConfig = { url, stores };
      out.debrid = true;
      // StremThru and native debrid are mutually exclusive execution modes.
      // If an old UI/config sends both, prefer ST and drop native keys so the
      // stream route cannot mix native RD/TB cache checks with ST proxy output.
      delete out.debridConfig;
      out.enableP2P = true;
      // We don't force qbitMode to 'private' here anymore. It remains whatever the user selected.
    }
  }

  return out;
}

function normalizePrefs(u = {}) {
  const m = { ...defaultPrefs(), ...u };
  if (!Array.isArray(m.indexers) || !m.indexers.length) m.indexers = ["all"];
  if (m.priorityLang === undefined) m.priorityLang = "pt-br";

  if (m.debridConfig && (m.debridConfig.torboxKey || m.debridConfig.rdKey)) {
    m.debrid = true;

    const hasTB = !!m.debridConfig.torboxKey;
    const hasRD = !!m.debridConfig.rdKey;

    if (hasTB && hasRD)  m.debridConfig.mode = 'dual';
    else if (hasTB)      m.debridConfig.mode = 'torbox';
    else if (hasRD)      m.debridConfig.mode = 'realdebrid';
    else                 m.debridConfig.mode = null;
  }

  if (m.stConfig && Array.isArray(m.stConfig.stores) && m.stConfig.stores.length > 0) {
    m.debrid = true;
    m.debridConfig = null;
  }

  if (m.addonName) m.addonName = m.addonName.replace(/\s*\[(TB\+RD|TB|RD|QB|PRO|ST)\]/gi, "").replace(/\bPRO\b/g, "").trim();
  if (!m.addonName) m.addonName = "ProwJack";

  if (m.enableP2P === undefined) m.enableP2P = true;
  if (m.qbitMode  === undefined) m.qbitMode  = 'off';

  return m;
}

module.exports = {
  defaultPrefs,
  sanitizeUserPrefs,
  normalizePrefs,
  validateServiceUrl,
  safeServiceUrl,
  clampNumber,
  cleanString,
  cleanStringArray,
};
