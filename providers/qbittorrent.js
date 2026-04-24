/**
 * providers/qbittorrent.js
 *
 * Backend de streaming via qBittorrent para trackers privados e públicos.
 * O addon reutiliza torrents locais, sobe o .torrent ou adiciona magnet,
 * escolhe o arquivo principal e expõe o vídeo por HTTP.
 */

const fs = require("fs");
const path = require("path");
const { injectTrackers } = require("../torrentEnrich");

const QBIT_URL      = (process.env.QBIT_URL      || "").replace(/\/+$/, "");
const QBIT_USER     = process.env.QBIT_USER     || "";
const QBIT_PASS     = process.env.QBIT_PASS     || "";
const QBIT_SAVE_DIR = process.env.QBIT_SAVE_DIR || "/downloads/prowjack";
const QBIT_CATEGORY = process.env.QBIT_CATEGORY || "prowjack-private";
const QBIT_TAGS     = process.env.QBIT_TAGS     || "prowjack";
const MIN_PROGRESS  = Math.min(1, Math.max(0.005, parseFloat(process.env.QBIT_MIN_PROGRESS || "0.02")));
const BUFFER_TIMEOUT = parseInt(process.env.QBIT_BUFFER_TIMEOUT || "180", 10);
const POLL_INTERVAL  = 3000;

const sessionCookies = new Map();

function resolveCreds(creds = null) {
  return {
    url:  String(creds?.url  || QBIT_URL).replace(/\/+$/, ""),
    user: String(creds?.user || QBIT_USER),
    pass: String(creds?.pass || QBIT_PASS),
  };
}

function getSessionKey(creds = null) {
  const { url, user, pass } = resolveCreds(creds);
  return `${url}\n${user}\n${pass}`;
}

function getSessionCookie(creds = null) {
  return sessionCookies.get(getSessionKey(creds)) || null;
}

function setSessionCookie(creds = null, cookie = null) {
  const key = getSessionKey(creds);
  if (!cookie) sessionCookies.delete(key);
  else sessionCookies.set(key, cookie);
}

function setCredentials(url, user, pass) {
  setSessionCookie({ url, user, pass }, null);
}

function isConfigured(creds = null) {
  const { url, user, pass } = resolveCreds(creds);
  return !!(url && user && pass);
}

