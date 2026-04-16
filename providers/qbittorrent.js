/**
 * providers/qbittorrent.js
 *
 * Backend de streaming via qBittorrent para trackers privados e públicos.
 * O addon reutiliza torrents locais, sobe o .torrent ou adiciona magnet,
 * escolhe o arquivo principal e expõe o vídeo por HTTP.
 */

const fs = require("fs");
const path = require("path");

const QBIT_URL = (process.env.QBIT_URL || "").replace(/\/+$/, "");
const QBIT_USER = process.env.QBIT_USER || "";
const QBIT_PASS = process.env.QBIT_PASS || "";
const QBIT_SAVE_DIR = process.env.QBIT_SAVE_DIR || "/downloads/prowjack";
const QBIT_CATEGORY = process.env.QBIT_CATEGORY || "prowjack-private";
const MIN_PROGRESS = Math.min(1, Math.max(0.005, parseFloat(process.env.QBIT_MIN_PROGRESS || "0.02")));
const BUFFER_TIMEOUT = parseInt(process.env.QBIT_BUFFER_TIMEOUT || "180", 10);
const POLL_INTERVAL = 3000;

let sessionCookie = null;
let _dynUrl  = "";
let _dynUser = "";
let _dynPass = "";

function setCredentials(url, user, pass) {
  const newUrl = (url || "").replace(/\/+$/, "");
  if (newUrl !== _dynUrl || user !== _dynUser || pass !== _dynPass) {
    sessionCookie = null; // força novo login se credenciais mudaram
  }
  _dynUrl  = newUrl;
  _dynUser = user || "";
  _dynPass = pass || "";
}

function _url()  { return _dynUrl  || QBIT_URL; }
function _user() { return _dynUser || QBIT_USER; }
function _pass() { return _dynPass || QBIT_PASS; }

function isConfigured() {
  return !!(_url() && _user() && _pass());
}

