"use strict";
const axios  = require("axios");
const https  = require("https");
const crypto = require("crypto");
const { enrichMetaPtBr } = require("./metadata");
const { CACHE_VERSION } = require("./constants");

https.globalAgent.setMaxListeners(50);
require("events").EventEmitter.defaultMaxListeners = 50;

const POLL_INTERVAL_MS = 45 * 60 * 1000;
const RSS_CACHE_TTL    = 24 * 3600;
const CATALOG_TTL      = 24 * 3600;

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #1: Cache compilado para regex (não recompila)         ║
// ╚════════════════════════════════════════════════════════════════════╝
const CATEGORY_REGEX = {
  anime: /\b(anime|animes)\b/i,
  animeTag: /\[SubsPlease\]|\[Erai-raws\]|\[HorribleSubs\]/i,
  series: /\bS\d{1,2}E\d{1,3}\b/i,
  seriesDots: /\b\d{1,2}x\d{1,3}\b/,
  seriesSeason: /\bSeason\s?\d{1,2}\b/i,
  seriesTemporada: /\bTemporada\s?\d{1,2}\b/i,
  seriesEpisode: /\bEpisode\s?\d{1,3}\b/i,
  seriesEp: /\bEp\s?\d{1,3}\b/i,
  seriesS: /\bS\d{2}\b/i,
  seriesCap: /\bcap[ií]tulo\s?\d{1,3}\b/i,
  seriesCategory: /\b(TV Series|TV Show|Serie|Series)\b/i,
};