async function qbitFetch(endpoint, options = {}, creds = null) {
  if (!isConfigured(creds)) throw new Error("qBittorrent não configurado");

  const { url: baseUrl } = resolveCreds(creds);
  const url = `${baseUrl}${endpoint}`;
  const headers = { ...(options.headers || {}) };
  const sessionCookie = getSessionCookie(creds);
  if (sessionCookie) headers.Cookie = sessionCookie;

  const res = await fetch(url, { ...options, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) setSessionCookie(creds, setCookie.split(";")[0]);
  return res;
}

async function login(force = false, creds = null) {
  if (!force && getSessionCookie(creds)) return;
  const { user, pass } = resolveCreds(creds);
  const body = new URLSearchParams({ username: user, password: pass });
  const res = await qbitFetch("/api/v2/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, creds);
  const text = await res.text();
  if (text !== "Ok.") throw new Error(`qBittorrent login falhou: ${text}`);
}

async function qbitApi(endpoint, options = {}, creds = null) {
  await login(false, creds);
  let res = await qbitFetch(endpoint, options, creds);
  if (res.status === 403) {
    setSessionCookie(creds, null);
    await login(true, creds);
    res = await qbitFetch(endpoint, options, creds);
  }
  return res;
}

// ─────────────────────────────────────────────────────────
// FIX PRINCIPAL: addTorrentBuffer agora usa FormData + Blob NATIVOS do Node.js 18+
//
// Problema original: o código usava `require('form-data')` (pacote npm) que cria um
// stream Readable do Node.js — incompatível com o fetch() nativo (undici) que espera
// tipos da Web API (FormData, Blob, ArrayBuffer, ReadableStream web, etc.).
// O upload do .torrent falhava silenciosamente, o torrent nunca era adicionado ao
// qBittorrent e o player não conseguia reproduzir.
//
// Solução: FormData e Blob globais (Node.js 18+) são 100% compatíveis com fetch nativo.
// O Content-Type multipart com boundary é definido automaticamente pelo fetch.
// ─────────────────────────────────────────────────────────
async function addTorrentBuffer(infoHash, torrentBuffer, creds = null) {
  if (!Buffer.isBuffer(torrentBuffer) || !torrentBuffer.length) {
    throw new Error("Buffer .torrent inválido");
  }

  // Injeta trackers extras para aumentar a conectividade (essencial em torrents de trackers privados)
  let enrichedBuffer;
  try {
    enrichedBuffer = injectTrackers(torrentBuffer);
  } catch (e) {
    console.warn(`[qBit] injectTrackers falhou (usando original): ${e.message}`);
    enrichedBuffer = torrentBuffer;
  }

  const savePath = path.join(QBIT_SAVE_DIR, infoHash.toLowerCase());

  // Usa FormData NATIVA (global no Node.js 18+) — compatível com fetch nativo.
  // NÃO usar require('form-data'): aquele pacote gera um Node.js Readable stream
  // que o fetch nativo (undici) não aceita corretamente como corpo multipart.
  const form = new FormData();
  form.append("savepath", savePath);
  form.append("category", QBIT_CATEGORY);
  form.append("tags", QBIT_TAGS);
  form.append("sequentialDownload", "true");
  form.append("firstLastPiecePrio", "true");
  form.append("autoTMM", "false");
  // Blob nativo (Node.js 18+): representa o arquivo .torrent com o MIME correto
  form.append(
    "torrents",
    new Blob([enrichedBuffer], { type: "application/x-bittorrent" }),
    `${infoHash}.torrent`
  );

  console.log(`[qBit] Enviando .torrent (original=${torrentBuffer.length}b enriquecido=${enrichedBuffer.length}b) para ${infoHash}...`);

  // Não definimos Content-Type nos headers — o fetch nativo detecta FormData e
  // define automaticamente: "multipart/form-data; boundary=----FormBoundary..."
  const res = await qbitApi("/api/v2/torrents/add", {
    method: "POST",
    body: form,
  }, creds);

  const text = await res.text();
  console.log(`[qBit] Resposta add: ${text} (status=${res.status})`);

  if (res.status >= 400) {
    throw new Error(`Erro API qBit (${res.status}): ${text}`);
  }

  // "Fails." pode indicar torrent já existente — não é erro crítico
  if (text === "Fails.") {
    const existing = await getTorrentInfo(infoHash, creds).catch(() => null);
    if (existing) return;
  }

  if (text !== "Ok.") {
    throw new Error(`Falha ao adicionar torrent: ${text}`);
  }
}

async function addMagnet(infoHash, magnet, creds = null) {
  if (!magnet || !String(magnet).startsWith("magnet:")) {
    throw new Error("Magnet inválido");
  }

  const savePath = path.join(QBIT_SAVE_DIR, infoHash.toLowerCase());
  const body = new URLSearchParams({
    urls: magnet,
    savepath: savePath,
    category: QBIT_CATEGORY,
    tags: QBIT_TAGS,
    sequentialDownload: "true",
    firstLastPiecePrio: "true",
    autoTMM: "false",
  });

  console.log(`[qBit] Enviando magnet para ${infoHash}...`);
  const res = await qbitApi("/api/v2/torrents/add", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, creds);
  const text = await res.text();
  console.log(`[qBit] Resposta add (magnet): ${text} (status=${res.status})`);

  if (res.status >= 400) {
    throw new Error(`Erro API qBit (${res.status}): ${text}`);
  }

  // "Fails." pode indicar torrent já existente — não é erro crítico
  if (text === "Fails.") {
    const existing = await getTorrentInfo(infoHash, creds).catch(() => null);
    if (existing) return;
  }

  if (text !== "Ok.") {
    throw new Error(`Falha ao adicionar magnet: ${text}`);
  }
}

async function getTorrentInfo(infoHash, creds = null) {
  try {
    const res = await qbitApi(`/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash.toLowerCase())}`, {}, creds);
    const list = await res.json();
    return Array.isArray(list) && list.length ? list[0] : null;
  } catch (err) {
    console.error(`[qBit] Erro ao buscar info do torrent ${infoHash}: ${err.message}`);
    return null;
  }
}

async function getTorrentFiles(infoHash, creds = null) {
  const res = await qbitApi(`/api/v2/torrents/files?hash=${encodeURIComponent(infoHash.toLowerCase())}`, {}, creds);
  const files = await res.json();
  return Array.isArray(files) ? files : [];
}

function pickTargetFile(files, fileIdx, fileName) {
  if (!Array.isArray(files) || !files.length) return null;
  if (Number.isInteger(fileIdx) && files[fileIdx]) return files[fileIdx];
  if (fileName) {
    const normalized = String(fileName).replace(/^\/+/, "");
    const byName = files.find(file =>
      String(file.name || "") === normalized ||
      String(file.name || "").endsWith(`/${normalized}`)
    );
    if (byName) return byName;
  }
  const videoFiles = files.filter(file => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(file.name || ""));
  const pool = videoFiles.length ? videoFiles : files;
  return pool.reduce((best, current) => ((current.size || 0) > (best.size || 0) ? current : best));
}

async function setFilePriority(infoHash, fileId, priority, creds = null) {
  const body = new URLSearchParams({
    hashes: infoHash.toLowerCase(),
    id: String(fileId),
    priority: String(priority),
  });
  await qbitApi("/api/v2/torrents/filePrio", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, creds);
}

async function prioritizeMainFile(infoHash, fileIdx, fileName, creds = null) {
  const files = await getTorrentFiles(infoHash, creds);
  const target = pickTargetFile(files, fileIdx, fileName);
  if (!target) return null; // metadados ainda não chegaram — sem erro

  await Promise.allSettled(
    files.map(file =>
      setFilePriority(infoHash, file.index, file.index === target.index ? 7 : 0, creds)
    )
  );

  return target;
}

async function ensureTorrentReady(infoHash, options = {}) {
  const { torrentBuffer = null, magnet = null, fileIdx = null, fileName = null, creds = null } = options;
  let info = await getTorrentInfo(infoHash, creds);
  if (!info) {
    if (torrentBuffer) {
      console.log(`[qBit] Adicionando via .torrent buffer para ${infoHash}...`);
      await addTorrentBuffer(infoHash, torrentBuffer, creds);
    } else if (magnet) {
      console.log(`[qBit] Adicionando via magnet para ${infoHash}...`);
      await addMagnet(infoHash, magnet, creds);
    } else {
      throw new Error(
        `Nenhuma fonte disponível para adicionar ao qBittorrent (infoHash=${infoHash}). ` +
        `torrentBuffer=${!!torrentBuffer} magnet=${!!magnet}`
      );
    }
  } else {
    console.log(`[qBit] Torrent ${infoHash} já existe no qBittorrent (state=${info.state})`);
  }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    info = await getTorrentInfo(infoHash, creds);
    if (info) break;
    await sleep(1000);
  }
  if (!info) throw new Error("Torrent não apareceu no qBittorrent após o envio");

  const target = await prioritizeMainFile(infoHash, fileIdx, fileName, creds);
  return { info, target };
}

async function waitForBuffer(infoHash, fileIdx, fileName, creds = null) {
  const deadline = Date.now() + BUFFER_TIMEOUT * 1000;

  while (Date.now() < deadline) {
    const info = await getTorrentInfo(infoHash, creds);
    if (!info) { await sleep(POLL_INTERVAL); continue; }

    if (["error", "missingFiles", "unknown"].includes(info.state)) {
      throw new Error(`qBittorrent erro no torrent: estado "${info.state}"`);
    }

    const files = await getTorrentFiles(infoHash, creds);
    const target = pickTargetFile(files, fileIdx, fileName);
    if (!target) { await sleep(POLL_INTERVAL); continue; }

    const progress = Number(target.progress || 0);
    console.log(`[qBit] ${infoHash} | arquivo=${target.name} | ${(progress * 100).toFixed(1)}% | estado=${info.state}`);

    if (progress >= MIN_PROGRESS) return { info, file: target };

    await sleep(POLL_INTERVAL);
  }

  const info  = await getTorrentInfo(infoHash, creds).catch(() => null);
  const files = info ? await getTorrentFiles(infoHash, creds).catch(() => []) : [];
  return { info, file: files.length ? pickTargetFile(files, fileIdx, fileName) : null };
}

async function getPlayableLocalFile(infoHash, fileIdx, fileName, creds = null) {
  const info = await getTorrentInfo(infoHash, creds);
  if (!info) return null;

  const files = await getTorrentFiles(infoHash, creds);
  const file = pickTargetFile(files, fileIdx, fileName);
  if (!file) return null;

  const filePath = resolveFilePath(info, file);
  if (!fs.existsSync(filePath)) return null;

  const isComplete     = Number(file.progress || 0) >= 1 || Number(info.progress || 0) >= 1;
  const hasPlayableBuffer = Number(file.progress || 0) >= MIN_PROGRESS;
  if (!isComplete && !hasPlayableBuffer) return null;

  return { info, file, filePath, isComplete };
}

// FIX #4: resolveFilePath agora tenta a subpasta do hash antes do fallback genérico.
// O torrent é salvo em QBIT_SAVE_DIR/{infoHash}/ (definido em addTorrentBuffer/addMagnet),
// mas a versão anterior tentava QBIT_SAVE_DIR/{relative} diretamente, que sempre falha.
function resolveFilePath(info, file) {
  const relative = String(file.name || "")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/%2e/gi, "")     // bloquear encoding
    .replace(/%252e/gi, "")   // bloquear double encoding
    .replace(/\\/g, "/");     // normalizar separadores

  if (!relative || relative.includes("..") || relative.includes("%") || relative.includes("\\")) {
    throw new Error("Path inválido detectado");
  }

  const base = path.resolve(QBIT_SAVE_DIR);

  // Verifica se o caminho resolvido está dentro de QBIT_SAVE_DIR
  const safePath = (p) => {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error("Path fora do diretório permitido");
    }
    return p;
  };

  // 1ª tentativa: caminho direto em QBIT_SAVE_DIR (ex: arquivo avulso)
  const byDir = path.join(QBIT_SAVE_DIR, relative);
  if (fs.existsSync(byDir)) return safePath(byDir);

  // 2ª tentativa: subpasta do hash — onde addTorrentBuffer/addMagnet salva o torrent
  if (info.hash) {
    const byHash = path.join(QBIT_SAVE_DIR, info.hash.toLowerCase(), relative);
    if (fs.existsSync(byHash)) return safePath(byHash);
  }

  // 3ª tentativa: content_path retornado pelo qBittorrent (caminho absoluto do conteúdo)
  const root = info.content_path || path.join(QBIT_SAVE_DIR, info.name || "");
  const normalizedRoot = path.normalize(root);
  if (normalizedRoot.endsWith(path.normalize(relative))) return safePath(normalizedRoot);

  return safePath(path.join(normalizedRoot, relative));
}

