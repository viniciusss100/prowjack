"use strict";

const axios = require("axios");
const { injectTrackers } = require("./torrentEnrich");

function buildMagnet(infoHash, existingMagnet, title) {
  if (existingMagnet && existingMagnet.startsWith("magnet:")) return existingMagnet;
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://open.dstud.io:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.dler.com:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://p4p.arenabg.com:1337/announce",
    "udp://bt.ktrackers.com:6666/announce",
    "http://tracker.bt4g.com:2095/announce",
    "http://open.trackerlist.xyz:80/announce",
  ];
  const dn = title ? `&dn=${encodeURIComponent(title)}` : "";
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

function logRdAddFailure(stage, res) {
  const status = res?.status || "sem status";
  const data = typeof res?.data === "string" ? res.data : JSON.stringify(res?.data || {});
  console.log(`[RD] ${stage} falhou: HTTP ${status} ${data.slice(0, 500)}`);
}

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #1: Deduplicação mais eficiente com Set único          ║
// ╚════════════════════════════════════════════════════════════════════╝
async function rdFindExistingTorrent(hash, key) {
  try {
    const hashLower = hash.toLowerCase();
    for (let page = 1; page <= 5; page++) {
      const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", {
        headers: { Authorization: `Bearer ${key}` },
        params: { page, limit: 100 },
        timeout: 8000
      });
      const torrents = Array.isArray(res.data) ? res.data : [];
      const found = torrents.find(t => String(t.hash || "").toLowerCase() === hashLower);
      if (found) return found;
      if (torrents.length < 100) break;
    }
    return null;
  } catch {
    return null;
  }
}

async function rdDeleteTorrent(id, key) {
  try {
    await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${id}`, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 5000
    });
  } catch {}
}

async function rdAddTorrent(magnet, key, buffer = null) {
  const headersAuth = { Authorization: `Bearer ${key}` };
  
  try {
    if (buffer) {
      const enriched = injectTrackers(buffer);
      const res = await axios.put(
        "https://api.real-debrid.com/rest/1.0/torrents/addTorrent",
        enriched,
        {
          headers: { ...headersAuth, "Content-Type": "application/x-bittorrent" },
          timeout: 12000,
          validateStatus: s => s < 500
        }
      );
      if (!res.data?.id) logRdAddFailure("addTorrent", res);
      return !!res.data?.id;
    }
    
    const res = await axios.post(
      "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
      `magnet=${encodeURIComponent(magnet)}`,
      {
        headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 12000,
        validateStatus: s => s < 500
      }
    );
    if (!res.data?.id) logRdAddFailure("addMagnet", res);
    return !!res.data?.id;
  } catch {
    return false;
  }
}

async function rdSelectFiles(torrentId, fileIds, key) {
  const filesParam = Array.isArray(fileIds) && fileIds.length && fileIds[0] !== "all"
    ? fileIds.join(",")
    : "all";
  const res = await axios.post(
    `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
    `files=${encodeURIComponent(filesParam)}`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 8000,
      validateStatus: s => s < 500
    }
  );
  if (res.status >= 400) throw new Error(`RD selectFiles HTTP ${res.status}`);
}

async function rdListDownloadedHashes(hashes, headersAuth) {
  const resultMap = {};
  const wanted = new Set((hashes || []).map(h => String(h || "").toLowerCase()).filter(h => /^[0-9a-f]{40}$/.test(h)));
  if (!wanted.size) return resultMap;
  try {
    for (let page = 1; page <= 5; page++) {
      const listRes = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", {
        headers: headersAuth,
        params: { page, limit: 100 },
        timeout: 8000,
        validateStatus: s => s < 500,
      });
      if (listRes.status >= 400 || !Array.isArray(listRes.data)) {
        console.log(`[RD] torrents list fallback falhou: HTTP ${listRes.status}`);
        break;
      }
      for (const torrent of listRes.data) {
        const hash = String(torrent.hash || "").toLowerCase();
        if (wanted.has(hash) && (torrent.status === "downloaded" || Number(torrent.progress) >= 100 || torrent.links?.length)) {
          resultMap[hash] = { rd: [{ all: { filename: torrent.filename || torrent.name || "", filesize: torrent.bytes || 0, __accountCached: true } }] };
        }
      }
      if (listRes.data.length < 100) break;
    }
  } catch (err) {
    console.log(`[RD] torrents list fallback falhou (${err.response?.status || err.message})`);
  }
  return resultMap;
}

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #2: Batch check cache com deduplicação eficiente       ║
// ╚════════════════════════════════════════════════════════════════════╝
async function rdBatchCheckCache(hashes, key, bufferMap = {}, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};

  // Deduplicar em um único Set
  const uniqueHashes = new Set();
  for (const h of hashes) {
    const normalized = String(h || "").toLowerCase();
    if (/^[0-9a-f]{40}$/.test(normalized)) uniqueHashes.add(normalized);
  }
  
  console.log(`[RD] rdBatchCheckCache: ${uniqueHashes.size} hashes únicos, ${privateHashes.size} privados`);
  if (!uniqueHashes.size) return {};

  const headersAuth = { Authorization: `Bearer ${key}` };
  const resultMap = await rdListDownloadedHashes([...uniqueHashes], headersAuth);
  console.log(`[RD] conta: ${Object.keys(resultMap).length} cached`);
  return resultMap;
}