const ATTR_REGEX = /<(?:torznab:)?attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?/gi;
const TAG_REGEX = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
const CDATA_REGEX = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const ENCLOSURE_REGEX = /<enclosure\b[^>]*url="([^"]+)"[^>]*length="([^"]*)"/i;
const ITEM_REGEX = /<item\b[\s\S]*?<\/item>/gi;
const INDEXER_REGEX = /<indexer\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/gi;

// Extracting hash from torrent binary
function extractHashFromTorrent(buf) {
  if (!Buffer.isBuffer(buf) || buf[0] !== 0x64) return null;
  const s = buf.toString("latin1");
  const pos = s.indexOf("4:info");
  if (pos === -1) return null;
  let i = pos + 6, depth = 0, iter = 0;
  const start = i;
  while (i < s.length && iter++ < 500000) {
    const c = s[i];
    if      (c === "d" || c === "l") { depth++; i++; }
    else if (c === "e")              { depth--; i++; if (depth === 0) break; }
    else if (c === "i")              { i = s.indexOf("e", i + 1) + 1; }
    else if (c >= "0" && c <= "9")  { const col = s.indexOf(":", i); if (col === -1) break; i = col + 1 + parseInt(s.slice(i, col), 10); }
    else i++;
  }
  if (depth !== 0) return null;
  return crypto.createHash("sha1").update(buf.slice(start, i)).digest("hex");
}

async function resolveItemHash(item) {
  if (item.InfoHash) return { hash: item.InfoHash.toLowerCase(), buffer: null };
  if (item.MagnetUri) {
    const m = item.MagnetUri.match(/btih:([a-fA-F0-9]{40})/i);
    return m ? { hash: m[1].toLowerCase(), buffer: null } : null;
  }
  if (!item.Link) return null;
  try {
    const res = await axios.get(item.Link, {
      responseType: "arraybuffer", timeout: 30000, maxRedirects: 10,
      maxContentLength: 8 * 1024 * 1024, validateStatus: s => s < 400,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const buf = Buffer.from(res.data);
    const hash = extractHashFromTorrent(buf);
    return hash ? { hash, buffer: buf } : null;
  } catch { return null; }
}

async function fetchPrivateIndexers(jUrl, jKey) {
  const catalogFilter = (process.env.RSS_CATALOG_INDEXERS || "").trim();

  // Tenta Prowlarr primeiro
  try {
    const res = await axios.get(`${jUrl}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      const all = res.data.map(ix => ({ id: String(ix.id), name: String(ix.name || ix.id) }));
      if (catalogFilter) return all;
      const privates = all.filter((_, i) =>
        res.data[i].privacy === "private" || res.data[i].privacy === "semiPrivate"
      );
      return privates.length ? privates : all;
    }
  } catch {}

  // Fallback: Jackett
  try {
    const params = { t: "indexers", configured: "true" };
    if (jKey) params.apikey = jKey;
    const res = await axios.get(`${jUrl}/api/v2.0/indexers/all/results/torznab/api`, {
      params, timeout: 8000, responseType: "text", validateStatus: () => true,
    });
    if (res.status < 400 && typeof res.data === "string") {
      const indexers = [];
      for (const m of res.data.matchAll(INDEXER_REGEX)) {
        const id = m[1];
        if (!id || id === "all") continue;
        const titleMatch = m[2].match(TAG_REGEX("title"));
        const name = titleMatch ? titleMatch[1].trim() : id;
        indexers.push({ id, name });
      }
      if (indexers.length) return indexers;
    }
  } catch (err) {
    console.log(`[RSS] Erro ao buscar indexers: ${err.message}`);
  }
  return [];
}

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #2: Decodificação com cache inline                     ║
// ╚════════════════════════════════════════════════════════════════════╝
function decodeXml(str = "") {
  return str
    .replace(CDATA_REGEX, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function parseRssItems(xml, indexerId, indexerName) {
  const items = xml.match(ITEM_REGEX) || [];
  return items.map(item => {
    const attrs = {};
    for (const m of item.matchAll(ATTR_REGEX))
      attrs[m[1].toLowerCase()] = decodeXml(m[2]);

    const getTag = (t) => { const m = item.match(TAG_REGEX(t)); return m ? decodeXml(m[1].trim()) : null; };
    const enc = item.match(ENCLOSURE_REGEX);
    const magnetUri = attrs.magneturl || null;
    const link      = magnetUri || getTag("link") || enc?.[1] || null;
    const size      = attrs.size ? parseInt(attrs.size, 10) : (enc?.[2] ? parseInt(enc[2], 10) : 0);
    const seedersParsed = attrs.seeders != null ? parseInt(attrs.seeders, 10) : null;
    const seedersRaw = Number.isFinite(seedersParsed) ? seedersParsed : null;

    const title = getTag("title") || "";
    if (!title || (!link && !magnetUri)) return null;

    // ╔════════════════════════════════════════════════════════════════╗
    // ║ OTIMIZAÇÃO #3: Usar regex compiladas (não recompila)          ║
    // ╚════════════════════════════════════════════════════════════════╝
    const isAnime  = CATEGORY_REGEX.anime.test(attrs.category || "") || 
                    CATEGORY_REGEX.animeTag.test(title);
    const isSeries = !isAnime && (
      CATEGORY_REGEX.series.test(title) ||
      CATEGORY_REGEX.seriesDots.test(title) ||
      CATEGORY_REGEX.seriesSeason.test(title) ||
      CATEGORY_REGEX.seriesTemporada.test(title) ||
      CATEGORY_REGEX.seriesEpisode.test(title) ||
      CATEGORY_REGEX.seriesEp.test(title) ||
      CATEGORY_REGEX.seriesS.test(title) ||
      CATEGORY_REGEX.seriesCap.test(title) ||
      CATEGORY_REGEX.seriesCategory.test(attrs.category || "")
    );
    const type     = isAnime ? "anime" : isSeries ? "series" : "movie";

    return {
      Title:       title,
      Guid:        getTag("guid") || link || "",
      Link:        link,
      MagnetUri:   magnetUri,
      Size:        Number.isFinite(size) ? size : 0,
      Seeders:     seedersRaw ?? 0,
      _displaySeeds: seedersRaw ?? 0,
      InfoHash:    (attrs.infohash && /^[a-f0-9]{40}$/i.test(attrs.infohash))
        ? attrs.infohash.toLowerCase()
        : null,
      Tracker:     String(indexerId),
      TrackerId:   String(indexerId),
      _indexerName: indexerName || String(indexerId),
      ImdbId:      attrs.imdbid || attrs.imdb || null,
      PublishDate: getTag("pubDate") || null,
      _structuredMatch: true,
      _rssType:    type,
    };
  }).filter(Boolean);
}

async function fetchIndexerRss(jUrl, jKey, indexerId, indexerName, rc) {
  const isProwlarr = /^\d+$/.test(String(indexerId));
  const url = isProwlarr
    ? `${jUrl}/${indexerId}/api`
    : `${jUrl}/api/v2.0/indexers/${indexerId}/results/torznab/api`;
  try {
    const res = await axios.get(url, {
      params: { apikey: jKey, t: "search", q: "" },
      timeout: 20000, responseType: "text", validateStatus: () => true,
    });
    if (res.status === 429) { console.log(`[RSS] ${indexerName || indexerId}: rate limit (429)`); return []; }
    if (res.status >= 400) { console.log(`[RSS] ${indexerName || indexerId}: HTTP ${res.status}`); return []; }
    const items = parseRssItems(String(res.data || ""), indexerId, indexerName);

    // Resolve background com controle de concorrência
    setImmediate(async () => {
      let idx = 0;
      const CONC = 3;
      async function worker() {
        while (idx < items.length) {
          const item = items[idx++];
          if (!item.InfoHash) {
            const result = await resolveItemHash(item);
            if (result?.hash) {
              item.InfoHash = result.hash;
              if (result.buffer) {
                await rc.setBuffer(`torrent:${result.hash}`, result.buffer, 7 * 24 * 3600).catch(() => {});
              }
            }
          }
        }
      }
      await Promise.all(Array.from({ length: CONC }, worker));
      await saveHashesOnly(rc, indexerId, indexerName, items);
    });

    return items;
  } catch { return []; }
}

function buildRssCacheKey(indexerId, type) {
  // Sufixo fixo ':items' em vez de random:
  //  - determinístico: o mesmo indexer/type sempre gera a mesma chave (sem acúmulo no Redis)
  //  - compatível com os globs `rss:v12:*:type:*` usados em loadRssItemsForType,
  //    updateCatalog e no fast-path do stream handler
  return `rss:${CACHE_VERSION}:${indexerId}:${type}:items`;
}

async function saveToRedis(rc, indexerId, indexerName, items, skipCatalog = false) {
  const byType = { movie: [], series: [], anime: [] };
  for (const item of items) {
    const t = item._rssType === "anime" ? "anime" : item._rssType === "series" ? "series" : "movie";
    byType[t].push(item);
  }

  for (const [type, list] of Object.entries(byType)) {
    const key = buildRssCacheKey(indexerId, type);
    if (!list.length) continue;
    await rc.set(key, JSON.stringify(list), RSS_CACHE_TTL);
    console.log(`[RSS] ${indexerName} (${type}): ${list.length} itens salvos`);
  }

  if (!skipCatalog) setImmediate(() => updateCatalog(rc, items, indexerId).catch(() => {}));
}

async function saveHashesOnly(rc, indexerId, indexerName, items) {
  const byType = { movie: [], series: [], anime: [] };
  for (const item of items) {
    const t = item._rssType === "anime" ? "anime" : item._rssType === "series" ? "series" : "movie";
    byType[t].push(item);
  }
  for (const [type, list] of Object.entries(byType)) {
    if (!list.length) continue;
    // Usa a mesma chave determinística de saveToRedis (sem random)
    const key = buildRssCacheKey(indexerId, type);
    await rc.set(key, JSON.stringify(list), RSS_CACHE_TTL).catch(() => {});
  }
}

async function updateCatalog(rc, newItems, indexerId = null) {
  const byType = { movie: [], series: [], anime: [] };
  for (const item of newItems) {
    const t = item._rssType === "anime" ? "anime" : item._rssType === "series" ? "series" : "movie";
    byType[t].push(item);
  }

  for (const [type, items] of Object.entries(byType)) {
    if (!items.length) continue;

    const seenIds  = new Set();
    const rssKeys = await rc.keys(`rss:${CACHE_VERSION}:*:${type}:*`);
    const activeIds = new Set();
    for (const key of rssKeys) {
      try {
        const raw = await rc.get(key);
        if (!raw) continue;
        for (const item of JSON.parse(raw)) {
          if (item.ImdbId) activeIds.add(item.ImdbId.startsWith("tt") ? item.ImdbId : `tt${item.ImdbId}`);
        }
      } catch {}
    }

    const rawCatalog = await rc.get(`rss:catalog:${type}`);
    const existing   = rawCatalog
      ? JSON.parse(rawCatalog).filter(m => !activeIds.size || activeIds.has(m.id))
      : [];

    const resolved = [];
    let idx = 0;

    // ╔════════════════════════════════════════════════════════════════╗
    // ║ OTIMIZAÇÃO #4: Worker pool com limit de concorrência          ║
    // ╚════════════════════════════════════════════════════════════════╝
    const CONC_WORKERS = 5;
    async function resolveWorker() {
      while (idx < items.length) {
        const item = items[idx++];
        let imdbId = item.ImdbId ? (item.ImdbId.startsWith("tt") ? item.ImdbId : `tt${item.ImdbId}`) : null;

        // Se não tiver ImdbId, tenta encontrar via busca por título no Cinemeta
        if (!imdbId && item.Title) {
          try {
            const stremioType = type === "movie" ? "movie" : "series";
            const searchRes = await axios.get(
              `https://v3-cinemeta.strem.io/search/${stremioType}/${encodeURIComponent(item.Title)}.json`,
              { timeout: 5000, validateStatus: () => true }
            );
            const match = searchRes.data?.metas?.[0];
            if (match?.imdb_id) {
              imdbId = match.imdb_id.startsWith("tt") ? match.imdb_id : `tt${match.imdb_id}`;
              item.ImdbId = imdbId; // persiste no item para saveHashesOnly
            }
          } catch {}
        }

        let meta = null;

        if (imdbId) {
          try {
            const stremioType = type === "movie" ? "movie" : "series";
            const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${stremioType}/${imdbId}.json`, { timeout: 5000 });
            meta = r.data?.meta;
            meta = await enrichMetaPtBr(meta, imdbId, stremioType);
          } catch {}
        }

        if (meta && imdbId) {
          if (seenIds.has(imdbId)) continue;
          seenIds.add(imdbId);

          resolved.push({
            id:          type === "movie" ? `rssmovie:${imdbId}` : `rssmeta:${type}:${imdbId.replace(/^tt/i,"")}`,
            type:        type === "movie" ? "movie" : "series",
            name:        meta.name || meta.title || item.Title,
            poster:      meta.poster || null,
            background:  meta.background || null,
            description: meta.description || null,
            releaseInfo: meta.releaseInfo || meta.year || null,
            imdbRating:  meta.imdbRating || null,
            _addedAt:    Date.now(),
          });
        }
      }
    }

    await Promise.all(Array.from({ length: CONC_WORKERS }, resolveWorker));

    if (!resolved.length) continue;

    const existingFiltered = existing.filter(m => !seenIds.has(m.id));
    const merged = [...resolved, ...existingFiltered].slice(0, 200);
    const CATALOG_KEY = "rss:catalog";
    await rc.set(`${CATALOG_KEY}:${type}`, JSON.stringify(merged), CATALOG_TTL);
    console.log(`[RSS Catalog] ${type}: +${resolved.length} novos (total ${merged.length})`);
  }

  // Salva os itens atualizados (agora com ImdbId descoberto) de volta no cache raw
  if (indexerId) {
    for (const [type, list] of Object.entries(byType)) {
      if (!list.length) continue;
      const key = buildRssCacheKey(indexerId, type);
      await rc.set(key, JSON.stringify(list), 86400 * 3).catch(() => {});
    }
  }
}

async function pollOnce(jUrl, jKey, rc) {
  const catalogFilter = (process.env.RSS_CATALOG_INDEXERS || "").trim();
  if (!catalogFilter) {
    console.log("[RSS] RSS_CATALOG_INDEXERS não configurado. Polling RSS desabilitado.");
    return;
  }

  console.log("[RSS] Iniciando polling de indexers configurados...");
  const indexers = await fetchPrivateIndexers(jUrl, jKey);
  if (!indexers.length) {
    console.log("[RSS] Nenhum indexer retornado da API.");
    return;
  }
  
  const indexersToPoll = indexers.filter(ix => {
    const tokens = catalogFilter.toLowerCase().split(",").map(s => s.trim());
    return tokens.includes(String(ix.id)) || tokens.some(t => ix.name.toLowerCase().includes(t));
  });

  if (!indexersToPoll.length) {
    console.log(`[RSS] Nenhum dos indexers configurados (${catalogFilter}) foi encontrado.`);
    return;
  }

  console.log(`[RSS] Polling limitado a: ${indexersToPoll.map(i => i.name).join(", ")}`);

  for (const ix of indexersToPoll) {
    const items = await fetchIndexerRss(jUrl, jKey, ix.id, ix.name, rc);
    // skipCatalog=false: updateCatalog deve ser chamado após salvar os itens
    if (items.length) await saveToRedis(rc, ix.id, ix.name, items, false);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log("[RSS] Polling concluído.");
}

function startRssPoller(jUrl, jKey, rc, redisClient) {
  let started = false;
  const runWhenReady = () => {
    if (started) return;
    started = true;
    pollOnce(jUrl, jKey, rc).catch(err => console.log(`[RSS] Erro: ${err.message}`));
    setInterval(() => {
      pollOnce(jUrl, jKey, rc).catch(err => console.log(`[RSS] Erro: ${err.message}`));
    }, POLL_INTERVAL_MS);
  };

  if (redisClient && typeof redisClient.on === "function") {
    redisClient.setMaxListeners(20);
    if (redisClient.status === "ready") {
      setTimeout(runWhenReady, 2000);
    } else {
      redisClient.once("ready", () => setTimeout(runWhenReady, 2000));
      setTimeout(runWhenReady, 90000);
    }
  } else {
    setTimeout(runWhenReady, 5000);
  }

  console.log(`[RSS] Poller agendado (intervalo: ${POLL_INTERVAL_MS / 60000} min)`);
}

const CATALOG_KEY = "rss:catalog";

module.exports = { startRssPoller, buildRssCacheKey, CATALOG_KEY, updateCatalog };
