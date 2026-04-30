"use strict";
const crypto  = require("crypto");
const express = require("express");
const axios   = require("axios");
const Redis   = require("ioredis");
const path    = require("path");
const fs      = require("fs");
const { resolveDebridStream, buildMagnet } = require("./debrid");
const { startRssPoller, buildRssCacheKey, CATALOG_KEY } = require("./rssPoller");
const { injectTrackers, extractTrackers, EXTRA_TRACKERS } = require("./torrentEnrich");
const {
  isConfigured: isQbitConfigured,
  ensureTorrentReady,
  getPlayableLocalFile,
  streamTorrentFile,
} = require("./providers/qbittorrent");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const requestCounts = new Map();
setInterval(() => requestCounts.clear(), 60000);

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const count = requestCounts.get(ip) || 0;
  if (count > 100) {
    return res.status(429).json({ error: "Rate limit excedido" });
  }
  requestCounts.set(ip, count + 1);
  next();
});

app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || ["*"];
  const origin = req.headers.origin;
  if (allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (_, res) => res.sendStatus(200));

app.use("/:userConfig/*", (req, res, next) => {
  if (!ENV.accessToken) return next();
  if (req.params.userConfig === "api") return next();
  const prefs = decodeUserCfg(req.params.userConfig);
  if (prefs?.token === ENV.accessToken) return next();
  const subpath = req.params[0] || "";
  if (subpath === "configure" || subpath === "manifest.json") return next();
  if (subpath.startsWith("catalog/") || subpath.startsWith("meta/")) return next();
  res.status(403).json({ error: "Acesso negado" });
});
const ENV = {
  jackettUrl:      (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:          (process.env.JACKETT_API_KEY || "").trim(),
  port:            process.env.PORT || 7014,
  redisUrl:        process.env.REDIS_URL || "redis://localhost:6379",
  addonPublicUrl:  (process.env.ADDON_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
  accessToken:     (process.env.ACCESS_TOKEN || "").trim(),
  scrapManifests:  (process.env.SCRAP_MANIFEST_URLS || "").split(",").map(s => s.trim()).filter(Boolean),
};
let redis = null;
const memoryStore = new Map();
try {
  redis = new Redis(ENV.redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  redis.on("connect", () => console.log(`✅ Redis conectado: ${ENV.redisUrl}`));
  redis.on("error",   (err) => console.log(`❌ Redis erro: ${err.message}`));
  redis.on("close",   () => console.log(`⚠️ Redis desconectado`));
} catch (err) {
  console.log(`❌ Redis falha na inicialização: ${err.message}`);
}

function memoryGet(k) {
  const entry = memoryStore.get(k);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memoryStore.delete(k);
    return null;
  }
  return entry.value;
}

function memorySet(k, v, ttl) {
  memoryStore.set(k, { value: v, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
}

function memoryDel(k) {
  memoryStore.delete(k);
}

function cleanExpiredMemory() {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
}

setInterval(cleanExpiredMemory, 60000);

const rc = {
  async get(k) {
    try {
      if (redis) {
        const value = await redis.get(k);
        if (value != null) return value;
      }
    } catch {}
    return memoryGet(k);
  },
  async set(k, v, ttl) {
    memorySet(k, v, ttl);
    try { if (redis) await redis.set(k, v, "EX", ttl); } catch {}
  },
  async del(k) {
    memoryDel(k);
    try { if (redis) await redis.del(k); } catch {}
  },
  async setBuffer(k, buf, ttl) {
    const b64 = buf.toString("base64");
    memorySet(k, b64, ttl);
    try { if (redis) await redis.set(k, b64, "EX", ttl); } catch {}
  },
  async getBuffer(k) {
    try {
      if (redis) {
        const v = await redis.get(k);
        if (v) return Buffer.from(v, "base64");
      }
    } catch {}
    const mem = memoryGet(k);
    return mem ? Buffer.from(mem, "base64") : null;
  },
  async keys(p) {
    const regex = new RegExp(`^${String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
    const memoryKeys = [...memoryStore.keys()].filter(key => regex.test(key));
    try {
      if (redis) {
        const redisKeys = await redis.keys(p);
        return [...new Set([...redisKeys, ...memoryKeys])];
      }
    } catch {}
    return memoryKeys;
  },
};
const CACHE_VERSION = "v12-native-debrid";

function getPublicBase(req) {
  if (ENV.addonPublicUrl) return ENV.addonPublicUrl;
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host     = req.headers["x-forwarded-host"]  || req.get("host");
  return `${protocol}://${host}`;
}

async function saveQbitJob(payload, ttl = 6 * 3600) {
  const token = crypto.randomBytes(18).toString("base64url");
  await rc.set(`qbitjob:${token}`, JSON.stringify(payload), ttl);
  return token;
}

async function loadQbitJob(token) {
  const raw = await rc.get(`qbitjob:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function toBase64Url(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function fromBase64Url(value) {
  try { return Buffer.from(String(value || ""), "base64url").toString("utf8"); }
  catch { return null; }
}

function getPreferredRssIndexers(prefs) {
  if (Array.isArray(prefs?.rssIndexers) && prefs.rssIndexers.length) return prefs.rssIndexers.filter(Boolean);
  if (Array.isArray(prefs?.indexers) && prefs.indexers.length && !prefs.indexers.includes("all")) return prefs.indexers.filter(Boolean);
  return null;
}

async function loadRssItemsForType(prefs, rssType) {
  const allowedRss = getPreferredRssIndexers(prefs);
  const keys = allowedRss
    ? await Promise.all(allowedRss.map(ix => rc.keys(`rss:${CACHE_VERSION}:${ix}:${rssType}:*`))).then(a => a.flat())
    : await rc.keys(`rss:${CACHE_VERSION}:*:${rssType}:*`);
  if (!keys.length) return [];
  return (await Promise.all(keys.map(async key => {
    try {
      const raw = await rc.get(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }))).flat();
}

function getRssItemToken(item) {
  const raw = item?.InfoHash || item?.Guid || item?.Link || item?.MagnetUri || "";
  return raw ? toBase64Url(raw) : null;
}

function parseRssMetaId(id) {
  const s = String(id || "");
  if (!s.startsWith("rssmeta:") && !s.startsWith("prowjack:")) return null;
  const parts = s.split(":");
  if (parts.length < 3) return null;
  const rawId = parts.slice(2).join(":");
  const metaId = /^\d+$/.test(rawId) ? `tt${rawId}` : rawId;
  return { catalogType: parts[1], metaId };
}

function parseRssItemId(id) {
  if (!String(id || "").startsWith("rssitem:")) return null;
  const parts = String(id).split(":");
  if (parts.length < 5) return null;
  const season = parseInt(parts[3], 10);
  const episode = parseInt(parts[4], 10);
  return {
    catalogType: parts[1],
    metaId: parts[2],
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
    token: parts.length > 5 ? parts.slice(5).join(":") : null,
  };
}

function extractSeriesFeedMarker(title) {
  const t = String(title || "");
  let m = t.match(/\bS(\d{1,2})E(\d{1,3})\b/i) || t.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) {
    return {
      season: parseInt(m[1], 10),
      episode: parseInt(m[2], 10),
      label: `S${String(m[1]).padStart(2, "0")}E${String(m[2]).padStart(2, "0")}`,
      pack: false,
    };
  }
  m = t.match(/\b(?:S|Season\s?|Temporada\s?)(\d{1,2})\b/i);
  if (m && isCompletePack(t)) {
    return {
      season: parseInt(m[1], 10),
      episode: 0,
      label: `Temporada ${String(m[1]).padStart(2, "0")} (Pack RSS)`,
      pack: true,
    };
  }
  return null;
}

function extractAnimeFeedMarker(title) {
  const t = String(title || "").replace(/\./g, " ");
  let m = t.match(/-\s*0*(\d{1,3})(?:v\d+)?\b/i)
    || t.match(/\[(\d{1,3})(?:v\d+)?\]/i)
    || t.match(/\bE(?:p(?:isode)?)?\s*0*(\d{1,3})\b/i);
  if (m) {
    return {
      season: 1,
      episode: parseInt(m[1], 10),
      label: `Episodio ${String(m[1]).padStart(2, "0")}`,
      pack: false,
    };
  }
  if (isCompletePack(t)) {
    return { season: 1, episode: 0, label: "Temporada/Batch RSS", pack: true };
  }
  return null;
}

function buildRssVideos(items, catalogType, metaId) {
  const matched = items.filter(item => normalizeImdbId(item.ImdbId) === normalizeImdbId(metaId));
  const seen = new Set();
  const videos = [];
  for (const item of matched) {
    const marker = catalogType === "anime" ? extractAnimeFeedMarker(item.Title) : extractSeriesFeedMarker(item.Title);
    if (!marker) continue;
    const key = `${marker.season}:${marker.episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      id: `rssitem:${catalogType}:${metaId}:${marker.season ?? 1}:${marker.episode ?? 0}`,
      title: marker.pack ? marker.label : `${marker.label}`,
      season: marker.season ?? 1,
      episode: marker.episode ?? 0,
      released: item.PublishDate || null,
      overview: item.Title || null,
    });
  }
  videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || String(b.released || "").localeCompare(String(a.released || "")));
  return videos;
}

function findRssItemByToken(items, token) {
  return items.find(item => getRssItemToken(item) === token) || null;
}

function matchRssItemsByMarker(items, catalogType, metaId, season, episode) {
  return items.filter(item => {
    if (normalizeImdbId(item.ImdbId) !== normalizeImdbId(metaId)) return false;
    const marker = catalogType === "anime" ? extractAnimeFeedMarker(item.Title) : extractSeriesFeedMarker(item.Title);
    if (!marker) return false;
    if (marker.season === season && marker.episode === episode) return true;
    if (marker.pack === true && marker.season === season) return true;
    return false;
  });
}


const ANIME_ONLY_IDS = new Set([
  "nyaasi", "animetosho", "animez", "nekobt",
  "animebytes", "anidex", "tokyotosho", "animeworld",
]);
function isAnimeOnly(id) {
  if (!id) return false;
  const norm = id.toLowerCase().replace(/[-_\s]/g, "");
  for (const known of ANIME_ONLY_IDS) {
    if (norm === known || norm.startsWith(known)) return true;
  }
  return false;
}
let _ixCache   = null;
let _ixCacheAt = 0;
async function getCachedIndexers(jUrl, jKey) {
  const cacheKey = `${jUrl}:${jKey}`;
  if (_ixCache && _ixCache.key === cacheKey && Date.now() - _ixCacheAt < 300_000) return _ixCache.data;
  try {
    const data = await jackettFetchIndexers(jUrl, jKey);
    _ixCache   = { key: cacheKey, data };
    _ixCacheAt = Date.now();
    return data;
  } catch {
    return _ixCache?.data || [];
  }
}
async function resolveSearchIndexers(prefs, isAnime) {
  const jUrl     = (prefs?.jackett?.url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey     = prefs?.jackett?.key || ENV.apiKey;
  const selected = (Array.isArray(prefs.indexers) ? prefs.indexers : []).filter(Boolean);
  const useAll   = !selected.length || selected.includes("all");
  const allList  = await getCachedIndexers(jUrl, jKey);
  const pool     = useAll ? allList.map(ix => ix.id) : selected;
  if (isAnime) {
    const animePool = pool.filter(id => isAnimeOnly(id));
    if (animePool.length > 0) return animePool;
    return pool;
  }
  const generalPool = pool.filter(id => !isAnimeOnly(id));
  return generalPool.length > 0 ? generalPool : pool;
}
async function isRateLimited(indexer) {
  return !!(await rc.get(`rl:${indexer}`));
}
async function setRateLimit(indexer, retryAfterHeader) {
  const parsed = parseInt(retryAfterHeader || "", 10);
  const ttl    = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3600) : 90;
  await rc.set(`rl:${indexer}`, "1", ttl);
}
function decodeUserCfg(str) {
  try {
    if (!str || typeof str !== "string" || str.length > 10000) return null;
    const b64     = str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof decoded !== "object" || Array.isArray(decoded)) return null;
    return decoded;
  } catch { return null; }
}
function defaultPrefs() {
  return {
    indexers:        ["all"],
    categories:      ["movie", "series", "anime"],
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
    maxResultsPerIndexer:   0,
    enableP2P:       true,  
    qbitMode:        "private",
    enableCatalog:   true,
    rssIndexers:     [],  
    token:           "",
  };
}
function resolvePrefs(encoded) {
  const u = encoded ? (decodeUserCfg(encoded) || {}) : {};
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
  }

  if (m.addonName) m.addonName = m.addonName.replace(/\s*\[(TB\+RD|TB|RD|QB|PRO|ST)\]/gi, "").replace(/\bPRO\b/g, "").trim();
  if (!m.addonName) m.addonName = "ProwJack";

  if (m.enableP2P === undefined) m.enableP2P = true;
  if (m.qbitMode  === undefined) m.qbitMode  = 'private';

  return m;
}
const RESOLUTION = [
  { re: /\b(4k|2160p)\b/i, label: "2160p", emoji: "🎞️ 4K",  score: 4   },
  { re: /\b1440p\b/i,      label: "1440p", emoji: "🎞️ 2K",  score: 3.5 },
  { re: /\b1080p\b/i,      label: "1080p", emoji: "🎞️ FHD", score: 3   },
  { re: /\b720p\b/i,       label: "720p",  emoji: "💿 HD",   score: 2   },
  { re: /\b576p\b/i,       label: "576p",  emoji: "📼 576P", score: 1   },
  { re: /\b480p\b/i,       label: "480p",  emoji: "📼 480P", score: 0.5 },
];
const QUALITY = [
  { re: /remux/i,            label: "REMUX",  emoji: "📀", score: 5   },
  { re: /blu[-.]?ray/i,      label: "BluRay", emoji: "💿", score: 4   },
  { re: /web[-.]?dl/i,       label: "WEBDL",  emoji: "🌐", score: 3   },
  { re: /webrip/i,           label: "WEBRip", emoji: "🖥️", score: 2.5 },
  { re: /hdrip/i,            label: "HDRip",  emoji: "💾", score: 2   },
  { re: /dvdrip/i,           label: "DVDRip", emoji: "💾", score: 1.5 },
  { re: /hdtv/i,             label: "HDTV",   emoji: "📺", score: 1   },
  { re: /\b(ts|tc|hcts)\b/i, label: "TS",     emoji: "⚠️", score: -2  },
  { re: /\bcam(rip)?\b/i,    label: "CAM",    emoji: "⛔ ", score: -5  },
];
const CODEC = [
  { re: /\bav1\b/i,         label: "AV1",   score: 4 },
  { re: /[hx]\.?265|hevc/i, label: "H.265", score: 3 },
  { re: /[hx]\.?264|avc/i,  label: "H.264", score: 2 },
  { re: /xvid|divx/i,       label: "XViD",  score: 0 },
];
const AUDIO = [
  { re: /atmos/i,             label: "Atmos"  },
  { re: /dts[-.]?x\b/i,       label: "DTS-X"  },
  { re: /dts[-.]?hd/i,        label: "DTS-HD" },
  { re: /\bdts\b/i,           label: "DTS"    },
  { re: /truehd/i,            label: "TrueHD" },
  { re: /dd\+|eac[-.]?3/i,    label: "DD+"    },
  { re: /\b(dd|ac[-.]?3)\b/i, label: "DD"     },
  { re: /\baac\b/i,           label: "AAC"    },
  { re: /\bmp3\b/i,           label: "MP3"    },
  { re: /\bopus\b/i,          label: "Opus"   },
];
const VISUAL = [
  { re: /hdr10\+/i,                   label: "HDR10+" },
  { re: /hdr10\b/i,                   label: "HDR10"  },
  { re: /dolby.?vision|dovi|\bdv\b/i, label: "DV"     },
  { re: /\bhdr\b/i,                   label: "HDR"    },
  { re: /\bsdr\b/i,                   label: "SDR"    },
];
const LANG = [
  { re: /(dublado|pt[-.]?br|portugu[eê]s|portuguese|brazilian)/i, code: "pt-br", emoji: "🇧🇷", label: "PT-BR" },
  { re: /\b(english|eng)\b/i,                                      code: "en",    emoji: "🇺🇸", label: "EN"    },
  { re: /(espa[nñ]ol|spanish|\besp\b)/i,                           code: "es",    emoji: "🇪🇸", label: "ES"    },
  { re: /(fran[cç]ais|french|\bfre\b)/i,                           code: "fr",    emoji: "🇫🇷", label: "FR"    },
];
const first    = (map, t) => {
  if (!Array.isArray(map) || !t) return null;
  return map.find(e => e?.re?.test(t));
};
const matchAll = (map, t) => {
  if (!Array.isArray(map) || !t) return [];
  return map.filter(e => e?.re?.test(t));
};
const uniq      = arr => [...new Set(arr.filter(Boolean))];
const normTitle = s => (s || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
function qp(extra = {}) {
  const p = { ...extra };
  if (ENV.apiKey) p.apikey = ENV.apiKey;
  return p;
}
function getLangs(title) {
  return matchAll(LANG, title);
}

function score(r, weights = {}, isAnime = false, priorityLang = "") {
  const w = { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5, ...weights };
  const t = r.Title || "";
  let s   = 0;

  const langs       = getLangs(t, isAnime);
  const hasPriority = priorityLang ? langs.some(l => l.code === priorityLang) : false;
  const isMulti     = /(multi)[-.\\s]?(audio)?/i.test(t);
  const isDualAnim  = isAnime && /(dual)[-.\\s]?(audio)?/i.test(t);

  if (priorityLang && hasPriority)  s += w.language * 25;
  else if (isDualAnim)              s += w.language * 15;
  else if (isMulti)                 s += w.language * 10;
  else if (langs.length > 0)        s += w.language * 5;
  else                              s += w.language * 2;

  const res  = first(RESOLUTION, t); if (res)  s += res.score  * w.resolution * 10;
  const qual = first(QUALITY,    t); if (qual) s += qual.score * 50;
  s += (r.Seeders || 0) * (w.seeders / 10);
  const gb = (r.Size || 0) / 1e9;
  if (gb > 0) s += Math.max(0, 10 - Math.abs(gb - 8)) * w.size;
  const codec = first(CODEC, t); if (codec) s += codec.score * w.codec * 5;
  return s;
}

function normalizeTitleTokens(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/[\[\(][^\]\)]*[\]\)]/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}|season\s?\d{1,2}|temporada\s?\d{1,2}|episode\s?\d{1,3}|ep\s?\d{1,3})\b/gi, " ")
    .replace(/\b(2160p|1440p|1080p|720p|576p|480p|4k|remux|blu[-.]?ray|web[-.]?dl|webrip|hdrip|dvdrip|hdtv|brrip|x26[45]|h\.?26[45]|hevc|av1|avc|dual|multi|audio|dublado|legendado|pt[-.]?br|eng|english|spanish|espa[nñ]ol|french|fran[cç]ais|aac|ac3|ddp?|eac3|atmos|truehd|dts(?:[-.]?hd|[-.]?x)?|10bit|8bit|proper|repack|extended|uncut|complete|completa|batch)\b/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(tok => tok.length >= 3 || /^(?:[a-z]\d|\d[a-z]|[a-z]\d[a-z]|\d[a-z]\d)$/i.test(tok))
    .filter(tok => !new Set(["the", "movie", "film", "one", "two", "and", "for", "with", "from", "into", "part"]).has(tok));
}

function escapedWordRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleMatchScore(title, aliases = []) {
  const titleTokens = normalizeTitleTokens(title);
  const titleText   = titleTokens.join(" ");
  if (!titleTokens.length) return 0;
  let best = 0;
  for (const alias of aliases.filter(Boolean)) {
    const aliasTokens = normalizeTitleTokens(alias);
    const aliasText   = aliasTokens.join(" ");
    if (!aliasTokens.length) continue;
    const aliasSet  = new Set(aliasTokens);
    const matched   = aliasTokens.filter(tok => titleTokens.includes(tok)).length;
    const coverage  = matched / aliasTokens.length;
    const density   = matched / Math.max(titleTokens.length, aliasTokens.length);
    const phraseHit = aliasText.length >= 5 && titleText.includes(aliasText);
    const exactShortHit = aliasTokens.length === 1 && aliasTokens[0].length <= 3
      ? new RegExp(`(^|[^a-z0-9])${escapedWordRegex(aliasTokens[0])}([^a-z0-9]|$)`, "i").test(String(title || ""))
      : false;
    if (!phraseHit && !exactShortHit) {
      if (aliasTokens.length <= 2 && matched < aliasTokens.length) continue;
      if (aliasTokens.length === 3 && matched < 2) continue;
    }
    let sc = coverage * 0.8 + density * 0.2;
    if (aliasTokens.length >= 2 && matched >= aliasTokens.length - 1) sc += 0.15;
    if (titleTokens.some(tok => aliasSet.has(tok))) sc += 0.05;
    if (phraseHit)     sc += 0.25;
    if (exactShortHit) sc += 0.35;
    best = Math.max(best, Math.min(sc, 1));
  }
  return best;
}

function extractReleaseYear(text) {
  const m = String(text || "").match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}
function normalizeImdbId(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^tt\d+$/i.test(raw)) return raw.toLowerCase();
  if (/^\d+$/.test(raw))    return `tt${raw}`;
  const m = raw.match(/tt\d+/i);
  return m ? m[0].toLowerCase() : null;
}
function getResultImdbId(r) {
  return normalizeImdbId(r?.ImdbId || r?.Imdb || r?.imdbId || r?.imdb || r?._imdbId || r?._imdb);
}
function looksLikeEpisodeRelease(title) {
  const t = String(title || "");
  return /\bs\d{1,2}[\s._-]*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bseason\s?\d{1,2}\b|\btemporada\s?\d{1,2}\b|\bepisode\s?\d{1,3}\b|\bcap[ií]tulo\s?\d{1,3}\b/i.test(t);
}
function isCompletePack(title) {
  return /\b(complete|completa|complete season|season pack|series pack|batch|全集)\b/i.test(title || "");
}
function parseEpisodeRanges(title, season) {
  const t = String(title || "");
  const s = season != null ? parseInt(season, 10) : null;
  const ranges = [];
  for (const m of t.matchAll(/\bs0*(\d{1,2})\s*e0*(\d{1,3})\s*[-~]\s*(?:e)?0*(\d{1,3})\b/gi)) {
    const matchSeason = parseInt(m[1], 10);
    if (s != null && matchSeason !== s) continue;
    ranges.push({ season: matchSeason, lo: parseInt(m[2], 10), hi: parseInt(m[3], 10) });
  }
  for (const m of t.matchAll(/\b0*(\d{1,2})x0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})\b/gi)) {
    const matchSeason = parseInt(m[1], 10);
    if (s != null && matchSeason !== s) continue;
    ranges.push({ season: matchSeason, lo: parseInt(m[2], 10), hi: parseInt(m[3], 10) });
  }
  for (const m of t.matchAll(/\bepisodes?\s*0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})\b/gi)) {
    ranges.push({ season: s, lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) });
  }
  return ranges;
}
function hasAnyEpisodeMarker(title) {
  return /\bs\d{1,2}\s*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bepisodes?\s*\d{1,3}\b|\bep\s*\d{1,3}\b/i.test(String(title || ""));
}
function episodeMatchRank(title, season, episode) {
  if (season == null || episode == null) return 1;
  const t    = (title || "").toLowerCase();
  const sRaw = parseInt(season,  10);
  const eRaw = parseInt(episode, 10);
  if (new RegExp(`\\bs0*${sRaw}[\\s._-]*e0*${eRaw}\\b|\\b0*${sRaw}x0*${eRaw}\\b`, "i").test(t)) return 4;
  for (const range of parseEpisodeRanges(t, sRaw)) {
    if (eRaw >= range.lo && eRaw <= range.hi) return 3;
  }
  const seasonOnly = new RegExp(`\\bs0*${sRaw}\\b|\\bseason\\s?0*${sRaw}\\b|\\btemporada\\s?0*${sRaw}\\b`, "i");
  if (seasonOnly.test(t) && !hasAnyEpisodeMarker(t)) return 2;
  if (isCompletePack(t)) return seasonOnly.test(t) ? 1 : 0;
  return 0;
}
function animeEpisodeMatchRank(title, ep) {
  if (ep == null) return 1;
  const t = (title || "").replace(/\./g, " ");
  const n = ep;
  if (new RegExp(`-\\s*0*${n}(?:v\\d+)?\\s*[\\[\\(\\s]`, "i").test(t)) return 3;
  if (new RegExp(`\\[0*${n}(?:v\\d+)?\\]`, "i").test(t)) return 3;
  if (new RegExp(`(?<=[\\s._\\-\\[\\(])0*${String(n).padStart(2, "0")}(?:v\\d+)?(?=[\\s._\\-\\]\\)\\[]|$)`, "i").test(t)) return 3;
  if (new RegExp(`(?<=[\\s._\\-\\[\\(])0*${String(n).padStart(3, "0")}(?:v\\d+)?(?=[\\s._\\-\\]\\)\\[]|$)`, "i").test(t)) return 3;
  if (new RegExp(`\\bE(?:p(?:isode)?)?\\s*0*${n}\\b`, "i").test(t)) return 3;
  for (const m of t.matchAll(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b/g)) {
    const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
    if (n >= lo && n <= hi) return 2;
  }
  if (isCompletePack(t)) return 1;
  return 0;
}
function seriesEpisodeMatches(title, season, episode) { return episodeMatchRank(title, season, episode) > 0; }
function animeEpisodeMatches(title, ep)               { return animeEpisodeMatchRank(title, ep) > 0; }