async function rdGetDirectLink(hash, magnet, fileIds, key, torrentBuffer = null) {
  const headersAuth = { Authorization: `Bearer ${key}` };
  let torrentId;
  let isExisting = false;
  let links = null;

  const existing = await rdFindExistingTorrent(hash, key);

  if (existing) {
    torrentId = existing.id;
    isExisting = true;
  } else {
    try {
      if (torrentBuffer) {
        const enriched = injectTrackers(torrentBuffer);
        const addRes = await axios.put(
          "https://api.real-debrid.com/rest/1.0/torrents/addTorrent",
          enriched,
          {
            headers: { ...headersAuth, "Content-Type": "application/x-bittorrent" },
            timeout: 12000,
            validateStatus: s => s < 500
          }
        );
        torrentId = addRes.data?.id;
      } else {
        const addRes = await axios.post(
          "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
          `magnet=${encodeURIComponent(magnet)}`,
          {
            headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 12000,
            validateStatus: s => s < 500
          }
        );
        torrentId = addRes.data?.id;
        if (!torrentId) logRdAddFailure("addMagnet", addRes);
      }

      if (!torrentId) return null;
    } catch {
      return null;
    }

    try {
      await rdSelectFiles(torrentId, fileIds, key);
    } catch {
      await rdDeleteTorrent(torrentId, key);
      return null;
    }
  }

  if (isExisting) {
    try {
      await rdSelectFiles(torrentId, fileIds, key);
    } catch {
      return null;
    }
  }

  try {
    const getRes = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      {
        headers: headersAuth,
        timeout: 8000,
        validateStatus: s => s < 400,
      }
    );
    if (getRes.status < 400 && getRes.data?.links?.length) {
      const dl = getRes.data.links[0];
      return { download: dl };
    }
  } catch {}
  
  return null;
}

async function torboxAddTorrent(magnet, key, waitForReady = false, buffer = null, options = {}) {
  const { isFallback = false } = options;
  const headersAuth = { Authorization: `Bearer ${key}` };

  try {
    let torrentId;

    // FormData/Blob nativos (Node 18+) — compatíveis com axios/fetch sem pacotes extras.
    const formData = new FormData();
    if (buffer) formData.append("file", new Blob([buffer], { type: "application/x-bittorrent" }), "torrent.torrent");
    else        formData.append("magnet", magnet);

    const res = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent",
      formData,
      {
        headers: headersAuth,
        timeout: 20000,
        validateStatus: s => s < 500,
      }
    );
    if (!res.data?.data?.torrent_id) {
      console.log(`[TorBox] Falha ao adicionar ${buffer ? "upload de arquivo" : "magnet"}: ${res.status}`);
      if (buffer && magnet && !isFallback) {
        console.log(`[TorBox] Tentando fallback com magnet...`);
        return torboxAddTorrent(magnet, key, waitForReady, null, { ...options, isFallback: true });
      }
      return null;
    }
    torrentId = res.data.data.torrent_id;

    if (waitForReady) {
      let retries = 0;
      while (retries < 20) {
        await new Promise(r => setTimeout(r, 500));
        const infoRes = await torboxGetTorrentInfo(torrentId, key);
        if (infoRes && infoRes.download_finished) return infoRes;
        retries++;
      }
    }

    return await torboxGetTorrentInfo(torrentId, key);
  } catch (err) {
    console.error(`[TorBox] Exception ao adicionar torrent: ${err.message}`);
    if (buffer && magnet && !isFallback) {
      console.log(`[TorBox] Exception no upload de arquivo, tentando fallback com magnet...`);
      return torboxAddTorrent(magnet, key, waitForReady, null, { ...options, isFallback: true });
    }
    return null;
  }
}

async function torboxGetTorrentInfo(torrentId, key) {
  try {
    const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
      headers: { Authorization: `Bearer ${key}` },
      params: { bypass_cache: "true" },
      timeout: 8000
    });
    return res.data?.data?.find(t => String(t.id) === String(torrentId));
  } catch {
    return null;
  }
}

