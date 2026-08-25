"use strict";

// ╔════════════════════════════════════════════════════════════════════╗
// ║ Tabelas de classificação de qualidade, resolução, codec, etc.     ║
// ╚════════════════════════════════════════════════════════════════════╝
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
  { re: /(dublado|dubbed.*pt|pt[-_. ]?br|\bpt\b|\bpor\b|portugu[eê]s|portuguese|brazilian|🇧🇷|🇵🇹)/i, code: "pt-br", emoji: "🇧🇷", label: "PT-BR" },
  { re: /\b(english|eng)\b/i,                                      code: "en",    emoji: "🇺🇸", label: "EN"    },
  { re: /(espa[nñ]ol|spanish|\besp\b)/i,                           code: "es",    emoji: "🇪🇸", label: "ES"    },
  { re: /(fran[cç]ais|french|\bfre\b)/i,                           code: "fr",    emoji: "🇫🇷", label: "FR"    },
];

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #1: Cache compilado para TITLE_CLEANUP_REGEX           ║
// ╚════════════════════════════════════════════════════════════════════╝
const TITLE_CLEANUP_REGEX = /\b(2160p|1440p|1080p|720p|576p|480p|4k|remux|blu[-.]?ray|web[-.]?dl|webrip|hdrip|dvdrip|hdtv|brrip|x26[45]|h\.?26[45]|hevc|av1|avc|dual|multi|audio|dublado|legendado|pt[-_. ]?br|eng|english|spanish|espa[nñ]ol|french|fran[cç]ais|aac|ac3|ddp?|eac3|atmos|truehd|dts(?:[-.]?hd|[-.]?x)?|10bit|8bit|proper|repack|extended|uncut|complete|completa|batch)\b/gi;

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #2: Cache Set para STOPWORDS                           ║
// ╚════════════════════════════════════════════════════════════════════╝
const STOPWORDS = new Set(["the", "movie", "film", "one", "two", "and", "for", "with", "from", "into", "part"]);

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
    .replace(TITLE_CLEANUP_REGEX, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(tok => tok.length >= 3 || /^(?:[a-z]\d|\d[a-z]|[a-z]\d[a-z]|\d[a-z]\d)$/i.test(tok))
    .filter(tok => !STOPWORDS.has(tok));
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

/**
 * Fração de tokens do título alvo presentes no título do resultado.
 * Ex.: "The Shawshank Redemption 1994" vs "The Shawshank Redemption 1994 1080p"
 * → cobre os tokens relevantes do alvo.
 */
function normalizedTokenOverlap(title, aliases = []) {
  const titleSet = new Set(normalizeTitleTokens(title));
  if (!titleSet.size) return 0;
  let best = 0;
  for (const alias of aliases.filter(Boolean)) {
    const aliasTokens = normalizeTitleTokens(alias);
    if (!aliasTokens.length) continue;
    const matched = aliasTokens.filter(tok => titleSet.has(tok)).length;
    best = Math.max(best, matched / aliasTokens.length);
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
  return /\bs\d{1,2}[\s._-]*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bseason\s?\d{1,2}\b|\btemporada\s?\d{1,2}\b|\bepisode\s?\d{1,3}\b|\bcap[íi]tulo\s?\d{1,3}\b/i.test(t);
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
  if (isCompletePack(t)) {
    if (seasonOnly.test(t)) return 1;
    if (/\bs\d{1,2}\b|\bseason\s?\d{1,2}\b|\btemporada\s?\d{1,2}\b/i.test(t)) return 0;
    return 1;
  }
  if (hasAnyEpisodeMarker(t)) return 0;
  return 1;
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
    if (!normalized) {
      if (r._scrapSource) deduped.push(r);
      continue;
    }

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
    const h = r._resolved?.infoHash;
    if (h) {
      if (seenHash.has(h)) continue;
      seenHash.add(h);
    }
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
    const priority        = group.filter(r =>  r._priorityIndexer);

    const bySeeds = arr => arr.slice().sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));

    let winner;
    if      (priority.length)        winner = bySeeds(priority)[0];
    else if (cachedPublic.length)    winner = bySeeds(cachedPublic)[0];
    else if (cachedPrivate.length)   winner = bySeeds(cachedPrivate)[0];
    else if (uncachedPublic.length)  winner = bySeeds(uncachedPublic)[0];
    else                             winner = bySeeds(uncachedPrivate)[0];

    result.push(winner);
  }

  return result;
}

