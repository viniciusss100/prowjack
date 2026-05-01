"use strict";

const axios = require("axios");
const { injectTrackers } = require("./torrentEnrich");

// =========================
// HELPER FUNCTIONS
// =========================

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

// =========================
// REAL-DEBRID FUNCTIONS
// =========================

async function rdFindExistingTorrent(hash, key) {
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", {
        headers: { Authorization: `Bearer ${key}` },
        params: { page, limit: 100 },
        timeout: 8000
      });
      const torrents = Array.isArray(res.data) ? res.data : [];
      const found = torrents.find(t => t.hash?.toLowerCase() === hash.toLowerCase());
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

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// NOVA VERSÃO - Cache check otimizado
async function rdBatchCheckCache(hashes, key, bufferMap = {}, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};

  const uniqueHashes = [...new Set(hashes.map(h => String(h || "").toLowerCase()).filter(h => /^[0-9a-f]{40}$/.test(h)))];
  console.log(`[RD] rdBatchCheckCache: ${uniqueHashes.length} hashes, ${privateHashes.size} privados`);
  if (!uniqueHashes.length) return {};

  const headersAuth = { Authorization: `Bearer ${key}` };

  // instantAvailability é read-only. Não use addMagnet aqui: isso cria itens na
  // conta do usuário e pode deixar o RD aguardando seleção/confirmação no site.
  try {
    const resultMap = {};
    for (const group of chunkArray(uniqueHashes, 80)) {
      const res = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${group.join("/")}`,
        { headers: headersAuth, timeout: 15000 }
      );
      const data = res.data || {};
      for (const hash of group) {
        const entry = data[hash.toLowerCase()] || data[hash];
        if (entry?.rd?.length) resultMap[hash.toLowerCase()] = { rd: entry.rd };
      }
    }
    console.log(`[RD] instantAvailability: ${Object.keys(resultMap).length} cached`);
    return resultMap;
  } catch (e) {
    console.log(`[RD] instantAvailability falhou (${e.response?.status || e.message}); cache check read-only retornando vazio`);
    return {};
  }
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

  // Recarrega o torrent depois de selectFiles para evitar usar links antigos ou
  // de outro arquivo quando o torrent já existia na conta RD.
  if (isExisting) {
    try {
      const infoRes = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: headersAuth, timeout: 8000 }
      );
      if (infoRes.data?.status === "downloaded" && infoRes.data?.links?.length) {
        links = infoRes.data.links;
      }
    } catch {}
  }

  // Polling com backoff
  const delays = [2000, 3000, 5000];

  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));

    try {
      const infoRes = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: headersAuth, timeout: 8000 }
      );

      const info = infoRes.data;

      if (info?.status === "downloaded" && info?.links?.length) {
        links = info.links;
        break;
      }

      if (["magnet_error", "error", "virus", "dead"].includes(info?.status)) {
        break;
      }
    } catch {}
  }

  if (!links?.length) return null;

  try {
    const unresRes = await axios.post(
      "https://api.real-debrid.com/rest/1.0/unrestrict/link",
      `link=${encodeURIComponent(links[0])}`,
      {
        headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 12000
      }
    );

    return {
      download: unresRes.data?.download,
      filename: unresRes.data?.filename || null
    };
  } catch {
    return null;
  }
}

// =========================
// TORBOX FUNCTIONS
// =========================

async function torboxAddTorrent(magnet, key, waitForReady = false, buffer = null) {
  try {
    const FormData = require('form-data');
    const form = new FormData();
    
    if (buffer) {
      form.append('file', buffer, { filename: 'torrent.torrent', contentType: 'application/x-bittorrent' });
    } else if (magnet) {
      form.append('magnet', magnet);
    } else {
      return null;
    }
    
    // Configurações padrão
    form.append('seed', '1');
    form.append('allow_zip', 'false');

    const res = await axios.post(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      form,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          ...form.getHeaders()
        },
        timeout: 20000,
        validateStatus: s => s < 500
      }
    );

    if (res.data?.success) {
      return res.data.data;
    }

    // Detecção de duplicata conforme Jackio
    const detail = res.data?.detail || "";
    if (detail.includes("exists") || detail.includes("already") || detail.includes("duplicate")) {
       const infoHash = magnet?.match(/btih:([a-f0-9]+)/i)?.[1];
       if (infoHash) {
         const myTorrents = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
           headers: { Authorization: `Bearer ${key}` },
           params: { bypass_cache: "true" }
         }).catch(() => null);
         const existing = myTorrents?.data?.data?.find(t => t.hash?.toLowerCase() === infoHash.toLowerCase());
         if (existing) return existing;
       }
    }

    console.error(`[TorBox] Erro ao adicionar torrent: ${JSON.stringify(res.data)}`);
    return null;
  } catch (err) {
    console.error(`[TorBox] Exception ao adicionar torrent: ${err.message}`);
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

async function torboxBatchCheckCache(hashes, key, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};

  try {
    const res = await axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
      params: { hash: hashes.join(","), format: "object", list_files: "true" },
      headers: { Authorization: `Bearer ${key}` },
      timeout: 10000
    });

    const resultMap = {};
    const data = res.data?.data || {};

    for (const hash of hashes) {
      const cached = data[hash];
      if (cached && typeof cached === "object" && cached !== false) {
        resultMap[hash.toLowerCase()] = cached;
      }
    }

    return resultMap;
  } catch (err) {
    console.error(`[TorBox] Erro no cache check: ${err.message}`);
    return {};
  }
}

// =========================
// RESOLVE DEBRID STREAM
// =========================

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

  // Dual mode: tenta ambos
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

  // Real-Debrid only
  if (mode === "realdebrid" && rdKey) {
    const rdStream = await resolveRDStream(infoHash, magnet, season, episode, isAnime, rdKey, files, rdCache || {}, buffer);
    return rdStream ? { ...rdStream, provider: "Real-Debrid" } : null;
  }

  // TorBox only
  if (mode === "torbox" && torboxKey) {
    const tbStream = await resolveTBStream(infoHash, magnet, season, episode, isAnime, torboxKey, files, tbCache || false, buffer);
    return tbStream ? { ...tbStream, provider: "TorBox" } : null;
  }

  return null;
}

async function resolveRDStream(infoHash, magnet, season, episode, isAnime, key, files, cache, buffer) {
  if (!cache || !cache.rd || !cache.rd.length) {
    return { queued: true, cached: false };
  }

  const variant = cache.rd[0];
  const fileIds = Object.keys(variant);

  if (season != null && episode != null) {
    // Encontrar arquivo específico do episódio
    const matchedFile = findBestFileMatch(variant, season, episode, isAnime);
    if (!matchedFile) return { queued: true, cached: true };

    const link = await rdGetDirectLink(infoHash, magnet, [matchedFile.id], key, buffer);
    if (link?.download) {
      return { url: link.download, filename: matchedFile.filename };
    }
    return { queued: true, cached: true };
  }

  // Filme: pega o maior arquivo
  const largestFile = Object.entries(variant)
    .sort((a, b) => (b[1].filesize || 0) - (a[1].filesize || 0))[0];

  if (!largestFile) return { queued: true, cached: true };

  const link = await rdGetDirectLink(infoHash, magnet, [largestFile[0]], key, buffer);
  if (link?.download) {
    return { url: link.download, filename: largestFile[1].filename };
  }

  return { queued: true, cached: true };
}

async function resolveTBStream(infoHash, magnet, season, episode, isAnime, key, files, cache, buffer) {
  if (!cache || typeof cache !== "object" || cache === false) {
    return { queued: true, cached: false };
  }

  // TorBox 'cache' pode ser:
  // 1. O objeto torrent completo (vindo do on-demand polling em addon.js)
  // 2. A lista de arquivos (vindo do batchCheckCache)
  
  const torrentId = cache.id || cache.torrent_id;
  const filesList = cache.files || (Array.isArray(cache) ? cache : null);

  // Caso 1: Torrent já está no painel e finalizado
  const isReady = cache.download_finished === true || cache.download_present === true || cache.download_state === "cached";

  if (torrentId && isReady && filesList) {
    const variant = {};
    filesList.forEach(f => {
      variant[f.id] = { filename: f.name, filesize: f.size };
    });

    let matchedFile;
    if (season != null && episode != null) {
      matchedFile = findBestFileMatch(variant, season, episode, isAnime);
    } else {
      const largest = Object.entries(variant)
        .sort((a, b) => (b[1].filesize || 0) - (a[1].filesize || 0))[0];
      if (largest) matchedFile = { id: largest[0], ...largest[1] };
    }

    if (matchedFile) {
      const url = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${torrentId}&file_id=${matchedFile.id}&redirect=true`;
      return { url, filename: matchedFile.filename };
    }
  }

  // Caso 2: Apenas dados de cache check (lista de arquivos)
  if (filesList) {
    const variant = {};
    filesList.forEach((f, idx) => {
      const fid = f.id !== undefined ? f.id : idx;
      variant[fid] = { filename: f.name || f.filename, filesize: f.size || f.filesize };
    });

    let matchedFile;
    if (season != null && episode != null) {
      matchedFile = findBestFileMatch(variant, season, episode, isAnime);
    } else {
      const largest = Object.entries(variant)
        .sort((a, b) => (b[1].filesize || 0) - (a[1].filesize || 0))[0];
      if (largest) matchedFile = { id: largest[0], ...largest[1] };
    }

    if (!matchedFile) return { queued: true, cached: true };

    // Adicionamos agora (instantâneo se estiver cacheado no TorBox)
    const added = await torboxAddTorrent(magnet || buildMagnet(infoHash, null, infoHash), key, false, buffer);
    if (added && (added.id || added.torrent_id)) {
      const tid = added.id || added.torrent_id;
      const url = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${tid}&file_id=${matchedFile.id}&redirect=true`;
      return { url, filename: matchedFile.filename };
    }
  }

  return { queued: true, cached: true };
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

// =========================
// EXPORTS
// =========================

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
