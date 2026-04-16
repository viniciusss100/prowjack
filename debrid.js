"use strict";
/**
 * debrid.js — Módulo de integração com serviços Debrid
 * * FIX: Suporte ao Upload de Buffer do arquivo .torrent (Inspirado no Jackettio)
 * Torrents de Trackers Privados agora usam "addTorrent" (upload de arquivo) 
 * em vez de "addMagnet" (que falha na conversão de metadados via DHT).
 */

const axios = require("axios");
const { injectTrackers } = require("./torrentEnrich");

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "https://tracker.nanoha.org/announce",
].map(t => `&tr=${encodeURIComponent(t)}`).join("");

function buildMagnet(infoHash, existingMagnet, title) {
  if (existingMagnet && existingMagnet.startsWith("magnet:")) {
    if (!existingMagnet.includes("&tr=")) return existingMagnet + TRACKERS;
    return existingMagnet;
  }
  const dn = encodeURIComponent(title || infoHash);
  return `magnet:?xt=urn:btih:${infoHash}&dn=${dn}${TRACKERS}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCH DE EPISÓDIOS
// ─────────────────────────────────────────────────────────────────────────────

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
  if (/\b(complete|completa|batch)\b/i.test(t)) return 1;
  return 0;
}

function episodeMatchRank(title, season, episode) {
  if (season == null || episode == null) return 1;
  const t    = (title || "").toLowerCase();
  const sRaw = parseInt(season, 10);
  const eRaw = parseInt(episode, 10);
  if (new RegExp(`\\bs0*${sRaw}[\\s._-]*e0*${eRaw}\\b|\\b0*${sRaw}x0*${eRaw}\\b`, "i").test(t)) return 4;
  const seasonOnly = new RegExp(`\\bs0*${sRaw}\\b|\\bseason\\s?0*${sRaw}\\b|\\btemporada\\s?0*${sRaw}\\b`, "i");
  if (seasonOnly.test(t) && !/\bs\d{1,2}[\s._-]*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bepisodes?\s*\d{1,3}\b|\bep\s*\d{1,3}\b/i.test(t)) return 2;
  if (/\b(complete|completa|batch)\b/i.test(t)) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// TORBOX
// ─────────────────────────────────────────────────────────────────────────────

async function torboxBatchCheckCache(hashes, key, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};
  const resultMap = {};

  // Torrents privados são excluídos: a API do TorBox pode adicioná-los
  // automaticamente à conta ao processar o cache check, causando downloads indesejados.
  const publicHashes = hashes.filter(h => !privateHashes.has(h));
  if (!publicHashes.length) return resultMap;

  const chunks = [];
  for (let i = 0; i < publicHashes.length; i += 50) chunks.push(publicHashes.slice(i, i + 50));

  const results = await Promise.allSettled(
    chunks.map(chunk =>
      axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
        params: { hash: chunk.join(","), format: "object", list_files: true },
        headers: { Authorization: `Bearer ${key}` },
        timeout: 10000,
        validateStatus: s => s < 500,
      })
    )
  );

  for (const r of results) {
    if (r.status !== "fulfilled") { console.log(`  [TorBox Batch] Erro: ${r.reason?.message}`); continue; }
    const data = r.value.data;
    if (!data?.success || !data?.data) continue;
    // Trata array (format:list) ou objeto (format:object)
    if (Array.isArray(data.data)) {
      for (const h of data.data) {
        if (typeof h === "string") resultMap[h.toLowerCase()] = true;
        else if (h?.hash) resultMap[h.hash.toLowerCase()] = h;
      }
    } else {
      for (const [k, v] of Object.entries(data.data)) {
        if (v) resultMap[k.toLowerCase()] = v;
      }
    }
  }
  return resultMap;
}

function torboxBuildPermalink(torrentId, fileId, key) {
  if (!torrentId && torrentId !== 0) {
    throw new Error(`TorBox: torrent_id inválido (${torrentId})`);
  }
  return `https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
}

