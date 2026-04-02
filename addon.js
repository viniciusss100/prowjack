"use strict";

const crypto  = require("crypto");
const express = require("express");
const axios   = require("axios");
const Redis   = require("ioredis");
const path    = require("path");
const fs      = require("fs");

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
  jackettUrl: (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:     (process.env.JACKETT_API_KEY || "").trim(),
  port:       process.env.PORT || 7014,
  redisUrl:   process.env.REDIS_URL || "redis://localhost:6379",
};

// ─────────────────────────────────────────────────────────
// REDIS
// ─────────────────────────────────────────────────────────
let redis = null;
try {
  redis = new Redis(ENV.redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  redis.on("error", () => {});
} catch {}

const rc = {
  async get(k)         { try { return redis ? await redis.get(k) : null; } catch { return null; } },
  async set(k, v, ttl) { try { redis && await redis.set(k, v, "EX", ttl); } catch {} },
  async del(k)         { try { redis && await redis.del(k); } catch {} },
  async keys(p)        { try { return redis ? await redis.keys(p) : []; } catch { return []; } },
};

const CACHE_VERSION = "v4-ptbr-strict-proxy-v3";

// ─────────────────────────────────────────────────────────
// INDEXERS (ISOLAMENTO DE ANIME APLICADO)
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

let _ixCache    = null;
let _ixCacheAt  = 0;
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

  const allList = await getCachedIndexers();
  const pool = useAll ? allList.map(ix => ix.id) : selected;

  if (isAnime) {
    const animePool = pool.filter(id => isAnimeOnly(id));
    if (animePool.length > 0) return animePool;
    console.log(`⚠️ Nenhum indexer de anime encontrado na configuração, usando pool geral (pode causar rate limits)`);
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
  console.log(`  🚫 ${indexer}: rate limited por ${ttl}s`);
}

// ─────────────────────────────────────────────────────────
// CONFIG (Base64URL Nativo)
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
    onlyDubbed:      false,
    debrid:          false
  };
}

function resolvePrefs(encoded) {
  const u = encoded ? (decodeUserCfg(encoded) || {}) : {};
  const m = { ...defaultPrefs(), ...u };
  if (!Array.isArray(m.indexers) || !m.indexers.length) m.indexers = ["all"];
  return m;
}

// ─────────────────────────────────────────────────────────
// PARSERS E DICIONARIOS
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
  { re: /\bcam(rip)?\b/i,    label: "CAM",    emoji: "⛔", score: -5  },
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
  { re: /\b(english|eng)\b/i,  code: "en", emoji: "🇺🇸", label: "EN" },
  { re: /(espa[nñ]ol|spanish|\besp\b)/i, code: "es", emoji: "🇪🇸", label: "ES" },
  { re: /(fran[cç]ais|french|\bfre\b)/i, code: "fr", emoji: "🇫🇷", label: "FR" },
];

