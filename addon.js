"use strict";
const crypto  = require("crypto");
const express = require("express");
const axios   = require("axios");
const Redis   = require("ioredis");
const path    = require("path");
const fs      = require("fs");
const { resolveDebridStream, buildMagnet } = require("./debrid");
const {
  isConfigured: isQbitConfigured,
  setCredentials: setQbitCredentials,
  ensureTorrentReady,
  waitForBuffer: waitForQbitBuffer,
  getPlayableLocalFile,
  streamTorrentFile,
} = require("./providers/qbittorrent");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (_, res) => res.sendStatus(200));
// ─────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────
const ENV = {
  jackettUrl:     (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:         (process.env.JACKETT_API_KEY || "").trim(),
  port:           process.env.PORT || 7014,
  redisUrl:       process.env.REDIS_URL || "redis://localhost:6379",
  stremthruUrl:   (process.env.STREMTHRU_URL  || "").trim(),
  stremthruKey:   (process.env.STREMTHRU_API_KEY || "").trim(),
  zileanUrl:      (process.env.ZILEAN_URL || "").trim(),
  zileanKey:      (process.env.ZILEAN_API_KEY || "").trim(),
  bitmagnetUrl:   (process.env.BITMAGNET_URL || "").trim(),
  bitmagnetKey:   (process.env.BITMAGNET_API_KEY || "").trim(),
  addonPublicUrl: (process.env.ADDON_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
};
// ─────────────────────────────────────────────────────────
// REDIS
// ─────────────────────────────────────────────────────────
let redis = null;
const memoryStore = new Map();
try {
  redis = new Redis(ENV.redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  redis.on("error", () => {});
} catch {}

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
const CACHE_VERSION = "v11-stremthru-qbit";

function getPublicBase(req) {
  if (ENV.addonPublicUrl) return ENV.addonPublicUrl;
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
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

function getStremThruBase(url) {
  const u = url || ENV.stremthruUrl;
  if (!u) return null;
  const match = u.match(/^(https?:\/\/[^/]+)/);
  return match ? match[1] : null;
}

const STREMTHRU_STORE_MAP = {
  realdebrid: "realdebrid",
  torbox: "torbox",
  alldebrid: "alldebrid",
  premiumize: "premiumize",
  debridlink: "debridlink",
};
// ─────────────────────────────────────────────────────────
// INDEXERS (ISOLAMENTO DE ANIME)
// ─────────────────────────────────────────────────────────
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
async function getCachedIndexers() {
  if (_ixCache && Date.now() - _ixCacheAt < 300_000) return _ixCache;
  try {
    _ixCache   = await jackettFetchIndexers();
    _ixCacheAt = Date.now();
  } catch {
    _ixCache = _ixCache || [];
  }
  return _ixCache;
}
async function resolveSearchIndexers(prefs, isAnime) {
  const selected = (Array.isArray(prefs.indexers) ? prefs.indexers : []).filter(Boolean);
  const useAll   = !selected.length || selected.includes("all");
  const allList  = await getCachedIndexers();
  const pool     = useAll ? allList.map(ix => ix.id) : selected;
  if (isAnime) {
    const animePool = pool.filter(id => isAnimeOnly(id));
    if (animePool.length > 0) return animePool;
    return pool;
  }
  const generalPool = pool.filter(id => !isAnimeOnly(id));
  return generalPool.length > 0 ? generalPool : pool;
}
// ─────────────────────────────────────────────────────────
// RATE LIMIT
// ─────────────────────────────────────────────────────────
async function isRateLimited(indexer) {
  return !!(await rc.get(`rl:${indexer}`));
}
async function setRateLimit(indexer, retryAfterHeader) {
  const parsed = parseInt(retryAfterHeader || "", 10);
  const ttl    = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3600) : 90;
  await rc.set(`rl:${indexer}`, "1", ttl);
}
// ─────────────────────────────────────────────────────────
// CONFIG (Base64URL)
// ─────────────────────────────────────────────────────────
function decodeUserCfg(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch { return null; }
}
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
    debrid:          false,
    debridConfig:    null,
  };
}
function resolvePrefs(encoded) {
  const u = encoded ? (decodeUserCfg(encoded) || {}) : {};
  const m = { ...defaultPrefs(), ...u };
  if (!Array.isArray(m.indexers) || !m.indexers.length) m.indexers = ["all"];
  if (m.priorityLang === undefined) m.priorityLang = "pt-br";
  if (m.debridConfig && (m.debridConfig.torboxKey || m.debridConfig.rdKey)) {
    m.debrid = true;
  }
  // Migração: normalizar addonName — remover PRO e tags de serviço (ficam no name do stream)
  if (m.addonName) m.addonName = m.addonName.replace(/\s*\[(TB\+RD|TB|RD|QB|PRO)\]/gi, "").replace(/\bPRO\b/g, "").trim();
  if (!m.addonName) m.addonName = "ProwJack";
  return m;
}
// ─────────────────────────────────────────────────────────
// PARSERS E DICIONÁRIOS
// ─────────────────────────────────────────────────────────
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
const first    = (map, t) => map.find(e => e.re.test(t));
const matchAll = (map, t) => map.filter(e => e.re.test(t));
const uniq     = arr => [...new Set(arr.filter(Boolean))];
const normTitle = s => (s || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
function qp(extra = {}) {
  const p = { ...extra };
  if (ENV.apiKey) p.apikey = ENV.apiKey;
  return p;
}
// ─────────────────────────────────────────────────────────
// DETECÇÃO DE IDIOMA E SCORE
// ─────────────────────────────────────────────────────────
function getLangs(title, isAnime) {
  const langs  = matchAll(LANG, title);
  const isDual = /(dual)[-.\\s]?(audio|2\.1|5\.1)?/i.test(title);
  if (isDual && !isAnime && !langs.some(l => l.code === "pt-br")) {
    langs.push({ code: "pt-br", emoji: "🇧🇷", label: "PT-BR" });
  }
  return langs;
}

function score(r, weights = {}, isAnime = false, priorityLang = "") {
  const w = { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5, ...weights };
  const t = r.Title || "";
  let s   = 0;

  const langs      = getLangs(t, isAnime);
  const hasPriority = priorityLang
    ? langs.some(l => l.code === priorityLang)
    : false;
  const isMulti    = /(multi)[-.\\s]?(audio)?/i.test(t);
  const isDualAnim = isAnime && /(dual)[-.\\s]?(audio)?/i.test(t);

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
    .replace(/[^a-z0-9\s]/g, " " )
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
    const aliasSet = new Set(aliasTokens);
    const matched  = aliasTokens.filter(tok => titleTokens.includes(tok)).length;
    const coverage = matched / aliasTokens.length;
    const density  = matched / Math.max(titleTokens.length, aliasTokens.length);
    const phraseHit = aliasText.length >= 5 && titleText.includes(aliasText);
    const exactShortHit = aliasTokens.length === 1 && aliasTokens[0].length <= 3
      ? new RegExp(`(^|[^a-z0-9])${escapedWordRegex(aliasTokens[0])}([^a-z0-9]|$)`, "i").test(String(title || ""))
      : false;
    if (!phraseHit && !exactShortHit) {
      if (aliasTokens.length <= 2 && matched < aliasTokens.length) continue;
      if (aliasTokens.length === 3 && matched < 2) continue;
    }
    let sc      = coverage * 0.8 + density * 0.2;
    if (aliasTokens.length >= 2 && matched >= aliasTokens.length - 1) sc += 0.15;
    if (titleTokens.some(tok => aliasSet.has(tok))) sc += 0.05;
    if (phraseHit) sc += 0.25;
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
  if (/^\d+$/.test(raw)) return `tt${raw}`;
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
  const sRaw = parseInt(season, 10);
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
function animeEpisodeMatches(title, ep) { return animeEpisodeMatchRank(title, ep) > 0; }

function normalizeForDedupe(str) {
  if (!str) return null;
  return str
    .replace(/[\[\(][^\]\)]*[\]\)]/g, '')
    .replace(/⚡ |✅ |💾|🇧🇷|🔍|📡|🎬|🎥|📺|🎞️|🎧|🗣️|📦|🌱|🏷️|⚠️|💿|🌐|🖥️|📼|📀/g, '')
    .replace(/\b(dual|dub|leg|pt\.?br|portuguese|4k|1080p|720p|480p|remux|bluray|webrip|web\.dl|hdtv|hdrip|brrip|dvdrip|hevc|x264|x265|aac|ac3|10bit)\b/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function dedupeResults(results) {
  const seenHash = new Set(), seenTitleSize = new Set(), deduped = [];
  for (const r of results) {
    const hash = r.InfoHash ? r.InfoHash.toLowerCase() : null;
    if (hash) {
      if (seenHash.has(hash)) continue;
      seenHash.add(hash);
      deduped.push(r);
    } else {
      const titleKey = `${(r.Title || "").toLowerCase().trim()}|${r.Size || 0}`;
      if (seenTitleSize.has(titleKey)) continue;
      seenTitleSize.add(titleKey);
      deduped.push(r);
    }
  }
  return deduped;
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
  const s   = buf.toString("latin1");
  const pos = s.indexOf("4:info");
  if (pos === -1) return null;
  let i = pos + 6, depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if      (c === "d" || c === "l") { depth++; i++; }
    else if (c === "e")              { depth--; i++; if (depth === 0) break; }
    else if (c === "i")              { i = s.indexOf("e", i + 1) + 1; }
    else if (c >= "0" && c <= "9")  {
      const colon = s.indexOf(":", i);
      if (colon === -1) break;
      i = colon + 1 + parseInt(s.slice(i, colon), 10);
    } else i++;
  }
  return depth === 0 ? buf.slice(start, i) : null;
}

function decodeBencode(buf) {
  let i = 0;
  const parse = () => {
    const c = String.fromCharCode(buf[i]);
    if (c === "i") {
      const end = buf.indexOf(0x65, i + 1);
      const num = parseInt(buf.toString("utf8", i + 1, end), 10);
      i = end + 1;
      return num;
    }
    if (c === "l") {
      i++;
      const out = [];
      while (buf[i] !== 0x65) out.push(parse());
      i++;
      return out;
    }
    if (c === "d") {
      i++;
      const out = {};
      while (buf[i] !== 0x65) {
        const key = parse();
        out[String(key)] = parse();
      }
      i++;
      return out;
    }
    let colon = i;
    while (buf[colon] !== 0x3a) colon++;
    const len = parseInt(buf.toString("utf8", i, colon), 10);
    const start = colon + 1;
    const end = start + len;
    const out = buf.toString("utf8", start, end);
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
  } catch {}
  return [];
}

function pickEpisodeFile(files, season, episode, isAnime) {
  if (!Array.isArray(files) || !files.length || episode == null) return null;
  const scored = files.map(file => {
    const name = file.name || "";
    const rank = isAnime
      ? animeEpisodeMatchRank(name, episode)
      : episodeMatchRank(name, season, episode);
    const videoBonus = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(name) ? 5 : 0;
    return { ...file, rank, total: rank * 1000 + videoBonus + Math.min(file.size || 0, 50 * 1e9) / 1e9 };
  }).filter(file => file.rank > 0);

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

// ─────────────────────────────────────────────────────────
// RESOLVE INFO HASH (COM SUPORTE OBRIGATÓRIO AO .TORRENT)
// ─────────────────────────────────────────────────────────
async function resolveInfoHash(r) {
  let fallbackHash = r.InfoHash ? r.InfoHash.toLowerCase() : null;
  let magnetHash   = r.MagnetUri ? extractInfoHash(r.MagnetUri) : null;
  const httpLink   = (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null;

  if (r.MagnetUri && magnetHash && !httpLink) {
    return { infoHash: magnetHash, files: null, buffer: null };
  }

  if (httpLink) {
    try {
      const res = await axios.get(httpLink, {
        timeout: 10000, maxRedirects: 10, responseType: "arraybuffer",
        maxContentLength: 8 * 1024 * 1024, validateStatus: s => s < 400,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      const finalUrl = res.request?.res?.responseUrl || "";
      if (finalUrl.startsWith("magnet:")) {
        const h = extractInfoHash(finalUrl);
        return h ? { infoHash: h, files: null, buffer: null } : null;
      }
      const buf = Buffer.from(res.data);
      const bodyStr = buf.toString("utf8", 0, Math.min(buf.length, 200));
      if (bodyStr.trimStart().startsWith("magnet:")) {
        const h = extractInfoHash(bodyStr.trim());
        return h ? { infoHash: h, files: null, buffer: null } : null;
      }
      if (buf[0] === 0x64) { // Assinatura de um dicionário bencode (d)
        const infoBuf = extractInfoBuf(buf);
        if (infoBuf) {
          const realHash = crypto.createHash("sha1").update(infoBuf).digest("hex");
          return {
            infoHash: realHash, // Hash verdadeiro!
            files: extractTorrentFiles(buf),
            buffer: buf, // Arquivo guardado para upload no Debrid
          };
        }
      }
    } catch {}
  }

  // Fallback para o InfoHash do Jackett se o download falhar
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

// ─────────────────────────────────────────────────────────
// FORMATTER
// ─────────────────────────────────────────────────────────
function formatStream(r, indexerName, isAnime = false, prefs = {}, showSeeds = true) {
  const t      = r.Title || "";
  const res    = first(RESOLUTION, t);
  const qual   = first(QUALITY, t);
  const codec  = first(CODEC, t);
  const audios = matchAll(AUDIO, t);
  const vis    = matchAll(VISUAL, t);
  const langs  = getLangs(t, isAnime);
  const group  = extractGroup(t);
  const size   = fmtBytes(r.Size);
  const seeds  = r.Seeders || 0;
  const cleanIndexer = renameIndexer(indexerName);
  const addonName    = prefs.addonName || "ProwJack PRO";
  const resLabel     = res ? res.label : "Desconhecida";
  const langDisplay  = [];
  if (langs.length) langDisplay.push(langs.map(l => `${l.emoji} ${l.label}`).join(" / "));
  else langDisplay.push("🌐 Original");
  const isMulti = /(multi|dual)[-.\\s]?(audio)?/i.test(t);
  if      (isMulti && isAnime)                              langDisplay.push("🎧 Multi/Dual-Audio");
  else if (isMulti && !langs.some(l => l.code === "pt-br")) langDisplay.push("🎧 Multi");
  const p2pLabel = prefs.debrid ? "" : "⚠️ P2P";
  const langStr  = langDisplay.join(" | ");
  const desc = [
    [qual ? `🎥 ${qual.label}` : "", vis.length ? `📺 ${vis.map(v=>v.label).join(" | ")}` : "", codec ? `🎞️ ${codec.label}` : "", langStr].filter(Boolean).join("  "),
    [audios.length ? `🎧 ${audios.map(a=>a.label).join(" | ")}` : ""].filter(Boolean).join("  "),
    [size ? `📦 ${size}` : "", showSeeds && seeds > 0 ? `🌱 ${seeds} seeds` : ""].filter(Boolean).join("  "),
    [`📡 ${cleanIndexer}`, group ? `🏷️ ${group}` : ""].filter(Boolean).join("  "),
    p2pLabel,
  ].filter(Boolean).join("\n");
  return { name: `${addonName}\n${resLabel}`, description: desc.trim(), resLabel };
}
// ─────────────────────────────────────────────────────────
// JACKETT + SEARCH
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// TORZNAB CACHE SOURCES (StremThru, Zilean, Bitmagnet)
// Fontes externas que indexam conteúdo já cacheado nos debrids.
// Hashes encontrados aqui são marcados como cached mesmo sem confirmação da API do debrid.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTorznabHash(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(s)) return s;
  if (/^[a-z2-7]{32}$/.test(s)) return base32ToHex(s) || null;
  return null;
}

async function fetchTorznabHashes(url, apiKey, paramsList) {
  const allHashes = new Set();
  for (const params of paramsList) {
    if (apiKey) params.set("apikey", apiKey);
    try {
      const res = await axios.get(`${url}?${params.toString()}`, { timeout: 8000, validateStatus: s => s < 500 });
      if (res.status >= 500) break;
      if (!res.data) continue;
      const xml = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      for (const m of xml.matchAll(/name="infohash"\s+value="([^"]+)"/gi)) {
        const h = normalizeTorznabHash(m[1]); if (h) allHashes.add(h);
      }
      for (const m of xml.matchAll(/xt=urn:btih:([a-zA-Z0-9]{32,40})/gi)) {
        const h = normalizeTorznabHash(m[1]); if (h) allHashes.add(h);
      }
    } catch {}
  }
  return [...allHashes];
}

async function searchCacheSources({ q, imdbId, type }, prefs) {
  const stUrl = prefs?.stremthru?.url || ENV.stremthruUrl;
  const stKey = prefs?.stremthru?.key || ENV.stremthruKey;
  const sources = [
    { name: "stremthru", url: stUrl,           key: stKey            },
    { name: "zilean",    url: ENV.zileanUrl,    key: ENV.zileanKey    },
    { name: "bitmagnet", url: ENV.bitmagnetUrl, key: ENV.bitmagnetKey },
  ].filter(s => s.url);

  if (!sources.length) return new Set();

  const isMovie  = !type || type === "movie";
  const isSeries = type === "series";

  const results = await Promise.allSettled(sources.map(async ({ name, url, key }) => {
    const paramsList = [];
    const cleanImdb = imdbId ? imdbId.replace("tt", "") : null;

    if (name === "zilean") {
      if (cleanImdb) {
        if (isMovie)  paramsList.push(new URLSearchParams({ t: "movie",    imdbid: cleanImdb }));
        if (isSeries) paramsList.push(new URLSearchParams({ t: "tvsearch", imdbid: cleanImdb }));
        paramsList.push(new URLSearchParams({ t: "search", imdbid: cleanImdb }));
      }
      if (q) paramsList.push(new URLSearchParams({ t: "search", q }));
    } else if (name === "stremthru") {
      if (cleanImdb) {
        if (isMovie)  paramsList.push(new URLSearchParams({ t: "movie",    imdbid: cleanImdb, cat: "2000" }));
        if (isSeries) paramsList.push(new URLSearchParams({ t: "tvsearch", imdbid: cleanImdb, cat: "5000" }));
      }
      if (q) paramsList.push(new URLSearchParams({ t: "search", q }));
    } else {
      if (cleanImdb) paramsList.push(new URLSearchParams({ t: "search", imdbid: cleanImdb }));
      if (q)         paramsList.push(new URLSearchParams({ t: "search", q }));
    }

    const t0 = Date.now();
    const hashes = await fetchTorznabHashes(url, key, paramsList);
    console.log(`[TORZNAB:${name.toUpperCase()}] ${Date.now() - t0}ms | hashes=${hashes.length}`);
    return hashes;
  }));

  const all = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  return new Set(all);
}

async function checkCacheViaStremThru(hashes, store, apiKey, stremthruUrl) {
  const base = getStremThruBase(stremthruUrl);
  const storeName = STREMTHRU_STORE_MAP[store] || store;
  if (!base || !storeName || !apiKey || !Array.isArray(hashes) || !hashes.length) return new Set();

  const normalized = [...new Set(hashes.map(h => String(h || "").toLowerCase()).filter(h => /^[0-9a-f]{40}$/.test(h)))];
  if (!normalized.length) return new Set();

  const cachedHashes = new Set();
  const pending = [];

  for (const hash of normalized) {
    const cached = await rc.get(`stremthru:${storeName}:${hash}`);
    if (cached === "1") cachedHashes.add(hash);
    else if (cached !== "0") pending.push(hash);
  }

  // Determina o header de autenticação correto:
  // Se apiKey contém ":" é user:pass (Basic), senão é Bearer token
  const authHeader = apiKey.includes(":")
    ? `Basic ${Buffer.from(apiKey).toString("base64")}`
    : `Bearer ${apiKey}`;

  const CHUNK = 500;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    try {
      const url = `${base}/v0/store/magnets/check`;
      const body = JSON.stringify({ hashes: chunk });
      let res = null;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-StremThru-Store-Name": storeName,
            "Authorization": authHeader,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
      } catch { continue; }

      if (!res.ok) {
        // Tenta endpoint alternativo GET com query params
        const urlAlt = `${base}/v0/store/magnets/check?magnet=${chunk.map(h => `magnet:?xt=urn:btih:${h}`).join("&magnet=")}`;
        let res2 = null;
        try {
          res2 = await fetch(urlAlt, {
            headers: {
              "X-StremThru-Store-Name": storeName,
              "Authorization": authHeader,
            },
            signal: AbortSignal.timeout(10000),
          });
        } catch { continue; }
        if (!res2?.ok) continue;
        const data2 = await res2.json().catch(() => null);
        if (!data2) continue;
        const chunkHits = new Set();
        for (const item of (data2?.data?.items || [])) {
          const h = String(item?.hash || "").toLowerCase();
          if (item?.status === "cached" && /^[0-9a-f]{40}$/.test(h)) { chunkHits.add(h); cachedHashes.add(h); }
        }
        await Promise.allSettled(chunk.map(h => rc.set(`stremthru:${storeName}:${h}`, chunkHits.has(h) ? "1" : "0", 1800)));
        continue;
      }

      const data = await res.json().catch(() => null);
      if (!data) continue;
      const chunkHits = new Set();
      for (const item of (data?.data?.items || [])) {
        const h = String(item?.hash || "").toLowerCase();
        if (item?.status === "cached" && /^[0-9a-f]{40}$/.test(h)) {
          chunkHits.add(h);
          cachedHashes.add(h);
        }
      }

      await Promise.allSettled(
        chunk.map(h => rc.set(`stremthru:${storeName}:${h}`, chunkHits.has(h) ? "1" : "0", 1800))
      );
    } catch { /* silencioso */ }
  }

  console.log(`[StremThruCache] store=${storeName} | ${cachedHashes.size} cached de ${normalized.length} hashes`);
  return cachedHashes;
}

async function jackettFetchIndexers(url, key) {
  const jUrl = (url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey = key || ENV.apiKey;
  // Jackett: t=indexers retorna XML com lista de indexers sem executar busca
  try {
    const res = await axios.get(`${jUrl}/api/v2.0/indexers/all/results/torznab/api`, {
      params: qp({ t: "indexers", configured: "true" }), timeout: 8000,
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
  // Fallback Prowlarr
  try {
    const res = await axios.get(`${jUrl}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      return res.data.map(ix => ({ id: String(ix.id || "").trim(), name: String(ix.name || "").trim() })).filter(ix => ix.id);
    }
  } catch {}
  return [];
}

function decodeXmlEntities(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
    for (const m of item.matchAll(/<(?:torznab:)?attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?/gi))
      attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2]);

    const enclosure = item.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*length="([^"]*)"/i);
    const magnetUri = attrs.magneturl || null;
    const link = magnetUri ? magnetUri : (xmlTagValue(item, "link") || enclosure?.[1] || null);
    const size = attrs.size ? parseInt(attrs.size, 10) : (enclosure?.[2] ? parseInt(enclosure[2], 10) : 0);
    const seeders = attrs.seeders ? parseInt(attrs.seeders, 10) : 0;

    return {
      Title: xmlTagValue(item, "title") || "",
      Guid: xmlTagValue(item, "guid") || link || magnetUri || "",
      Link: link,
      MagnetUri: magnetUri,
      Size: Number.isFinite(size) ? size : 0,
      Seeders: Number.isFinite(seeders) ? seeders : 0,
      InfoHash: attrs.infohash ? attrs.infohash.toLowerCase() : null,
      Tracker: indexer,
      TrackerId: indexer,
      ImdbId: normalizeImdbId(attrs.imdbid || attrs.imdb || attrs.imdbidnum || attrs.imdbnum),
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
  return (Array.isArray(items) ? items : []).map(item => ({
    Title: item.title || "",
    Guid: item.guid || item.downloadUrl || item.magnetUrl || "",
    Link: item.downloadUrl || item.magnetUrl || (item.guid?.startsWith("http") ? item.guid : null) || null,
    MagnetUri: item.magnetUrl && item.magnetUrl.startsWith("magnet:") ? item.magnetUrl : null,
    Size: Number(item.size) || 0,
    Seeders: Number(item.seeders) || 0,
    InfoHash: normalizeProwlarrInfoHash(item.infoHash),
    Tracker: item.indexer || indexer,
    TrackerId: String(item.indexerId || indexer || "").trim(),
    ImdbId: normalizeImdbId(item.imdbId),
    PublishDate: item.publishDate || null,
    _structuredMatch: false,
  })).filter(r => r.Title && (r.Link || r.MagnetUri || r.Guid));
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
  const res = await axios.get(
    `${jUrl}/api/v2.0/indexers/${indexer}/results`,
    { params: qp({ Query: query }), timeout, validateStatus: () => true }
  );
  if (res.status === 404) return prowlarrSearch(query, indexer, 50, jUrl, jKey);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return (res.data?.Results || []).map(r => ({ ...r, _structuredMatch: false }));
}

async function jackettStructuredSearch(search, indexer, timeout, jUrl, jKey) {
  if (!search?.mode || !search?.imdbId) return [];
  const params = { apikey: jKey, t: search.mode, imdbid: search.imdbId, q: search.title };
  if (search.year)   params.year = search.year;
  if (search.season != null) params.season = search.season;
  if (search.episode != null) params.ep = search.episode;

  const res = await axios.get(
    `${jUrl}/api/v2.0/indexers/${indexer}/results/torznab/api`,
    { params, timeout, responseType: "text", validateStatus: () => true }
  );
  if (res.status === 404) return [];
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return parseTorznabResults(String(res.data || ""), indexer);
}

async function jackettSearchOneIndexer(indexer, plan, timeout, fastTimeout, jUrl, jKey) {
  if (await isRateLimited(indexer)) return [];
  const t0 = Date.now();
  try {
    let results = [];
    if (plan.search && !plan.parsed?.isAnime) {
      try {
        results = await jackettStructuredSearch(plan.search, indexer, timeout, jUrl, jKey);
      } catch (err) {
        if (err.response?.status === 429) throw err;
      }
    }
    if (results.length === 0) {
      for (const query of plan.queries) {
        const textResults = await jackettTextSearch(query, indexer, timeout, jUrl, jKey);
        results.push(...textResults);
        if (results.length > 0) break;
      }
    }
    const ms = Date.now() - t0;
    await trackMetrics(indexer, ms, results.length, true);
    const mode = results.some(r => r._structuredMatch) ? "estruturado" : "texto";
    console.log(`  ${indexer}: ${results.length} resultados (${ms}ms, ${mode})`);
    return results;
  } catch (err) {
    const ms = Date.now() - t0;
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
  const jUrl = (prefs?.jackett?.url || ENV.jackettUrl).replace(/\/+$/, "");
  const jKey = prefs?.jackett?.key || ENV.apiKey;
  const queryList = uniq(Array.isArray(plan?.queries) ? plan.queries : [plan?.queries].filter(Boolean));
  const cacheKey  = `search:${CACHE_VERSION}:${Buffer.from(JSON.stringify({ queryList, search: plan?.search || null, parsed: plan?.parsed || null })).toString("base64")}:${indexers.join(",")}`;
  const cached    = await rc.get(cacheKey);
  if (cached) {
    console.log(`Cache HIT para buscas: ${JSON.stringify(queryList)}`);
    return JSON.parse(cached);
  }
  const FAST_TIMEOUT = (prefs?.slowThreshold > 0 ? prefs.slowThreshold : 12000);
  const SLOW_TIMEOUT = 50000;
  console.log(`Jackett iniciando busca: "${queryList[0] || plan?.search?.title || "sem titulo"}" em [${indexers.length} indexers]`);
  console.log(`Fase rapida: aguardando respostas... (${FAST_TIMEOUT}ms max)`);
  
  const fastFlat    = (await Promise.all(indexers.map(indexer => jackettSearchOneIndexer(indexer, plan, FAST_TIMEOUT, FAST_TIMEOUT, jUrl, jKey)))).flat();
  const fastDeduped = dedupeResults(fastFlat);
  console.log(`Conclusao da janela rapida: ${fastFlat.length} brutos -> ${fastDeduped.length} deduplicados`);
  
  if (fastDeduped.length === 0) return []; 
  
  setImmediate(async () => {
    try {
      const slowDeduped = dedupeResults((await Promise.all(indexers.map(indexer => jackettSearchOneIndexer(indexer, plan, SLOW_TIMEOUT, FAST_TIMEOUT, jUrl, jKey)))).flat());
      if (slowDeduped.length > fastDeduped.length) {
        console.log(`[Background] Cache atualizado: ${fastDeduped.length} -> ${slowDeduped.length}`);
        if (slowDeduped.length > 0) await rc.set(cacheKey, JSON.stringify(slowDeduped), 1800);
      } else {
        if (fastDeduped.length > 0) await rc.set(cacheKey, JSON.stringify(fastDeduped), 1800);
      }
    } catch {}
  });
  return fastDeduped;
}

// ─────────────────────────────────────────────────────────
// METADATA
// ─────────────────────────────────────────────────────────
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
      title   : meta?.name || imdbId,
      aliases : uniq([meta?.name, meta?.originalName, ...(meta?.aliases || [])]).map(normTitle),
      imdbId  : meta?.imdb_id || meta?.id || imdbId,
      year    : extractReleaseYear(meta?.year || meta?.releaseInfo || meta?.released || ""),
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
  if (id.startsWith("kitsu:")) {
    const parts = id.split(":");
    return {
      source : "kitsu",
      isAnime: true,
      kitsuId: parts[1],
      season : parts[2] ? parseInt(parts[2], 10) : null,
      episode: parts[3] ? parseInt(parts[3], 10) : null,
      type,
    };
  }
  if (type === "series" && id.includes(":")) {
    const [metaId, s, e] = id.split(":");
    return { source: "imdb", isAnime: false, metaId, season: parseInt(s, 10), episode: parseInt(e, 10), type };
  }
  return { source: "imdb", isAnime: false, metaId: id, season: null, episode: null, type };
}
// ─────────────────────────────────────────────────────────
// BUILD QUERIES
// ─────────────────────────────────────────────────────────
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
      imdbId : meta.imdbId, title  : meta.title, year   : meta.year, season : parsed.season, episode: parsed.episode,
    },
  };
}

// ─────────────────────────────────────────────────────────
// API E MANIFEST
// ─────────────────────────────────────────────────────────

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
    return res.json({ ok: false, error: "Provider desconhecido" });
  } catch (err) {
    const s = err.response?.status;
    return res.json({ ok: false, error: s === 401 ? "Key inválida (401)" : s === 403 ? "Acesso negado (403)" : err.message });
  }
});

app.get("/api/env",     async (_, res) => {
  let redisOk = false;
  try { await rc.ping(); redisOk = true; } catch {}
  res.json({ jackettUrl: ENV.jackettUrl, jackettKey: ENV.apiKey, qbitUrl: (process.env.QBIT_URL||"").replace(/\/+$/,""), qbitUser: process.env.QBIT_USER||"", stremthruUrl: ENV.stremthruUrl, stremthruKey: ENV.stremthruKey, redisUrl: ENV.redisUrl, redisOk, port: ENV.port, qbitEnabled: isQbitConfigured() });
});
app.get("/api/indexers", async (req, res) => {
  const url = (req.query.url || "").trim().replace(/\/+$/, "") || ENV.jackettUrl;
  const key = (req.query.key || "").trim() || ENV.apiKey;
  try   { const indexers = await jackettFetchIndexers(url, key); res.json({ ok: true, count: indexers.length, indexers }); }
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
    resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt", "kitsu:"],
    catalogs: [], behaviorHints: { configurable: true, configurationRequired: true, p2p: true },
  });
});
app.get("/configure", (_, res) => {
  const publicPath = path.join(__dirname, "public", "configure.html");
  const rootPath   = path.join(__dirname, "configure.html");
  if (fs.existsSync(publicPath))    res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.status(404).send("Arquivo configure.html nao encontrado.");
});
app.get("/", (_, res) => res.redirect("/configure"));
app.get("/:userConfig/manifest.json", (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);
  const types = [...new Set((prefs.categories || ["movie","series"]).map(c => c==="movies"?"movie":c==="anime"?"series":c))];
  const name  = prefs.addonName || "ProwJack PRO";
  const isDebridActive = prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);
  res.json({
    id: "org.prowjack.pro", version: "3.10.0", name,
    description: `Jackett Otimizado · Prioridade PT-BR`,
    resources: ["stream"], types, idPrefixes: ["tt", "kitsu:"], catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false, p2p: !isDebridActive },
  });
});

// ── ROTA DEBRID-ADD COM TRAVA REDIS (ANTI-SPAM) E DOWNLOAD DE .TORRENT ───
app.get("/:userConfig/debrid-add/:provider/:infoHash", async (req, res) => {
  const { provider, infoHash } = req.params;
  const magnet  = req.query.magnet;
  const linkUrl = req.query.link;
  const prefs   = resolvePrefs(req.params.userConfig);
  const config  = prefs.debridConfig;

  const lockKey  = `addlock:${provider}:${infoHash}`;
  const isLocked = await rc.get(lockKey);

  // Se já foi enfileirado, verifica se o RD terminou e redireciona
  if (isLocked) {
    if (provider.toLowerCase() === "realdebrid" && config?.rdKey) {
      const { rdFindExistingTorrent } = require("./debrid");
      const existing = await rdFindExistingTorrent(infoHash, config.rdKey);
      if (existing?.links?.length) {
        try {
          const unresRes = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link",
            `link=${encodeURIComponent(existing.links[0])}`,
            { headers: { Authorization: `Bearer ${config.rdKey}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 });
          if (unresRes.data?.download) {
            console.log(`  [ON-DEMAND] RD completo! Redirecionando ${infoHash}`);
            await rc.del(lockKey);
            return res.redirect(302, unresRes.data.download);
          }
        } catch {}
      }
    }
    console.log(`  [ON-DEMAND] Ainda baixando ${infoHash}`);
    return res.status(202).send("Download em andamento. Tente novamente em alguns minutos.");
  }

  await rc.set(lockKey, "1", 300); // trava por 5 min
  console.log(`\n=========================================`);
  console.log(`[DEBRID ON-DEMAND] Enfileirando ${infoHash} no ${provider}...`);

  if (config && (magnet || linkUrl)) {
    let torrentBuffer = null;
    if (linkUrl?.startsWith("http")) {
      try {
        const dl = await axios.get(linkUrl, { responseType: "arraybuffer", timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
        if (dl.data && Buffer.from(dl.data)[0] === 0x64) torrentBuffer = Buffer.from(dl.data);
      } catch(e) { console.log(`  [ON-DEMAND] Falha ao baixar .torrent: ${e.message}`); }
    }
    try {
      if (provider.toLowerCase() === "torbox") {
        const { torboxAddTorrent } = require("./debrid");
        await torboxAddTorrent(magnet, config.torboxKey, false, torrentBuffer);
      } else {
        const { rdAddTorrent } = require("./debrid");
        await rdAddTorrent(magnet, config.rdKey, torrentBuffer);
      }
      console.log(`[ON-DEMAND] Enfileirado com sucesso.`);
    } catch (e) { console.log(`[ON-DEMAND] Erro: ${e.message}`); }
  }
  console.log(`=========================================\n`);
  return res.status(202).send("Download enfileirado. Aguarde o download completar e clique novamente.");
});

app.get("/:userConfig/qbit/:jobToken", async (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);
  if (prefs.qbit) setQbitCredentials(prefs.qbit.url, prefs.qbit.user, prefs.qbit.pass);
  if (!isQbitConfigured()) return res.status(503).send("qBittorrent não configurado.");

  const job = await loadQbitJob(req.params.jobToken);
  if (!job?.infoHash) return res.status(404).send("Job expirado ou inválido.");

  const lockKey = `qbitlock:${job.infoHash}`;
  if (!(await rc.get(lockKey))) await rc.set(lockKey, "1", 90);

  try {
    const playable = await getPlayableLocalFile(job.infoHash, job.fileIdx, job.fileName);
    if (!playable) {
      let torrentBuffer = null;
      if (job.link && !job.link.startsWith("magnet:")) {
        try {
          const dl = await axios.get(job.link, {
            responseType: "arraybuffer", timeout: 15000, maxRedirects: 10,
            maxContentLength: 8 * 1024 * 1024, headers: { "User-Agent": "Mozilla/5.0" },
            validateStatus: s => s < 400,
          });
          if (dl.data && Buffer.from(dl.data)[0] === 0x64) torrentBuffer = Buffer.from(dl.data);
        } catch {}
      }
      await ensureTorrentReady(job.infoHash, {
        torrentBuffer, magnet: job.magnet, fileIdx: job.fileIdx, fileName: job.fileName,
      });
      await waitForQbitBuffer(job.infoHash, job.fileIdx, job.fileName);
    }
    await streamTorrentFile(req, res, job.infoHash, job.fileIdx, job.fileName);
  } catch (err) {
    console.log(`[qBit] Falha ao preparar ${job.infoHash}: ${err.message}`);
    if (!res.headersSent) res.status(503).send(`qBittorrent: ${err.message}`);
  }
});

app.get("/qbit/stream/:jobToken", async (req, res) => {
  if (!isQbitConfigured()) return res.status(503).json({ error: "qBittorrent não configurado" });
  const job = await loadQbitJob(req.params.jobToken);
  if (!job?.infoHash) return res.status(404).json({ error: "Job expirado ou inválido" });

  try {
    await streamTorrentFile(req, res, job.infoHash, job.fileIdx, job.fileName);
  } catch (err) {
    console.error("[qBit stream]", err.message);
    if (!res.headersSent) res.status(503).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// STREAMS
// ─────────────────────────────────────────────────────────
const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i;
app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs      = resolvePrefs(req.params.userConfig);
  if (prefs.qbit) setQbitCredentials(prefs.qbit.url, prefs.qbit.user, prefs.qbit.pass);
  const { type, id } = req.params;
  console.log(`\n=========================================`);
  console.log(`NOVA BUSCA: [${type}] ${id}`);

  const isDebridMode = prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);

  if (isDebridMode) {
    console.log(`[DEBRID] Modo ativo: ${prefs.debridConfig.mode.toUpperCase()} — P2P desabilitado`);
  }

  try {
    const { parsed, displayTitle, aliases = [], queries, episode, year, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);

    const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
    if (parsed.isAnime && !enabledCats.includes("anime")) return res.json({ streams: [] });
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) return res.json({ streams: [] });
    if (type === "movie" && !enabledCats.includes("movie")) return res.json({ streams: [] });

    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);
    const results  = await jackettSearch({ parsed, queries, search }, indexers, prefs);
    const priorityLang = prefs.priorityLang ?? "pt-br";

    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => !prefs.skipBadReleases || !BAD_RE.test(r.Title || ""))
      .filter(r => type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
      .filter(r => {
        if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
        if (type === "series") return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
        return true;
      })
      .filter(r => !prefs.onlyDubbed || !priorityLang || getLangs(r.Title || "", parsed.isAnime).some(l => l.code === priorityLang))
      .filter(r => {
        const resultImdbId = getResultImdbId(r);
        if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
          r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
          r._metaIdMatch = true; return true;
        }
        const sc = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const episodeRank = parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
        const minScore = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
        const finalScore = Math.max(sc, type === "series" ? relaxedScore * 0.8 : 0);
        r._titleMatchScore = finalScore;
        return finalScore >= minScore;
      })
      .filter(r => { if (type !== "movie" || !year) return true; const ry = extractReleaseYear(r.Title || ""); return !ry || Math.abs(ry - year) <= 1; })
      .map(r => {
        // Salva o score original puro antes de sofrer boost pelo cache
        r._originalScore = (((r._metaIdMatch ? 1 : 0) * 40000) + ((r._structuredMatch ? 1 : 0) * 20000) +
          (parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode)) * 10000 +
          (r._titleMatchScore || 0) * 1000 + score(r, prefs.weights, parsed.isAnime, priorityLang));
        return r;
      })
      .sort((a, b) => {
        if (!isDebridMode) return (b.Seeders || 0) - (a.Seeders || 0);
        return b._originalScore - a._originalScore;
      });

    // FIX: Ampliando o leque de busca para garantir que links do final da lista sejam checados e empurrados para cima
    const maxProcess = (prefs.maxResults || 20) * 3; 
    const topCandidates = candidates.slice(0, maxProcess);

    console.log(`Extraindo InfoHashes de ${topCandidates.length} candidatos promissores...`);
    
    const withHashes = [];
    const concurrency = 10;
    for (let i = 0; i < topCandidates.length; i += concurrency) {
      const chunk = topCandidates.slice(i, i + concurrency);
      const resolvedChunk = await Promise.all(
        chunk.map(async r => {
          const resolved = await resolveInfoHash(r);
          if (resolved?.infoHash) return { ...r, _resolved: resolved };
          return null;
        })
      );
      withHashes.push(...resolvedChunk.filter(Boolean));
    }

    let rdCacheMap = {};
    let tbCacheMap = {};

    if (isDebridMode && withHashes.length > 0) {
      const allHashes = [...new Set(withHashes.map(r => r._resolved.infoHash))];
      console.log(`[DEBRID] Verificando cache em lote para ${allHashes.length} hashes únicos...`);
      const { mode, torboxKey, rdKey } = prefs.debridConfig;
      const { rdBatchCheckCache, torboxBatchCheckCache } = require("./debrid");

      // Hashes de torrents privados (sem MagnetUri = tracker privado).
      // O TorBox pode adicioná-los automaticamente ao processar o checkcached.
      const privateHashes = new Set(
        withHashes
          .filter(r => !r.MagnetUri && r._resolved?.buffer)
          .map(r => r._resolved.infoHash)
      );
      if (privateHashes.size) console.log(`[DEBRID] ${privateHashes.size} hashes privados excluídos do TB checkcached`);

      // Mapa hash → buffer para torrents privados (usados no RD batch via PUT /addTorrent)
      const bufferMap = {};
      for (const r of withHashes) {
        if (r._resolved?.buffer) bufferMap[r._resolved.infoHash] = r._resolved.buffer;
      }

      const cacheQ = type === "series" && parsed.season != null && parsed.episode != null
        ? `${displayTitle} S${String(parsed.season).padStart(2,"0")}E${String(parsed.episode ?? episode).padStart(2,"0")}`
        : displayTitle;

      const [rdResult, tbResult, torznabHashes] = await Promise.all([
        (mode === "realdebrid" || mode === "dual") && rdKey
          ? rdBatchCheckCache(allHashes, rdKey, bufferMap)
          : Promise.resolve({}),
        (mode === "torbox" || mode === "dual") && torboxKey
          ? torboxBatchCheckCache(allHashes, torboxKey, privateHashes)
          : Promise.resolve({}),
        searchCacheSources({ q: cacheQ, imdbId: requestedImdbId, type }, prefs),
      ]);

      rdCacheMap = rdResult;
      tbCacheMap = tbResult;

      const nativeCached = new Set();
      for (const hash of allHashes) {
        if (rdCacheMap[hash]?.rd?.length > 0) nativeCached.add(hash);
        if (tbCacheMap[hash] && typeof tbCacheMap[hash] === "object" && tbCacheMap[hash] !== false) nativeCached.add(hash);
      }

      const stremThruCandidates = allHashes.filter(hash => !privateHashes.has(hash) && !nativeCached.has(hash));
      const stUrl = prefs?.stremthru?.url || ENV.stremthruUrl;
      const stremThruChecks = [
        (mode === "realdebrid" || mode === "dual") && rdKey
          ? checkCacheViaStremThru(stremThruCandidates, "realdebrid", rdKey, stUrl)
          : Promise.resolve(new Set()),
        (mode === "torbox" || mode === "dual") && torboxKey
          ? checkCacheViaStremThru(stremThruCandidates, "torbox", torboxKey, stUrl)
          : Promise.resolve(new Set()),
      ];
      const [stremThruRd, stremThruTb] = await Promise.all(stremThruChecks);
      const stremThruCached = new Set([...stremThruRd, ...stremThruTb]);

      const debridCached = new Set();
      const torznabCached = new Set();
      const stremThruConfirmed = new Set();

      // FIX: Marcar os hashes cacheados e reordenar a lista para que eles subam ao topo (Boost)
      withHashes.forEach(r => {
        r._isCached = false;
        const h = r._resolved.infoHash;
        if ((mode === "realdebrid" || mode === "dual") && rdCacheMap[h] && rdCacheMap[h].rd?.length > 0) {
          r._isCached = true; debridCached.add(h);
        }
        if ((mode === "torbox" || mode === "dual") && tbCacheMap[h] && typeof tbCacheMap[h] === 'object' && tbCacheMap[h] !== false) {
          r._isCached = true; debridCached.add(h);
        }
        if (!r._isCached && stremThruCached.has(h)) {
          r._isCached = true; stremThruConfirmed.add(h);
        }
        if (!r._isCached && torznabHashes.has(h)) {
          r._cacheCandidate = true;
          torznabCached.add(h);
        }
      });

      console.log(`[DEBRID] cached=${debridCached.size + stremThruConfirmed.size} (debrid=${debridCached.size} stremthru=${stremThruConfirmed.size} candidatos=${torznabCached.size}) uncached=${withHashes.filter(r => !r._isCached).length}`);

      // Ordenação: cache é prioridade máxima; dentro de cada grupo, ordena por idioma → resolução → qualidade → tamanho
      const sortMode = prefs.sortMode || "cache";
      const langScore = (r) => {
        const t = r.Title || "";
        const langs = getLangs(t, parsed.isAnime);
        if (priorityLang && langs.some(l => l.code === priorityLang)) return 3;
        if (/(multi)[-.\\s]?(audio)?/i.test(t)) return 2;
        if (langs.length > 0) return 1;
        return 0;
      };
      const resScore  = (r) => { const res  = first(RESOLUTION, r.Title || ""); return res  ? res.score  : 0; };
      const qualScore = (r) => { const qual = first(QUALITY,    r.Title || ""); return qual ? qual.score : 0; };
      const sizeScore = (r) => { const gb = (r.Size || 0) / 1e9; return gb > 0 ? Math.max(0, 10 - Math.abs(gb - 10)) : 0; };

      withHashes.sort((a, b) => {
        // Cache sempre primeiro independente do sortMode
        const ca = a._isCached ? 1 : 0, cb = b._isCached ? 1 : 0;
        if (ca !== cb) return cb - ca;
        // Dentro do grupo, aplica o sortMode escolhido pelo usuário
        if (sortMode === "resolution") {
          const dr = resScore(b) - resScore(a); if (dr !== 0) return dr;
          const dq = qualScore(b) - qualScore(a); if (dq !== 0) return dq;
        } else if (sortMode === "size") {
          const ds = sizeScore(b) - sizeScore(a); if (ds !== 0) return ds;
        } else if (sortMode === "seeders") {
          return (b.Seeders || 0) - (a.Seeders || 0);
        } else {
          // "cache" — dentro do grupo: idioma → resolução → qualidade → tamanho
          const dl = langScore(b) - langScore(a); if (dl !== 0) return dl;
          const dr = resScore(b)  - resScore(a);  if (dr !== 0) return dr;
          const dq = qualScore(b) - qualScore(a); if (dq !== 0) return dq;
          return sizeScore(b) - sizeScore(a);
        }
        return (b._originalScore || 0) - (a._originalScore || 0);
      });
    }

    // ── Resolução de streams finais ──────────────────────────────────────────
    const resolvedAll = await Promise.all(
      withHashes.map(async r => {
        try {
        const resolved = r._resolved;
        const indexerName = r.Tracker || r.TrackerId || "Unknown";
        const { name, description: descNoSeeds, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, false);
        const { description } = formatStream(r, indexerName, parsed.isAnime, prefs, true);
        const matchedFile = (type === "series" || parsed.isAnime)
          ? pickEpisodeFile(resolved.files, parsed.season, parsed.episode ?? episode, parsed.isAnime)
          : null;
        const magnet = buildMagnet(resolved.infoHash, r.MagnetUri, r.Title);
        const publicBase = getPublicBase(req);
        const localPlayable = isQbitConfigured()
          ? await getPlayableLocalFile(resolved.infoHash, matchedFile?.idx ?? null, matchedFile?.name || null).catch(() => null)
          : null;

        const buildQbitStream = async (label) => {
          const jobToken = await saveQbitJob({
            infoHash: resolved.infoHash,
            link: (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
            magnet,
            fileIdx: matchedFile?.idx ?? null,
            fileName: matchedFile?.name || null,
          });
          const qbitName = localPlayable
            ? `${prefs.addonName || "ProwJack PRO"}\n⚡️ ${resLabel || "Links"} [QB]`
            : `${prefs.addonName || "ProwJack PRO"}\n⬇️ ${resLabel || "Links"} [QB]`;
          return {
            name: qbitName,
            description: [description, matchedFile?.name ? `📂 ${matchedFile.name}` : ""].filter(Boolean).join("\n"),
            url: `${publicBase}/${req.params.userConfig}/qbit/${jobToken}`,
            _cached: !!localPlayable,
            behaviorHints: {
              filename: matchedFile?.name,
              videoSize: matchedFile?.size,
              bingeGroup: `prowjack|qbit|${resolved.infoHash}`,
              notWebReady: false,
            },
          };
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

          if (!debridData) return null;
          const resultsArray = debridData.multi ? debridData.multi : [debridData];
          
          return Promise.all(resultsArray.map(async resObj => {
            const addonName = prefs.addonName || "ProwJack PRO";
            const resLabelStr = resLabel || "Links";
            const isDual = prefs.debridConfig?.mode === "dual";
            const providerTag = resObj.provider === "TorBox" ? "[TB]" : "[RD]";

            if (resObj.url && !resObj.queued) {
              const debridFilename = resObj.filename || matchedFile?.name;
              const streamName = isDual
                ? `${addonName}\n⚡️ ${resLabelStr} ${providerTag}`
                : `${addonName}\n⚡️ ${resLabelStr}`;
              return {
                name: streamName,
                description: [descNoSeeds, debridFilename ? `📂 ${debridFilename}` : ""].filter(Boolean).join("\n"),
                url: resObj.url,
                _cached: true,
                behaviorHints: {
                  filename: debridFilename, videoSize: matchedFile?.size, bingeGroup: `prowjack|debrid|${resolved.infoHash}`, notWebReady: false,
                },
              };
            }

            if (resObj.queued) {
              const provider = resObj.provider || "Debrid";
              const hostUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
              const linkParam = r.Link ? `&link=${encodeURIComponent(r.Link)}` : "";
              const addUrl = `${hostUrl}/${req.params.userConfig}/debrid-add/${provider}/${resolved.infoHash}?magnet=${encodeURIComponent(magnet)}${linkParam}`;
              const streamName = isDual
                ? `${addonName}\n⬇️ ${resLabelStr} ${providerTag}`
                : `${addonName}\n⬇️ ${resLabelStr}`;

              const debridOption = {
                name: streamName,
                description: description,
                url: addUrl,
                _cached: false,
                behaviorHints: { notWebReady: true },
              };

              if (isQbitConfigured()) {
                const qbitOption = await buildQbitStream(localPlayable ? "💾" : "HTTP");
                return [debridOption, qbitOption];
              }

              return debridOption;
            }
            return null;
          })).then(items => items.filter(Boolean));
        }

        if (isQbitConfigured() && (localPlayable || r.Link || magnet)) {
          return buildQbitStream(localPlayable ? "💾" : "HTTP");
        }

        const sources = r.MagnetUri ? [r.MagnetUri] : (resolved.infoHash ? [buildMagnet(resolved.infoHash, null, r.Title)] : []);
        if (!sources.length) return null;
        return {
          name,
          description: [description, matchedFile?.name ? `📂 ${matchedFile.name}` : ""].filter(Boolean).join("\n"),
          infoHash: resolved.infoHash, fileIdx: matchedFile?.idx, sources,
          behaviorHints: {
            filename: matchedFile?.name, videoSize: matchedFile?.size,
            bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
          },
        };
        } catch { return null; }
      })
    );

    const allStreams = resolvedAll.flat(2).filter(Boolean);

    // Garante cached primeiro mesmo após flat() misturar streams multi (TB+RD)
    if (isDebridMode) {
      allStreams.sort((a, b) => (b._cached ? 1 : 0) - (a._cached ? 1 : 0));
    }

    const maxOut = prefs.maxResults || 20;
    let finalStreams;
    if (isDebridMode) {
      const cached = allStreams.filter(s => s._cached);
      const queued = allStreams.filter(s => !s._cached);
      finalStreams = [...cached, ...queued].slice(0, maxOut);
    } else {
      finalStreams = allStreams.slice(0, maxOut);
    }
    // Remove campo interno antes de enviar
    finalStreams.forEach(s => delete s._cached);

    if (isDebridMode) {
      const cached = finalStreams.filter(s => s.url && !s.url.includes('/debrid-add/')).length;
      const queued = finalStreams.filter(s => s.url && s.url.includes('/debrid-add/')).length;
      console.log(`[DEBRID] Streams listados: ${cached} ⚡️ cached + ${queued} ⬇️ on-demand`);
    } else {
      console.log(`Magnets listados: Enviando ${finalStreams.length} torrents!`);
    }
    console.log(`=========================================\n`);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro no processamento: ${err.message}`);
    res.json({ streams: [] });
  }
});

app.listen(ENV.port, () => {
  console.log(`ProwJack PRO v3.10.0 -> http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
  console.log(`   qBittorrent: ${isQbitConfigured() ? "ativo" : "desativado"}`);
});