async function streamTorrentFile(req, res, infoHash, fileIdx, fileName, creds = null) {
  const info = await getTorrentInfo(infoHash, creds);
  if (!info) return res.status(404).json({ error: "Torrent não encontrado" });

  const files = await getTorrentFiles(infoHash, creds);
  const file  = pickTargetFile(files, fileIdx, fileName);
  if (!file)  return res.status(404).json({ error: "Arquivo não encontrado" });

  const filePath = resolveFilePath(info, file);
  if (!fs.existsSync(filePath)) {
    return res.status(503).json({ error: "Arquivo ainda não está disponível no disco" });
  }

  const stat           = fs.statSync(filePath);
  const fileSize       = file.size || stat.size;
  const availableBytes = Math.max(1, Math.floor((file.progress || 0) * fileSize));
  const range          = req.headers.range;
  const mimeType       = getMimeType(filePath);

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const hasSuffixRange = parts[0] === "" && parts[1];
    const suffixLength = hasSuffixRange ? parseInt(parts[1], 10) : null;

    if (hasSuffixRange) {
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) return res.status(416).end();
      const safeStart = Math.max(0, availableBytes - suffixLength);
      const safeEnd = availableBytes - 1;

      res.writeHead(206, {
        "Content-Range":  `bytes ${safeStart}-${safeEnd}/${fileSize}`,
        "Content-Length": safeEnd - safeStart + 1,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes",
        "Cache-Control":  "no-store",
      });
      fs.createReadStream(filePath, { start: safeStart, end: safeEnd }).pipe(res);
      return;
    }

    if (!Number.isFinite(start) || start < 0) return res.status(416).end();
    if (start >= availableBytes) {
      res.setHeader("Retry-After", "3");
      return res.status(503).json({ error: "Buffer insuficiente para esse trecho" });
    }
    const parsedEnd = parts[1] ? parseInt(parts[1], 10) : null;
    if (parts[1] && (!Number.isFinite(parsedEnd) || parsedEnd < start)) return res.status(416).end();
    const requestedEnd = parsedEnd != null ? parsedEnd : Math.min(start + 2 * 1024 * 1024, fileSize - 1);
    const safeEnd      = Math.min(requestedEnd, fileSize - 1, availableBytes - 1);

    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${safeEnd}/${fileSize}`,
      "Content-Length": safeEnd - start + 1,
      "Content-Type":   mimeType,
      "Accept-Ranges":  "bytes",
      "Cache-Control":  "no-store",
    });
    fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
    return;
  }

  const safeLength = Math.min(fileSize, availableBytes);
  res.writeHead(200, {
    "Content-Length": safeLength,
    "Content-Type":   mimeType,
    "Accept-Ranges":  "bytes",
    "Cache-Control":  "no-store",
  });
  fs.createReadStream(filePath, { start: 0, end: safeLength - 1 }).pipe(res);
}

async function cleanupOldTorrents(maxAgeHours = 24, creds = null) {
  const res  = await qbitApi(`/api/v2/torrents/info?category=${encodeURIComponent(QBIT_CATEGORY)}`, {}, creds);
  const list = await res.json();
  const now   = Date.now() / 1000;
  const limit = maxAgeHours * 3600;
  const toDelete = (Array.isArray(list) ? list : []).filter(t => (now - t.added_on) > limit);
  if (!toDelete.length) return;

  const body = new URLSearchParams({
    hashes: toDelete.map(t => t.hash).join("|"),
    deleteFiles: "true",
  });
  await qbitApi("/api/v2/torrents/delete", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, creds);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMimeType(filePath) {
  const ext   = path.extname(filePath).toLowerCase();
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