const first     = (map, t) => map.find(e => e.re.test(t));
const matchAll  = (map, t) => map.filter(e => e.re.test(t));
const uniq      = arr => [...new Set(arr.filter(Boolean))];
const normTitle = s => (s || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
function qp(extra = {}) {
  const p = { ...extra };
  if (ENV.apiKey) p.apikey = ENV.apiKey;
  return p;
}

// ─────────────────────────────────────────────────────────
// ⚡ INTELIGÊNCIA DE IDIOMA (Lógica Especial de DUAL)
// ─────────────────────────────────────────────────────────
function getLangs(title, isAnime) {
    const langs = matchAll(LANG, title);
    const isDual = /(dual|multi)[-.\s]?(audio|2\.1|5\.1)?/i.test(title);
    
    if (isDual) {
        if (!isAnime) {
            if (!langs.some(l => l.code === "pt-br")) {
                langs.push({ code: "pt-br", emoji: "🇧🇷", label: "PT-BR" });
            }
        }
    }
    return langs;
}

// ─────────────────────────────────────────────────────────
// FILTRO ESTRITO DE EPISÓDIOS (SERIES E ANIME)
// ─────────────────────────────────────────────────────────
function seriesEpisodeMatches(title, season, episode) {
  if (season == null || episode == null) return true;
  const t = (title || "").toLowerCase();
  const sRaw = parseInt(season, 10);
  const eRaw = parseInt(episode, 10);
  
  const epRegex = new RegExp(`\\bs0*${sRaw}[\\s.-_]?e0*${eRaw}\\b|\\b0*${sRaw}x0*${eRaw}\\b`, 'i');
  if (epRegex.test(t)) return true;

  const packRegex = new RegExp(`\\bs0*${sRaw}\\b(?!\\s?[.-_]?e\\d)|\\bseason\\s?0*${sRaw}\\b|\\btemporada\\s?0*${sRaw}\\b`, 'i');
  if (packRegex.test(t)) return true;

  const multiRegex = /s0*(\d{1,2})\s*[-~]\s*s?0*(\d{1,2})/i;
  const multiMatch = t.match(multiRegex);
  if (multiMatch) {
      const start = parseInt(multiMatch[1], 10);
      const end = parseInt(multiMatch[2], 10);
      if (sRaw >= start && sRaw <= end) return true;
  }
  
  const completeRegex = /\b(complete|completa|todas as temporadas|series pack)\b/i;
  if (completeRegex.test(t)) return true;

  return false;
}

function animeEpisodeMatches(title, ep) {
  if (ep == null) return true;
  const t = (title || "").replace(/\./g, " ");
  const n = ep;
  for (const m of t.matchAll(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b/g)) {
    const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
    if (n >= lo && n <= hi) return true;
  }
  const pad2 = String(n).padStart(2, "0");
  const pad3 = String(n).padStart(3, "0");
  if (new RegExp(`-\\s*0*${n}(?:v\\d+)?\\s*[\\[\\(\\s]`, "i").test(t)) return true;
  for (const v of [pad2, pad3, String(n)]) {
    if (new RegExp(`\\[0*${n}(?:v\\d+)?\\]`).test(t)) return true;
    if (new RegExp(`(?<=[\\s\\._\\-\\[\\(])0*${v}(?:v\\d+)?(?=[\\s\\._\\-\\]\\)\\[]|$)`, "i").test(t)) return true;
  }
  if (new RegExp(`\\bE(?:p(?:isode)?)?\\s*0*${n}\\b`, "i").test(t)) return true;
  if (new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${n}(?:v\\d+)?(?=[\\s\\]\\)\\[\\-_]|$)`).test(t)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────
// DEDUPLICAÇÃO E SCORE
// ─────────────────────────────────────────────────────────
function normalizeForDedupe(str) {
  if (!str) return null;
  return str.replace(/[\[\(][^\]\)]*[\]\)]/g, '').replace(/⚡|✅|💾|🇧🇷|🔍|📡|🎬|🎥|📺|🎞️|🎧|🗣️|📦|🌱|🏷️|⚠️|💿|🌐|🖥️|📼|📀/g, '') 
    .replace(/\b(dual|dub|leg|pt\.?br|portuguese|4k|1080p|720p|480p|remux|bluray|webrip|web\.dl|hdtv|hdrip|brrip|dvdrip|hevc|x264|x265|aac|ac3|10bit)\b/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dedupeResults(results) {
  const seenHash = new Set(), seenFile = new Set(), seenTitle = new Set(), deduped = [];
  for (const r of results) {
    const hash = r.InfoHash ? r.InfoHash.toLowerCase() : null;
    const filename = r.Title ? r.Title.toLowerCase().replace(/\.[^.]+$/, '') : null;
    const titleKey = normalizeForDedupe(r.Title);

    if (hash && seenHash.has(hash)) continue;
    if (filename && seenFile.has(filename)) continue;
    if (titleKey && titleKey.length > 8 && seenTitle.has(titleKey)) continue;
    
    if (!hash && !filename && !titleKey) {
      const key = [r.Guid||"", r.Link||"", r.MagnetUri||"", r.Tracker||""].join("|");
      if (seenHash.has(key)) continue;
      seenHash.add(key);
      deduped.push(r);
      continue;
    }
    if (hash) seenHash.add(hash);
    if (filename) seenFile.add(filename);
    if (titleKey && titleKey.length > 8) seenTitle.add(titleKey);
    deduped.push(r);
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
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.length === 40 ? hex : null;
}

function extractInfoHash(magnet) {
  if (!magnet) return null;
  const hex = magnet.match(/btih:([a-fA-F0-9]{40})(?:[&?]|$)/i);
  if (hex) return hex[1].toLowerCase();
  const b32 = magnet.match(/btih:([A-Za-z2-7]{32})(?:[&?]|$)/i);
  if (b32) return base32ToHex(b32[1]);
  const loose = magnet.match(/btih:([a-fA-F0-9]{40})/i);
  if (loose) return loose[1].toLowerCase();
  return null;
}

function extractInfoBuf(buf) {
  const s = buf.toString("latin1");
  const pos = s.indexOf("4:info");
  if (pos === -1) return null;
  let i = pos + 6, depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === "d" || c === "l") { depth++; i++; }
    else if (c === "e") { depth--; i++; if (depth === 0) break; }
    else if (c === "i") { i = s.indexOf("e", i + 1) + 1; }
    else if (c >= "0" && c <= "9") {
      const colon = s.indexOf(":", i);
      if (colon === -1) break;
      i = colon + 1 + parseInt(s.slice(i, colon), 10);
    } else i++;
  }
  return depth === 0 ? buf.slice(start, i) : null;
}

async function resolveInfoHash(r) {
  if (r.InfoHash) return r.InfoHash.toLowerCase();
  if (r.MagnetUri) { const h = extractInfoHash(r.MagnetUri); if (h) return h; }
  
  if (!r.Link) return null;
  try {
    const res = await axios.get(r.Link, {
      timeout: 10000, maxRedirects: 10,
      responseType: "arraybuffer", maxContentLength: 8 * 1024 * 1024,
      validateStatus: s => s < 400,
    });
    const finalUrl = res.request?.res?.responseUrl || "";
    if (finalUrl.startsWith("magnet:")) return extractInfoHash(finalUrl);
    const buf = Buffer.from(res.data);
    const bodyStr = buf.toString("utf8", 0, Math.min(buf.length, 200));
    if (bodyStr.trimStart().startsWith("magnet:")) return extractInfoHash(bodyStr.trim());
    if (buf[0] === 0x64) {
      const infoBuf = extractInfoBuf(buf);
      if (infoBuf) return crypto.createHash("sha1").update(infoBuf).digest("hex");
    }
  } catch (e) { 
      console.log(`  ⚠️ Erro ao extrair infoHash de ${r.Tracker}: ${e.message}`); 
  }
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

function score(r, weights = {}, isAnime = false) {
  const w = { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5, ...weights };
  const t = r.Title || "";
  let s = 0;
  
  const langs = getLangs(t, isAnime);
  const hasPtBr = langs.some(l => l.code === "pt-br");
  const hasEn = langs.some(l => l.code === "en");

  if (hasPtBr) s += w.language * 25;
  else if (hasEn) s += w.language * 5;

  if (isAnime && /(multi|dual)[-.\s]?(audio)?/i.test(t)) {
      s += w.language * 15;
  }

  const res = first(RESOLUTION, t);
  if (res) s += res.score * w.resolution * 10;
  const qual = first(QUALITY, t);
  if (qual) s += qual.score * 50;
  s += (r.Seeders || 0) * (w.seeders / 10);

  const gb = (r.Size || 0) / 1e9;
  if (gb > 0) s += Math.max(0, 10 - Math.abs(gb - 8)) * w.size;

  const codec = first(CODEC, t);
  if (codec) s += codec.score * w.codec * 5;

  return s;
}

function renameIndexer(name) {
  if (!name) return name;
  return name.replace(/\[TORRENT🧲?\]\s*/gi, '')
             .replace(/🇧🇷\s*Rede/gi, 'Rede Torrent')
             .replace(/🇧🇷\s*TorrentFilmes/gi, 'TorrentFilmes').trim();
}

function formatStream(r, indexerName, isAnime = false, prefs = {}) {
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
  const n1 = `🔍 ProwJack · ${cleanIndexer}`;
  const n2 = [res ? res.emoji : "❔", qual ? `${qual.emoji} ${qual.label}` : "", vis.length ? vis.map(v => v.label).join(" | ") : ""].filter(Boolean).join("  ");
  
  const langDisplay = [];
  if (langs.length) langDisplay.push(langs.map(l => l.emoji).join(" "));
  else langDisplay.push("🌐");
  if (isAnime && /(multi|dual)[-.\s]?(audio)?/i.test(t)) langDisplay.push("🎧 Multi/Dual-Audio");
  
  const n3 = [langDisplay.join(" "), codec ? `🎞️ ${codec.label}` : "", seeds > 0 ? `🌱 ${seeds}` : ""].filter(Boolean).join("  ");
  const clean = t.replace(/\b\d{4}\b\.?/g, " ").replace(/\./g, " ").replace(/\s{2,}/g, " ").trim();
  
  const p2pLabel = prefs.debrid ? "" : "⚠️ P2P";

  const desc = [
    `🎬 ${clean}`,
    [qual ? `🎥 ${qual.label}` : "", vis.length ? `📺 ${vis.map(v => v.label).join(" | ")}` : "", codec ? `🎞️ ${codec.label}` : "", res ? `📐 ${res.label}` : ""].filter(Boolean).join("  "),
    [audios.length ? `🎧 ${audios.map(a => a.label).join(" | ")}` : "", langs.length ? `🗣️ ${langs.map(l => `${l.emoji} ${l.label}`).join(" / ")}` : ""].filter(Boolean).join("  "),
    [size ? `📦 ${size}` : "", seeds > 0 ? `🌱 ${seeds} seeds` : "", `📡 ${cleanIndexer}`].filter(Boolean).join("  "),
    group ? `🏷️ ${group}` : "",
    [p2pLabel, langs.some(l => l.code === "pt-br") ? "🇧🇷 PT-BR" : ""].filter(Boolean).join("  "),
  ].filter(Boolean).join("\n");

  return { name: [n1, n2, n3].join("\n"), description: desc };
}

// ─────────────────────────────────────────────────────────
// JACKETT + SEARCH 
// ─────────────────────────────────────────────────────────
async function jackettFetchIndexers() {
  const base = ENV.jackettUrl;
  try {
    const res = await axios.get(`${base}/api/v2.0/indexers/all/results`, { params: qp({ Query: "" }), timeout: 15000, validateStatus: () => true });
    if (res.status < 400 && Array.isArray(res.data?.Indexers)) {
      return res.data.Indexers.map(ix => ({ id: String(ix.ID).trim(), name: String(ix.Name).trim() })).filter(ix => ix.id && ix.id !== "all");
    }
  } catch (e) {}
  return [];
}

async function trackMetrics(indexer, ms, count, ok) {
  const key = `metrics:${indexer}`;
  const raw = await rc.get(key);
  const m = raw ? JSON.parse(raw) : { calls: 0, totalMs: 0, totalResults: 0, failures: 0 };
  m.calls++; m.totalMs += ms; m.totalResults += count;
  if (!ok) m.failures++;
  m.avgMs = Math.round(m.totalMs / m.calls);
  m.avgResults = Math.round(m.totalResults / m.calls);
  m.successRate = Math.round(((m.calls - m.failures) / m.calls) * 100);
  m.lastCall = new Date().toISOString();
  await rc.set(key, JSON.stringify(m), 86400);
}

async function jackettSearch(queries, indexers, prefs) {
  const queryList = uniq(Array.isArray(queries) ? queries : [queries]);
  const cacheKey = `search:${CACHE_VERSION}:${queryList.join("||")}:${indexers.join(",")}`;
  const cached = await rc.get(cacheKey);
  
  if (cached) {
      console.log(`⚡ Cache HIT para buscas: ${JSON.stringify(queryList)}`);
      return JSON.parse(cached); 
  }

  const FAST_TIMEOUT = 12000, SLOW_TIMEOUT = 50000; 
  const tasks = [];
  for (const query of queryList) {
      console.log(`🌐 Jackett iniciando busca: "${query}" em [${indexers.length} indexers]`);
      for (const indexer of indexers) {
          tasks.push({ query, indexer });
      }
  }

  const fetchIndexer = async (task, timeout) => {
    const { query, indexer } = task;
    if (await isRateLimited(indexer)) {
        console.log(`  ⏭️ ${indexer}: skip (rate limit)`);
        return [];
    }
    const t0 = Date.now();
    try {
      const res = await axios.get(`${ENV.jackettUrl}/api/v2.0/indexers/${indexer}/results`, { params: qp({ Query: query }), timeout, validateStatus: () => true });
      const ms = Date.now() - t0;
      if (res.status === 429) { 
          await setRateLimit(indexer, res.headers?.["retry-after"]); 
          return []; 
      }
      if (res.status >= 400) {
          console.log(`  ❌ ${indexer}: Erro HTTP ${res.status} (${ms}ms)`);
          return [];
      }
      const results = res.data?.Results || [];
      await trackMetrics(indexer, ms, results.length, true);
      console.log(`  ✅ ${indexer}: ${results.length} resultados (${ms}ms)`);
      return results;
    } catch (err) {
      const ms = Date.now() - t0;
      if (err.response?.status === 429) await setRateLimit(indexer, err.response?.headers?.["retry-after"]);
      
      if (err.code === 'ECONNABORTED' && timeout === FAST_TIMEOUT) {
          console.log(`  ⏱️ ${indexer}: timeout lento na janela rápida de ${ms}ms (indo para background)`);
      } else {
          console.log(`  ❌ ${indexer}: Falha -> ${err.message} (${ms}ms)`);
      }
      return [];
    }
  };

  console.log(`⚡ Fase rápida: aguardando respostas... (${FAST_TIMEOUT}ms max)`);
  const fastResults = await Promise.all(tasks.map(task => fetchIndexer(task, FAST_TIMEOUT)));
  const fastFlat = fastResults.flat();
  const fastDeduped = dedupeResults(fastFlat);
  console.log(`⚡ Conclusão da janela rápida: ${fastFlat.length} brutos → ${fastDeduped.length} deduplicados`);
  
  if (fastDeduped.length === 0) { 
      await rc.set(cacheKey, JSON.stringify([]), 300); 
      return []; 
  }

  setImmediate(async () => {
    try {
      console.log(`\n🔄 [Background] Resgatando retardatários...`);
      const slowResults = await Promise.all(tasks.map(task => fetchIndexer(task, SLOW_TIMEOUT)));
      const slowDeduped = dedupeResults(slowResults.flat());
      if (slowDeduped.length > fastDeduped.length) {
          console.log(`💾 [Background] Mais resultados encontrados! Cache atualizado de ${fastDeduped.length} para ${slowDeduped.length}`);
          await rc.set(cacheKey, JSON.stringify(slowDeduped), 1800); 
      } else {
          await rc.set(cacheKey, JSON.stringify(fastDeduped), 1800); 
      }
    } catch (err) {
        console.log(`🚨 [Background] Erro interno: ${err.message}`);
    }
  });

  return fastDeduped;
}

// ─────────────────────────────────────────────────────────
// METADATA
// ─────────────────────────────────────────────────────────
async function getCinemetaTitle(type, imdbId) {
  try {
    const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
    const meta = res.data?.meta;
    return { title: meta?.name || imdbId, aliases: uniq([meta?.name, meta?.originalName, ...(meta?.aliases||[])]).map(normTitle) };
  } catch { return { title: imdbId, aliases: [normTitle(imdbId)] }; }
}
async function getKitsuMeta(kitsuId) {
  try {
    const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 5000, headers: { Accept: "application/vnd.api+json" } });
    const attrs = res.data?.data?.attributes || {};
    const aliases = uniq([attrs.titles?.ja_jp, attrs.titles?.en_jp, attrs.canonicalTitle, attrs.titles?.en, attrs.slug?.replace(/-/g, " ")]).map(normTitle);
    return { title: aliases[0] || String(kitsuId), aliases };
  } catch (e) { return { title: String(kitsuId), aliases: [String(kitsuId)] }; }
}
function parseStreamId(type, id) {
  if (id.startsWith("kitsu:")) {
    const parts = id.split(":");
    return { source: "kitsu", isAnime: true, kitsuId: parts[1], episode: parts[2] ? parseInt(parts[2], 10) : null, type };
  }
  if (type === "series" && id.includes(":")) {
    const [metaId, s, e] = id.split(":");
    return { source: "imdb", isAnime: false, metaId, season: parseInt(s, 10), episode: parseInt(e, 10), type };
  }
  return { source: "imdb", isAnime: false, metaId: id, season: null, episode: null, type };
}
async function buildQueries(type, id) {
  const parsed = parseStreamId(type, id);
  if (parsed.isAnime) {
    const meta = await getKitsuMeta(parsed.kitsuId);
    const ep = parsed.episode;
    const queries = ep != null ? uniq(meta.aliases.flatMap(t => [`${t} - ${String(ep).padStart(2,"0")}`, `${t} ${ep}`])) : uniq(meta.aliases);
    return { parsed, displayTitle: meta.title, queries, episode: ep };
  }
  const meta = await getCinemetaTitle(type, parsed.metaId);
  let queries = [meta.title];
  if (type === "series" && parsed.season != null && parsed.episode != null) {
    queries = uniq([`${meta.title} S${String(parsed.season).padStart(2,"0")}E${String(parsed.episode).padStart(2,"0")}`, ...meta.aliases.slice(0, 2).map(a => `${a} S${String(parsed.season).padStart(2,"0")}E${String(parsed.episode).padStart(2,"0")}`)]);
  }
  return { parsed, displayTitle: meta.title, queries: uniq(queries.map(normTitle)), episode: null };
}

// ─────────────────────────────────────────────────────────
// API E MANIFEST
// ─────────────────────────────────────────────────────────
app.get("/api/env", (_, res) => res.json({ jackettUrl: ENV.jackettUrl, apiKeySet: !!ENV.apiKey, port: ENV.port, redisUrl: ENV.redisUrl }));
app.get("/api/indexers", async (_, res) => {
  try {
    const indexers = await jackettFetchIndexers();
    res.json({ ok: true, count: indexers.length, indexers });
  } catch (err) { res.json({ ok: false, error: err.message, indexers: [] }); }
});
app.get("/api/test", async (_, res) => {
  try { const indexers = await jackettFetchIndexers(); res.json({ ok: true, count: indexers.length, indexers }); } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get("/api/metrics", async (_, res) => {
  const keys = await rc.keys("metrics:*"); const out = {};
  for (const k of keys) { const raw = await rc.get(k); if (raw) out[k.replace("metrics:","")] = JSON.parse(raw); }
  res.json(out);
});
app.delete("/api/metrics/:indexer", async (req, res) => { await rc.del(`metrics:${req.params.indexer}`); res.json({ ok: true }); });

app.get("/manifest.json", (_, res) => {
  res.json({ id: "org.prowjack.pro", version: "3.6.0", name: "ProwJack PRO", description: "Configure os parametros pela URL.", resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt", "kitsu:"], catalogs: [], behaviorHints: { configurable: true, configurationRequired: true, p2p: true } });
});

app.get("/configure", (_, res) => {
  const publicPath = path.join(__dirname, "public", "configure.html");
  const rootPath = path.join(__dirname, "configure.html");
  if (fs.existsSync(publicPath)) res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.status(404).send("Arquivo configure.html não encontrado.");
});

app.get("/", (_, res) => res.redirect("/configure"));

app.get("/:userConfig/manifest.json", (req, res) => {
  const prefs   = resolvePrefs(req.params.userConfig);
  const types   = [...new Set((prefs.categories||["movie","series"]).map(c => c==="movies"?"movie":c==="anime"?"series":c))];
  const name    = prefs.addonName || "ProwJack PRO";
  
  res.json({
    id: "org.prowjack.pro", version: "3.6.0", name: name,
    description: `Jackett Otimizado · 🇧🇷 Prioridade PT-BR`,
    resources: ["stream"], types, idPrefixes: ["tt","kitsu:"], catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false, p2p: !prefs.debrid },
  });
});

// ─────────────────────────────────────────────────────────
// ⚡ STREAMS COM BACKEND PROXY
// ─────────────────────────────────────────────────────────
const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i; // ⚡ RESTAURADO AQUI!

app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);
  const { type, id } = req.params;

  console.log(`\n=========================================`);
  console.log(`🍿 NOVA BUSCA: [${type}] ${id}`);

  if (prefs.stConfig) {
      console.log(`🔄 [PROXY] Conversão Debrid Ativa! Falando com StremThru de forma oculta...`);
      
      const rawPrefs = { ...prefs };
      delete rawPrefs.stConfig;
      rawPrefs.debrid = true; 
      
      const rawB64 = Buffer.from(JSON.stringify(rawPrefs), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const upstreamUrl = `${protocol}://${host}/${rawB64}/manifest.json`;
      
      const wrapper = {
          upstreams: [{ u: upstreamUrl }],
          stores: prefs.stConfig.stores
      };
      
      const b64Wrap = Buffer.from(JSON.stringify(wrapper), 'utf8').toString('base64');
      const stUrl = `${prefs.stConfig.url}/stremio/wrap/${encodeURIComponent(b64Wrap)}/stream/${type}/${id}.json`;
      
      try {
          const { data } = await axios.get(stUrl, {
              timeout: 60000, 
              headers: { "User-Agent": "ProwJack/3.6" }
          });
          console.log(`✅ [PROXY] Sucesso! StremThru converteu e devolveu ${data?.streams?.length || 0} links.`);
          console.log(`=========================================\n`);
          return res.json({ streams: data.streams || [] });
      } catch (err) {
          console.log(`❌ [PROXY] O StremThru falhou ao converter: ${err.message}`);
          console.log(`=========================================\n`);
          return res.json({ streams: [] });
      }
  }

  try {
    const { parsed, displayTitle, queries, episode } = await buildQueries(type, id);
    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);

    const results = await jackettSearch(queries, indexers, prefs);

    let rejectedBySeriesFilter = 0;
    
    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => !prefs.skipBadReleases || !BAD_RE.test(r.Title || "")) // ⚡ FILTRO AGORA FUNCIONA
      .filter(r => {
        if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
        if (type === "series") {
            const matches = seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            if (!matches) rejectedBySeriesFilter++;
            return matches;
        }
        return true;
      })
      .filter(r => {
        if (!prefs.onlyDubbed) return true;
        return getLangs(r.Title || "", parsed.isAnime).some(l => l.code === "pt-br");
      })
      .sort((a, b) => score(b, prefs.weights, parsed.isAnime) - score(a, prefs.weights, parsed.isAnime))
      .slice(0, prefs.maxResults || 20);

    if (type === "series" && rejectedBySeriesFilter > 0) {
        console.log(`🛡️ Filtro de Série: ${rejectedBySeriesFilter} resultados inúteis foram descartados.`);
    }

    console.log(`🔎 Extraindo InfoHash de ${candidates.length} links promissores...`);

    const resolved = await Promise.all(
      candidates.map(async r => {
        const infoHash = await resolveInfoHash(r);
        if (!infoHash) {
             console.log(`  ⚠️ Erro ou .torrent vazio em "${(r.Title||"").slice(0,60)}"`);
             return null;
        }
        
        const indexerName = r.Tracker || r.TrackerId || "Unknown";
        const { name, description } = formatStream(r, indexerName, parsed.isAnime, prefs);
        const sources = r.MagnetUri ? [r.MagnetUri] : [];
        return {
          name, description, infoHash, sources,
          behaviorHints: { bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${infoHash}` },
        };
      })
    );
    
    const finalStreams = resolved.filter(Boolean);
    console.log(`✅ Magnets prontos: Enviando ${finalStreams.length} torrents!`);
    console.log(`=========================================\n`);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`❌ Erro no processamento do Jackett: ${err.message}`);
    res.json({ streams: [] });
  }
});

app.listen(ENV.port, () => {
  console.log(`🚀 ProwJack PRO v3.6.0 → http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
});
