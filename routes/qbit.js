const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { isConfigured: isQbitConfigured, ensureTorrentReady, getPlayableLocalFile, streamTorrentFile, waitForBuffer } = require("../providers/qbittorrent");
const { TORRENT_DOWNLOAD_TIMEOUT_MS } = require("../constants");
const { rc, loadQbitJob } = require("../cache");
const { resolvePrefs } = require("../configStore");
const { isQbitEnabledForPrefs } = require("../routeHelpers");
const { torrentDownloadRecentlyFailed, markTorrentDownloadFailed } = require("../torrentUtils");
const { torboxAddTorrent, resolveDebridStream, rdAddTorrent } = require("../debrid");
const { injectTrackers } = require("../torrentEnrich");

const router = express.Router();

router.get("/:userConfig/debrid-add/:provider/:infoHash", async (req, res) => {
  const { provider, infoHash } = req.params;
  const magnet  = Array.isArray(req.query.magnet) ? req.query.magnet[0] : req.query.magnet;
  const linkUrl = Array.isArray(req.query.link) ? req.query.link[0] : req.query.link;
  const requestedFileId = Array.isArray(req.query.file_id) ? req.query.file_id[0] : req.query.file_id;
  const seasonParam  = req.query.season  != null ? parseInt(req.query.season,  10) : null;
  const episodeParam = req.query.episode != null ? parseInt(req.query.episode, 10) : null;
  const isAnimeParam = req.query.anime === "1";
  const prefs   = await resolvePrefs(req.params.userConfig);

  const providerLower = provider.toLowerCase();
  const isST = providerLower.startsWith("stremthru-");
  const stStoreName = isST ? providerLower.replace("stremthru-", "") : null;

  let stStoreObj, stUrl, stToken;
  if (isST) {
    if (!prefs.stConfig || !prefs.stConfig.stores) return res.status(400).send("StremThru config missing");
    const storeCodeMap2 = { torbox: "torbox", realdebrid: "realdebrid" };
    stStoreObj = prefs.stConfig.stores.find(s => s.c === stStoreName || storeCodeMap2[s.c] === stStoreName);
    if (!stStoreObj) return res.status(400).send("StremThru store config missing");
    stUrl = prefs.stConfig.url;
    stToken = stStoreObj.t;
  }

  const config  = prefs.debridConfig;
  if (!isST && (!config && provider !== "fallback") || (!magnet && !linkUrl)) {
    return res.status(400).send("Configuração ou magnet/link ausente");
  }

  const providerSecret = isST ? stToken : (providerLower === "realdebrid" ? config.rdKey : providerLower === "torbox" ? config.torboxKey : JSON.stringify(config || {}));
  const accountHash = crypto.createHash("sha256").update(String(providerSecret || req.params.userConfig || "")).digest("hex").slice(0, 16);
  const lockKey      = `addlock:${providerLower}:${accountHash}:${infoHash}`;
  const alreadyAdded = await rc.get(lockKey);

  // Download do .torrent se disponível (cache primeiro, link como fallback)
  let torrentBuffer = await rc.getBuffer(`torrent:${infoHash.toLowerCase()}`).catch(() => null);
  if (torrentBuffer) {
    console.log(`[ON-DEMAND] Buffer .torrent recuperado do cache para ${infoHash}`);
  }

  if (!torrentBuffer && typeof linkUrl === "string" && linkUrl.startsWith("http")) {
    try {
      if (!(await torrentDownloadRecentlyFailed(linkUrl))) {
        const dl = await axios.get(linkUrl, {
          responseType: "arraybuffer",
          timeout: TORRENT_DOWNLOAD_TIMEOUT_MS,
          maxRedirects: 5,
          validateStatus: s => s < 400,
          headers: { "User-Agent": "Mozilla/5.0" },
          beforeRedirect: (options) => {
            if (options.href?.startsWith("magnet:")) {
              throw new Error("Redirect para magnet detectado");
            }
          },
        });
        if (dl.data && Buffer.from(dl.data)[0] === 0x64) {
          torrentBuffer = Buffer.from(dl.data);
        }
      }
    } catch(e) {
      if (!e.message.includes("magnet")) {
        await markTorrentDownloadFailed(linkUrl);
        console.log(`[ON-DEMAND] Falha ao baixar .torrent: ${e.message}`);
      }
    }
  }

  const isRD = !isST && providerLower === "realdebrid";
  const isTB = !isST && providerLower === "torbox";

  if (!alreadyAdded) {
    await rc.set(lockKey, "1", 3600);
    console.log(`[ON-DEMAND] Adicionando ${infoHash} ao ${provider}...`);
    try {
      if (isST) {
        const payload = { magnet };
        const headers = {
          "Content-Type": "application/json",
          "X-StremThru-Store-Name": stStoreName,
          "X-StremThru-Store-Authorization": `Bearer ${stToken}`
        };
        const addRes = await axios.post(`${stUrl}/v0/store/magnets`, payload, { headers, validateStatus: () => true });
        if (addRes.status >= 400) {
           console.log(`[ON-DEMAND] Falha StremThru Add:`, addRes.data);
        } else {
           const stData = addRes.data?.data;
           if (stData && (stData.status === "downloaded" || (stData.files && stData.files.length > 0))) {
              const selectedFile = requestedFileId ? stData.files.find(f => String(f.index) === String(requestedFileId)) : stData.files[0];
              if (selectedFile?.link) {
                 const linkRes = await axios.post(`${stUrl}/v0/store/link/generate`, { link: selectedFile.link }, { headers, validateStatus: () => true });
                 if (linkRes.data?.data?.link) {
                    await rc.del(lockKey);
                    return res.redirect(302, linkRes.data.data.link);
                 }
              }
           }
        }
      } else if (isTB) {
        const tbResult = await torboxAddTorrent(magnet, config.torboxKey, false, torrentBuffer, { infoHash });
        if (!tbResult) {
          console.log(`[ON-DEMAND] Falha ao adicionar ao TorBox (pode já estar na fila ou erro de API)`);
        } else {
          console.log(`[ON-DEMAND] Adicionado com sucesso ao TorBox`);
          const isReady = tbResult.download_finished === true || tbResult.download_present === true || tbResult.download_state === "cached";
          if (isReady && tbResult.files?.length > 0) {
            if (requestedFileId) {
              const tid = tbResult.id || tbResult.torrent_id;
              const url = `https://api.torbox.app/v1/api/torrents/requestdl?token=${config.torboxKey}&torrent_id=${tid}&file_id=${encodeURIComponent(requestedFileId)}&redirect=true`;
              await rc.del(lockKey);
              return res.redirect(302, url);
            }
            const stream = await resolveDebridStream(infoHash, magnet, "", seasonParam, episodeParam, isAnimeParam, config, null, null, tbResult, null);
            if (stream?.url) {
              await rc.del(lockKey);
              return res.redirect(302, stream.url);
            }
          }
        }
      } else if (isRD) {
        const ok = await rdAddTorrent(magnet, config.rdKey, torrentBuffer);
        if (!ok) {
          console.log(`[ON-DEMAND] Falha ao adicionar ao RD`);
          return res.status(500).send(`Falha ao adicionar torrent ao Real-Debrid`);
        }
        console.log(`[ON-DEMAND] Adicionado com sucesso ao RD`);
      }
    } catch (e) {
      console.log(`[ON-DEMAND] Erro ao adicionar: ${e.message}`);
      if (isRD) return res.status(500).send(`Erro: ${e.message}`);
    }
  }

  // Polling com backoff exponencial (até 120s)
  if (isST) {
    return await pollStremThru(res, stUrl, stStoreName, stToken, infoHash, requestedFileId);
  }

  if (isTB) {
    return await pollTorbox(res, config.torboxKey, infoHash, requestedFileId, magnet, seasonParam, episodeParam, isAnimeParam, config);
  }

  if (isRD) {
    const fallbackHTML = `
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Aguardando Torrent...</title>
          <style>
            body { background:#0b0b0b; color:#fff; font-family:sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; padding: 20px; }
            h1 { color:#e50914; margin-bottom: 10px; }
            p { font-size:18px; line-height:1.5; color:#ccc; max-width: 600px; }
            .loader { border:6px solid #222; border-top:6px solid #e50914; border-radius:50%; width:60px; height:60px; animation:spin 1s linear infinite; margin: 30px auto; }
            @keyframes spin { 0% { transform:rotate(0deg); } 100% { transform:rotate(360deg); } }
            .btn { background:#e50914; color:#fff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; margin-top:20px; display:inline-block; transition: background 0.2s; }
            .btn:hover { background:#f40612; }
          </style>
        </head>
        <body>
          <h1>Adicionando ao debrid...</h1>
          <div class="loader"></div>
          <p>O torrent está sendo enviado para a nuvem.</p>
          <p>Volte ao Stremio e tente reproduzir o link <strong>[RD] cached</strong> que aparecerá na lista de opções quando o download for concluído.</p>
          <p style="font-size:14px; margin-top:30px; color:#777;">Tracker Privado em Real-Debrid via ProwJack</p>
        </body>
      </html>
    `;
    return res.send(fallbackHTML);
  }

  return res.status(500).send("Debrid Provider não suportado neste fallback");
});