async function torboxFindByHash(hash, key) {
  try {
    const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
      headers: { Authorization: `Bearer ${key}` },
      params: { bypass_cache: "true" },
      timeout: 8000
    });
    const list = res.data?.data;
    if (!Array.isArray(list)) return null;
    return list.find(t => String(t.hash || "").toLowerCase() === String(hash || "").toLowerCase()) || null;
  } catch {
    return null;
  }
}

async function torboxRequestDL(torrentId, fileId, key, source = "torrent") {
  try {
    const endpoint = source === "torrent"
      ? "https://api.torbox.app/v1/api/torrents/requestdl"
      : "https://api.torbox.app/v1/api/usenet/requestdl";
    const params = source === "torrent"
      ? { token: key, torrent_id: torrentId, file_id: fileId, zip_link: false }
      : { token: key, usenet_id: torrentId,  file_id: fileId, zip_link: false };
    const res = await axios.get(endpoint, { params, timeout: 10000 });
    return res.data?.data || null;
  } catch (err) {
    console.error(`[TorBox] requestdl erro (id=${torrentId} file=${fileId}): ${err.message}`);
    return null;
  }
}

// ╔════════════════════════════════════════════════════════════════════╗
// ║ OTIMIZAÇÃO #3: TorBox batch check com case handling único          ║
// ╚════════════════════════════════════════════════════════════════════╝
async function torboxBatchCheckCache(hashes, key, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};

  try {
    // Deduplicação única em um Set
    const uniqueHashes = new Set();
    const hashMap = new Map(); // hash.toLowerCase() -> hash original
    for (const h of hashes) {
      const lower = String(h || "").toLowerCase();
      if (lower && !uniqueHashes.has(lower)) {
        uniqueHashes.add(lower);
        hashMap.set(lower, h);
      }
    }

    const res = await axios.post("https://api.torbox.app/v1/api/torrents/checkcached",
      { hashes: [...uniqueHashes] },
      {
        params: { format: "object", list_files: "true" },
        headers: { Authorization: `Bearer ${key}` },
        timeout: 10000
      }
    );

    const resultMap = {};
    const data = res.data?.data || {};

    // Single lookup por hash normalizado
    for (const hashLower of uniqueHashes) {
      const cached = data[hashLower] ?? data[hashLower.toUpperCase()];
      if (cached && cached !== false) {
        resultMap[hashLower] = typeof cached === "object" ? cached : { cached: true };
      }
    }

    console.log(`[TorBox] checkcached: ${Object.keys(resultMap).length} cached`);
    return resultMap;
  } catch (err) {
    console.error(`[TorBox] Erro no cache check: ${err.message}`);
    return {};
  }
}

async function resolveDebridStream(
  infoHash,
  magnet,
  title,
  season,
  episode,
  isAnime,
  config,
  files,
  rdCache,
  tbCache,
  buffer
) {
  if (!config) return null;

  const { mode, torboxKey, rdKey } = config;
  const results = [];

  if (mode === "dual") {
    if (rdKey) {
      const rdStream = await resolveRDStream(infoHash, magnet, season, episode, isAnime, rdKey, files, rdCache || {}, buffer);
      if (rdStream) results.push({ ...rdStream, provider: "Real-Debrid" });
    }
    
    if (torboxKey) {
      const tbStream = await resolveTBStream(infoHash, magnet, season, episode, isAnime, torboxKey, files, tbCache || false, buffer);
      if (tbStream) results.push({ ...tbStream, provider: "TorBox" });
    }

    if (results.length > 0) return { multi: results };
    return null;
  }

  if (mode === "realdebrid" && rdKey) {
    const rdStream = await resolveRDStream(infoHash, magnet, season, episode, isAnime, rdKey, files, rdCache || {}, buffer);
    return rdStream ? { ...rdStream, provider: "Real-Debrid" } : null;
  }

  if (mode === "torbox" && torboxKey) {
    const tbStream = await resolveTBStream(infoHash, magnet, season, episode, isAnime, torboxKey, files, tbCache || false, buffer);
    return tbStream ? { ...tbStream, provider: "TorBox" } : null;
  }

  return null;
}

async function resolveRDStream(infoHash, magnet, season, episode, isAnime, key, files, cache, buffer) {
  if (!infoHash) return null;
  const headersAuth = { Authorization: `Bearer ${key}` };

  if (!cache || !cache.rd || !cache.rd.length) {
    const isPrivate = buffer && !magnet;
    if (isPrivate) return null;
    return { queued: true, cached: false };
  }

  const variant = cache.rd[0];

  if (season != null && episode != null) {
    const matchedFile = findBestFileMatch(variant, season, episode, isAnime);
    if (!matchedFile) return { queued: true, cached: true };
    const link = await rdGetDirectLink(infoHash, magnet, [matchedFile.id], key, buffer);
    if (link?.download) return { url: link.download, filename: matchedFile.filename };
    return { queued: true, cached: true };
  }

  const largestFile = Object.entries(variant)
    .sort((a, b) => (b[1].filesize || 0) - (a[1].filesize || 0))[0];
  if (!largestFile) return { queued: true, cached: true };

  const link = await rdGetDirectLink(infoHash, magnet, [largestFile[0]], key, buffer);
  if (link?.download) return { url: link.download, filename: largestFile[1].filename };
  return { queued: true, cached: true };
}

