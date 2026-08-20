"use strict";
const crypto = require("crypto");
const axios  = require("axios");
const { rc } = require("./cache");
const { 
  animeEpisodeMatchRank, 
  episodeMatchRank, 
  normalizeTitleTokens 
} = require("./scoring");

// Constante definida no addon, mas trazemos para cá para falhas
const TORRENT_FAILURE_TTL = 3600 * 24; // 1 dia

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

function normalizeTorrentLink(link) {
  if (!link) return "";
  try {
    const url = new URL(String(link));
    url.hash = "";
    return url.toString();
  } catch {
    return String(link).trim().split("#")[0];
  }
}

function torrentFailureKeys(r) {
  const keys = [];
  if (r && r.Link) {
    const normalized = normalizeTorrentLink(r.Link);
    if (normalized) keys.push("torrent:fail:" + crypto.createHash("sha1").update(normalized).digest("hex"));
  }
  if (r && r.Guid) {
    keys.push("torrent:fail:guid:" + crypto.createHash("sha1").update(r.Guid).digest("hex"));
  }
  return keys;
}

async function torrentDownloadRecentlyFailed(r) {
  const keys = torrentFailureKeys(r);
  if (!keys.length) return false;
  for (const key of keys) {
    try {
      if (await rc.get(key)) return true;
    } catch {}
  }
  return false;
}

async function markTorrentDownloadFailed(r) {
  const keys = torrentFailureKeys(r);
  if (!keys.length) return;
  await Promise.allSettled(keys.map(key => rc.set(key, "1", TORRENT_FAILURE_TTL)));
}

const activeDownloads = new Map();
const INFOHASH_QUEUE_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.INFOHASH_QUEUE_CONCURRENCY || 3)));

function infoHashQueueKey(r) {
  if (!r) return null;
  const fallbackHash = r.InfoHash ? String(r.InfoHash).toLowerCase() : null;
  if (fallbackHash) return `hash:${fallbackHash}`;

  const magnetHash = r.MagnetUri ? extractInfoHash(r.MagnetUri) : null;
  if (magnetHash) return `magnet:${magnetHash}`;

  const httpLink = (r.Link && !String(r.Link).startsWith("magnet:")) ? String(r.Link) : null;
  if (httpLink) return `urlhash:${crypto.createHash("sha1").update(httpLink).digest("hex")}`;

  return null;
}

class InfoHashQueue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.queuedKeys = new Set();
    this.runningKeys = new Set();
  }

  enqueue(r, reqCtx = {}) {
    const key = infoHashQueueKey(r);
    if (!key || this.queuedKeys.has(key) || this.runningKeys.has(key) || activeDownloads.has(key)) return false;

    this.queue.push({ key, r, reqCtx });
    this.queuedKeys.add(key);
    this.drain();
    return true;
  }

  enqueueMany(items, limit, reqCtx = {}) {
    let added = 0;
    for (const item of [...items].slice(0, limit)) {
      if (this.enqueue(item, { ...reqCtx })) added++;
    }
    return added;
  }

  drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this.queuedKeys.delete(task.key);
      this.runningKeys.add(task.key);
      this.running++;

      resolveInfoHash(task.r, { ...task.reqCtx, waitForDownload: true })
        .catch(err => console.warn(`[InfoHashQueue] Falha ao resolver infoHash: ${err.message}`))
        .finally(() => {
          this.running--;
          this.runningKeys.delete(task.key);
          this.drain();
        });
    }
  }
}

const infoHashQueue = new InfoHashQueue(INFOHASH_QUEUE_CONCURRENCY);