// ── Polling helpers (backoff: 1s → 2s → 3s → 5s, até 120s) ──────────────────
async function pollWithBackoff(label, checkFn) {
  const deadline = Date.now() + 120000;
  const delays   = [1000, 2000, 3000, 5000];
  let delayIndex = 0;
  console.log(`[ON-DEMAND] ${label}: aguardando download (até 120s)...`);

  while (Date.now() < deadline) {
    try {
      const result = await checkFn(Math.min(8000, deadline - Date.now()));
      if (result) return result;
    } catch {}
    await new Promise(r => setTimeout(r, delays[delayIndex]));
    if (delayIndex < delays.length - 1) delayIndex++;
  }
  return null;
}

async function pollStremThru(res, stUrl, stStoreName, stToken, infoHash, requestedFileId) {
  const headers = { "X-StremThru-Store-Name": stStoreName, "X-StremThru-Store-Authorization": `Bearer ${stToken}` };
  const redirectUrl = await pollWithBackoff("StremThru", async (remainingTime) => {
    const checkRes = await axios.get(`${stUrl}/v0/store/magnets/check?magnet=${infoHash}&local=true`, {
      headers,
      timeout: remainingTime,
      signal: AbortSignal.timeout(remainingTime),
      validateStatus: () => true
    });

    const items = checkRes.data?.data?.items || [];
    const torrent = items.find(t => t.hash?.toLowerCase() === infoHash.toLowerCase());

    if (torrent && (torrent.status === "downloaded" || (torrent.files && torrent.files.length > 0))) {
      console.log(`[ON-DEMAND] StremThru pronto! Gerando link...`);
      const selectedFile = requestedFileId ? torrent.files.find(f => String(f.index) === String(requestedFileId)) : torrent.files[0];
      if (selectedFile?.link) {
        const linkRes = await axios.post(`${stUrl}/v0/store/link/generate`, { link: selectedFile.link }, { headers, validateStatus: () => true });
        if (linkRes.data?.data?.link) return linkRes.data.data.link;
      }
    }
    return null;
  });
  if (redirectUrl) return res.redirect(302, redirectUrl);
  return res.status(504).send("Timeout aguardando download no StremThru");
}