function normalizeForDedupe(str) {
  if (!str) return null;
  return str
    .replace(/[\[\(][^\]\)]*[\]\)]/g, '')
    .replace(/⚡|✅|💾|🇧🇷|🔍|📡|🎬|🎥|📺|🎞️|🎧|🗣️|📦|🌱|🏷️|⚠️|💿|🌐|🖥️|📼|📀|🇺🇸|🇪🇸|🇫🇷/g, '')
    .replace(/\b(dual|dub|leg|pt\.?br|portuguese|english|spanish|4k|2160p|1440p|1080p|720p|576p|480p|remux|bluray|blu-ray|webrip|web-dl|web\.dl|hdtv|hdrip|brrip|dvdrip|hevc|x264|x265|h\.264|h\.265|av1|aac|ac3|dd\+?|eac3|atmos|truehd|dts|10bit|8bit|hdr10?\+?|dolby.?vision|proper|repack|extended)\b/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dedupeResults(results) {
  const seenHash       = new Set();
  const seenNormalized = new Map();
  const deduped        = [];

  for (const r of results) {
    const hash = r.InfoHash ? r.InfoHash.toLowerCase() : null;

    if (hash) {
      if (seenHash.has(hash)) continue;
      seenHash.add(hash);
      deduped.push(r);
      continue;
    }

    const normalized = normalizeForDedupe(r.Title || "");
    if (!normalized) continue;

    const sizeGB = Math.round((r.Size || 0) / 1e8) / 10;
    const key    = `${normalized}|${sizeGB}`;

    const existing = seenNormalized.get(key);
    if (existing) {
      if ((r.Seeders || 0) > (existing.Seeders || 0) || (r.InfoHash && !existing.InfoHash)) {
        const idx = deduped.indexOf(existing);
        if (idx !== -1) deduped[idx] = r;
        seenNormalized.set(key, r);
      }
      continue;
    }

    seenNormalized.set(key, r);
    deduped.push(r);
  }

  return deduped;
}

function dedupeWithCachePriority(withHashes, isDebridMode) {
  const isPrivate = r => !r.MagnetUri && !!r._resolved?.buffer;

  const sizeBucket = r => Math.round((r.Size || 0) / 5e8);

  const seenHash   = new Set();
  const noExactDups = [];
  for (const r of withHashes) {
    const h = r._resolved.infoHash;
    if (seenHash.has(h)) continue;
    seenHash.add(h);
    noExactDups.push(r);
  }

  if (!isDebridMode) {
    const seen   = new Map();
    const result = [];
    for (const r of noExactDups) {
      const norm = normalizeForDedupe(r.Title || "");
      if (!norm) { result.push(r); continue; }
      const key      = `${norm}|${sizeBucket(r)}`;
      const existing = seen.get(key);
      if (!existing) { seen.set(key, r); result.push(r); continue; }
      if ((r.Seeders || 0) > (existing.Seeders || 0)) {
        const idx = result.indexOf(existing);
        if (idx !== -1) result[idx] = r;
        seen.set(key, r);
      }
    }
    return result;
  }

  const groups = new Map();
  for (const r of noExactDups) {
    const norm = normalizeForDedupe(r.Title || "");
    const key  = norm ? `${norm}|${sizeBucket(r)}` : `__notitle__${r._resolved.infoHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) { result.push(group[0]); continue; }

    const cachedPublic    = group.filter(r =>  r._isCached && !isPrivate(r));
    const cachedPrivate   = group.filter(r =>  r._isCached &&  isPrivate(r));
    const uncachedPublic  = group.filter(r => !r._isCached && !isPrivate(r));
    const uncachedPrivate = group.filter(r => !r._isCached &&  isPrivate(r));

    const bySeeds = arr => arr.slice().sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));

    let winner;
    if      (cachedPublic.length)    winner = bySeeds(cachedPublic)[0];
    else if (cachedPrivate.length)   winner = bySeeds(cachedPrivate)[0];
    else if (uncachedPublic.length)  winner = bySeeds(uncachedPublic)[0];
    else                             winner = bySeeds(uncachedPrivate)[0];

    result.push(winner);
  }

  return result;
}

function base32ToHex(b32) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of b32.toUpperCase()) {
    const v = alpha.indexOf(c);
    if (v === -1) return null;
    bits += v.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4)
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.length === 40 ? hex : null;
}
function extractInfoHash(magnet) {
  if (!magnet) return null;
  const hex   = magnet.match(/btih:([a-fA-F0-9]{40})(?:[&?]|$)/i);
  if (hex)   return hex[1].toLowerCase();
  const b32   = magnet.match(/btih:([A-Za-z2-7]{32})(?:[&?]|$)/i);
  if (b32)   return base32ToHex(b32[1]);
  const loose = magnet.match(/btih:([a-fA-F0-9]{40})/i);
  if (loose) return loose[1].toLowerCase();
  return null;
}

function extractInfoBuf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > 10 * 1024 * 1024) return null;
  const s   = buf.toString("latin1");
  const pos = s.indexOf("4:info");
  if (pos === -1) return null;
  let i = pos + 6, depth = 0;
  const start = i;
  const maxIterations = 1000000;
  let iterations = 0;
  while (i < s.length && iterations < maxIterations) {
    iterations++;
    const c = s[i];
    if      (c === "d" || c === "l") { depth++; i++; }
    else if (c === "e")              { depth--; i++; if (depth === 0) break; }
    else if (c === "i")              { i = s.indexOf("e", i + 1) + 1; }
    else if (c >= "0" && c <= "9")  {
      const colon = s.indexOf(":", i);
      if (colon === -1) break;
      const len = parseInt(s.slice(i, colon), 10);
      if (!Number.isFinite(len) || len < 0 || len > buf.length) break;
      i = colon + 1 + len;
    } else i++;
  }
  if (iterations >= maxIterations) {
    console.warn("[SECURITY] extractInfoBuf: loop excessivo detectado");
    return null;
  }
  return depth === 0 ? buf.slice(start, i) : null;
}

function decodeBencode(buf) {
  let i = 0;
  let depth = 0;
  const maxDepth = 100;
  const parse = () => {
    if (depth > maxDepth) throw new Error("Max depth exceeded");
    const c = String.fromCharCode(buf[i]);
    if (c === "i") {
      const end = buf.indexOf(0x65, i + 1);
      const num = parseInt(buf.toString("utf8", i + 1, end), 10);
      i = end + 1;
      return num;
    }
    if (c === "l") {
      i++; depth++;
      const out = [];
      while (buf[i] !== 0x65) out.push(parse());
      i++; depth--;
      return out;
    }
    if (c === "d") {
      i++; depth++;
      const out = {};
      while (buf[i] !== 0x65) {
        const key = parse();
        out[String(key)] = parse();
      }
      i++; depth--;
      return out;
    }
    let colon = i;
    while (buf[colon] !== 0x3a) colon++;
    const len   = parseInt(buf.toString("utf8", i, colon), 10);
    const start = colon + 1;
    const end   = start + len;
    const out   = buf.toString("utf8", start, end);
    i = end;
    return out;
  };
  return parse();
}

function extractTorrentFiles(buf) {
  try {
    const meta = decodeBencode(buf);
    const info = meta?.info;
    if (!info) return [];
    if (Array.isArray(info.files)) {
      return info.files.map((file, idx) => ({
        idx,
        name: Array.isArray(file.path) ? file.path.join("/") : String(file.path || info.name || ""),
        size: Number(file.length) || 0,
      }));
    }
    if (info.name) {
      return [{ idx: 0, name: String(info.name), size: Number(info.length) || 0 }];
    }
  } catch (err) {
    console.warn(`[WARN] Falha ao extrair arquivos do torrent: ${err.message}`);
  }
  return [];
}

function pickEpisodeFile(files, season, episode, isAnime) {
  if (!Array.isArray(files) || !files.length || episode == null) return null;

  const scoreFiles = (rankFn) => files.map(file => {
    const name = file.name || "";
    const rank = rankFn(name);
    const videoBonus = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(name) ? 5 : 0;
    return { ...file, rank, total: rank * 1000 + videoBonus + Math.min(file.size || 0, 50 * 1e9) / 1e9 };
  }).filter(f => f.rank > 0);

  const scored = scoreFiles(
    isAnime
      ? (name) => animeEpisodeMatchRank(name, episode)
      : (name) => episodeMatchRank(name, season, episode)
  );

  if (!scored.length && isAnime) {
    const fallback = scoreFiles((name) => episodeMatchRank(name, season, episode));
    if (fallback.length) {
      fallback.sort((a, b) => b.total - a.total);
      console.log(`[FILE] pickEpisodeFile: match via fallback SxxExx para anime S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")} → "${fallback[0].name}"`);
      return fallback[0];
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.total - a.total);
  return scored[0];
}

function relaxedTitleMatchScore(title, aliases = []) {
  const titleTokens = new Set(normalizeTitleTokens(title));
  let best = 0;
  for (const alias of aliases.filter(Boolean)) {
    const aliasTokens = normalizeTitleTokens(alias);
    if (!aliasTokens.length) continue;
    const matched = aliasTokens.filter(tok => titleTokens.has(tok)).length;
    if (!matched) continue;
    best = Math.max(best, matched / aliasTokens.length);
  }
  return best;
}

async function resolveInfoHash(r) {
  let fallbackHash = r.InfoHash ? r.InfoHash.toLowerCase() : null;
  let magnetHash   = r.MagnetUri ? extractInfoHash(r.MagnetUri) : null;
  const httpLink   = (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null;

  if (fallbackHash) {
    try {
      const cached = await rc.getBuffer(`torrent:${fallbackHash}`);
      if (cached) return { infoHash: fallbackHash, files: null, buffer: cached };
    } catch {}
    return { infoHash: fallbackHash, files: null, buffer: null };
  }

  if (r.MagnetUri && magnetHash && !httpLink) {
    return { infoHash: magnetHash, files: null, buffer: null };
  }

  if (httpLink) {
    let _magnetRedirect = null;
    try {
      const res = await axios.get(httpLink, {
        timeout: 10000, maxRedirects: 10, responseType: "arraybuffer",
        maxContentLength: 8 * 1024 * 1024, validateStatus: s => s < 400,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        beforeRedirect: (options) => {
          if (options.href?.startsWith("magnet:")) {
            _magnetRedirect = options.href;
            throw Object.assign(new Error("magnet_redirect"), { isMagnetRedirect: true });
          }
        },
      });
      const finalUrl = res.request?.res?.responseUrl || "";
      if (finalUrl.startsWith("magnet:")) {
        const h = extractInfoHash(finalUrl);
        return h ? { infoHash: h, files: null, buffer: null } : null;
      }
      const buf = Buffer.from(res.data);
      if (buf.length > 8 * 1024 * 1024) {
        console.warn(`[SECURITY] Torrent muito grande: ${buf.length} bytes`);
        return null;
      }
      const bodyStr = buf.toString("utf8", 0, Math.min(buf.length, 200));
      if (bodyStr.trimStart().startsWith("magnet:")) {
        const h = extractInfoHash(bodyStr.trim());
        return h ? { infoHash: h, files: null, buffer: null } : null;
      }
      if (buf[0] === 0x64) {
        const infoBuf = extractInfoBuf(buf);
        if (infoBuf) {
          const realHash = crypto.createHash("sha1").update(infoBuf).digest("hex");
          rc.setBuffer(`torrent:${realHash}`, buf, 7 * 24 * 3600).catch(() => {});
          return { infoHash: realHash, files: extractTorrentFiles(buf), buffer: buf };
        }
      }
    } catch (err) {
      if (_magnetRedirect || err.isMagnetRedirect || err.cause?.isMagnetRedirect) {
        const src = _magnetRedirect || err.cause?.magnetUrl;
        const h   = src ? extractInfoHash(src) : null;
        if (h) return { infoHash: h, files: null, buffer: null };
      } else {
        console.warn(`[WARN] Falha ao baixar torrent: ${err.message}`);
      }
    }
  }

  if (fallbackHash) return { infoHash: fallbackHash, files: null, buffer: null };
  return null;
}

function extractGroup(title) {
  const m = title.match(/[-.]([A-Z0-9]{2,12})(?:\[.+?\])?$/i);
  return m ? m[1].toUpperCase() : null;
}
function fmtBytes(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
function renameIndexer(name) {
  if (!name) return name;
  return name
    .replace(/\[TORRENT🧲?\]\s*/gi, '')
    .replace(/🇧🇷\s*Rede/gi, 'Rede Torrent')
    .replace(/🇧🇷\s*TorrentFilmes/gi, 'TorrentFilmes')
    .trim();
}

function matchesKeywordBoost(title, boostFilter) {
  if (!boostFilter || !boostFilter.trim()) return false;
  const pattern = boostFilter.trim();
  if (pattern.length > 500) return false;
  try {
    const regex = new RegExp(pattern, "i");
    const start = Date.now();
    const result = regex.test(String(title || "").slice(0, 500));
    if (Date.now() - start > 100) { console.warn(`[SECURITY] Regex timeout: ${pattern}`); return false; }
    return result;
  } catch { return false; }
}

function formatStream(r, indexerName, isAnime = false, prefs = {}, showSeeds = true, streamMeta = {}) {
  const t      = r.Title || "";
  const res    = first(RESOLUTION, t);
  const qual   = first(QUALITY, t);
  const codec  = first(CODEC, t);
  const audios = matchAll(AUDIO, t);
  const vis    = matchAll(VISUAL, t);
  const langs  = getLangs(t, isAnime);
  const group  = extractGroup(t);
  const size   = fmtBytes(r.Size);
  const seeds  = r._displaySeeds ?? r.Seeders ?? 0;
  const cleanIndexer = renameIndexer(indexerName);
  const addonName    = prefs.addonName || "ProwJack PRO";
  const resLabel     = res ? res.label : "Desconhecida";

  const isMulti = /(multi|dual)[-.\\s]?(audio)?/i.test(t);
  const langParts = [];
  if (langs.length)  langParts.push(langs.map(l => `${l.emoji} ${l.label}`).join(" / "));
  if (isMulti && !langs.some(l => l.code === "pt-br")) langParts.push("🎧 Multi");
  const langLine = langParts.length ? langParts.join(" | ") : "";

  const p2pLabel = prefs.debrid ? "" : "⚠️ P2P";

  const titleLine = [
    streamMeta.title ? `🎬 ${streamMeta.title}` : "",
    streamMeta.year  ? `(${streamMeta.year})`   : "",
    streamMeta.formattedSeasons ? `🍂 ${streamMeta.formattedSeasons}` : "",
  ].filter(Boolean).join(" ");

  const desc = [
    titleLine,
    [res ? resLabel : "", qual ? `🎥 ${qual.label}` : "", vis.length ? `📺 ${vis.map(v=>v.label).join(" | ")}` : "", codec ? `🎞️ ${codec.label}` : ""].filter(Boolean).join("  "),
    langLine,
    [audios.length ? `🎧 ${audios.map(a=>a.label).join(" | ")}` : ""].filter(Boolean).join("  "),
    [size ? `💾 ${size}` : "", showSeeds ? `👤 ${seeds}` : ""].filter(Boolean).join("  "),
    [`⚙️ ${cleanIndexer}`, group ? `🏷️ ${group}` : ""].filter(Boolean).join("  "),
    p2pLabel,
  ].filter(Boolean).join("\n");
  return { name: `${addonName}\n${resLabel}`, description: desc.trim(), resLabel };
}
async function jackettFetchIndexers(url, key) {
  const jUrl = (url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey = key || ENV.apiKey;
  try {
    const params = { t: "indexers", configured: "true" };
    if (jKey) params.apikey = jKey;
    const res = await axios.get(`${jUrl}/api/v2.0/indexers/all/results/torznab/api`, {
      params, timeout: 8000,
      responseType: "text", validateStatus: () => true,
    });
    if (res.status < 400 && typeof res.data === "string") {
      const indexers = [];
      for (const m of res.data.matchAll(/<indexer\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/gi)) {
        const id = m[1];
        if (!id || id === "all") continue;
        const titleMatch = m[2].match(/<title>([^<]+)<\/title>/i);
        const name = titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : id;
        indexers.push({ id, name });
      }
      if (indexers.length) return indexers;
    }
  } catch {}
  try {
    const res = await axios.get(`${(url || ENV.jackettUrl).replace(/\/+$/, "")}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      return res.data.map(ix => ({ id: String(ix.id || "").trim(), name: String(ix.name || "").trim() })).filter(ix => ix.id);
    }
  } catch {}
  return [];
}

async function fetchIndexerPrivacyMap(url, key) {
  const jUrl = (url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey = key || ENV.apiKey;
  try {
    const res = await axios.get(`${jUrl}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      const out = new Map();
      for (const ix of res.data) {
        const id = String(ix.id || "").trim();
        if (!id) continue;
        out.set(id, {
          private: ix.privacy === "private" || ix.privacy === "semiPrivate",
          privacy: ix.privacy || null,
        });
      }
      return out;
    }
  } catch {}
  return new Map();
}

function decodeXmlEntities(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'");
}

function xmlTagValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function parseTorznabResults(xml, indexer) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const attrs = {};
    const matches = item.matchAll(/<(?:torznab:)?attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?/gi);
    for (const m of matches) attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2]);

    const enclosure = item.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*length="([^"]*)"/i);
    const magnetUri = attrs.magneturl || null;
    const link      = magnetUri ? magnetUri : (xmlTagValue(item, "link") || enclosure?.[1] || null);
    const size      = attrs.size ? parseInt(attrs.size, 10) : (enclosure?.[2] ? parseInt(enclosure[2], 10) : 0);
    const seedersRaw = attrs.seeders ? parseInt(attrs.seeders, 10) : null;
    const seeders    = seedersRaw ?? 1;

    return {
      Title:       xmlTagValue(item, "title") || "",
      Guid:        xmlTagValue(item, "guid")  || link || magnetUri || "",
      Link:        link,
      MagnetUri:   magnetUri,
      Size:        Number.isFinite(size) ? size : 0,
      Seeders:     Number.isFinite(seeders) ? seeders : 1,
      _displaySeeds: seedersRaw ?? 0,
      InfoHash:    attrs.infohash ? attrs.infohash.toLowerCase() : null,
      Tracker:     indexer,
      TrackerId:   indexer,
      ImdbId:      normalizeImdbId(attrs.imdbid || attrs.imdb || attrs.imdbidnum || attrs.imdbnum),
      PublishDate: xmlTagValue(item, "pubDate") || null,
      _structuredMatch: true,
    };
  }).filter(r => r.Title && (r.Link || r.MagnetUri || r.Guid));
}