function torboxPickFile(files, season, episode, isAnime) {
  if (!Array.isArray(files) || !files.length) return { fileId: 0, name: null };

  const withMeta = files.map((f, idx) => ({
    idx, fileId: f.id ?? idx, size: f.size || 0, name: f.name || f.short_name || "",
  }));

  if (season == null && episode == null) {
    const videoFiles = withMeta.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : withMeta;
    const best = pool.reduce((a, b) => b.size > a.size ? b : a);
    return { fileId: best.fileId, name: best.name };
  }

  const scored = withMeta.map(f => ({
    ...f,
    rank: isAnime ? animeEpisodeMatchRank(f.name, episode) : episodeMatchRank(f.name, season, episode),
  })).filter(f => f.rank > 0);

  if (!scored.length) {
    const videoFiles = withMeta.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : withMeta;
    const best = pool.reduce((a, b) => b.size > a.size ? b : a);
    return { fileId: best.fileId, name: best.name };
  }
  const best = scored.reduce((a, b) => b.rank > a.rank || (b.rank === a.rank && b.size > a.size) ? b : a);
  return { fileId: best.fileId, name: best.name };
}

/**
 * Adiciona ao TorBox (com suporte ao upload de Buffer Binário)
 */
async function torboxAddTorrent(magnet, key, addOnlyIfCached = false, torrentBuffer = null) {
  try {
    const headers = { Authorization: `Bearer ${key}` };
    let data;

    // Se temos o .torrent, enviamos fisicamente (imprescindível para trackers privados)
    if (torrentBuffer) {
      const enriched = injectTrackers(torrentBuffer);
      const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
      const parts = [];
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="seed"\r\n\r\n3\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="allow_zip"\r\n\r\nfalse\r\n`));
      if (addOnlyIfCached) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="add_only_if_cached"\r\n\r\ntrue\r\n`));
      }
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`));
      parts.push(enriched);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      
      data = Buffer.concat(parts);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    } else {
      if (!magnet) return false;
      const params = { magnet, seed: "3", allow_zip: "false" };
      if (addOnlyIfCached) params.add_only_if_cached = "true";
      data = new URLSearchParams(params).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const res = await axios.post(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      data,
      { headers, timeout: 12000, validateStatus: s => s < 500 }
    );
    if (res.data?.success) {
      const tId = res.data.data?.torrent_id ?? res.data.data?.id;
      if (tId !== undefined && tId !== null) return tId;
      return true;
    }
    console.log(`[TorBox] createtorrent falhou: HTTP ${res.status} — ${JSON.stringify(res.data)}`);
    return false;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-DEBRID
// ─────────────────────────────────────────────────────────────────────────────

async function rdBatchCheckCache(hashes, key, bufferMap = {}) {
  if (!hashes || !hashes.length) return {};
  const resultMap = {};

  // instantAvailability está depreciado e retorna falsos negativos.
  // Verificamos via add + selectFiles + status imediato (top 5 por performance).
  const topHashes = hashes.slice(0, 5);
  const headersAuth = { Authorization: `Bearer ${key}` };

  await Promise.allSettled(topHashes.map(async hash => {
    let torrentId;
    try {
      const buf = bufferMap[hash];
      if (buf) {
        // Tracker privado: usa upload do .torrent (addMagnet falha sem metadados DHT)
        const enriched = injectTrackers(buf);
        const addRes = await axios.put(
          "https://api.real-debrid.com/rest/1.0/torrents/addTorrent", enriched,
          { headers: { ...headersAuth, "Content-Type": "application/x-bittorrent" }, timeout: 12000, validateStatus: s => s < 500 }
        );
        torrentId = addRes.data?.id;
      } else {
        const magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce`;
        const addRes = await axios.post(
          "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
          `magnet=${encodeURIComponent(magnet)}`,
          { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000, validateStatus: s => s < 500 }
        );
        torrentId = addRes.data?.id;
      }
      if (!torrentId) return;

      let info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: headersAuth, timeout: 8000 }).then(r => r.data);

      if (info.status === "waiting_files_selection") {
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
          "files=all", { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000, validateStatus: s => s < 500 });
        await new Promise(r => setTimeout(r, 700));
        info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
          { headers: headersAuth, timeout: 8000 }).then(r => r.data);
      }

      if (info.status === "downloaded" || info.progress === 100) {
        // Monta entrada compatível com o formato esperado pelo _resolveRD
        const rdEntry = {};
        for (const f of (info.files || [])) {
          if (f.selected) rdEntry[f.id] = { filename: f.path?.split("/").pop() || "", filesize: f.bytes || 0 };
        }
        resultMap[hash] = { rd: [rdEntry], _torrentId: torrentId, _links: info.links };
      } else {
        // Polling extra rápido
        await new Promise(r => setTimeout(r, 800));
        const info2 = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
          { headers: headersAuth, timeout: 8000 }).then(r => r.data);
        if (info2.status === "downloaded" || info2.progress === 100) {
          const rdEntry = {};
          for (const f of (info2.files || [])) {
            if (f.selected) rdEntry[f.id] = { filename: f.path?.split("/").pop() || "", filesize: f.bytes || 0 };
          }
          resultMap[hash] = { rd: [rdEntry], _torrentId: torrentId, _links: info2.links };
        } else {
          await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`,
            { headers: headersAuth, timeout: 6000 }).catch(() => {});
        }
      }
    } catch (err) {
      if (torrentId) axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`,
        { headers: headersAuth, timeout: 6000 }).catch(() => {});
    }
  }));

  return resultMap;
}