async function pollTorbox(res, torboxKey, infoHash, requestedFileId, magnet, seasonParam, episodeParam, isAnimeParam, config) {
  const redirectUrl = await pollWithBackoff("TorBox", async (remainingTime) => {
    const tbRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
      headers: { Authorization: `Bearer ${torboxKey}` },
      timeout: remainingTime,
      signal: AbortSignal.timeout(remainingTime),
    });

    const torrent = tbRes.data?.data?.find(t => t.hash?.toLowerCase() === infoHash.toLowerCase());

    const isCached = torrent?.download_present === true ||
                    torrent?.download_finished === true ||
                    torrent?.download_state === "cached" ||
                    (torrent?.hash && torrent?.files?.length > 0);

    if (isCached && torrent?.files?.length > 0) {
      console.log(`[ON-DEMAND] TorBox pronto! Resolvendo stream...`);
      if (requestedFileId) {
        const tid = torrent.id || torrent.torrent_id;
        return `https://api.torbox.app/v1/api/torrents/requestdl?token=${torboxKey}&torrent_id=${tid}&file_id=${encodeURIComponent(requestedFileId)}&redirect=true`;
      }
      const stream = await resolveDebridStream(infoHash, magnet, "", seasonParam, episodeParam, isAnimeParam, config, null, null, torrent, null);
      if (stream?.url) return stream.url;
    }
    return null;
  });
  if (redirectUrl) return res.redirect(302, redirectUrl);
  return res.status(504).send("Timeout aguardando download no TorBox");
}