function normalizeProwlarrInfoHash(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  if (/^[0-9a-f]{80}$/.test(value)) {
    try {
      const ascii = Buffer.from(value, "hex").toString("utf8").trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(ascii)) return ascii;
    } catch {}
  }
  return null;
}

function parseProwlarrResults(items, indexer) {
  return (Array.isArray(items) ? items : []).map(item => {
    const seedersRaw = Number(item.seeders) || null;
    return {
      Title:     item.title || "",
      Guid:      item.guid || item.downloadUrl || item.magnetUrl || "",
      Link:      item.downloadUrl || item.magnetUrl || (item.guid?.startsWith("http") ? item.guid : null) || null,
      MagnetUri: item.magnetUrl && item.magnetUrl.startsWith("magnet:") ? item.magnetUrl : null,
      Size:      Number(item.size) || 0,
      Seeders:   seedersRaw ?? 1,
      _displaySeeds: seedersRaw ?? 0,
      InfoHash:  normalizeProwlarrInfoHash(item.infoHash),
      Tracker:   item.indexer || indexer,
      TrackerId: String(item.indexerId || indexer || "").trim(),
      ImdbId:    normalizeImdbId(item.imdbId),
      PublishDate: item.publishDate || null,
      _structuredMatch: false,
    };
  }).filter(r => r.Title && (r.Link || r.MagnetUri || r.Guid));
}

async function prowlarrSearch(query, indexer, limit = 50, jUrl, jKey) {
  const res = await axios.get(`${jUrl}/api/v1/search`, {
    params: { apikey: jKey, query, type: "search", indexerIds: indexer, limit, offset: 0 },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return parseProwlarrResults(res.data, indexer);
}

async function jackettTextSearch(query, indexer, timeout, jUrl, jKey) {
  const params = { Query: query };
  if (jKey) params.apikey = jKey;
  const res = await axios.get(
    `${jUrl}/api/v2.0/indexers/${indexer}/results`,
    { params, timeout, validateStatus: () => true }
  );
  if (res.status === 404 || res.status === 401) return prowlarrSearch(query, indexer, 50, jUrl, jKey);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400)  throw new Error(`HTTP ${res.status}`);
  return (res.data?.Results || []).map(r => ({ ...r, _structuredMatch: false }));
}

async function jackettStructuredSearch(search, indexer, timeout, jUrl, jKey) {
  if (!search?.mode || !search?.imdbId) return [];
  const params = { apikey: jKey, t: search.mode, imdbid: search.imdbId, q: search.title };
  if (search.year)    params.year   = search.year;
  if (search.season  != null) params.season = search.season;
  if (search.episode != null) params.ep     = search.episode;

  const res = await axios.get(
    `${jUrl}/api/v2.0/indexers/${indexer}/results/torznab/api`,
    { params, timeout, responseType: "text", validateStatus: () => true }
  );
  if (res.status === 404) return [];
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400)  throw new Error(`HTTP ${res.status}`);
  return parseTorznabResults(String(res.data || ""), indexer);
}

