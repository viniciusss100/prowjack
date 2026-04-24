"use strict";
const axios  = require("axios");
const https  = require("https");
const crypto = require("crypto");

// Aumenta limite de listeners para evitar warnings com múltiplas conexões TLS simultâneas
https.globalAgent.setMaxListeners(0);
require("events").EventEmitter.defaultMaxListeners = 0;

const POLL_INTERVAL_MS = 45 * 60 * 1000;
const RSS_CACHE_TTL    = 24 * 3600; // 24h
const CACHE_VERSION    = "v12-native-debrid";

// Extrai infoHash de buffer .torrent
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

// Baixa .torrent e extrai infoHash durante o polling (timeout generoso de 30s)
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

// Detecta indexers privados via API do Prowlarr ou Jackett
async function fetchPrivateIndexers(jUrl, jKey) {
  // Tenta Prowlarr primeiro
  try {
    const res = await axios.get(`${jUrl}/api/v1/indexer`, {
      params: { apikey: jKey }, timeout: 8000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data)) {
      const privates = res.data
        .filter(ix => ix.privacy === "private" || ix.privacy === "semiPrivate")
        .map(ix => ({ id: String(ix.id), name: String(ix.name || ix.id) }));
      if (privates.length) return privates;
      // Prowlarr respondeu mas sem privados — retorna todos configurados
      return res.data.map(ix => ({ id: String(ix.id), name: String(ix.name || ix.id) }));
    }
  } catch {}

  // Fallback: Jackett — busca indexers via torznab caps
  try {
    const params = { t: "indexers", configured: "true" };
    if (jKey) params.apikey = jKey;
    const res = await axios.get(`${jUrl}/api/v2.0/indexers/all/results/torznab/api`, {
      params, timeout: 8000, responseType: "text", validateStatus: () => true,
    });
    if (res.status < 400 && typeof res.data === "string") {
      const indexers = [];
      for (const m of res.data.matchAll(/<indexer\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/gi)) {
        const id = m[1];
        if (!id || id === "all") continue;
        const titleMatch = m[2].match(/<title>([^<]+)<\/title>/i);
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

// Parseia XML torznab/RSS
function decodeXml(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function parseRssItems(xml, indexerId, indexerName) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const attrs = {};
    for (const m of item.matchAll(/<(?:torznab:)?attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?/gi))
      attrs[m[1].toLowerCase()] = decodeXml(m[2]);

    const tag = (t) => { const m = item.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`, "i")); return m ? decodeXml(m[1].trim()) : null; };
    const enc = item.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*length="([^"]*)"/i);
    const magnetUri = attrs.magneturl || null;
    const link      = magnetUri || tag("link") || enc?.[1] || null;
    const size      = attrs.size ? parseInt(attrs.size, 10) : (enc?.[2] ? parseInt(enc[2], 10) : 0);
    const seedersRaw = attrs.seeders != null ? parseInt(attrs.seeders, 10) : null;

    const title = tag("title") || "";
    if (!title || (!link && !magnetUri)) return null;

    // Classifica categoria pelo título
    const isAnime  = /\b(anime|animes)\b/i.test(attrs.category || "") || /\[SubsPlease\]|\[Erai-raws\]|\[HorribleSubs\]/i.test(title);
    const isSeries = !isAnime && (/\bS\d{1,2}E\d{1,3}\b|\bSeason\b|\bTemporada\b/i.test(title) || /\b\d{1,2}x\d{1,3}\b/.test(title));
    const type     = isAnime ? "anime" : isSeries ? "series" : "movie";

    return {
      Title:       title,
      Guid:        tag("guid") || link || "",
      Link:        link,
      MagnetUri:   magnetUri,
      Size:        Number.isFinite(size) ? size : 0,
      Seeders:     seedersRaw ?? 1,
      _displaySeeds: seedersRaw ?? 0,
      InfoHash:    attrs.infohash ? attrs.infohash.toLowerCase() : null,
      Tracker:     String(indexerId),
      TrackerId:   String(indexerId),
      _indexerName: indexerName || String(indexerId),
      ImdbId:      attrs.imdbid || attrs.imdb || null,
      PublishDate: tag("pubDate") || null,
      _structuredMatch: true,
      _rssType:    type,
    };
  }).filter(Boolean);
}

async function fetchIndexerRss(jUrl, jKey, indexerId, indexerName, rc) {
  // Prowlarr: /{numericId}/api — Jackett: /api/v2.0/indexers/{id}/results/torznab/api
  const isProwlarr = /^\d+$/.test(String(indexerId));
  const url = isProwlarr
    ? `${jUrl}/${indexerId}/api`
    : `${jUrl}/api/v2.0/indexers/${indexerId}/results/torznab/api`;
  try {
    const res = await axios.get(url, {
      params: { apikey: jKey, t: "search", q: "" },
      timeout: 20000, responseType: "text", validateStatus: () => true,
    });
    if (res.status >= 400) return [];
    const items = parseRssItems(String(res.data || ""), indexerId, indexerName);

    // Resolve infoHash em background e re-salva no Redis conforme resolve
    setImmediate(async () => {
      let idx = 0;
      let updated = false;
      async function worker() {
        while (idx < items.length) {
          const item = items[idx++];
          if (!item.InfoHash) {
            const result = await resolveItemHash(item);
            if (result?.hash) {
              item.InfoHash = result.hash;
              updated = true;
              if (result.buffer) {
                await rc.setBuffer(`torrent:${result.hash}`, result.buffer, 7 * 24 * 3600).catch(() => {});
              }
            }
          }
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      if (updated) await saveHashesOnly(rc, indexerId, indexerName, items);
    });

    return items;
  } catch (err) {
    console.log(`[RSS] ${indexerName || indexerId}: ${err.message}`);
    return [];
  }
}

// Gera a mesma cacheKey que jackettSearch usa para uma query vazia por indexer
function buildRssCacheKey(indexerId, type) {
  const queryList = [];
  const search    = null;
  const parsed    = { type, isAnime: type === "anime" };
  const key       = Buffer.from(JSON.stringify({ queryList, search, parsed })).toString("base64");
  return `rss:${CACHE_VERSION}:${indexerId}:${type}:${key}`;
}

// Extrai título limpo e ano do nome do release
function parseTorrentTitle(raw) {
  const year = (raw.match(/\b(19\d{2}|20\d{2})\b/) || [])[1];
  const clean = raw
    .replace(/\[.*?\]|\(.*?\)/g, " ")
    .replace(/\b(19|20)\d{2}\b.*$/i, "")
    .replace(/\b(S\d{1,2}E\d{1,3}|Season\s?\d+|Temporada\s?\d+)\b.*/i, "")
    .replace(/\b(2160p|1080p|720p|480p|BluRay|WEB-DL|WEBRip|HDTV|REMUX|x264|x265|HEVC|AAC|AC3|DTS|DUAL|MULTI|PT-BR|DUBLADO)\b.*/i, "")
    .replace(/[._]+/g, " ").trim();
  return { clean, year: year ? parseInt(year, 10) : null };
}

// Resolve imdbId via Cinemeta por busca de título
async function resolveImdbByTitle(title, year, type) {
  try {
    const query = encodeURIComponent(title);
    const stremioType = type === "movie" ? "movie" : "series";
    const res = await axios.get(
      `https://v3-cinemeta.strem.io/catalog/${stremioType}/top/search=${query}.json`,
      { timeout: 6000 }
    );
    const metas = res.data?.metas || [];
    if (!metas.length) return null;

    const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
    const queryNorm = normalize(title);

    // Só aceita se o título do Cinemeta bater com o título buscado
    const candidates = metas.filter(m => {
      const metaNorm = normalize(m.name || m.title || "");
      return metaNorm === queryNorm || metaNorm.includes(queryNorm) || queryNorm.includes(metaNorm);
    });
    if (!candidates.length) return null;

    if (year) {
      const match = candidates.find(m => {
        const my = parseInt((m.releaseInfo || m.year || "").toString().slice(0, 4), 10);
        return Math.abs(my - year) <= 1;
      });
      if (match) return match;
    }
    return candidates[0];
  } catch {
    return null;
  }
}

const CATALOG_TTL = 6 * 3600; // 6h
const CATALOG_KEY = "rss:catalog"; // hash Redis: field = "movie" | "series" | "anime"

// Salva resultados no Redis agrupados por tipo + atualiza catálogo
async function saveToRedis(rc, indexerId, indexerName, items, skipCatalog = false) {
  const byType = { movie: [], series: [], anime: [] };
  for (const item of items) {
    const t = item._rssType === "anime" ? "anime" : item._rssType === "series" ? "series" : "movie";
    byType[t].push(item);
  }

  for (const [type, list] of Object.entries(byType)) {
    const key = buildRssCacheKey(indexerId, type);
    if (!list.length) {
      await rc.del(key);
      continue;
    }
    await rc.set(key, JSON.stringify(list), RSS_CACHE_TTL);
    console.log(`[RSS] ${indexerName} (${type}): ${list.length} itens salvos`);
  }

  // Atualiza catálogo apenas se explicitamente solicitado
  if (!skipCatalog) setImmediate(() => updateCatalog(rc, items).catch(() => {}));
}

async function saveHashesOnly(rc, indexerId, indexerName, items) {
  // Salva apenas os hashes atualizados sem disparar updateCatalog
  const byType = { movie: [], series: [], anime: [] };
  for (const item of items) {
    const t = item._rssType === "anime" ? "anime" : item._rssType === "series" ? "series" : "movie";
    byType[t].push(item);
  }
  for (const [type, list] of Object.entries(byType)) {
    if (!list.length) continue;
    const key = buildRssCacheKey(indexerId, type);
    await rc.set(key, JSON.stringify(list), RSS_CACHE_TTL).catch(() => {});
  }
}

// Deduplica por imdbId e atualiza catálogo no Redis
async function updateCatalog(rc, newItems) {
  // Agrupa por tipo
  const byType = { movie: [], series: [], anime: [] };
  for (const item of newItems) {
    const t = item._rssType === "anime" ? "anime" : item._rssType === "series" ? "series" : "movie";
    byType[t].push(item);
  }

  for (const [type, items] of Object.entries(byType)) {
    if (!items.length) continue;

    // Carrega catálogo existente
    const seenIds  = new Set();

    // Coleta imdbIds presentes no cache RSS atual para este tipo
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

    // Carrega catálogo existente, filtrando apenas itens ainda presentes no cache RSS
    const rawCatalog = await rc.get(`${CATALOG_KEY}:${type}`);
    const existing   = rawCatalog
      ? JSON.parse(rawCatalog).filter(m => !activeIds.size || activeIds.has(m.id))
      : [];

    const resolved = [];
    for (const item of items) {
      // Tenta usar imdbId direto do feed
      let imdbId = item.ImdbId ? (item.ImdbId.startsWith("tt") ? item.ImdbId : `tt${item.ImdbId}`) : null;
      let meta   = null;

      if (imdbId) {
        // Busca metadados direto pelo id
        try {
          const stremioType = type === "movie" ? "movie" : "series";
          const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${stremioType}/${imdbId}.json`, { timeout: 5000 });
          meta = r.data?.meta;
        } catch {}
      }

      if (!meta) {
        // Fallback: busca por título
        const { clean, year } = parseTorrentTitle(item.Title);
        if (!clean || clean.length < 3) continue;
        const stremioType = type === "movie" ? "movie" : "series";
        meta = await resolveImdbByTitle(clean, year, stremioType);
        if (meta) imdbId = meta.id || meta.imdb_id;
      }

      if (!meta || !imdbId) continue;
      if (seenIds.has(imdbId)) continue;
      seenIds.add(imdbId);

      resolved.push({
        id:          imdbId,
        type:        type === "movie" ? "movie" : "series",
        name:        meta.name || meta.title || item.Title,
        poster:      meta.poster || null,
        background:  meta.background || null,
        description: meta.description || null,
        releaseInfo: meta.releaseInfo || meta.year || null,
        imdbRating:  meta.imdbRating || null,
        genres:      meta.genres || [],
        _addedAt:    Date.now(),
      });

      // Pausa para não sobrecarregar Cinemeta
      await new Promise(r => setTimeout(r, 300));
    }

    if (!resolved.length) continue;

    // Merge: novos na frente + existentes ainda no cache RSS, limita 200
    const existingFiltered = existing.filter(m => !seenIds.has(m.id));
    const merged = [...resolved, ...existingFiltered].slice(0, 200);
    await rc.set(`${CATALOG_KEY}:${type}`, JSON.stringify(merged), CATALOG_TTL);
    console.log(`[RSS Catalog] ${type}: +${resolved.length} novos (total ${merged.length})`);
  }
}

async function pollOnce(jUrl, jKey, rc) {
  console.log("[RSS] Iniciando polling de indexers privados...");
  const indexers = await fetchPrivateIndexers(jUrl, jKey);
  if (!indexers.length) {
    console.log("[RSS] Nenhum indexer privado encontrado.");
    return;
  }
  console.log(`[RSS] ${indexers.length} indexers privados: ${indexers.map(i => i.name).join(", ")}`);

  for (const ix of indexers) {
    const items = await fetchIndexerRss(jUrl, jKey, ix.id, ix.name, rc);
    if (items.length) await saveToRedis(rc, ix.id, ix.name, items);
    await new Promise(r => setTimeout(r, 1000));
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
      setTimeout(runWhenReady, 90000); // fallback 90s
    }
  } else {
    setTimeout(runWhenReady, 5000);
  }

  console.log(`[RSS] Poller agendado (intervalo: ${POLL_INTERVAL_MS / 60000} min)`);
}

module.exports = { startRssPoller, buildRssCacheKey, CATALOG_KEY };