router.get("/:userConfig/qbit/:jobToken", async (req, res) => {
  const prefs = await resolvePrefs(req.params.userConfig);
  const job = await loadQbitJob(req.params.jobToken);
  if (!job?.infoHash) return res.status(404).send("Job expirado ou inválido.");
  const qbitCreds = null;
  if (!isQbitEnabledForPrefs(prefs, qbitCreds)) return res.status(404).send("qBittorrent desabilitado para esta configuração.");

  try {
    // 1. Verifica se já está disponível para reprodução imediata
    let playable = await getPlayableLocalFile(job.infoHash, job.fileIdx, job.fileName, qbitCreds);

    if (!playable) {
      // 2. Obtém o buffer .torrent — prioridade: buffer salvo no job > re-download pelo link
      // FIX: o buffer já foi baixado e enriquecido na hora de montar o stream (buildQbitStream).
      // Usar o buffer do job evita falhas causadas por links do Jackett que expiram ou
      // requerem autenticação de sessão que não está disponível aqui.
      let torrentBuffer = null;

      if (job.torrentB64) {
        // Caminho preferencial: buffer pré-baixado salvo no job como base64
        try {
          torrentBuffer = Buffer.from(job.torrentB64, "base64");
          console.log(`[qBit] Buffer .torrent do job: ${torrentBuffer.length} bytes`);
        } catch (e) {
          console.log(`[qBit] Falha ao decodificar torrentB64: ${e.message}`);
        }
      }

      if (!torrentBuffer && job.link && !job.link.startsWith("magnet:")) {
        // Fallback: tenta re-download do link do Jackett
        try {
          if (!(await torrentDownloadRecentlyFailed(job.link))) {
            const dl = await axios.get(job.link, {
              responseType: "arraybuffer", timeout: TORRENT_DOWNLOAD_TIMEOUT_MS, maxRedirects: 5,
              maxContentLength: 8 * 1024 * 1024, headers: { "User-Agent": "Mozilla/5.0" },
              validateStatus: s => s < 400,
              beforeRedirect: (options) => {
                if (options.href?.startsWith("magnet:")) throw new Error("Redirect para magnet");
              },
            });
            if (dl.data && Buffer.from(dl.data)[0] === 0x64) {
              const raw = Buffer.from(dl.data);
              try { torrentBuffer = injectTrackers(raw); } catch { torrentBuffer = raw; }
              console.log(`[qBit] .torrent re-baixado do link: ${torrentBuffer.length} bytes`);
            }
          }
        } catch (e) {
          if (!e.message.includes("magnet")) {
            await markTorrentDownloadFailed(job.link);
            console.log(`[qBit] Falha ao re-baixar .torrent: ${e.message}`);
          }
        }
      }

      // 3. Garante que o torrent existe no qBit e prioriza o arquivo correto (operação rápida)
      await ensureTorrentReady(job.infoHash, {
        torrentBuffer, magnet: job.magnet, fileIdx: job.fileIdx, fileName: job.fileName, creds: qbitCreds,
      });

      // 4. Aguarda até que o torrent tenha buffer suficiente para reproduzir (bloqueia o request)
      await waitForBuffer(job.infoHash, job.fileIdx, job.fileName, qbitCreds);

      playable = await getPlayableLocalFile(job.infoHash, job.fileIdx, job.fileName, qbitCreds);

      if (!playable) {
        // Ainda não tem buffer — responde imediatamente e deixa o player tentar em 5s.
        // O Stremio e a maioria dos players respeitam o Retry-After e tentam novamente.
        console.log(`[qBit] ${job.infoHash} sem buffer ainda — respondendo 503 para retry`);
        res.setHeader("Retry-After", "5");
        return res.status(503).send("Aguardando buffer do qBittorrent...");
      }
    }

    // 5. Arquivo disponível: faz o streaming com suporte a Range requests
    await streamTorrentFile(req, res, job.infoHash, job.fileIdx, job.fileName, qbitCreds);
  } catch (err) {
    console.log(`[qBit] Falha ao preparar ${job.infoHash}: ${err.message}`);
    if (!res.headersSent) res.status(503).send(`qBittorrent: ${err.message}`);
  }
});

router.get("/qbit/stream/:jobToken", async (req, res) => {
  const job = await loadQbitJob(req.params.jobToken);
  if (!job?.infoHash) return res.status(404).json({ error: "Job expirado ou inválido" });
  const qbitCreds = job.qbit || null;
  if (!isQbitConfigured(qbitCreds)) return res.status(503).json({ error: "qBittorrent não configurado" });

  try {
    await streamTorrentFile(req, res, job.infoHash, job.fileIdx, job.fileName, qbitCreds);
  } catch (err) {
    console.error("[qBit stream]", err.message);
    if (!res.headersSent) res.status(503).json({ error: err.message });
  }
});

module.exports = router;