async function jackettSearchOneIndexer(indexer, plan, timeout, fastTimeout, jUrl, jKey) {
  if (await isRateLimited(indexer)) return [];
  const t0 = Date.now();
  try {
    let results = [];
    const isSeries = plan.parsed?.type === 'series' || (plan.search?.season != null);
    if (plan.search && !plan.parsed?.isAnime && !isSeries) {
      try {
        results = await jackettStructuredSearch(plan.search, indexer, timeout, jUrl, jKey);
      } catch (err) {
        console.log(`  ${indexer}: erro na busca estruturada: ${err.message}`);
        if (err.response?.status === 429) throw err;
      }
    }
    if (results.length === 0) {
      for (const query of plan.queries) {
        try {
          const textResults = await jackettTextSearch(query, indexer, timeout, jUrl, jKey);
          results.push(...textResults);
          if (results.length > 0) break;
        } catch (err) {
          console.log(`  ${indexer}: erro na busca por texto "${query}": ${err.message}`);
          if (err.response?.status === 429) throw err;
        }
      }
    }
    const ms   = Date.now() - t0;
    await trackMetrics(indexer, ms, results.length, true);
    const mode = results.some(r => r._structuredMatch) ? "estruturado" : "texto";
    console.log(`  ${indexer}: ${results.length} resultados (${ms}ms, ${mode})`);
    return results;
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  ${indexer}: ERRO FATAL: ${err.message} (${ms}ms)`);
    if (err.response?.status === 429) await setRateLimit(indexer, err.response?.headers?.["retry-after"]);
    if (err.code === "ECONNABORTED" && timeout === fastTimeout)
      console.log(`  ${indexer}: timeout lento de ${ms}ms (indo para background)`);
    return [];
  }
}

async function trackMetrics(indexer, ms, count, ok) {
  const key = `metrics:${indexer}`;
  const raw = await rc.get(key);
  const m   = raw ? JSON.parse(raw) : { calls: 0, totalMs: 0, totalResults: 0, failures: 0 };
  m.calls++; m.totalMs += ms; m.totalResults += count;
  if (!ok) m.failures++;
  m.avgMs       = Math.round(m.totalMs      / m.calls);
  m.avgResults  = Math.round(m.totalResults / m.calls);
  m.successRate = Math.round(((m.calls - m.failures) / m.calls) * 100);
  m.lastCall    = new Date().toISOString();
  await rc.set(key, JSON.stringify(m), 86400);
}

async function jackettSearch(plan, indexers, prefs) {
  const jUrl     = (prefs?.jackett?.url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey     = prefs?.jackett?.key  || ENV.apiKey;
  const queryList = uniq(Array.isArray(plan?.queries) ? plan.queries : [plan?.queries].filter(Boolean));
  const cacheKey  = `search:${CACHE_VERSION}:${Buffer.from(JSON.stringify({ queryList, search: plan?.search || null, parsed: plan?.parsed || null })).toString("base64")}:${indexers.join(",")}`;
  const cached    = await rc.get(cacheKey);
  if (cached) {
    console.log(`Cache HIT para buscas: ${JSON.stringify(queryList)}`);
    return JSON.parse(cached);
  }
  const FAST_TIMEOUT = (prefs?.slowThreshold > 0 ? prefs.slowThreshold : 8000);
  const SLOW_TIMEOUT = 50000;
  console.log(`Jackett iniciando busca: "${queryList[0] || plan?.search?.title || "sem titulo"}" em [${indexers.length} indexers]`);
  console.log(`Fase rapida: aguardando respostas... (${FAST_TIMEOUT}ms max)`);

  const fastFlat    = (await Promise.all(indexers.map(indexer => jackettSearchOneIndexer(indexer, plan, FAST_TIMEOUT, FAST_TIMEOUT, jUrl, jKey)))).flat();
  const fastDeduped = prefs.dedupe !== false ? dedupeResults(fastFlat) : fastFlat;
  console.log(`Conclusao da janela rapida: ${fastFlat.length} brutos -> ${fastDeduped.length} ${prefs.dedupe !== false ? 'deduplicados' : 'resultados'}`);

  setImmediate(async () => {
    try {
      const slowFlat    = (await Promise.all(indexers.map(indexer => jackettSearchOneIndexer(indexer, plan, SLOW_TIMEOUT, FAST_TIMEOUT, jUrl, jKey)))).flat();
      const slowDeduped = prefs.dedupe !== false ? dedupeResults(slowFlat) : slowFlat;
      if (slowDeduped.length > fastDeduped.length) {
        console.log(`[Background] Cache atualizado: ${fastDeduped.length} -> ${slowDeduped.length}`);
        if (slowDeduped.length > 0) await rc.set(cacheKey, JSON.stringify(slowDeduped), 10800);
      } else {
        if (fastDeduped.length > 0) await rc.set(cacheKey, JSON.stringify(fastDeduped), 10800);
      }
    } catch {}
  });
  return fastDeduped;
}

async function getCinemetaTitle(type, imdbId) {
  try {
    const res    = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 5000 }
    );
    const meta    = res.data?.meta;
    const genres  = (meta?.genres   || []).map(g => g.toLowerCase());
    const country = (meta?.country  || "").toLowerCase();
    const lang    = (meta?.language || "").toLowerCase();
    const isAnime =
      genres.includes("anime") ||
      (genres.includes("animation") && (country.includes("japan") || country.includes("jp"))) ||
      (genres.includes("animation") && (lang.includes("japanese") || lang.includes("japan") || lang === "ja"));
    return {
      title  : meta?.name || imdbId,
      aliases: uniq([meta?.name, meta?.originalName, ...(meta?.aliases || [])]).map(normTitle),
      imdbId : meta?.imdb_id || meta?.id || imdbId,
      year   : extractReleaseYear(meta?.year || meta?.releaseInfo || meta?.released || ""),
      isAnime,
    };
  } catch {
    return { title: imdbId, aliases: [normTitle(imdbId)], imdbId, year: null, isAnime: false };
  }
}
async function getKitsuMeta(kitsuId) {
  try {
    const res   = await axios.get(
      `https://kitsu.io/api/edge/anime/${kitsuId}`,
      { timeout: 5000, headers: { Accept: "application/vnd.api+json" } }
    );
    const attrs   = res.data?.data?.attributes || {};
    const aliases = uniq([
      attrs.titles?.ja_jp,
      attrs.titles?.en_jp,
      attrs.canonicalTitle,
      attrs.titles?.en,
      attrs.slug?.replace(/-/g, " "),
    ]).map(normTitle);
    return { title: aliases[0] || String(kitsuId), aliases };
  } catch {
    return { title: String(kitsuId), aliases: [String(kitsuId)] };
  }
}
function parseStreamId(type, id) {
  if (!id || typeof id !== "string") return { source: "imdb", isAnime: false, metaId: "unknown", season: null, episode: null, type };
  const rssItem = parseRssItemId(id);
  if (rssItem) {
    return {
      source: "rssitem",
      isAnime: rssItem.catalogType === "anime",
      metaId: rssItem.metaId,
      season: rssItem.season,
      episode: rssItem.episode,
      rssToken: rssItem.token,
      rssType: rssItem.catalogType,
      type,
    };
  }
  if (id.startsWith("rssmovie:")) {
    return { source: "rssmovie", isAnime: false, metaId: id.slice("rssmovie:".length), season: null, episode: null, type };
  }
  if (id.startsWith("rssmeta:") || id.startsWith("prowjack:")) {
    const parts = id.split(":");
    const metaId = parts.slice(2).join(":");
    return { source: "rssmovie", isAnime: false, metaId, season: null, episode: null, type };
  }
  if (id.startsWith("kitsu:")) {
    const parts   = id.split(":");
    const season  = parts[2] ? parseInt(parts[2], 10) : null;
    const episode = parts[3] ? parseInt(parts[3], 10) : null;
    return {
      source : "kitsu",
      isAnime: true,
      kitsuId: parts[1] || "unknown",
      season : Number.isFinite(season)  ? season  : null,
      episode: Number.isFinite(episode) ? episode : null,
      type,
    };
  }
  if (type === "series" && id.includes(":")) {
    const [metaId, s, e] = id.split(":");
    const season  = parseInt(s, 10);
    const episode = parseInt(e, 10);
    return {
      source:  "imdb",
      isAnime: false,
      metaId:  metaId || "unknown",
      season:  Number.isFinite(season)  ? season  : null,
      episode: Number.isFinite(episode) ? episode : null,
      type,
    };
  }
  return { source: "imdb", isAnime: false, metaId: id, season: null, episode: null, type };
}
async function buildQueries(type, id) {
  const parsed = parseStreamId(type, id);
  if (parsed.isAnime) {
    const meta = await getKitsuMeta(parsed.kitsuId);
    const ep   = parsed.episode;
    const queries = ep != null
      ? uniq(meta.aliases.flatMap(t => [
          `${t} - ${String(ep).padStart(2, "0")}`,
          `${t} ${ep}`,
        ]))
      : uniq(meta.aliases);
    return {
      parsed, displayTitle: meta.title, aliases: meta.aliases, queries, episode: ep, search: null, year: null,
    };
  }
  const meta = await getCinemetaTitle(type, parsed.metaId);
  if (meta.isAnime) {
    parsed.isAnime = true;
    console.log(`[Cinemeta] Anime detectado: "${meta.title}" — usando indexers e filtros de anime`);
  }
  let queries;
  let episode = null;
  if (parsed.isAnime && parsed.season != null && parsed.episode != null) {
    episode = parsed.episode;
    queries = uniq(meta.aliases.flatMap(t => [
      `${t} - ${String(episode).padStart(2, "0")}`,
      `${t} ${episode}`,
      `${t} S${String(parsed.season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    ]));
  } else if (type === "series" && parsed.season != null && parsed.episode != null) {
    queries = uniq([
      `${meta.title} S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}`,
      ...meta.aliases.slice(0, 2).map(a =>
        `${a} S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}`
      ),
    ]);
  } else {
    queries = [meta.title];
  }
  return {
    parsed, displayTitle: meta.title, aliases: meta.aliases, queries: uniq(queries.map(normTitle)),
    episode, year: meta.year, search: parsed.isAnime ? null : {
      mode   : type === "movie" ? "movie" : "tvsearch",
      imdbId : meta.imdbId, title: meta.title, year: meta.year, season: parsed.season, episode: parsed.episode,
    },
  };
}

app.get("/api/debrid/test/:provider", async (req, res) => {
  const { provider } = req.params;
  const key = (req.query.key || "").trim();
  if (!key) return res.json({ ok: false, error: "API Key não informada" });
  try {
    if (provider === "torbox") {
      const r = await axios.get("https://api.torbox.app/v1/api/user/me",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      const d = r.data?.data || {};
      return res.json({ ok: true, name: d.email || d.customer || "Usuário", plan: d.plan || "" });
    }
    if (provider === "realdebrid") {
      const r = await axios.get("https://api.real-debrid.com/rest/1.0/user",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      return res.json({ ok: true, name: r.data?.username || "Usuário", plan: r.data?.type || "" });
    }
    if (provider === "stremthru") {
      const r = await axios.get("https://stremthru.13377001.xyz/api/v1/user",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      return res.json({ ok: true, name: r.data?.email || "Usuário", plan: r.data?.subscription || "" });
    }
    return res.json({ ok: false, error: "Provider desconhecido" });
  } catch (err) {
    const s = err.response?.status;
    return res.json({ ok: false, error: s === 401 ? "Key inválida (401)" : s === 403 ? "Acesso negado (403)" : err.message });
  }
});

app.get("/api/env", async (_, res) => {
  let redisOk = false;
  try {
    if (redis) {
      await redis.ping();
      redisOk = true;
    }
  } catch {}
  res.json({ jackettUrl: ENV.jackettUrl, jackettKey: ENV.apiKey, qbitUrl: (process.env.QBIT_URL||"").replace(/\/+$/,""), qbitUser: process.env.QBIT_USER||"", redisUrl: ENV.redisUrl, redisOk, port: ENV.port, qbitEnabled: isQbitConfigured() });
});
app.get("/api/indexers", async (req, res) => {
  const url = (req.query.url || "").trim().replace(/\/+$/, "") || ENV.jackettUrl;
  const key = (req.query.key || "").trim() || ENV.apiKey;
  try   {
    const [indexers, privacyMap] = await Promise.all([
      jackettFetchIndexers(url, key),
      fetchIndexerPrivacyMap(url, key),
    ]);
    const enriched = indexers.map(ix => ({
      ...ix,
      private: !!privacyMap.get(String(ix.id))?.private,
      privacy: privacyMap.get(String(ix.id))?.privacy || null,
    }));
    res.json({ ok: true, count: enriched.length, indexers: enriched });
  }
  catch (err) { res.json({ ok: false, error: err.message, indexers: [] }); }
});
app.get("/api/test", async (_, res) => {
  try   { const indexers = await jackettFetchIndexers(); res.json({ ok: true, count: indexers.length, indexers }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get("/api/metrics", async (_, res) => {
  const keys = await rc.keys("metrics:*");
  const out  = {};
  for (const k of keys) { const raw = await rc.get(k); if (raw) out[k.replace("metrics:", "")] = JSON.parse(raw); }
  res.json(out);
});
app.delete("/api/metrics/:indexer", async (req, res) => {
  await rc.del(`metrics:${req.params.indexer}`); res.json({ ok: true });
});
app.get("/manifest.json", (_, res) => {
  res.json({
    id: "org.prowjack.pro", version: "3.10.0", name: "ProwJack PRO",
    description: "Configure os parametros pela URL.",
    resources: ["stream", "meta"], types: ["movie", "series"],
    idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "rssitem:"],
    catalogs: [], behaviorHints: { configurable: true, configurationRequired: true, p2p: true },
  });
});
function sendConfigurePage(res) {
  const publicPath = path.join(__dirname, "public", "configure.html");
  const rootPath   = path.join(__dirname, "configure.html");
  if (fs.existsSync(publicPath))    res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.status(404).send("Arquivo configure.html nao encontrado.");
}

app.get("/configure", (_, res) => sendConfigurePage(res));
app.get("/:userConfig/configure", (_, res) => sendConfigurePage(res));
app.get("/", (_, res) => res.redirect("/configure"));
app.get("/:userConfig/manifest.json", (req, res) => {
  const prefs  = resolvePrefs(req.params.userConfig);
  const types  = [...new Set((prefs.categories || ["movie","series"]).map(c => c==="movies"?"movie":c==="anime"?"series":c))];
  const name   = prefs.addonName || "ProwJack PRO";
  const isDebridActive = prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);
  const hasP2P = !!prefs.stConfig || (!isDebridActive && prefs.enableP2P !== false);

  const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
  const catalogs = [];
  if (prefs.enableCatalog) {
    if (enabledCats.includes("movie"))  catalogs.push({ type: "movie",  id: "prowjack_rss_movie",  name: `${name} — Lançamentos` });
    if (enabledCats.includes("series")) catalogs.push({ type: "series", id: "prowjack_rss_series", name: `${name} — Lançamentos` });
  }
  res.json({
    id: "org.prowjack.pro", version: "3.11.0", name,
    description: `Jackett Otimizado · Prioridade PT-BR`,
    resources: [
      "catalog",
      { name: "meta",   types, idPrefixes: ["rssmovie:", "rssmeta:", "prowjack:", "rssitem:"] },
      { name: "stream", types, idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "prowjack:", "rssitem:"] },
    ],
    types, idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "prowjack:", "rssitem:"], catalogs,
    behaviorHints: { configurable: true, configurationRequired: false, p2p: hasP2P },
  });
});

app.get("/:userConfig/catalog/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const catalogTypeMap = {
    prowjack_rss_movie:  "movie",
    prowjack_rss_series: "series",
    prowjack_rss_anime:  "anime",
  };
  const catalogType = catalogTypeMap[id];
  if (!catalogType) return res.json({ metas: [] });

  try {
    const raw   = await rc.get(`${CATALOG_KEY}:${catalogType}`);
    const items = raw ? JSON.parse(raw) : [];
    const metas = items.map(m => ({
      id:          m.id,
      type:        m.type,
      name:        m.name,
      poster:      m.poster,
      background:  m.background,
      description: m.description,
      releaseInfo: m.releaseInfo,
      imdbRating:  m.imdbRating,
      genres:      m.genres,
    })).filter(m => m.id && m.poster);
    res.json({ metas });
  } catch {
    res.json({ metas: [] });
  }
});

app.get("/:userConfig/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const prefs = resolvePrefs(req.params.userConfig);

  if (id.startsWith("rssmovie:")) {
    const ttId = id.slice("rssmovie:".length);
    try {
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${ttId}.json`, { timeout: 6000 });
      const meta = r.data?.meta;
      if (meta) return res.json({ meta: { ...meta, id } });
    } catch {}
    return res.json({ meta: null });
  }

  const rssMeta = parseRssMetaId(id);

  if (!rssMeta) {
    try {
      const targetType = type === "movie" ? "movie" : "series";
      const cleanId = normalizeImdbId(id) || id;
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${targetType}/${cleanId}.json`, { timeout: 5000 });
      return res.json(r.data || { meta: null });
    } catch {
      return res.json({ meta: null });
    }
  }

  try {
    const metaCacheKey = `rssmeta:${rssMeta.metaId}`;
    let baseMeta = {};
    const cachedMetaRaw = await rc.get(metaCacheKey).catch(() => null);
    if (cachedMetaRaw) {
      try { baseMeta = JSON.parse(cachedMetaRaw); } catch {}
    }
    if (!baseMeta.name) {
      try {
        const r = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${rssMeta.metaId}.json`, { timeout: 6000 });
        baseMeta = r.data?.meta || {};
        if (baseMeta.name) rc.set(metaCacheKey, JSON.stringify(baseMeta), 86400).catch(() => {});
      } catch {
        const catalogRaw = await rc.get(`${CATALOG_KEY}:${rssMeta.catalogType}`).catch(() => null);
        const catalogItems = catalogRaw ? JSON.parse(catalogRaw) : [];
        const found = catalogItems.find(i => i.id === id || i.id === rssMeta.metaId);
        if (found) baseMeta = found;
      }
    }

    const rssItems = await loadRssItemsForType(prefs, rssMeta.catalogType);
    const matchedRssItems = rssItems.filter(item =>
      normalizeImdbId(item.ImdbId) === normalizeImdbId(rssMeta.metaId)
    );

    const availableEps = new Set();
    for (const item of matchedRssItems) {
      const marker = rssMeta.catalogType === "anime"
        ? extractAnimeFeedMarker(item.Title)
        : extractSeriesFeedMarker(item.Title);
      if (!marker) {
        availableEps.add("all");
        continue;
      }
      if (marker.pack) {
        availableEps.add(`season:${marker.season}`);
      } else {
        availableEps.add(`${marker.season}:${marker.episode}`);
      }
    }

    console.log(`[Meta] ${rssMeta.metaId}: ${matchedRssItems.length} itens RSS → marcadores: [${[...availableEps].join(", ")}]`);

    const cinemetaVideos = baseMeta.videos || [];
    let videos;

    if (availableEps.size === 0) {
      videos = [];
      console.log(`[Meta] ${rssMeta.metaId}: nenhum episódio RSS disponível`);
    } else {
      videos = cinemetaVideos
        .filter(v => {
          if (!v.season || !v.episode) return false;
          if (availableEps.has("all"))                      return true;
          if (availableEps.has(`${v.season}:${v.episode}`)) return true;
          if (availableEps.has(`season:${v.season}`))       return true;
          return false;
        })
        .map(v => ({
          ...v,
          id: `rssitem:${rssMeta.catalogType}:${rssMeta.metaId}:${v.season}:${v.episode}`,
        }));

      if (videos.length === 0 && matchedRssItems.length > 0) {
        const rssVideos = buildRssVideos(rssItems, rssMeta.catalogType, rssMeta.metaId);

        if (cinemetaVideos.length === 0) {
          console.log(`[Meta] ${rssMeta.metaId}: Cinemeta sem episódios → usando RSS`);
          videos = rssVideos;
        } else {
          const rssKeys = new Set(rssVideos.map(v => `${v.season}:${v.episode}`));
          const cinemetaOther = cinemetaVideos
            .filter(v => v.season && v.episode && !rssKeys.has(`${v.season}:${v.episode}`))
            .map(v => ({ ...v, id: `rssitem:${rssMeta.catalogType}:${rssMeta.metaId}:${v.season}:${v.episode}` }));
          videos = [...cinemetaOther, ...rssVideos]
            .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
          console.log(`[Meta] ${rssMeta.metaId}: temporada RSS mais recente → merge ${cinemetaOther.length} Cinemeta + ${rssVideos.length} RSS`);
        }
      }

      const rssCount   = videos.filter(v => String(v.id).startsWith("rssitem:")).length;
      const totalCount = videos.length;
      console.log(`[Meta] ${rssMeta.metaId}: ${totalCount} eps disponíveis (${rssCount} via RSS, ${totalCount - rssCount} via Cinemeta)`);
    }

    if (!baseMeta.name && !videos.length) return res.json({ meta: null });

    const { videos: _ignored, imdb_id: _imdb, moviedb_id: _tmdb, slug: _slug, trailers: _tr, credits_cast: _cc, credits_crew: _cr, ...baseMetaWithoutVideos } = baseMeta;
    return res.json({
      meta: {
        ...baseMetaWithoutVideos,
        id,
        type: "series",
        videos,
        behaviorHints: { hasScheduledVideos: false },
      }
    });
  } catch (err) {
    console.error(`[Meta] Erro: ${err.message}`);
    return res.json({ meta: null });
  }
});