async function resolveInfoHash(r, reqCtx = {}) {
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
    if (await torrentDownloadRecentlyFailed(r)) {
      return magnetHash ? { infoHash: magnetHash, files: null, buffer: null, isPrivate: false } : null;
    }

    const urlHashKey = `urlhash:${crypto.createHash("sha1").update(httpLink).digest("hex")}`;
    const guidHashKey = r.Guid ? `guidhash:${crypto.createHash("sha1").update(r.Guid).digest("hex")}` : null;
    try {
      let cachedHashStr = guidHashKey ? await rc.get(guidHashKey) : null;
      if (!cachedHashStr) cachedHashStr = await rc.get(urlHashKey);
      
      if (cachedHashStr) {
        let cachedHash = cachedHashStr;
        let isPrivate;
        if (cachedHashStr.includes("|")) {
           const parts = cachedHashStr.split("|");
           cachedHash = parts[0];
           isPrivate = parts[1] === "1";
        }
        try {
          const cachedBuf = await rc.getBuffer(`torrent:${cachedHash}`);
          if (cachedBuf) {
             if (isPrivate === undefined) isPrivate = cachedBuf.toString("latin1").includes("7:privatei1e");
             return { infoHash: cachedHash, files: extractTorrentFiles(cachedBuf), buffer: cachedBuf, isPrivate };
          }
        } catch {}
        return { infoHash: cachedHash, files: null, buffer: null, isPrivate };
      }
    } catch {}

    if (reqCtx.fastOnly) return null; 

    let downloadPromise = activeDownloads.get(urlHashKey);
    if (!downloadPromise) {
      downloadPromise = (async () => {
        let _magnetRedirect = null;
        try {
          const res = await axios.get(httpLink, {
            timeout: 25000, maxRedirects: 10, responseType: "arraybuffer",
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
            if (h) {
              rc.set(urlHashKey, `${h}|0`, 7 * 24 * 3600).catch(()=>{});
              if (guidHashKey) rc.set(guidHashKey, `${h}|0`, 7 * 24 * 3600).catch(()=>{});
            }
            return h ? { infoHash: h, files: null, buffer: null, isPrivate: false } : null;
          }
          const buf = Buffer.from(res.data);
          if (buf.length > 8 * 1024 * 1024) return magnetHash ? { infoHash: magnetHash, files: null, buffer: null, isPrivate: false } : null;
          const bodyStr = buf.toString("utf8", 0, Math.min(buf.length, 200));
          if (bodyStr.trimStart().startsWith("magnet:")) {
            const h = extractInfoHash(bodyStr.trim());
            if (h) {
              rc.set(urlHashKey, `${h}|0`, 7 * 24 * 3600).catch(()=>{});
              if (guidHashKey) rc.set(guidHashKey, `${h}|0`, 7 * 24 * 3600).catch(()=>{});
            }
            return h ? { infoHash: h, files: null, buffer: null, isPrivate: false } : null;
          }
          if (buf[0] === 0x64) {
            const infoBuf = extractInfoBuf(buf);
            if (infoBuf) {
              const realHash = crypto.createHash("sha1").update(infoBuf).digest("hex");
              const isPrivate = infoBuf.toString("latin1").includes("7:privatei1e");
              rc.setBuffer(`torrent:${realHash}`, buf, 7 * 24 * 3600).catch(() => {});
              rc.set(urlHashKey, `${realHash}|${isPrivate ? 1 : 0}`, 7 * 24 * 3600).catch(() => {});
              if (guidHashKey) rc.set(guidHashKey, `${realHash}|${isPrivate ? 1 : 0}`, 7 * 24 * 3600).catch(() => {});
              return { infoHash: realHash, files: extractTorrentFiles(buf), buffer: buf, isPrivate };
            }
          }
          return magnetHash ? { infoHash: magnetHash, files: null, buffer: null, isPrivate: false } : null;
        } catch (err) {
            if (_magnetRedirect || err.isMagnetRedirect || err.cause?.isMagnetRedirect) {
            const src = _magnetRedirect || err.cause?.magnetUrl;
            const h   = src ? extractInfoHash(src) : null;
            if (h) {
              rc.set(urlHashKey, `${h}|0`, 7 * 24 * 3600).catch(()=>{});
              if (guidHashKey) rc.set(guidHashKey, `${h}|0`, 7 * 24 * 3600).catch(()=>{});
              return { infoHash: h, files: null, buffer: null, isPrivate: false };
            }
          } else {
            await markTorrentDownloadFailed(r);
            const indexerMatch = httpLink.match(/https?:\/\/[^\/]+\/([^\/]+)\/download/);
            const idxId = indexerMatch ? `Indexador ${indexerMatch[1]}` : httpLink.slice(0,40)+'...';
            console.warn(`[WARN] Falha ao baixar torrent (${idxId}): ${err.message}`);
          }
          return magnetHash ? { infoHash: magnetHash, files: null, buffer: null, isPrivate: false } : null;
        } finally {
          activeDownloads.delete(urlHashKey);
        }
      })();
      activeDownloads.set(urlHashKey, downloadPromise);
    }

    if (reqCtx.waitForDownload) {
      return await downloadPromise;
    }

    const timeoutMs = reqCtx.stremthruMode ? 14000 : 6000;
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), timeoutMs));
    const result = await Promise.race([downloadPromise, timeoutPromise]);
    
    if (result === "TIMEOUT") {
      const indexerMatch = httpLink.match(/https?:\/\/[^\/]+\/([^\/]+)\/download/);
      const idxId = indexerMatch ? `Indexador ${indexerMatch[1]}` : httpLink.slice(0,50)+'...';
      console.warn(`[WARN] Timeout ${Math.round(timeoutMs/1000)}s atingido em resolveInfoHash para ${idxId} (Download continua em background)`);
      reqCtx.hasTimedOut = true;
      return magnetHash ? { infoHash: magnetHash, files: null, buffer: null, isPrivate: false } : null;
    }
    return result;
  }

  if (fallbackHash) return { infoHash: fallbackHash, files: null, buffer: null };
  return null;
}

module.exports = {
  base32ToHex,
  extractInfoHash,
  extractInfoBuf,
  decodeBencode,
  extractTorrentFiles,
  pickEpisodeFile,
  normalizeTorrentLink,
  torrentFailureKeys,
  torrentDownloadRecentlyFailed,
  markTorrentDownloadFailed,
  infoHashQueueKey,
  InfoHashQueue,
  infoHashQueue,
  resolveInfoHash
};