async function qbitFetch(endpoint, options = {}) {
  if (!isConfigured()) throw new Error("qBittorrent não configurado");

  const url = `${_url()}${endpoint}`;
  const headers = { ...(options.headers || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;

  const res = await fetch(url, { ...options, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";")[0];
  return res;
}

async function login(force = false) {
  if (!force && sessionCookie) return;
  const body = new URLSearchParams({ username: _user(), password: _pass() });
  const res = await qbitFetch("/api/v2/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (text !== "Ok.") throw new Error(`qBittorrent login falhou: ${text}`);
}

async function qbitApi(endpoint, options = {}) {
  await login();
  let res = await qbitFetch(endpoint, options);
  if (res.status === 403) {
    sessionCookie = null;
    await login(true);
    res = await qbitFetch(endpoint, options);
  }
  return res;
}

async function addTorrentBuffer(infoHash, torrentBuffer) {
  if (!Buffer.isBuffer(torrentBuffer) || !torrentBuffer.length) {
    throw new Error("Buffer .torrent inválido");
  }

  const boundary = `----ProwJack${Math.random().toString(36).slice(2)}`;
  const parts = [];
  const appendField = (name, value) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };

  appendField("savepath", QBIT_SAVE_DIR);
  appendField("category", QBIT_CATEGORY);
  appendField("sequentialDownload", "true");
  appendField("firstLastPiecePrio", "true");
  appendField("autoTMM", "false");

  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="${infoHash}.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`));
  parts.push(torrentBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const res = await qbitApi("/api/v2/torrents/add", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
  const text = await res.text();
  if (text !== "Ok." && text !== "Fails.") {
    throw new Error(`Erro ao adicionar torrent ao qBittorrent: ${text}`);
  }
}

async function addMagnet(infoHash, magnet) {
  if (!magnet || !String(magnet).startsWith("magnet:")) {
    throw new Error("Magnet inválido");
  }

  const body = new URLSearchParams({
    urls: magnet,
    savepath: QBIT_SAVE_DIR,
    category: QBIT_CATEGORY,
    sequentialDownload: "true",
    firstLastPiecePrio: "true",
    autoTMM: "false",
  });

  const res = await qbitApi("/api/v2/torrents/add", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (text !== "Ok." && text !== "Fails.") {
    throw new Error(`Erro ao adicionar magnet ao qBittorrent: ${text}`);
  }
}

async function getTorrentInfo(infoHash) {
  const res = await qbitApi(`/api/v2/torrents/info?category=${encodeURIComponent(QBIT_CATEGORY)}&hashes=${encodeURIComponent(infoHash.toLowerCase())}`);
  const list = await res.json();
  return Array.isArray(list) && list.length ? list[0] : null;
}

async function getTorrentFiles(infoHash) {
  const res = await qbitApi(`/api/v2/torrents/files?hash=${encodeURIComponent(infoHash.toLowerCase())}`);
  const files = await res.json();
  return Array.isArray(files) ? files : [];
}

function pickTargetFile(files, fileIdx, fileName) {
  if (!Array.isArray(files) || !files.length) return null;
  if (Number.isInteger(fileIdx) && files[fileIdx]) return files[fileIdx];
  if (fileName) {
    const normalized = String(fileName).replace(/^\/+/, "");
    const byName = files.find(file => String(file.name || "") === normalized || String(file.name || "").endsWith(`/${normalized}`));
    if (byName) return byName;
  }
  const videoFiles = files.filter(file => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(file.name || ""));
  const pool = videoFiles.length ? videoFiles : files;
  return pool.reduce((best, current) => ((current.size || 0) > (best.size || 0) ? current : best));
}

async function setFilePriority(infoHash, fileId, priority) {
  const body = new URLSearchParams({
    hashes: infoHash.toLowerCase(),
    id: String(fileId),
    priority: String(priority),
  });
  await qbitApi("/api/v2/torrents/filePrio", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function prioritizeMainFile(infoHash, fileIdx, fileName) {
  const files = await getTorrentFiles(infoHash);
  const target = pickTargetFile(files, fileIdx, fileName);
  if (!target) return null; // metadados ainda não chegaram — sem erro

  await Promise.allSettled(
    files.map(file => setFilePriority(infoHash, file.index, file.index === target.index ? 7 : 0))
  );

  return target;
}

async function ensureTorrentReady(infoHash, options = {}) {
  const { torrentBuffer = null, magnet = null, fileIdx = null, fileName = null } = options;
  let info = await getTorrentInfo(infoHash);
  if (!info) {
    if (torrentBuffer) await addTorrentBuffer(infoHash, torrentBuffer);
    else if (magnet) await addMagnet(infoHash, magnet);
    else throw new Error("Nenhuma fonte disponível para adicionar ao qBittorrent");
  }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    info = await getTorrentInfo(infoHash);
    if (info) break;
    await sleep(1000);
  }
  if (!info) throw new Error("Torrent não apareceu no qBittorrent após o envio");

  const target = await prioritizeMainFile(infoHash, fileIdx, fileName);
  return { info, target };
}

async function waitForBuffer(infoHash, fileIdx, fileName) {
  const deadline = Date.now() + BUFFER_TIMEOUT * 1000;

  while (Date.now() < deadline) {
    const info = await getTorrentInfo(infoHash);
    if (!info) { await sleep(POLL_INTERVAL); continue; }

    if (["error", "missingFiles", "unknown"].includes(info.state)) {
      throw new Error(`qBittorrent erro no torrent: estado "${info.state}"`);
    }

    const files = await getTorrentFiles(infoHash);
    const target = pickTargetFile(files, fileIdx, fileName);
    if (!target) { await sleep(POLL_INTERVAL); continue; }

    const progress = Number(target.progress || 0);
    console.log(`[qBit] ${infoHash} | arquivo=${target.name} | ${(progress * 100).toFixed(1)}% | estado=${info.state}`);

    if (progress >= MIN_PROGRESS) return { info, file: target };

    await sleep(POLL_INTERVAL);
  }
  
  const info = await getTorrentInfo(infoHash).catch(() => null);
  const files = info ? await getTorrentFiles(infoHash).catch(() => []) : [];
  return { info, file: files.length ? pickTargetFile(files, fileIdx, fileName) : null };
}

async function getPlayableLocalFile(infoHash, fileIdx, fileName) {
  const info = await getTorrentInfo(infoHash);
  if (!info) return null;

  const files = await getTorrentFiles(infoHash);
  const file = pickTargetFile(files, fileIdx, fileName);
  if (!file) return null;

  const filePath = resolveFilePath(info, file);
  if (!fs.existsSync(filePath)) return null;

  const isComplete = Number(file.progress || 0) >= 1 || Number(info.progress || 0) >= 1;
  const hasPlayableBuffer = Number(file.progress || 0) >= MIN_PROGRESS;
  if (!isComplete && !hasPlayableBuffer) return null;

  return { info, file, filePath, isComplete };
}

function resolveFilePath(info, file) {
  const relative = String(file.name || "").replace(/^\/+/, "").replace(/\.\./g, "");
  if (!relative || relative.includes("..")) {
    throw new Error("Path traversal detectado");
  }
  const byDir = path.join(QBIT_SAVE_DIR, relative);
  if (fs.existsSync(byDir)) {
    const resolved = path.resolve(byDir);
    const base = path.resolve(QBIT_SAVE_DIR);
    if (!resolved.startsWith(base)) {
      throw new Error("Path fora do diretório permitido");
    }
    return byDir;
  }
  const root = info.content_path || path.join(QBIT_SAVE_DIR, info.name || "");
  const normalizedRoot = path.normalize(root);
  if (normalizedRoot.endsWith(path.normalize(relative))) return normalizedRoot;
  const finalPath = path.join(normalizedRoot, relative);
  const resolvedFinal = path.resolve(finalPath);
  const baseResolved = path.resolve(QBIT_SAVE_DIR);
  if (!resolvedFinal.startsWith(baseResolved)) {
    throw new Error("Path fora do diretório permitido");
  }
  return finalPath;
}

async function streamTorrentFile(req, res, infoHash, fileIdx, fileName) {
  const info = await getTorrentInfo(infoHash);
  if (!info) return res.status(404).json({ error: "Torrent não encontrado" });

  const files = await getTorrentFiles(infoHash);
  const file = pickTargetFile(files, fileIdx, fileName);
  if (!file) return res.status(404).json({ error: "Arquivo não encontrado" });

  const filePath = resolveFilePath(info, file);
  if (!fs.existsSync(filePath)) {
    return res.status(503).json({ error: "Arquivo ainda não está disponível no disco" });
  }

  const stat = fs.statSync(filePath);
  const fileSize = file.size || stat.size;
  const availableBytes = Math.max(1, Math.floor((file.progress || 0) * fileSize));
  const range = req.headers.range;
  const mimeType = getMimeType(filePath);

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    if (!Number.isFinite(start)) return res.status(416).end();
    if (start >= availableBytes) {
      res.setHeader("Retry-After", "3");
      return res.status(503).json({ error: "Buffer insuficiente para esse trecho" });
    }
    const requestedEnd = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 2 * 1024 * 1024, fileSize - 1);
    const safeEnd = Math.min(requestedEnd, fileSize - 1, availableBytes - 1);

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${safeEnd}/${fileSize}`,
      "Content-Length": safeEnd - start + 1,
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
    return;
  }

  const safeLength = Math.min(fileSize, availableBytes);
  res.writeHead(200, {
    "Content-Length": safeLength,
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath, { start: 0, end: safeLength - 1 }).pipe(res);
}

async function cleanupOldTorrents(maxAgeHours = 24) {
  const res = await qbitApi(`/api/v2/torrents/info?category=${encodeURIComponent(QBIT_CATEGORY)}`);
  const list = await res.json();
  const now = Date.now() / 1000;
  const limit = maxAgeHours * 3600;
  const toDelete = (Array.isArray(list) ? list : []).filter(t => (now - t.added_on) > limit);
  if (!toDelete.length) return;

  const body = new URLSearchParams({ hashes: toDelete.map(t => t.hash).join("|"), deleteFiles: "true" });
  await qbitApi("/api/v2/torrents/delete", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".mkv": "video/x-matroska",
    ".mp4": "video/mp4",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
  };
  return types[ext] || "video/mp4";
}

module.exports = {
  isConfigured,
  setCredentials,
  ensureTorrentReady,
  waitForBuffer,
  getPlayableLocalFile,
  streamTorrentFile,
  cleanupOldTorrents,
  getTorrentInfo,
  getTorrentFiles,
};