// ─── Formatação de stream ─────────────────────────────────────────────────────
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
  return stripSourceBadges(name)
    .replace(/🇧🇷\s*Rede/gi, 'Rede Torrent')
    .replace(/🇧🇷\s*TorrentFilmes/gi, 'TorrentFilmes')
    .trim();
}

function stripSourceBadges(value) {
  if (value == null) return value;
  return String(value)
    .replace(/\[\s*TORRENT\s*🧲?\s*\]\s*/giu, "")
    .replace(/\[\s*P2P\s*🧲?\s*\]\s*/giu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function visibleSeedCount(result) {
  const n = result?._displaySeeds ?? result?.Seeders ?? result?._seeders ?? 0;
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

const REDOS_SUSPICIOUS = /(\([^)]*[+*][^)]*\))[+*]|\(\?:[^)]*[+*][^)]*\)[+*]|\(\?=[^)]*[+*][^)]*\)[+*]|\(\?![^)]*[+*][^)]*\)[+*]/;

function matchesKeywordBoost(title, boostFilter) {
  if (!boostFilter || !boostFilter.trim()) return false;
  const pattern = boostFilter.trim();
  if (pattern.length > 500) return false;
  if (REDOS_SUSPICIOUS.test(pattern)) {
    console.warn(`[SECURITY] ReDoS-suspeito bloqueado: ${pattern.slice(0, 80)}`);
    return false;
  }
  try {
    const regex = new RegExp(pattern, "i");
    const input = String(title || "").slice(0, 300);
    let result = false;
    try {
      result = regex.test(input);
    } catch {
      return false;
    }
    return result;
  } catch { return false; }
}

function splitFilterTerms(value) {
  return String(value || "")
    .split(/[,\n;|]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100);
}

