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
const CACHE_VERSION = "v5-priority-lang";
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
    // ── Idioma ──────────────────────────────────────────
    // priorityLang: qual idioma aparece no topo dos resultados.
    //   "pt-br" → PT-BR/Dublado primeiro (padrão histórico).
    //   ""      → sem preferência; rankeado puramente por
    //             qualidade/seeders/tamanho/codec.
    // Isso corrige o bug em que resultados não-dublados eram
    // efetivamente excluídos mesmo com onlyDubbed: false,
    // pois o bônus de 1000 pts para PT-BR tornava impossível
    // que outros idiomas aparecessem dentro do limite maxResults.
    priorityLang:    "pt-br",
    // onlyDubbed: filtro estrito — só mostra o idioma prioritário.
    // Usa priorityLang como referência, não mais PT-BR hardcoded.
    onlyDubbed:      false,
    debrid:          false,
  };
}
function resolvePrefs(encoded) {
  const u = encoded ? (decodeUserCfg(encoded) || {}) : {};
  const m = { ...defaultPrefs(), ...u };
  if (!Array.isArray(m.indexers) || !m.indexers.length) m.indexers = ["all"];
  // Compatibilidade retroativa: URLs antigas sem priorityLang
  // mas com onlyDubbed:true devem continuar filtrando PT-BR.
  if (m.priorityLang === undefined) m.priorityLang = "pt-br";
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
// DETECÇÃO DE IDIOMA
// ─────────────────────────────────────────────────────────
function getLangs(title, isAnime) {
  const langs  = matchAll(LANG, title);
  const isDual = /(dual)[-.\s]?(audio|2\.1|5\.1)?/i.test(title);
  if (isDual && !isAnime && !langs.some(l => l.code === "pt-br")) {
    langs.push({ code: "pt-br", emoji: "🇧🇷", label: "PT-BR" });
  }
  return langs;
}
// ─────────────────────────────────────────────────────────
// SCORE — parametrizado por priorityLang
//
// FIX PRINCIPAL: antes, o bônus de PT-BR era hardcoded (1000 pts),
// tornando impossível que resultados em outros idiomas aparecessem
// nos primeiros maxResults quando havia torrents PT-BR suficientes.
// Agora:
//   • priorityLang definido → idioma selecionado recebe bônus 25x
//     (mesmo comportamento de antes, mas para qualquer idioma)
//   • priorityLang vazio    → nenhum idioma recebe bônus especial;
//     todos pontuam igualmente e o ranking é puro qualidade/seeders.
// ─────────────────────────────────────────────────────────
function score(r, weights = {}, isAnime = false, priorityLang = "") {
  const w = { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5, ...weights };
  const t = r.Title || "";
  let s   = 0;

  const langs      = getLangs(t, isAnime);
  const hasPriority = priorityLang
    ? langs.some(l => l.code === priorityLang)
    : false;
  const isMulti    = /(multi)[-.\s]?(audio)?/i.test(t);
  const isDualAnim = isAnime && /(dual)[-.\s]?(audio)?/i.test(t);

  if (priorityLang && hasPriority)  s += w.language * 25;  // idioma prioritário: bônus alto
  else if (isDualAnim)              s += w.language * 15;  // anime dual-audio: bônus médio
  else if (isMulti)                 s += w.language * 10;  // multi-áudio: bônus moderado
  else if (langs.length > 0)        s += w.language * 5;   // qualquer idioma identificado
  else                              s += w.language * 2;   // idioma desconhecido

  // Resolução, qualidade, seeders, tamanho, codec — sem mudança
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

    let score      = coverage * 0.8 + density * 0.2;

    if (aliasTokens.length >= 2 && matched >= aliasTokens.length - 1) score += 0.15;
    if (titleTokens.some(tok => aliasSet.has(tok))) score += 0.05;
    if (phraseHit) score += 0.25;
    if (exactShortHit) score += 0.35;
    best = Math.max(best, Math.min(score, 1));
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
  return normalizeImdbId(
    r?.ImdbId || r?.Imdb || r?.imdbId || r?.imdb || r?._imdbId || r?._imdb
  );
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
  if (isCompletePack(t)) {
    return seasonOnly.test(t) ? 1 : 0;
  }
  return 0;
}

function animeEpisodeMatchRank(title, ep) {
  if (ep == null) return 1;
  const t = (title || "").replace(/\./g, " ");
  const n = ep;

  if (new RegExp(`-\\s*0*${n}(?:v\\d+)?\\s*[\\[\\(\\s]`, "i").test(t)) return 3;
  if (new RegExp(`\\[0*${n}(?:v\\d+)?\\]`, "i").test(t)) return 3;
  if (new RegExp(`(?<=[\\s._\-\\[\\(])0*${String(n).padStart(2, "0")}(?:v\\d+)?(?=[\\s._\-\\]\\)\\[]|$)`, "i").test(t)) return 3;
  if (new RegExp(`(?<=[\\s._\-\\[\\(])0*${String(n).padStart(3, "0")}(?:v\\d+)?(?=[\\s._\-\\]\\)\\[]|$)`, "i").test(t)) return 3;
  if (new RegExp(`\\bE(?:p(?:isode)?)?\\s*0*${n}\\b`, "i").test(t)) return 3;

  for (const m of t.matchAll(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b/g)) {
    const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
    if (n >= lo && n <= hi) return 2;
  }

  if (isCompletePack(t)) return 1;
  return 0;
}
// ─────────────────────────────────────────────────────────
// FILTRO ESTRITO DE EPISÓDIOS
// ─────────────────────────────────────────────────────────
function seriesEpisodeMatches(title, season, episode) {
  return episodeMatchRank(title, season, episode) > 0;
}
function animeEpisodeMatches(title, ep) {
  return animeEpisodeMatchRank(title, ep) > 0;
}
// ─────────────────────────────────────────────────────────
// DEDUPLICAÇÃO
// ─────────────────────────────────────────────────────────
function normalizeForDedupe(str) {
  if (!str) return null;
  return str
    .replace(/[\[\(][^\]\)]*[\]\)]/g, '')
    .replace(/⚡ |✅ |💾|🇧🇷|🔍|📡|🎬|🎥|📺|🎞️|🎧|🗣️|📦|🌱|🏷️|⚠️|💿|🌐|🖥️|📼|📀/g, '')
    .replace(/\b(dual|dub|leg|pt\.?br|portuguese|4k|1080p|720p|480p|remux|bluray|webrip|web\.dl|hdtv|hdrip|brrip|dvdrip|hevc|x264|x265|aac|ac3|10bit)\b/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function dedupeResults(results) {
  const seenHash = new Set(), seenFile = new Set(), seenTitle = new Set(), deduped = [];
  for (const r of results) {
    const hash     = r.InfoHash ? r.InfoHash.toLowerCase() : null;
    const filename = r.Title    ? r.Title.toLowerCase().replace(/\.[^.]+$/, '') : null;
    const titleKey = normalizeForDedupe(r.Title);
    if (hash     && seenHash.has(hash))                              continue;
    if (filename && seenFile.has(filename))                          continue;
    if (titleKey && titleKey.length > 8 && seenTitle.has(titleKey)) continue;
    if (!hash && !filename && !titleKey) {
      const key = [r.Guid||"", r.Link||"", r.MagnetUri||"", r.Tracker||""].join("|");
      if (seenHash.has(key)) continue;
      seenHash.add(key); deduped.push(r); continue;
    }
    if (hash)                            seenHash.add(hash);
    if (filename)                        seenFile.add(filename);
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

async function resolveInfoHash(r) {
  if (r.InfoHash)  return { infoHash: r.InfoHash.toLowerCase(), files: null };
  if (r.MagnetUri) {
    const h = extractInfoHash(r.MagnetUri);
    if (h) return { infoHash: h, files: null };
  }
  if (!r.Link)     return null;
  try {
    const res = await axios.get(r.Link, {
      timeout: 10000, maxRedirects: 10, responseType: "arraybuffer",
      maxContentLength: 8 * 1024 * 1024, validateStatus: s => s < 400,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const finalUrl = res.request?.res?.responseUrl || "";
    if (finalUrl.startsWith("magnet:")) {
      const infoHash = extractInfoHash(finalUrl);
      return infoHash ? { infoHash, files: null } : null;
    }
    const buf     = Buffer.from(res.data);
    const bodyStr = buf.toString("utf8", 0, Math.min(buf.length, 200));
    if (bodyStr.trimStart().startsWith("magnet:")) {
      const infoHash = extractInfoHash(bodyStr.trim());
      return infoHash ? { infoHash, files: null } : null;
    }
    if (buf[0] === 0x64) {
      const infoBuf = extractInfoBuf(buf);
      if (infoBuf) {
        return {
          infoHash: crypto.createHash("sha1").update(infoBuf).digest("hex"),
          files: extractTorrentFiles(buf),
        };
      }
    }
  } catch {}
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
  const addonName    = prefs.addonName || "ProwJack PRO";
  const resLabel     = res ? res.label : "Desconhecida";
  const langDisplay  = [];
  if (langs.length) langDisplay.push(langs.map(l => `${l.emoji} ${l.label}`).join(" / "));
  else langDisplay.push("🌐 Original");
  const isMulti = /(multi|dual)[-.\s]?(audio)?/i.test(t);
  if      (isMulti && isAnime)                              langDisplay.push("🎧 Multi/Dual-Audio");
  else if (isMulti && !langs.some(l => l.code === "pt-br")) langDisplay.push("🎧 Multi");
  const clean    = t.replace(/\b\d{4}\b\.?/g, " ").replace(/\./g, " ").replace(/\s{2,}/g, " ").trim();
  const p2pLabel = prefs.debrid ? "" : "⚠️ P2P";
  const desc = [
    `🎬 ${clean}`,
    [qual ? `🎥 ${qual.label}` : "", vis.length ? `📺 ${vis.map(v=>v.label).join(" | ")}` : "", codec ? `🎞️ ${codec.label}` : ""].filter(Boolean).join("  "),
    [audios.length ? `🎧 ${audios.map(a=>a.label).join(" | ")}` : "", langDisplay.join(" | ")].filter(Boolean).join("  "),
    [size ? `📦 ${size}` : "", seeds > 0 ? `🌱 ${seeds} seeds` : "", `📡 ${cleanIndexer}`].filter(Boolean).join("  "),
    group   ? `🏷️ ${group}` : "",
    p2pLabel,
  ].filter(Boolean).join("\n");
  return { name: `${addonName}\n${resLabel}`, description: desc.trim() };
}
// ─────────────────────────────────────────────────────────
// JACKETT + SEARCH
// ─────────────────────────────────────────────────────────
async function jackettFetchIndexers() {
  try {
    const res = await axios.get(`${ENV.jackettUrl}/api/v2.0/indexers/all/results`, {
      params: qp({ Query: "" }), timeout: 15000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data?.Indexers)) {
      return res.data.Indexers
        .map(ix => ({ id: String(ix.ID).trim(), name: String(ix.Name).trim() }))
        .filter(ix => ix.id && ix.id !== "all");
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

async function jackettTextSearch(query, indexer, timeout) {
  const res = await axios.get(
    `${ENV.jackettUrl}/api/v2.0/indexers/${indexer}/results`,
    { params: qp({ Query: query }), timeout, validateStatus: () => true }
  );
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return (res.data?.Results || []).map(r => ({ ...r, _structuredMatch: false }));
}

async function jackettStructuredSearch(search, indexer, timeout) {
  if (!search?.mode || !search?.imdbId) return [];
  const params = { apikey: ENV.apiKey, t: search.mode, imdbid: search.imdbId, q: search.title };
  if (search.year)   params.year = search.year;
  if (search.season != null) params.season = search.season;
  if (search.episode != null) params.ep = search.episode;

  const res = await axios.get(
    `${ENV.jackettUrl}/api/v2.0/indexers/${indexer}/results/torznab/api`,
    { params, timeout, responseType: "text", validateStatus: () => true }
  );
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: res });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return parseTorznabResults(String(res.data || ""), indexer);
}

async function jackettSearchOneIndexer(indexer, plan, timeout, fastTimeout) {
  if (await isRateLimited(indexer)) return [];
  const t0 = Date.now();
  try {
    let results = [];
    if (plan.search && !plan.parsed?.isAnime) {
      try {
        results = await jackettStructuredSearch(plan.search, indexer, timeout);
      } catch (err) {
        if (err.response?.status === 429) throw err;
      }
    }
    if (results.length === 0) {
      for (const query of plan.queries) {
        const textResults = await jackettTextSearch(query, indexer, timeout);
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
  const queryList = uniq(Array.isArray(plan?.queries) ? plan.queries : [plan?.queries].filter(Boolean));
  const cacheKey  = `search:${CACHE_VERSION}:${Buffer.from(JSON.stringify({ queryList, search: plan?.search || null, parsed: plan?.parsed || null })).toString("base64")}:${indexers.join(",")}`;
  const cached    = await rc.get(cacheKey);
  if (cached) {
    console.log(`Cache HIT para buscas: ${JSON.stringify(queryList)}`);
    return JSON.parse(cached);
  }
  // FIX: slowThreshold do usuário como timeout da fase rápida.
  const FAST_TIMEOUT = (prefs?.slowThreshold > 0 ? prefs.slowThreshold : 12000);
  const SLOW_TIMEOUT = 50000;
  console.log(`Jackett iniciando busca: "${queryList[0] || plan?.search?.title || "sem titulo"}" em [${indexers.length} indexers]`);
  console.log(`Fase rapida: aguardando respostas... (${FAST_TIMEOUT}ms max)`);
  const fastFlat    = (await Promise.all(indexers.map(indexer => jackettSearchOneIndexer(indexer, plan, FAST_TIMEOUT, FAST_TIMEOUT)))).flat();
  const fastDeduped = dedupeResults(fastFlat);
  console.log(`Conclusao da janela rapida: ${fastFlat.length} brutos -> ${fastDeduped.length} deduplicados`);
  if (fastDeduped.length === 0) { await rc.set(cacheKey, JSON.stringify([]), 300); return []; }
  setImmediate(async () => {
    try {
      const slowDeduped = dedupeResults((await Promise.all(indexers.map(indexer => jackettSearchOneIndexer(indexer, plan, SLOW_TIMEOUT, FAST_TIMEOUT)))).flat());
      if (slowDeduped.length > fastDeduped.length) {
        console.log(`[Background] Cache atualizado: ${fastDeduped.length} -> ${slowDeduped.length}`);
        await rc.set(cacheKey, JSON.stringify(slowDeduped), 1800);
      } else {
        await rc.set(cacheKey, JSON.stringify(fastDeduped), 1800);
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
      parsed,
      displayTitle: meta.title,
      aliases: meta.aliases,
      queries,
      episode: ep,
      search: null,
      year: null,
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
    parsed,
    displayTitle: meta.title,
    aliases     : meta.aliases,
    queries     : uniq(queries.map(normTitle)),
    episode,
    year        : meta.year,
    search      : parsed.isAnime ? null : {
      mode   : type === "movie" ? "movie" : "tvsearch",
      imdbId : meta.imdbId,
      title  : meta.title,
      year   : meta.year,
      season : parsed.season,
      episode: parsed.episode,
    },
  };
}
// ─────────────────────────────────────────────────────────
// API E MANIFEST
// ─────────────────────────────────────────────────────────
app.get("/api/env",     (_, res) => res.json({ jackettUrl: ENV.jackettUrl, apiKeySet: !!ENV.apiKey, port: ENV.port, redisUrl: ENV.redisUrl }));
app.get("/api/indexers", async (_, res) => {
  try   { const indexers = await jackettFetchIndexers(); res.json({ ok: true, count: indexers.length, indexers }); }
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
    id: "org.prowjack.pro", version: "3.7.0", name: "ProwJack PRO",
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
  res.json({
    id: "org.prowjack.pro", version: "3.7.0", name,
    description: `Jackett Otimizado · Prioridade PT-BR`,
    resources: ["stream"], types, idPrefixes: ["tt", "kitsu:"], catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false, p2p: !prefs.debrid },
  });
});
// ─────────────────────────────────────────────────────────
// STREAMS
// ─────────────────────────────────────────────────────────
const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i;
app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs      = resolvePrefs(req.params.userConfig);
  const { type, id } = req.params;
  console.log(`\n=========================================`);
  console.log(`NOVA BUSCA: [${type}] ${id}`);
  // ── Proxy StremThru ───────────────────────────────────────────────────────
  if (prefs.stConfig) {
    console.log(`[PROXY] Conversao Debrid Ativa...`);
    const rawPrefs = { ...prefs };
    delete rawPrefs.stConfig;
    rawPrefs.debrid = true;
    const rawB64 = Buffer.from(JSON.stringify(rawPrefs), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const protocol    = req.headers['x-forwarded-proto'] || req.protocol;
    const host        = req.headers['x-forwarded-host']  || req.get('host');
    const upstreamUrl = `${protocol}://${host}/${rawB64}/manifest.json`;
    const wrapper     = { upstreams: [{ u: upstreamUrl }], stores: prefs.stConfig.stores };
    const b64Wrap     = Buffer.from(JSON.stringify(wrapper), 'utf8').toString('base64');
    const stUrl       = `${prefs.stConfig.url}/stremio/wrap/${encodeURIComponent(b64Wrap)}/stream/${type}/${id}.json`;
    try {
      const { data } = await axios.get(stUrl, { timeout: 60000, headers: { "User-Agent": "ProwJack/3.7" } });
      console.log(`[PROXY] Sucesso! ${data?.streams?.length || 0} links.`);
      console.log(`=========================================\n`);
      return res.json({ streams: data.streams || [] });
    } catch (err) {
      console.log(`[PROXY] StremThru falhou: ${err.message}`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
  }
  // ── Busca principal ───────────────────────────────────────────────────────
  try {
    const { parsed, displayTitle, aliases = [], queries, episode, year, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);

    // Verificação de categorias habilitadas
    const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length
      ? prefs.categories
      : ["movie", "series"];
    if (parsed.isAnime && !enabledCats.includes("anime")) {
      console.log(`[Categoria] Anime bloqueado pelas preferencias do usuario`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) {
      console.log(`[Categoria] Serie bloqueada pelas preferencias do usuario`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    if (type === "movie" && !enabledCats.includes("movie")) {
      console.log(`[Categoria] Filme bloqueado pelas preferencias do usuario`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }

    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);
    const results  = await jackettSearch({ parsed, queries, search }, indexers, prefs);

    // Idioma prioritário — determina o bônus no score e o alvo do filtro estrito.
    // Vazio = sem preferência de idioma (ranking por qualidade/seeders apenas).
    const priorityLang = prefs.priorityLang ?? "pt-br";

    let rejectedBySeriesFilter = 0;
    let rejectedByTitleMatch   = 0;
    let rejectedByYear         = 0;
    let rejectedByMovieShape   = 0;
    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => !prefs.skipBadReleases || !BAD_RE.test(r.Title || ""))
      .filter(r => {
        if (type !== "movie") return true;
        const ok = !looksLikeEpisodeRelease(r.Title || "");
        if (!ok) rejectedByMovieShape++;
        return ok;
      })
      .filter(r => {
        if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
        if (type === "series") {
          const matches = seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
          if (!matches) rejectedBySeriesFilter++;
          return matches;
        }
        return true;
      })
      // FIX: filtro de idioma agora usa priorityLang em vez de "pt-br" hardcoded.
      // Quando onlyDubbed:false, NENHUM resultado é excluído por idioma.
      // Quando onlyDubbed:true, só passa o idioma prioritário selecionado.
      .filter(r => {
        if (!prefs.onlyDubbed) return true;
        if (!priorityLang)     return true; // sem lang definida = sem filtro
        return getLangs(r.Title || "", parsed.isAnime).some(l => l.code === priorityLang);
      })
      .filter(r => {
        const resultImdbId = getResultImdbId(r);
        if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
          r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
          r._metaIdMatch = true;
          return true;
        }
        const score = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const episodeRank = parsed.isAnime
          ? animeEpisodeMatchRank(r.Title || "", episode)
          : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
        const minScore = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
        const finalScore = Math.max(score, type === "series" ? relaxedScore * 0.8 : 0);
        const ok = finalScore >= minScore;
        if (!ok) rejectedByTitleMatch++;
        r._titleMatchScore = finalScore;
        return ok;
      })
      .filter(r => {
        if (type !== "movie" || !year) return true;
        const releaseYear = extractReleaseYear(r.Title || "");
        if (!releaseYear) return true;
        const ok = releaseYear === year;
        if (!ok) rejectedByYear++;
        return ok;
      })
      // FIX PRINCIPAL: score() agora recebe priorityLang.
      // Quando priorityLang="" : todos os idiomas pontuam igual — não-dublados
      //                          aparecem normalmente, ordenados por qualidade.
      // Quando priorityLang set: idioma selecionado aparece no topo, mas os
      //                          demais ainda aparecem abaixo (sem exclusão).
      .sort((a, b) =>
        (((b._metaIdMatch ? 1 : 0) * 40000) +
          ((b._structuredMatch ? 1 : 0) * 20000) +
          (parsed.isAnime
          ? animeEpisodeMatchRank(b.Title || "", episode)
          : episodeMatchRank(b.Title || "", parsed.season, parsed.episode)) * 10000 +
          (b._titleMatchScore || 0) * 1000 +
          score(b, prefs.weights, parsed.isAnime, priorityLang)) -
        (((a._metaIdMatch ? 1 : 0) * 40000) +
          ((a._structuredMatch ? 1 : 0) * 20000) +
          (parsed.isAnime
          ? animeEpisodeMatchRank(a.Title || "", episode)
          : episodeMatchRank(a.Title || "", parsed.season, parsed.episode)) * 10000 +
          (a._titleMatchScore || 0) * 1000 +
          score(a, prefs.weights, parsed.isAnime, priorityLang))
      );
    // Nota: .slice() aplicado APÓS resolveInfoHash (fix Bug 2 anterior).

    if (type === "series" && rejectedBySeriesFilter > 0)
      console.log(`Filtro de Serie: ${rejectedBySeriesFilter} resultados descartados.`);
    if (rejectedByTitleMatch > 0)
      console.log(`Filtro de Titulo: ${rejectedByTitleMatch} resultados descartados.`);
    if (rejectedByYear > 0)
      console.log(`Filtro de Ano: ${rejectedByYear} resultados descartados.`);
    if (rejectedByMovieShape > 0)
      console.log(`Filtro de Filme: ${rejectedByMovieShape} resultados episodicos descartados.`);

    const langLabel = priorityLang
      ? `Idioma prioritário: ${priorityLang.toUpperCase()}`
      : `Sem preferência de idioma`;
    console.log(`${langLabel} | onlyDubbed: ${prefs.onlyDubbed}`);
    console.log(`Extraindo InfoHash de ${candidates.length} links promissores...`);

    const resolvedAll = await Promise.all(
      candidates.map(async r => {
        const resolved = await resolveInfoHash(r);
        if (!resolved?.infoHash) {
          console.log(`  Erro ou torrent vazio em "${(r.Title||"").slice(0,60)}"`);
          return null;
        }
        const matchedFile = (type === "series" || parsed.isAnime)
          ? pickEpisodeFile(resolved.files, parsed.season, parsed.episode ?? episode, parsed.isAnime)
          : null;
        const indexerName            = r.Tracker || r.TrackerId || "Unknown";
        const { name, description }  = formatStream(r, indexerName, parsed.isAnime, prefs);
        const sources                = r.MagnetUri ? [r.MagnetUri] : [];
        return {
          name,
          description: matchedFile?.name
            ? `${description}\n📂 ${matchedFile.name}`
            : description,
          infoHash: resolved.infoHash,
          fileIdx: matchedFile?.idx,
          sources,
          behaviorHints: {
            filename: matchedFile?.name,
            videoSize: matchedFile?.size,
            bingeGroup: parsed.isAnime
              ? `prowjack|anime|${displayTitle}`
              : `prowjack|${resolved.infoHash}`,
          },
        };
      })
    );

    // Slice após resolução — garante maxResults streams válidos, não candidatos brutos.
    const finalStreams = resolvedAll.filter(Boolean).slice(0, prefs.maxResults || 20);

    console.log(`Magnets prontos: Enviando ${finalStreams.length} torrents!`);
    console.log(`=========================================\n`);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro no processamento do Jackett: ${err.message}`);
    res.json({ streams: [] });
  }
});
app.listen(ENV.port, () => {
  console.log(`ProwJack PRO v3.7.0 -> http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
});