async function resolveTBStream(infoHash, magnet, season, episode, isAnime, key, files, cache, buffer) {
  if (!infoHash && !cache?.id) return null;
  if (!cache || typeof cache !== "object" || cache === false) {
    const isPrivate = buffer && !magnet;
    if (isPrivate) return null;
    return { queued: true, cached: false };
  }

  // Extrai dados do cache
  const torrentId = cache.id || cache.torrent_id;
  const filesList = cache.files || (Array.isArray(cache) ? cache : null);
  const isReady   = cache.download_finished === true
                 || cache.download_present  === true
                 || cache.download_state    === "cached"
                 || cache.cached            === true;

  // Caso 1: torrent já está na conta do usuário (veio do mylist com id real)
  if (torrentId && isReady && filesList) {
    const variant = {};
    filesList.forEach(f => { variant[f.id] = { filename: f.name || f.filename, filesize: f.size || f.filesize }; });

    const matchedFile = pickTBFile(variant, season, episode, isAnime);
    if (matchedFile) {
      // Chama requestdl server-side para obter URL CDN real (igual ao tbmedia)
      const cdnUrl = await torboxRequestDL(torrentId, matchedFile.id, key);
      if (cdnUrl) return { url: cdnUrl, filename: matchedFile.filename };
      // Fallback: usa permalink sem redirect para não depender de redirecionamento
      const url = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${torrentId}&file_id=${matchedFile.id}&zip_link=false`;
      return { url, filename: matchedFile.filename };
    }
  }

  // Caso 2: veio do checkcached (cache global) — não tem torrent_id real da conta
  // Precisamos buscar o torrent na conta do usuário pelo hash
  if (filesList && Array.isArray(filesList) && filesList.length > 0) {
    const variant = {};
    filesList.forEach((f, idx) => {
      const fid = f.id !== undefined ? f.id : idx;
      variant[fid] = { filename: f.name || f.filename, filesize: f.size || f.filesize };
    });

    const matchedFile = pickTBFile(variant, season, episode, isAnime);
    if (!matchedFile) return { queued: true, cached: true };

    // Busca torrent na conta do usuário pelo hash
    if (infoHash) {
      const accountTorrent = await torboxFindByHash(infoHash, key);
      if (accountTorrent?.id) {
        // Torrent já está na conta — resolve com ID real
        const cdnUrl = await torboxRequestDL(accountTorrent.id, matchedFile.id, key);
        if (cdnUrl) return { url: cdnUrl, filename: matchedFile.filename };
        const url = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${accountTorrent.id}&file_id=${matchedFile.id}&zip_link=false`;
        return { url, filename: matchedFile.filename };
      }
    }

    // Torrent em cache global mas não na conta ainda — on-demand vai adicionar
    return { queued: true, cached: true, fileId: matchedFile.id, filename: matchedFile.filename };
  }

  return { queued: true, cached: true };
}

function pickTBFile(variant, season, episode, isAnime) {
  if (season != null && episode != null) {
    return findBestFileMatch(variant, season, episode, isAnime);
  }
  const largest = Object.entries(variant)
    .sort((a, b) => (b[1].filesize || 0) - (a[1].filesize || 0))[0];
  return largest ? { id: largest[0], ...largest[1] } : null;
}

function findBestFileMatch(variant, season, episode, isAnime) {
  const entries = Object.entries(variant);
  
  for (const [id, file] of entries) {
    const name = file.filename || file.name || "";
    
    if (isAnime) {
      const epMatch = name.match(new RegExp(`[-\\s]0*${episode}(?:v\\d+)?[\\s\\[\\(]`, "i"));
      if (epMatch) return { id, ...file };
    } else {
      const seMatch = new RegExp(`s0*${season}[\\s._-]*e0*${episode}\\b`, "i");
      if (seMatch.test(name)) return { id, ...file };
    }
  }

  return null;
}

module.exports = {
  buildMagnet,
  rdFindExistingTorrent,
  rdDeleteTorrent,
  rdAddTorrent,
  rdBatchCheckCache,
  rdGetDirectLink,
  torboxAddTorrent,
  torboxGetTorrentInfo,
  torboxBatchCheckCache,
  resolveDebridStream
};