app.get("/:userConfig/debrid-add/:provider/:infoHash", async (req, res) => {
  const { provider, infoHash } = req.params;
  const magnet  = req.query.magnet;
  const linkUrl = req.query.link;
  const prefs   = resolvePrefs(req.params.userConfig);
  const config  = prefs.debridConfig;

  if (!config || (!magnet && !linkUrl)) {
    return res.status(400).send("Configuração ou magnet/link ausente");
  }

  const lockKey      = `addlock:${provider}:${infoHash}`;
  const alreadyAdded = await rc.get(lockKey);

  let torrentBuffer = null;
  if (linkUrl?.startsWith("http")) {
    try {
      const dl = await axios.get(linkUrl, {
        responseType: "arraybuffer",
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: s => s < 400,
        headers: { "User-Agent": "Mozilla/5.0" },
        beforeRedirect: (options) => {
          if (options.href?.startsWith("magnet:")) {
            throw new Error("Redirect para magnet detectado");
          }
        },
      });
      if (dl.data && Buffer.from(dl.data)[0] === 0x64) {
        torrentBuffer = Buffer.from(dl.data);
      }
    } catch(e) {
      if (!e.message.includes("magnet")) {
        console.log(`[ON-DEMAND] Falha ao baixar .torrent: ${e.message}`);
      }
    }
  }

  const isRD = provider.toLowerCase() === "realdebrid";
  const isTB = provider.toLowerCase() === "torbox";

  if (!alreadyAdded) {
    await rc.set(lockKey, "1", 3600);
    console.log(`[ON-DEMAND] Adicionando ${infoHash} ao ${provider}...`);
    try {
      if (isTB) {
        const { torboxAddTorrent } = require("./debrid");
        const ok = await torboxAddTorrent(magnet, config.torboxKey, false, torrentBuffer);
        if (!ok) console.log(`[ON-DEMAND] Falha ao adicionar ao TorBox (pode já estar na fila ou erro de API)`);
        else     console.log(`[ON-DEMAND] Adicionado com sucesso ao TorBox`);
      } else if (isRD) {
        const { rdAddTorrent } = require("./debrid");
        const ok = await rdAddTorrent(magnet, config.rdKey, torrentBuffer);
        if (!ok) {
          console.log(`[ON-DEMAND] Falha ao adicionar ao RD`);
          return res.status(500).send(`Falha ao adicionar torrent ao Real-Debrid`);
        }
        console.log(`[ON-DEMAND] Adicionado com sucesso ao RD`);
      }
    } catch (e) {
      console.log(`[ON-DEMAND] Erro ao adicionar: ${e.message}`);
      if (isRD) return res.status(500).send(`Erro: ${e.message}`);
    }
  }

  if (isTB) {
    const deadline = Date.now() + 120000;
    const delays   = [2000, 3000, 5000, 8000];
    let delayIndex = 0;
    console.log(`[ON-DEMAND] TorBox: aguardando download (até 120s)...`);

    while (Date.now() < deadline) {
      try {
        const remainingTime = deadline - Date.now();
        const tbRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
          headers: { Authorization: `Bearer ${config.torboxKey}` },
          timeout: Math.min(8000, remainingTime),
          signal: AbortSignal.timeout(remainingTime),
        });

        const torrent = tbRes.data?.data?.find(t =>
          t.hash?.toLowerCase() === infoHash.toLowerCase()
        );

        if (torrent?.download_finished) {
          console.log(`[ON-DEMAND] TorBox pronto! Resolvendo stream...`);
          const { resolveDebridStream } = require("./debrid");
          const stream = await resolveDebridStream(
            infoHash, magnet, "", null, null, false,
            config, null, null, torrent, null
          );
          if (stream?.url) {
            await rc.del(lockKey);
            return res.redirect(302, stream.url);
          }
        }
      } catch (err) {
        console.log(`[ON-DEMAND] TorBox polling erro: ${err.message}`);
      }

      const pollDelay = delays[Math.min(delayIndex, delays.length - 1)];
      delayIndex++;
      if (Date.now() + pollDelay < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollDelay));
      } else break;
    }

    console.log(`[ON-DEMAND] TorBox timeout (120s) — ainda processando`);
    res.setHeader("Retry-After", "10");
    return res.status(202).send("Download em andamento no TorBox. O player tentará novamente automaticamente.");
  }

  const deadline = Date.now() + 120000;
  const delays   = [2000, 3000, 5000, 8000];
  let delayIndex = 0;
  console.log(`[ON-DEMAND] Aguardando processamento (até 120s)...`);

  while (Date.now() < deadline) {
    try {
      const remainingTime = deadline - Date.now();
      if (isRD) {
        const { rdFindExistingTorrent } = require("./debrid");
        const existing = await rdFindExistingTorrent(infoHash, config.rdKey);
        if (existing?.links?.length) {
          const unresRes = await axios.post(
            "https://api.real-debrid.com/rest/1.0/unrestrict/link",
            `link=${encodeURIComponent(existing.links[0])}`,
            {
              headers: {
                Authorization: `Bearer ${config.rdKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              timeout: Math.min(12000, remainingTime),
              signal: AbortSignal.timeout(remainingTime),
            }
          );
          if (unresRes.data?.download) {
            console.log(`[ON-DEMAND] RD pronto! Redirecionando...`);
            await rc.del(lockKey);
            return res.redirect(302, unresRes.data.download);
          }
        }
      }
    } catch (err) {
      console.log(`[ON-DEMAND] Erro no polling: ${err.message}`);
    }

    const pollDelay = delays[Math.min(delayIndex, delays.length - 1)];
    delayIndex++;
    if (Date.now() + pollDelay < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollDelay));
    } else break;
  }

  console.log(`[ON-DEMAND] Timeout (120s) — ainda processando`);
  res.setHeader("Retry-After", "10");
  return res.status(202).send("Download em andamento. O player tentará novamente automaticamente.");
});

app.get("/:userConfig/qbit/:jobToken", async (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);
  const job = await loadQbitJob(req.params.jobToken);
  if (!job?.infoHash) return res.status(404).send("Job expirado ou inválido.");
  const qbitCreds = job.qbit || prefs.qbit || null;
  if (!isQbitConfigured(qbitCreds)) return res.status(503).send("qBittorrent não configurado.");

  try {
    let playable = await getPlayableLocalFile(job.infoHash, job.fileIdx, job.fileName, qbitCreds);

    if (!playable) {
      let torrentBuffer = null;

      if (job.torrentB64) {
        try {
          torrentBuffer = Buffer.from(job.torrentB64, "base64");
          console.log(`[qBit] Buffer .torrent do job: ${torrentBuffer.length} bytes`);
        } catch (e) {
          console.log(`[qBit] Falha ao decodificar torrentB64: ${e.message}`);
        }
      }

      if (!torrentBuffer && job.link && !job.link.startsWith("magnet:")) {
        try {
          const dl = await axios.get(job.link, {
            responseType: "arraybuffer", timeout: 15000, maxRedirects: 5,
            maxContentLength: 8 * 1024 * 1024, headers: { "User-Agent": "Mozilla/5.0" },
            validateStatus: s => s < 400,
            beforeRedirect: (options) => {
              if (options.href?.startsWith("magnet:")) throw new Error("Redirect para magnet");
            },
          });
          if (dl.data && Buffer.from(dl.data)[0] === 0x64) {
            const raw = Buffer.from(dl.data);
            try { torrentBuffer = injectTrackers(raw); } catch { torrentBuffer = raw; }
            console.log(`[qBit] .torrent re-baixado do link: ${torrentBuffer.length} bytes`);
          }
        } catch (e) {
          if (!e.message.includes("magnet")) console.log(`[qBit] Falha ao re-baixar .torrent: ${e.message}`);
        }
      }

      await ensureTorrentReady(job.infoHash, {
        torrentBuffer, magnet: job.magnet, fileIdx: job.fileIdx, fileName: job.fileName, creds: qbitCreds,
      });

      playable = await getPlayableLocalFile(job.infoHash, job.fileIdx, job.fileName, qbitCreds);

      if (!playable) {
        console.log(`[qBit] ${job.infoHash} sem buffer ainda — respondendo 503 para retry`);
        res.setHeader("Retry-After", "5");
        return res.status(503).send("Aguardando buffer do qBittorrent...");
      }
    }

    await streamTorrentFile(req, res, job.infoHash, job.fileIdx, job.fileName, qbitCreds);
  } catch (err) {
    console.log(`[qBit] Falha ao preparar ${job.infoHash}: ${err.message}`);
    if (!res.headersSent) res.status(503).send(`qBittorrent: ${err.message}`);
  }
});

app.get("/qbit/stream/:jobToken", async (req, res) => {
  const job = await loadQbitJob(req.params.jobToken);
  if (!job?.infoHash) return res.status(404).json({ error: "Job expirado ou inválido" });
  const qbitCreds = job.qbit || null;
  if (!isQbitConfigured(qbitCreds)) return res.status(503).json({ error: "qBittorrent não configurado" });

  try {
    await streamTorrentFile(req, res, job.infoHash, job.fileIdx, job.fileName, qbitCreds);
  } catch (err) {
    console.error("[qBit stream]", err.message);
    if (!res.headersSent) res.status(503).json({ error: err.message });
  }
});

async function fetchScrapStreams(manifestUrl, type, id) {
  try {
    const base = manifestUrl.replace(/\/manifest\.json$/i, "");
    const url  = `${base}/stream/${type}/${id}.json`;
    const res  = await axios.get(url, { timeout: 8000, validateStatus: s => s < 400 });
    const streams = res.data?.streams;
    if (!Array.isArray(streams)) return [];
    return streams
      .filter(s => s.infoHash || (s.url && !s.url.startsWith("magnet:")))
      .map(s => {
        const rawName = s.name || "";
        const desc    = s.description || s.title || "";
        const titleForFilters = desc || rawName;
        const size = s.behaviorHints?.videoSize || 0;
        return {
          ...s,
          _sourceType:  "debrid",
          _scrapSource: true,
          _cached:      true,   
          _title:       titleForFilters,
          _filename:    s.behaviorHints?.filename || "",
          _sizeBytes:   size,
          _seeders:     0,
          _sizeGb:      size / 1e9,
        };
      });
  } catch { return []; }
}

const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i;
app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);
  const qbitCreds = prefs.qbit || null;
  const { type, id } = req.params;
  console.log(`\n=========================================`);
  console.log(`NOVA BUSCA: [${type}] ${id}`);

  const isDebridMode = prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);

  if (isDebridMode) {
    console.log(`[DEBRID] Modo ativo: ${prefs.debridConfig.mode.toUpperCase()} — P2P desabilitado`);
  }

  const streamCacheKey = `streams:${CACHE_VERSION}:${req.params.userConfig}:${type}:${id}`;
  const cachedStreams = await rc.get(streamCacheKey).catch(() => null);
  if (cachedStreams) {
    try {
      const parsed = JSON.parse(cachedStreams);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[Stream Cache HIT] ${parsed.length} streams para ${id}`);
        console.log(`=========================================\n`);
        return res.json({ streams: parsed });
      }
    } catch {}
  }

  try {
    const { parsed, displayTitle, aliases = [], queries, episode, year, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);

    const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
    if (parsed.isAnime && !enabledCats.includes("anime"))                       return res.json({ streams: [] });
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) return res.json({ streams: [] });
    if (type === "movie" && !enabledCats.includes("movie"))                      return res.json({ streams: [] });

    const indexers     = await resolveSearchIndexers(prefs, parsed.isAnime);

    let results;
    const rssType = parsed.rssType || (parsed.isAnime ? "anime" : type === "movie" ? "movie" : "series");
    let usedRssFastPath = false;
    const preferredRssIndexers = Array.isArray(prefs.rssIndexers) && prefs.rssIndexers.length
      ? prefs.rssIndexers
      : (Array.isArray(prefs.indexers) && prefs.indexers.length && !prefs.indexers.includes("all") ? prefs.indexers : null);
    const bypassRssFilters = parsed.source === "rssitem" || !!preferredRssIndexers?.length;

    if (parsed.source === "rssmovie") {
      const rssHits = await loadRssItemsForType(prefs, "movie");
      const matched = rssHits.filter(r => normalizeImdbId(r.ImdbId) === normalizeImdbId(parsed.metaId));
      if (matched.length) {
        results = matched.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
        usedRssFastPath = true;
        console.log(`[RSS Fast-path] ${results.length} resultados do cache RSS para ${parsed.metaId}`);
      } else {
        return res.json({ streams: [] });
      }
    } else if (parsed.source === "rssitem" && parsed.rssToken) {
      const rssHits = await loadRssItemsForType(prefs, parsed.rssType || rssType);
      const exactItem = findRssItemByToken(rssHits, parsed.rssToken);
      if (exactItem) {
        results = [{ ...exactItem, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: 0 }];
        usedRssFastPath = true;
      } else {
        return res.json({ streams: [] });
      }
    } else if (parsed.source === "rssitem") {
      const rssHits = await loadRssItemsForType(prefs, parsed.rssType || rssType);
      const requestedEpisode = parsed.episode ?? 0;
      const exactItems = matchRssItemsByMarker(
        rssHits,
        parsed.rssType || rssType,
        parsed.metaId,
        parsed.season ?? 1,
        requestedEpisode
      );
      if (exactItems.length) {
        results = exactItems.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
        usedRssFastPath = true;
      } else {
        return res.json({ streams: [] });
      }
    } else if (requestedImdbId || aliases.length) {
      const allowedRss = preferredRssIndexers;
      const rssPattern = allowedRss
        ? null 
        : `rss:${CACHE_VERSION}:*:${rssType}:*`;
      const rssKeys = allowedRss
        ? await Promise.all(allowedRss.map(ix => rc.keys(`rss:${CACHE_VERSION}:${ix}:${rssType}:*`))).then(a => a.flat())
        : await rc.keys(rssPattern);
      if (rssKeys.length > 0) {
        const rssHits = (await Promise.all(
          rssKeys.map(async key => {
            try { const raw = await rc.get(key); return raw ? JSON.parse(raw) : []; }
            catch { return []; }
          })
        )).flat();

        const matched = rssHits
          .map((r, idx) => {
            const resultImdbId = normalizeImdbId(r.ImdbId);
            const byImdb = !!(requestedImdbId && resultImdbId && resultImdbId === requestedImdbId);
            const titleScore = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const effectiveScore = Math.max(titleScore, (parsed.isAnime || type === "series") ? relaxedScore * 0.85 : 0);
            const minAliasScore = parsed.isAnime ? 0.45 : type === "series" ? 0.5 : 0.6;
            const byAlias = effectiveScore >= minAliasScore;
            if (!byImdb && !byAlias) return null;
            return {
              ...r,
              _metaIdMatch: byImdb,
              _titleMatchScore: effectiveScore,
              _rssPreferred: bypassRssFilters,
              _rssOrder: idx,
            };
          })
          .filter(Boolean);

        if (matched.length > 0) {
          console.log(`[RSS Fast-path] ${matched.length} resultados do cache RSS para ${requestedImdbId || displayTitle}`);
          results = matched;
          usedRssFastPath = true;
        }
      }
    }

    if (!usedRssFastPath) {
      const [jackettResults, scrapResults] = await Promise.all([
        jackettSearch({ parsed, queries, search }, indexers, prefs),
        ENV.scrapManifests.length
          ? Promise.all(ENV.scrapManifests.map(m => fetchScrapStreams(m, type, id)))
          : Promise.resolve([])
      ]);
      results = jackettResults;
      results._scrapStreams = scrapResults.flat();
    }
    const priorityLang = prefs.priorityLang ?? "pt-br";

    console.log(`Filtros ativos: onlyDubbed=${prefs.onlyDubbed}, priorityLang=${priorityLang}, keywordBoost=${prefs.keywordBoost ? 'SIM' : 'NÃO'}`);

    const candidates = (bypassRssFilters && usedRssFastPath
      ? results
          .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
          .filter(r => {
            if (parsed.source === "rssitem") return true;
            if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
            if (type === "series") return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            return true;
          })
          .map(r => {
            r._originalScore = 1_000_000 - (r._rssOrder || 0);
            return r;
          })
      : results
          .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
          .filter(r => !prefs.skipBadReleases || !BAD_RE.test(r.Title || ""))
          .filter(r => type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
          .filter(r => {
            if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
            if (type === "series") return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            return true;
          })
          .filter(r => {
            if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) {
              r._titleMatchScore = 1; r._keywordMatch = true; return true;
            }
            if (!prefs.onlyDubbed || !priorityLang) return true;
            const langs   = getLangs(r.Title || "", parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;
            return hasLang;
          })
          .filter(r => {
            if (r._keywordMatch || r._metaIdMatch) return true;
            const resultImdbId = getResultImdbId(r);
            if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              r._metaIdMatch = true; return true;
            }
            const langs   = getLangs(r.Title || "", parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;

            const sc           = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const episodeRank  = parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
            const minScore     = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
            const finalScore   = Math.max(sc, type === "series" ? relaxedScore * 0.8 : 0);
            if (hasLang && finalScore > 0) r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
            r._titleMatchScore = Math.max(r._titleMatchScore || 0, finalScore);
            return finalScore >= minScore || (hasLang && finalScore > 0);
          })
          .filter(r => { if (type !== "movie" || !year) return true; const ry = extractReleaseYear(r.Title || ""); return !ry || Math.abs(ry - year) <= 1; })
          .map(r => {
            const t       = r.Title || "";
            const langs   = getLangs(t, parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;
            const isMulti = /(multi)[-.\\s]?(audio)?/i.test(t);
            const langPriority = hasLang ? 3 : (prefs.keywordBoost && matchesKeywordBoost(t, prefs.keywordBoost) ? 2 : (isMulti ? 1 : 0));
            r._originalScore = (langPriority * 100000) +
              ((r._metaIdMatch    ? 1 : 0) * 40000) +
              ((r._structuredMatch ? 1 : 0) * 20000) +
              (parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode)) * 10000 +
              (r._titleMatchScore || 0) * 1000 +
              score(r, prefs.weights, parsed.isAnime, priorityLang);
            return r;
          })
          .sort((a, b) => b._originalScore - a._originalScore));

    console.log(`Resultados: ${results.length} brutos → ${candidates.length} após filtros (idioma, título, ano)`);
    if (prefs.keywordBoost) {
      const withKeywords = candidates.filter(r => matchesKeywordBoost(r.Title || "", prefs.keywordBoost));
      console.log(`Keywords: ${withKeywords.length}/${candidates.length} releases com boost`);
    }

    let filteredCandidates = candidates;
    if (!bypassRssFilters && prefs.maxResultsPerIndexer > 0) {
      const countByIndexer = new Map();
      filteredCandidates = candidates.filter(r => {
        if (r._keywordMatch) return true;
        const key = r.TrackerId || r.Tracker || "unknown";
        const n   = (countByIndexer.get(key) || 0) + 1;
        countByIndexer.set(key, n);
        return n <= prefs.maxResultsPerIndexer;
      });
    }

    const maxOut              = prefs.maxResults || 20;
    const cacheCheckCandidates = isDebridMode && !prefs.stConfig && !bypassRssFilters
      ? filteredCandidates
      : filteredCandidates.slice(0, maxOut);
    const topCandidates = cacheCheckCandidates;
    console.log(`Extraindo InfoHashes de ${topCandidates.length} candidatos...`);

    const withHashes = (await (async () => {
      const results = new Array(topCandidates.length).fill(null);
      const CONCURRENCY = 5;
      let idx = 0;
      async function worker() {
        while (idx < topCandidates.length) {
          const i = idx++;
          const resolved = await resolveInfoHash(topCandidates[i]);
          results[i] = resolved?.infoHash ? { ...topCandidates[i], _resolved: resolved } : null;
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return results;
    })()).filter(Boolean);

    let rdCacheMap = {};
    let tbCacheMap = {};

    if (isDebridMode && !prefs.stConfig && withHashes.length > 0 && !bypassRssFilters) {
      const allHashes   = [...new Set(withHashes.map(r => r._resolved.infoHash))];
      const { mode, torboxKey, rdKey } = prefs.debridConfig;
      const { rdBatchCheckCache, torboxBatchCheckCache } = require("./debrid");

      const privateHashes = new Set(
        withHashes.filter(r => !r.MagnetUri && r._resolved?.buffer).map(r => r._resolved.infoHash)
      );
      const bufferMap = {};
      for (const r of withHashes) {
        if (r._resolved?.buffer) bufferMap[r._resolved.infoHash] = r._resolved.buffer;
      }

      const [rdResult, tbResult] = await Promise.all([
        (mode === "realdebrid" || mode === "dual") && rdKey
          ? rdBatchCheckCache(allHashes, rdKey, bufferMap, privateHashes) : Promise.resolve({}),
        (mode === "torbox"     || mode === "dual") && torboxKey
          ? torboxBatchCheckCache(allHashes, torboxKey, privateHashes)    : Promise.resolve({}),
      ]);
      rdCacheMap = rdResult;
      tbCacheMap = tbResult;

      const debridCached = new Set();
      withHashes.forEach(r => {
        r._isCached = false;
        const h = r._resolved.infoHash;
        if ((mode === "realdebrid" || mode === "dual") && rdCacheMap[h]?.rd?.length > 0) {
          r._isCached = true; debridCached.add(h);
        }
        if ((mode === "torbox" || mode === "dual") && tbCacheMap[h] && typeof tbCacheMap[h] === 'object' && tbCacheMap[h] !== false) {
          r._isCached = true; debridCached.add(h);
        }
      });
      console.log(`[DEBRID] cached=${debridCached.size} uncached=${withHashes.length - debridCached.size}`);
    } else if (prefs.stConfig) {
      console.log(`[STREMTHRU] Proxy ativo - cache check desabilitado`);
    }

    const dedupedWithHashes = bypassRssFilters ? withHashes : dedupeWithCachePriority(withHashes, isDebridMode && !prefs.stConfig);
    if (!bypassRssFilters && dedupedWithHashes.length < withHashes.length) {
      const removed = withHashes.length - dedupedWithHashes.length;
      console.log(`[DEDUP] ${withHashes.length} → ${dedupedWithHashes.length} candidatos (-${removed} duplicatas, preferiu público cacheado)`);
    }

    const streamMeta = {
      title: displayTitle,
      year,
      formattedSeasons: (type === "series" && parsed.season != null)
        ? `S${String(parsed.season).padStart(2, "0")}${parsed.episode != null ? `E${String(parsed.episode).padStart(2, "0")}` : ""}`
        : "",
    };

    const resolvedAll = await Promise.all(
      dedupedWithHashes.map(async r => {
        try {
          const resolved     = r._resolved;
          const indexerName  = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
          const { name, description: descNoSeeds, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, false, streamMeta);
          const { description } = formatStream(r, indexerName, parsed.isAnime, prefs, true, streamMeta);
          const matchedFile  = (type === "series" || parsed.isAnime)
            ? pickEpisodeFile(resolved.files, parsed.season, parsed.episode ?? episode, parsed.isAnime)
            : null;
          if ((type === "series" || parsed.isAnime) && resolved.files?.length && !matchedFile) {
            console.log(`[WARN] pickEpisodeFile: nenhum arquivo encontrado para S${parsed.season}E${parsed.episode ?? episode} em "${r.Title?.slice(0,60)}"`);
          } else if (matchedFile) {
            console.log(`[FILE] Arquivo selecionado: "${matchedFile.name}" (idx=${matchedFile.idx}) para S${parsed.season}E${parsed.episode ?? episode}`);
          }
          const magnet      = buildMagnet(resolved.infoHash, r.MagnetUri, r.Title);
          const publicBase  = getPublicBase(req);
          const localPlayable = isQbitConfigured(qbitCreds)
            ? await getPlayableLocalFile(resolved.infoHash, matchedFile?.idx ?? null, matchedFile?.name || null, qbitCreds).catch(() => null)
            : null;

          const isPrivateTracker = !r.MagnetUri && !!resolved.buffer;

          let qbitStreamPromise = null;
          const buildQbitStream = async () => {
            if (qbitStreamPromise) return qbitStreamPromise;
            qbitStreamPromise = (async () => {
            let torrentB64 = null;
            if (resolved.buffer) {
              try {
                torrentB64 = injectTrackers(resolved.buffer).toString("base64");
              } catch {
                torrentB64 = resolved.buffer.toString("base64");
              }
            }
            const jobToken = await saveQbitJob({
              infoHash: resolved.infoHash,
              link:     (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
              magnet,
              fileIdx:  matchedFile?.idx  ?? null,
              fileName: matchedFile?.name || null,
              torrentB64,
              qbit: prefs.qbit ? {
                url: prefs.qbit.url || "",
                user: prefs.qbit.user || "",
                pass: prefs.qbit.pass || "",
              } : null,
            });
            const qbitName = localPlayable
              ? `${prefs.addonName || "ProwJack PRO"}\n⚡️ ${resLabel || "Links"} [QB]`
              : `${prefs.addonName || "ProwJack PRO"}\n⬇️ ${resLabel || "Links"} [QB]`;
            return {
              name: qbitName,
              description: [description, matchedFile?.name ? `📂 ${matchedFile.name}` : "", isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
              url:   `${publicBase}/${req.params.userConfig}/qbit/${jobToken}`,
              indexer: renameIndexer(indexerName),
              _cached: !!localPlayable,
              _sourceType: "http",
              behaviorHints: {
                filename:   matchedFile?.name || r.Title,
                videoSize:  matchedFile?.size,
                bingeGroup: `prowjack|qbit|${resolved.infoHash}`,
                notWebReady: false,
              },
            };
            })();
            return qbitStreamPromise;
          };

          if (isDebridMode) {
            const debridData = await resolveDebridStream(
              resolved.infoHash,
              magnet,
              r.Title,
              parsed.season,
              parsed.episode ?? episode,
              parsed.isAnime,
              prefs.debridConfig,
              resolved.files,
              rdCacheMap[resolved.infoHash],
              tbCacheMap[resolved.infoHash],
              resolved.buffer
            );

            if (!debridData) {
              if (prefs.enableP2P && isQbitConfigured(qbitCreds) && isPrivateTracker && resolved.buffer &&
                  (prefs.qbitMode === 'always' || prefs.qbitMode === 'private')) {
                return buildQbitStream();
              }
              return null;
            }
            const resultsArray = debridData.multi ? debridData.multi : [debridData];

            return Promise.all(resultsArray.map(async resObj => {
              const addonName    = prefs.addonName || "ProwJack PRO";
              const resLabelStr  = resLabel || "Links";
              const isDual       = prefs.debridConfig?.mode === "dual";
              const providerTag  = resObj.provider === "TorBox" ? "[TB]" : "[RD]";

              if (resObj.url && !resObj.queued) {
                const debridFilename = resObj.filename || matchedFile?.name;
                const streamName     = isDual
                  ? `${addonName}\n⚡️ ${resLabelStr} ${providerTag}`
                  : `${addonName}\n⚡️ ${resLabelStr}`;
                return {
                  name: streamName,
                  description: [descNoSeeds, debridFilename ? `📂 ${debridFilename}` : ""].filter(Boolean).join("\n"),
                  url:     resObj.url,
                  _cached: true,
                  _sourceType: "debrid",
                  behaviorHints: {
                    filename:   debridFilename || r.Title,
                    videoSize:  matchedFile?.size,
                    bingeGroup: `prowjack|debrid|${resolved.infoHash}`,
                    notWebReady: false,
                  },
                };
              }

              if (resObj.queued) {
                const provider   = (resObj.provider || "Debrid").toLowerCase().replace(/[^a-z]/g, "");
                const hostUrl    = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
                const linkParam  = r.Link ? `&link=${encodeURIComponent(r.Link)}` : "";
                const addUrl     = `${hostUrl}/${req.params.userConfig}/debrid-add/${provider}/${resolved.infoHash}?magnet=${encodeURIComponent(magnet)}${linkParam}`;
                const cacheEmoji = resObj.cached ? "⚡️" : "⬇️";
                const streamName = isDual
                  ? `${addonName}\n${cacheEmoji} ${resLabelStr} ${providerTag}`
                  : `${addonName}\n${cacheEmoji} ${resLabelStr}`;

                const debridOption = {
                  name: streamName,
                  description,
                  url:     addUrl,
                  _cached: !!resObj.cached,
                  _sourceType: "debrid",
                  behaviorHints: { notWebReady: true },
                };

                if (prefs.enableP2P && isQbitConfigured(qbitCreds)) {
                  const shouldOfferQbit = prefs.qbitMode === 'always' ||
                    (prefs.qbitMode === 'private' && isPrivateTracker);
                  if (shouldOfferQbit) {
                    const qbitOption = await buildQbitStream();
                    return [debridOption, qbitOption];
                  }
                }

                return debridOption;
              }
              return null;
            })).then(items => items.filter(Boolean));
          }

          const shouldOfferQbit = prefs.enableP2P && isQbitConfigured(qbitCreds) &&
            (prefs.qbitMode === 'always' || (prefs.qbitMode === 'private' && isPrivateTracker));

          if (shouldOfferQbit && (localPlayable || r.Link || magnet)) {
            const qbitStream = await buildQbitStream();

            if (isPrivateTracker && !r.MagnetUri) {
              return qbitStream;
            }

            let _qbitTrackers = [];
            if (resolved.buffer) {
              _qbitTrackers = extractTrackers(resolved.buffer);
            } else if (r.MagnetUri) {
              for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
                try { _qbitTrackers.push(decodeURIComponent(m[1])); } catch {}
              }
            }
            const _qbitAllTrackers = _qbitTrackers.length ? _qbitTrackers : EXTRA_TRACKERS;
            const sources = _qbitAllTrackers.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);
            if (!resolved.infoHash) return qbitStream;

            const p2pStream = {
              name,
              description: [description, matchedFile?.name ? `📂 ${matchedFile.name}` : ""].filter(Boolean).join("\n"),
              infoHash: resolved.infoHash,
              sources,
              _sourceType: "p2p",
              behaviorHints: {
                filename:   matchedFile?.name || r.Title,
                videoSize:  matchedFile?.size || undefined,
                bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
              },
            };
            if (matchedFile?.idx != null) p2pStream.fileIdx = matchedFile.idx;
            return [qbitStream, p2pStream];
          }

          if (isPrivateTracker && !r.MagnetUri && !prefs.enableP2P) return null;

          if (prefs.enableP2P !== false && !isDebridMode && !prefs.stConfig) {
            if (!resolved.infoHash) return null;

            let trackerList = [];
            if (resolved.buffer) {
              trackerList = extractTrackers(resolved.buffer);
            } else if (r.MagnetUri) {
              for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
                try { trackerList.push(decodeURIComponent(m[1])); } catch {}
              }
            }
            const allTrackers = trackerList.length ? trackerList : EXTRA_TRACKERS;
            const sources = allTrackers.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);

            const stream = {
              name,
              description: [description, matchedFile?.name ? `📂 ${matchedFile.name}` : ""].filter(Boolean).join("\n"),
              infoHash: resolved.infoHash,
              sources,
              _sourceType: "p2p",
              behaviorHints: {
                filename:   matchedFile?.name || r.Title,
                videoSize:  matchedFile?.size || undefined,
                bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
              },
            };

            if (matchedFile?.idx != null) stream.fileIdx = matchedFile.idx;

            return stream;
          }

          if (prefs.stConfig) {
            const sources = r.MagnetUri
              ? [r.MagnetUri]
              : (resolved.infoHash ? [buildMagnet(resolved.infoHash, null, r.Title)] : []);
            if (!sources.length) return null;
            
            const storeCodeMap = { torbox: "TB", realdebrid: "RD" };
            const desc = [description, matchedFile?.name ? `📂 ${matchedFile.name}` : ""].filter(Boolean).join("\n");
            const bh   = { filename: matchedFile?.name || r.Title, videoSize: matchedFile?.size, bingeGroup: `prowjack|${resolved.infoHash}`, notWebReady: true };
            return prefs.stConfig.stores.map(s => {
              const tag = storeCodeMap[s.c] || s.c.toUpperCase();
              return { name: `${name.split("\n")[0]}\n⬇️ ${resLabel || "Links"} [${tag}]`, description: desc, url: sources[0], _sourceType: "debrid", behaviorHints: bh };
            });
          }

          return null;
        } catch { return null; }
      })
    );

    const allStreams = resolvedAll.flat(2).filter(Boolean);

    const pendingScrap = results._scrapStreams || [];
    if (pendingScrap.length) {
      const filteredScrap = prefs.onlyDubbed && priorityLang
        ? pendingScrap.filter(s => {
            if (prefs.keywordBoost && matchesKeywordBoost(s._title, prefs.keywordBoost)) return true;
            const langs = getLangs(s._title, parsed.isAnime);
            return langs.length === 0 || langs.some(l => l.code === priorityLang);
          })
        : pendingScrap;
      const scrapSlots = Math.ceil(maxOut / 2);
      const scrapToAdd = filteredScrap.slice(0, scrapSlots);
      if (scrapToAdd.length) {
        scrapToAdd.forEach(s => { s._originalScore = 0; });
        console.log(`[SCRAP] ${scrapToAdd.length}/${pendingScrap.length} streams de ${ENV.scrapManifests.length} addon(s) externo(s)`);
        allStreams.push(...scrapToAdd);
      }
    }

    resolvedAll.forEach((streamOrArr, i) => {
      const r = dedupedWithHashes[i];
      if (!r) return;
      const items = Array.isArray(streamOrArr) ? streamOrArr.flat() : [streamOrArr];
      for (const s of items) {
        if (!s) continue;
        s._originalScore = r._originalScore || 0;
        s._title   = r.Title   || "";
        s._seeders = r.Seeders || 0;
        s._sizeGb  = (r.Size   || 0) / 1e9;
      }
    });

    const dedupedStreams = (() => {
      const out = [];
      const seenQbit = new Set();
      const scrapHashes = new Set(allStreams.filter(s => s._scrapSource && s.infoHash).map(s => s.infoHash.toLowerCase()));
      const scrapSizes  = allStreams.filter(s => s._scrapSource && (s._sizeBytes > 0)).map(s => s._sizeBytes);
      const jackettHashes = new Set(allStreams.filter(s => !s._scrapSource && s.infoHash).map(s => s.infoHash.toLowerCase()));
      const isSimilarSize = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.05;
      for (const s of allStreams) {
        if (s._scrapSource && s.infoHash && jackettHashes.has(s.infoHash.toLowerCase())) {
          s._cached = true;
        }
        if (!s._scrapSource) {
          const hash = s.infoHash?.toLowerCase();
          const size = s.behaviorHints?.videoSize || s._sizeBytes || 0;
          if (hash && scrapHashes.has(hash)) continue;
          if (size > 0 && scrapSizes.some(ss => isSimilarSize(ss, size))) continue;
        }
        const isQbit = s?._sourceType === "http" && typeof s.url === "string" && s.url.includes("/qbit/");
        if (isQbit) {
          const key = `${s.behaviorHints?.bingeGroup || ""}|${s.behaviorHints?.filename || ""}`;
          if (seenQbit.has(key)) continue;
          seenQbit.add(key);
        }
        out.push(s);
      }
      return out;
    })();

    const _sourceRank = (s) => {
      if (s?._sourceType === "debrid") return 0;
      if (s?._sourceType === "http")   return 1;
      if (s?._sourceType === "p2p")    return 2;
      return 3;
    };

    const _langScore = (s) => {
      const t    = s._title || "";
      const langs = getLangs(t, parsed.isAnime);
      if (priorityLang && langs.some(l => l.code === priorityLang)) return 3;
      if (prefs.keywordBoost && matchesKeywordBoost(t, prefs.keywordBoost)) return 2;
      if (/(multi|dual)[-.\\s]?(audio)?/i.test(t)) return 1;
      if (s._scrapSource && langs.length === 0) return 1;
      return 0;
    };
    const _resScore  = (s) => { const r = first(RESOLUTION, s._title || ""); return r ? r.score  : 0; };
    const _qualScore = (s) => { const q = first(QUALITY,    s._title || ""); return q ? q.score  : 0; };

    dedupedStreams.sort((a, b) => {
      const dsr = _sourceRank(a) - _sourceRank(b); if (dsr !== 0) return dsr;
      const ca = a._cached ? 1 : 0, cb = b._cached ? 1 : 0;
      if (ca !== cb) return cb - ca;
      const dl = _langScore(b) - _langScore(a); if (dl !== 0) return dl;
      const dr = _resScore(b)  - _resScore(a);  if (dr !== 0) return dr;
      const dq = _qualScore(b) - _qualScore(a); if (dq !== 0) return dq;
      const ds = (b._seeders || 0) - (a._seeders || 0); if (ds !== 0) return ds;
      return Math.abs((a._sizeGb || 0) - 10) - Math.abs((b._sizeGb || 0) - 10);
    });

    const finalStreams = dedupedStreams.slice(0, maxOut);
    if (dedupedStreams.length > 0) {
      const top = dedupedStreams.slice(0, Math.min(5, dedupedStreams.length));
      console.log(`[ORDEM] top${top.length}: ` + top.map(s => `[cache=${s._cached?1:0} lang=${_langScore(s)} res=${_resScore(s).toFixed(1)}] ${(s._title||s.name||"").slice(0,50)}`).join(" | "));
    }
    finalStreams.forEach(s => {
      delete s._cached;
      delete s._originalScore;
      delete s._title;
      delete s._seeders;
      delete s._sizeGb;
      delete s.indexer; 
    });

    if (isDebridMode) {
      const cached = finalStreams.filter(s => s.url && !s.url.includes('/debrid-add/')).length;
      const queued = finalStreams.filter(s => s.url &&  s.url.includes('/debrid-add/')).length;
      console.log(`[DEBRID] Streams listados: ${cached} ⚡️ cached + ${queued} ⬇️ on-demand`);
    } else {
      console.log(`Magnets listados: Enviando ${finalStreams.length} torrents!`);
    }
    console.log(`=========================================\n`);
    if (finalStreams.length > 0) {
      rc.set(streamCacheKey, JSON.stringify(finalStreams), 10800).catch(() => {});
    }
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro no processamento: ${err.message}`);
    res.json({ streams: [] });
  }
});

app.listen(ENV.port, () => {
  console.log(`ProwJack v3.11.0 -> http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
  console.log(`   qBittorrent: ${isQbitConfigured() ? "ativo" : "desativado"}`);
  startRssPoller(ENV.jackettUrl, ENV.apiKey, rc, redis);
});