function textHasAnyTerm(text, terms) {
  const hay = String(text || "").toLowerCase();
  return terms.some(term => {
    if (!term) return false;
    if (/^\d+$/.test(term)) return new RegExp(`(?:^|\\s)${term}(?:\\s|$)`).test(hay);
    return hay.includes(term);
  });
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resultIndexerText(r, indexerName = "") {
  return [r?._indexerName, r?.Tracker, r?.TrackerId, r?.Indexer, indexerName].filter(Boolean).join(" ");
}

function isPriorityIndexerResult(r, prefs = {}, indexerName = "") {
  const raw = Array.isArray(prefs.priorityIndexers) ? prefs.priorityIndexers.join(",") : prefs.priorityIndexers;
  const terms = splitFilterTerms(raw);
  return terms.length ? textHasAnyTerm(resultIndexerText(r, indexerName), terms) : false;
}

function isRdExcludedResult(r, prefs = {}, indexerName = "") {
  const title = String(r?.Title || "");
  const indexerText = resultIndexerText(r, indexerName);
  const group = extractGroup(title) || "";
  return (
    textHasAnyTerm(title, splitFilterTerms(prefs.rdExcludeKeywords)) ||
    textHasAnyTerm(title, splitFilterTerms(prefs.rdExcludeQualities)) ||
    textHasAnyTerm(indexerText, splitFilterTerms(prefs.rdExcludeIndexers)) ||
    textHasAnyTerm(group || title, splitFilterTerms(prefs.rdExcludeGroups))
  );
}

function hasDirectInfoHash(r) {
  return !!(r?.InfoHash || (r?.MagnetUri && extractInfoHashFromMagnet(r.MagnetUri)));
}

// extractInfoHash local (para evitar dependência circular; torrentUtils exporta a canônica)
function extractInfoHashFromMagnet(magnet) {
  if (!magnet) return null;
  const hex = magnet.match(/btih:([a-fA-F0-9]{40})(?:[&?]|$)/i);
  return hex ? hex[1].toLowerCase() : null;
}

// Sem cache: a saída depende de prefs.addonName e streamMeta (título/ano/temporada),
// que não podem fazer parte de uma chave leve — cache aqui causava nome/descrição
// errados entre usuários e títulos diferentes.
function formatStream(r, indexerName, isAnime = false, prefs = {}, showSeeds = true, streamMeta = {}) {
  const t = r.Title || "";
  const res = first(RESOLUTION, t);
  const qual = first(QUALITY, t);
  const codec = first(CODEC, t);
  const audios = matchAll(AUDIO, t);
  const vis = matchAll(VISUAL, t);
  const langs = getLangs(t, isAnime);
  const group = extractGroup(t);
  let size = fmtBytes(r.Size);
  if (!size && t) {
    const sizeMatch = t.match(/\[?([0-9.,]+(?:[ ]*)?(?:GiB|MiB|KiB|GB|MB|KB))\]?/i);
    if (sizeMatch) size = sizeMatch[1].toUpperCase().replace(/\s+/g, '').replace(/I/g, 'i');
  }
  const seeds = r._displaySeeds ?? r.Seeders ?? 0;
  const cleanIndexer = renameIndexer(indexerName);
  const addonName = prefs.addonName || "ProwJack";

  const resMap = {
    "2160p": "🟣 4K",
    "1440p": "🟡 2K",
    "1080p": "🔵 FHD",
    "720p": "🟢 HD",
    "576p": "⚫ SD",
    "480p": "⚫ SD",
  };
  const resLabel = res ? (resMap[res.label] || res.label) : "Links";
  const visualLabel = vis.length
    ? vis.map(v => v.label)
        .map(v => v === "HDR10+" ? "💫 HDR10+" : v === "HDR10" ? "🌟 HDR10" : v === "HDR" ? "🌟 HDR" : v === "DV" ? "⭐️ DV" : v)
        .join(" 🔹 ")
    : "";
  const codecLabel = codec ? codec.label.replace(/H\.265/i, "HEVC").replace(/H\.264/i, "AVC") : "";
  const langLine = langs.length ? `🔊 ${langs.map(l => l.label).join(" • ")}` : "";
  const brGroup = group && /(bioma|c76|franceira|sigla|sf|tossato|sh4down|7sprit7|pia|riper|tomtom|andrehsa|fly|cza)/i.test(group) ? "🇧🇷 " : "";

  const titleLine = [
    streamMeta.title ? `🎬 ${streamMeta.title}` : "",
    streamMeta.year ? `(${streamMeta.year})` : "",
    streamMeta.formattedSeasons ? `🍂 ${streamMeta.formattedSeasons}` : "",
  ].filter(Boolean).join(" ");

  const desc = [
    titleLine,
    [size ? `💾 ${size}` : "", codecLabel ? `🎞️ ${codecLabel}` : "", qual ? `🎥 ${qual.label}` : ""].filter(Boolean).join("  "),
    [langLine, audios.length ? `🎧 ${audios.map(a => a.label).join(" • ")}` : ""].filter(Boolean).join("  "),
    [showSeeds && seeds > 0 ? `🌱 ${seeds}` : "", visualLabel].filter(Boolean).join("  "),
    [group ? `${brGroup}🫟 ${group}` : "", cleanIndexer ? `⚙️ ${cleanIndexer}` : ""].filter(Boolean).join("  "),
  ].filter(Boolean).join("\n");

  const result = { name: `${addonName}\n${resLabel}`, description: desc.trim(), resLabel };
  return result;
}

module.exports = {
  RESOLUTION, QUALITY, CODEC, AUDIO, VISUAL, LANG,
  TITLE_CLEANUP_REGEX, STOPWORDS,
  first, matchAll, uniq, normTitle,
  getLangs, score,
  normalizeTitleTokens, escapedWordRegex,
  titleMatchScore, relaxedTitleMatchScore, normalizedTokenOverlap,
  extractReleaseYear, normalizeImdbId, getResultImdbId,
  looksLikeEpisodeRelease, isCompletePack,
  parseEpisodeRanges, hasAnyEpisodeMarker,
  episodeMatchRank, animeEpisodeMatchRank,
  seriesEpisodeMatches, animeEpisodeMatches,
  normalizeForDedupe, dedupeResults, dedupeWithCachePriority,
  extractGroup, fmtBytes,
  renameIndexer, stripSourceBadges,
  visibleSeedCount, matchesKeywordBoost,
  splitFilterTerms, textHasAnyTerm,
  resultIndexerText, isPriorityIndexerResult, isRdExcludedResult,
  hasDirectInfoHash, formatStream,
};