function rdPickFileIds(cacheEntry, season, episode, isAnime) {
  const files = Object.entries(cacheEntry).map(([id, info]) => ({
    id, name: info.filename || "", size: info.filesize || 0,
  }));
  if (!files.length) return ["all"];

  if (season == null && episode == null) {
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : files;
    return [pool.reduce((a, b) => b.size > a.size ? b : a).id];
  }

  const scored = files.map(f => ({
    ...f,
    rank: isAnime ? animeEpisodeMatchRank(f.name, episode) : episodeMatchRank(f.name, season, episode),
  })).filter(f => f.rank > 0);

  if (!scored.length) {
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : files;
    return [pool.reduce((a, b) => b.size > a.size ? b : a).id];
  }
  return [scored.reduce((a, b) => b.rank > a.rank || (b.rank === a.rank && b.size > a.size) ? b : a).id];
}

async function rdDeleteTorrent(torrentId, key) {
  if (!torrentId) return;
  try {
    await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`,
      { headers: { Authorization: `Bearer ${key}` }, timeout: 6000 });
    console.log(`  [Real-Debrid] Torrent ${torrentId} deletado da conta após uso.`);
  } catch {}
}

async function rdFindExistingTorrent(hash, key) {
  try {
    const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", {
      headers: { Authorization: `Bearer ${key}` },
      params: { limit: 100 },
      timeout: 8000,
      validateStatus: s => s < 500,
    });
    return res.data?.find(t => t.hash?.toLowerCase() === hash && t.status === "downloaded") || null;
  } catch { return null; }
}

async function rdGetDirectLink(hash, magnet, fileIds, key, torrentBuffer = null) {
  const headersAuth = { Authorization: `Bearer ${key}` };
  let torrentId;
  let isExisting = false;

  // Reutiliza torrent já existente na conta (evita re-add e polling desnecessário)
  const existing = await rdFindExistingTorrent(hash, key);
  if (existing) {
    torrentId = existing.id;
    isExisting = true;
  } else {
    try {
      if (torrentBuffer) {
        const enriched = injectTrackers(torrentBuffer);
        const addRes = await axios.put("https://api.real-debrid.com/rest/1.0/torrents/addTorrent", enriched,
          { headers: { ...headersAuth, "Content-Type": "application/x-bittorrent" }, timeout: 12000, validateStatus: s => s < 500 });
        torrentId = addRes.data?.id;
      } else {
        const addRes = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
          `magnet=${encodeURIComponent(magnet)}`,
          { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000, validateStatus: s => s < 500 });
        torrentId = addRes.data?.id;
      }
      if (!torrentId) return null;
    } catch { return null; }

    try {
      const filesParam = Array.isArray(fileIds) && fileIds.length && fileIds[0] !== "all" ? fileIds.join(",") : "all";
      await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
        `files=${encodeURIComponent(filesParam)}`,
        { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000, validateStatus: s => s < 500 });
    } catch {
      await rdDeleteTorrent(torrentId, key); return null;
    }
  }

  // Se já existia e estava downloaded, tenta pegar links direto sem polling
  if (isExisting && existing.links?.length) {
    try {
      const unresRes = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link",
        `link=${encodeURIComponent(existing.links[0])}`,
        { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 });
      const downloadUrl = unresRes.data?.download;
      const filename    = unresRes.data?.filename || null;
      if (downloadUrl) return { download: downloadUrl, filename };
    } catch {}
  }

  // Polling para torrents recém-adicionados
  let links = null;
  const delays = [600, 1000, 1000, 1200, 1200, 1500];
  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));
    try {
      const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: headersAuth, timeout: 10000 });
      const info = infoRes.data;
      if (info?.status === "downloaded" && info?.links?.length) { links = info.links; break; }
      if (["magnet_error", "error", "virus", "dead"].includes(info?.status)) break;
    } catch {}
  }

  if (!links?.length) return null;

  let downloadUrl = null, filename = null;
  try {
    const unresRes = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link",
      `link=${encodeURIComponent(links[0])}`,
      { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 });
    downloadUrl = unresRes.data?.download || null;
    filename    = unresRes.data?.filename  || null;
  } catch { return null; }

  return downloadUrl ? { download: downloadUrl, filename } : null;
}

async function rdAddTorrent(magnet, key, torrentBuffer = null) {
  try {
    let torrentId;
    if (torrentBuffer) {
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-bittorrent" };
      const addRes = await axios.put("https://api.real-debrid.com/rest/1.0/torrents/addTorrent", torrentBuffer, { headers, timeout: 12000, validateStatus: s => s < 500 });
      torrentId = addRes.data?.id;
    } else {
      if (!magnet) return false;
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
      const addRes = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", `magnet=${encodeURIComponent(magnet)}`, { headers, timeout: 12000, validateStatus: s => s < 500 });
      torrentId = addRes.data?.id;
    }
    if (!torrentId) return false;
    
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      "files=all", { headers, timeout: 10000, validateStatus: s => s < 500 });
    return true;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRADOR
// ─────────────────────────────────────────────────────────

async function resolveDebridStream(infoHash, magnet, title, season, episode, isAnime, config, torrentFiles, rdCacheEntry, tbCacheEntry, torrentBuffer) {
  const { mode, torboxKey, rdKey } = config || {};
  const useTorbox = (mode === "torbox"     || mode === "dual") && !!torboxKey;
  const useRD     = (mode === "realdebrid" || mode === "dual") && !!rdKey;

  if (!useTorbox && !useRD) return null;

  const enrichedMagnet = buildMagnet(infoHash, magnet, title);

  if (useTorbox && useRD) {
    const [tbResult, rdResult] = await Promise.allSettled([
      _resolveTorbox(infoHash, enrichedMagnet, season, episode, isAnime, torboxKey, torrentFiles, tbCacheEntry, torrentBuffer),
      _resolveRD(infoHash, enrichedMagnet, season, episode, isAnime, rdKey, rdCacheEntry, torrentBuffer),
    ]);

    const results = [];
    if (tbResult.status === "fulfilled" && tbResult.value) results.push(tbResult.value);
    if (rdResult.status === "fulfilled" && rdResult.value) results.push(rdResult.value);

    return results.length > 0 ? { multi: results } : null;
  }

  if (useTorbox) return _resolveTorbox(infoHash, enrichedMagnet, season, episode, isAnime, torboxKey, torrentFiles, tbCacheEntry, torrentBuffer);
  if (useRD) return _resolveRD(infoHash, enrichedMagnet, season, episode, isAnime, rdKey, rdCacheEntry, torrentBuffer);

  return null;
}

async function _resolveTorbox(infoHash, magnet, season, episode, isAnime, key, torrentFiles, tbCacheEntry, torrentBuffer) {
  // tbCacheEntry pode ser `true` (cacheado mas sem metadados) ou um objeto completo
  const hasCache = tbCacheEntry && (tbCacheEntry === true || (typeof tbCacheEntry === 'object' && tbCacheEntry !== false));

  if (hasCache) {
    const torrentId = (tbCacheEntry !== true) ? (tbCacheEntry.id ?? tbCacheEntry.torrent_id ?? null) : null;
    const files  = (tbCacheEntry !== true && tbCacheEntry.files) ? tbCacheEntry.files : (torrentFiles || []);
    const picked = torboxPickFile(files, season, episode, isAnime);

    if (torrentId != null) {
      const url = torboxBuildPermalink(torrentId, picked.fileId, key);
      return { url, provider: "TorBox", filename: picked.name || null };
    }

    // Fallback: sem ID no cache entry (ou entry === true), adiciona para obter o ID
    const addedTorrentId = await torboxAddTorrent(magnet, key, true, torrentBuffer);
    if (addedTorrentId && addedTorrentId !== true) {
      const url = torboxBuildPermalink(addedTorrentId, picked.fileId, key);
      return { url, provider: "TorBox", filename: picked.name || null };
    }
  }
  return { queued: true, provider: "TorBox" };
}

async function _resolveRD(infoHash, magnet, season, episode, isAnime, key, rdCacheEntry, torrentBuffer) {
  if (rdCacheEntry && Array.isArray(rdCacheEntry.rd) && rdCacheEntry.rd.length > 0) {
    const entry = rdCacheEntry.rd[0];
    const fileIds = rdPickFileIds(entry, season, episode, isAnime);

    // Se o batch check já deixou o torrent adicionado e com links prontos, usa direto
    if (rdCacheEntry._torrentId && rdCacheEntry._links?.length) {
      const headersAuth = { Authorization: `Bearer ${key}` };
      const selectedFiles = Object.keys(entry);
      const linkIndex = fileIds[0] !== "all"
        ? Math.max(0, selectedFiles.indexOf(String(fileIds[0])))
        : 0;
      const link = rdCacheEntry._links[linkIndex] || rdCacheEntry._links[0];
      try {
        const unresRes = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link",
          `link=${encodeURIComponent(link)}`,
          { headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 });
        const downloadUrl = unresRes.data?.download;
        if (downloadUrl) {
          await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${rdCacheEntry._torrentId}`,
            { headers: headersAuth, timeout: 6000 }).catch(() => {});
          return { url: downloadUrl, provider: "Real-Debrid", filename: unresRes.data?.filename || null };
        }
      } catch {}
    }

    const result = await rdGetDirectLink(infoHash, magnet, fileIds, key, torrentBuffer);
    if (result?.download) {
      return { url: result.download, provider: "Real-Debrid", filename: result.filename || null };
    }
  }
  // Torrent pode ter sido adicionado anteriormente (via on-demand ou batch); verifica antes de retornar queued
  const existing = await rdFindExistingTorrent(infoHash, key);
  if (existing?.links?.length) {
    const result = await rdGetDirectLink(infoHash, magnet, ["all"], key, torrentBuffer);
    if (result?.download) {
      return { url: result.download, provider: "Real-Debrid", filename: result.filename || null };
    }
  }
  return { queued: true, provider: "Real-Debrid" };
}

module.exports = {
  buildMagnet,
  resolveDebridStream,
  torboxBatchCheckCache,
  torboxPickFile,
  torboxAddTorrent,
  rdBatchCheckCache,
  rdPickFileIds,
  rdFindExistingTorrent,
  rdGetDirectLink,
  rdAddTorrent,
};
