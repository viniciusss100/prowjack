const express = require("express");
const router = express.Router();
const path = require("path");
const crypto = require("crypto");
const { isConfigured: isQbitConfigured, ensureTorrentReady, getPlayableLocalFile, streamTorrentFile } = require("../providers/qbittorrent");
const { ENV, CACHE_VERSION, STREAM_CACHE_VERSION, TORRENT_DOWNLOAD_TIMEOUT_MS, PUBLIC_TRACKERS, BAD_RE, BAD_EXT_RE, QB_EXTRA_SLOTS, MIN_STREAM_SEEDS, STREMTHRU_PROXY_TIMEOUT_MS } = require("../constants");
const { rc, redis, saveQbitJob, loadQbitJob } = require("../cache");
const { decodeUserCfg, resolvePrefs } = require("../configStore");
const { normalizePrefs, sanitizeUserPrefs, clampNumber, defaultPrefs } = require("../prefs");
const {
  getPublicBase,
  buildStremThruProxyManifestUrl,
  isQbitEnabledForPrefs,
  shouldOfferQbitForResult,
  getRequestAccessToken,
  hasAdminAccess,
  requireAdminAccess,
  getRssFastPathResults,
  sendConfigurePage,
  fetchScrapStreams,
  isPrivateTrackerCandidate,
  checkRateLimit
} = require("../routeHelpers");
const {
  RESOLUTION, QUALITY, CODEC, AUDIO, VISUAL, LANG,
  TITLE_CLEANUP_REGEX, STOPWORDS,
  first, matchAll, uniq, normTitle,
  getLangs, score,
  normalizeTitleTokens, escapedWordRegex,
  titleMatchScore, relaxedTitleMatchScore,
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
  hasDirectInfoHash, formatStream
} = require("../scoring");
const { decodeXmlEntities } = require("../jackettSearch"); // Fallback for some strings

const streamWaiters = new Map();
const {
  base32ToHex, extractInfoHash, extractInfoBuf, decodeBencode, extractTorrentFiles,
  pickEpisodeFile, normalizeTorrentLink, torrentFailureKeys, torrentDownloadRecentlyFailed,
  markTorrentDownloadFailed, infoHashQueueKey, InfoHashQueue, infoHashQueue, resolveInfoHash
} = require("../torrentUtils");
const {
  jackettFetchIndexers, fetchIndexerPrivacyMap, jackettSearch, buildQueries, resolveSearchIndexers, parseStreamId
} = require("../jackettSearch");
const {
  getPreferredRssIndexers, loadRssItemsForType, rssCatalogMetaId, getRssItemToken,
  parseRssMetaId, parseRssItemId, extractSeriesFeedMarker, extractAnimeFeedMarker,
  buildRssVideos, findRssItemByToken, matchRssItemsByMarker
} = require("../rssHelpers");
const { fetchStremThruStoreLinks, buildMagnet, resolveDebridStream } = require("../debrid");
const { fetchTmdbMeta, getImdbIdFromTmdb } = require("../metadata");
const { enrichWithTorrentData, enrichJackettResults, EXTRA_TRACKERS, extractTrackers, injectTrackers } = require("../torrentEnrich");


router.get("/internal/:userConfig/stream/:type/:id.json", async (req, res) => {
  try {
    const { userConfig, type, id } = req.params;
    // Carrega prefs mas força modo P2P puro (sem debrid/StremThru) para ser upstream
    const rawPrefs = await resolvePrefs(userConfig);
    // Internal ST upstream must wait the FULL available window so ALL indexers
    // can respond — not just the fastest one.
    //
    // BUG 1 FIX: antes usávamos Math.min(rawPrefs.slowThreshold, internalMax), que limitava
    // a fase rápida ao slowThreshold do usuário (padrão 8 s). Com 7+ indexers, a maioria
    // respondia depois dos 8 s e a rota interna enviava 0–1 resultado ao StremThru.
    // O slowThreshold do usuário controla o spinner de carregamento na rota PRINCIPAL;
    // para o upstream interno devemos usar o tempo máximo que o proxy StremThru permite.
    const internalMax = Math.min(20000, Math.max(8000, STREMTHRU_PROXY_TIMEOUT_MS - 5000));
    const prefs = { ...rawPrefs, debrid: false, stConfig: null, enableP2P: true, slowThreshold: internalMax, timeout: internalMax };
    delete prefs.debridConfig;
    delete prefs.stConfig;

    const parsed = await parseStreamId(type, id);
    if (!parsed) return res.json({ streams: [] });

    const plan = await buildQueries(type, id);
    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);
    const results  = await jackettSearch({ parsed, queries: plan.queries, search: plan.search }, indexers, prefs);
  const reqCtx = { hasTimedOut: false };
    if (results._incomplete) reqCtx.hasTimedOut = true;

    const priorityLang = prefs.priorityLang ?? "pt-br";
    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => {
        const isPrio = isPriorityIndexerResult(r, prefs);
        if (isPrio) r._priorityIndexer = true;
        return isPrio || !prefs.skipBadReleases || !BAD_RE.test(r.Title || "");
      })
      .filter(r => r._priorityIndexer || r._scrapSource || type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
      .filter(r => {
        if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) return true;
        if (prefs.onlyDubbed && priorityLang) {
          const langs = getLangs(r.Title || "", parsed.isAnime);
          if (!langs.some(l => l.code === priorityLang)) return false;
        }
        return true;
      })
      .map(r => {
        // Priorização de idioma/keyword aplicada ANTES de resolução/seeders:
        // mesmo com onlyDubbed desmarcado, resultados no idioma selecionado
        // (ou com keyword boost) ficam à frente dos demais.
        const hasPrioLang = priorityLang && (
          getLangs(r.Title || "", parsed.isAnime).some(l => l.code === priorityLang) ||
          (priorityLang === "pt-br" && /(dublado|dubbed.*pt|pt[-_. ]?br|\bpor\b|\bpt\b|portugu[eê]s|portuguese|brazilian)/i.test(r.Title || ""))
        );
        const hasKeyword = !!(prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost));
        const langRank = hasPrioLang ? 3 : (hasKeyword ? 2 : (/multi/i.test(r.Title || "") ? 1 : 0));
        r._rankBoost = langRank * 1000000;
        return r;
      })
      .sort((a, b) =>
        (((b._priorityIndexer ? 1 : 0) * 5000000) + (b._rankBoost || 0) + score(b, prefs.weights, parsed.isAnime, priorityLang)) -
        (((a._priorityIndexer ? 1 : 0) * 5000000) + (a._rankBoost || 0) + score(a, prefs.weights, parsed.isAnime, priorityLang))
      )
      .slice(0, prefs.maxResults || 20);

    // Resolve infohashes (ou preserva link .torrent para o StremThru caso falhe)
    const withHashes = (await (async () => {
      const results2 = new Array(candidates.length).fill(null);
      const CONC = 8;
      let idx = 0;
      async function worker() {
        while (idx < candidates.length) {
          const i = idx++;
          const cand = candidates[i];
          const resolved = await resolveInfoHash(cand, { ...reqCtx, fastOnly: false });
          if (resolved?.infoHash) {
            results2[i] = { ...cand, _resolved: resolved };
          } else if (cand.MagnetUri || cand.Link) {
            // Se falhou em resolver (ex: fastOnly) mas tem link, mantém para o StremThru
            results2[i] = { ...cand, _resolved: { infoHash: null, url: cand.MagnetUri || cand.Link } };
          }
        }
      }
      await Promise.all(Array.from({ length: CONC }, worker));
      return results2;
    })()).filter(Boolean);

    const maxOut = prefs.maxResults || 20;
    const streams = withHashes.slice(0, maxOut).map(r => {
      const resolved = r._resolved;
      const indexerName = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
      const { name, description, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, true, {});
      // Envia addonName na linha 2: StremThru prepend "⚡ [TB] " na linha 1
      // Resultado final: "⚡ [TB] \nProwJack\n🔵 FHD" → Stremio exibe ⚡[TB] / ProwJack / FHD
      const addonName = prefs.addonName || "ProwJack";
        
        const fallbackTitle = (r.Title && !r.Title.includes('\\n')) ? r.Title : "";
        const displayFileName = r._scrapStream?._filename || fallbackTitle;
        const filenameLine = displayFileName ? `📄 ${displayFileName}` : "";
        const isPrivateTracker = isPrivateTrackerCandidate(r, resolved);
        // BUG 2 FIX: antes descartávamos trackers privados aqui com return null.
        // Consequência: StremThru nunca os recebia, mesmo quando o torrent já estava
        // em cache no debrid (caso em que o StremThru resolveria normalmente).
        //
        // Novo comportamento:
        //   • Torrent privado EM CACHE no debrid → StremThru retorna URL → rota principal captura ✓
        //   • Torrent privado NÃO em cache      → StremThru devolve P2P (sem URL)
        //     → rota principal identifica pelo marcador "🔒 Tracker Privado" e cria job qBit ✓

        const streamObj = {
          name: `\n${addonName}\n${resLabel || "Links"}`,
          description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
          behaviorHints: { notWebReady: false },
        };

      const stStores = prefs.stConfig?.stores || [];

if (resolved.infoHash) {


        let trackerList = [];


        if (resolved.buffer) trackerList = extractTrackers(resolved.buffer);


        else if (r.MagnetUri) {


          for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {


            try { trackerList.push(decodeURIComponent(m[1])); } catch {}


          }


        }


        const sources = (trackerList.length ? trackerList : EXTRA_TRACKERS)


          .map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);


        


        streamObj.infoHash = resolved.infoHash;


        streamObj.sources = sources;


        streamObj.behaviorHints.bingeGroup = `prowjack|${resolved.infoHash}`;


      } else {
        return null;
      }
      return streamObj;
    }).filter(Boolean);

    console.log(`[Internal] ${type}/${id}: ${streams.length} streams P2P para StremThru`);
    if (reqCtx.hasTimedOut) {
      res.set("Cache-Control", "public, max-age=5, s-maxage=5");
    } else {
      res.set("Cache-Control", "public, max-age=60, s-maxage=300");
    }
    res.json({ streams });

    // Resolve no background para caches futuros sem saturar o Prowlarr/tracker.
    const queued = infoHashQueue.enqueueMany(candidates, maxOut * 2);
    if (queued) console.log(`[InfoHashQueue] ${queued} itens enfileirados pela rota interna`);
  } catch (err) {
    console.error(`[Internal] Erro: ${err.message}`);
    res.json({ streams: [] });
  }
});

router.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs = await resolvePrefs(req.params.userConfig);
  const isStremThruMode = !!(prefs.stConfig && Array.isArray(prefs.stConfig.stores) && prefs.stConfig.stores.length);
  const qbitCreds = null;
  const qbitEnabledForPrefs = isQbitEnabledForPrefs(prefs, qbitCreds);
  const { type, id } = req.params;
  console.log(`\n=========================================`);
  console.log(`NOVA BUSCA: [${type}] ${id}`);

  const isDebridMode = prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);

  if (isDebridMode) {
    console.log(`[DEBRID] Modo ativo: ${prefs.debridConfig.mode.toUpperCase()} — P2P desabilitado`);
  }

  // Cache de streams resolvidos — retorno instantâneo se já processado antes
  const streamCacheKey = `streams:${STREAM_CACHE_VERSION}:${req.params.userConfig}:${type}:${id}`;
  const cachedStreams = await rc.get(streamCacheKey).catch(() => null);
  if (cachedStreams) {
    try {
      const parsed = JSON.parse(cachedStreams);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[Stream Cache HIT] ${parsed.length} streams para ${id}`);
        console.log(`=========================================\n`);
        return res.json({ streams: parsed });
      }
    } catch {}
  }
  // Lock atômico: se já existe uma Promise em andamento para este cache key,
  // aguarda ela resolver em vez de disparar nova busca (elimina a race condition).
  if (streamWaiters.has(streamCacheKey)) {
    console.log(`[Stream In-flight] aguardando resultado existente para ${id}`);
    try {
      const inflightStreams = await Promise.race([
        streamWaiters.get(streamCacheKey),
        new Promise(resolve => setTimeout(() => resolve([]), 120000)),
      ]);
      if (Array.isArray(inflightStreams) && inflightStreams.length > 0) {
        console.log(`[Stream In-flight HIT] ${inflightStreams.length} streams para ${id}`);
        console.log(`=========================================\n`);
        return res.json({ streams: inflightStreams });
      }
    } catch {}
    console.log(`[Stream In-flight] timeout; retornando vazio temporario para ${id}`);
    console.log(`=========================================\n`);
    return res.json({ streams: [] });
  }

  // Cria a Promise de lock ANTES de qualquer await — garante atomicidade
  let _resolveLock;
  const lockPromise = new Promise(resolve => { _resolveLock = resolve; });
  streamWaiters.set(streamCacheKey, lockPromise);
  // releaseLock: resolve a Promise com os streams finais e remove o lock
  const releaseLock = (streams = []) => {
    _resolveLock(streams);
    streamWaiters.delete(streamCacheKey);
  };
  const _t0 = Date.now();
  const reqCtx = { hasTimedOut: false, stremthruMode: isStremThruMode };

  try {
    const { parsed, displayTitle, aliases = [], queries, episode, year, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);

    // streamMeta: usado pelo formatStream em todo o fluxo (incluindo fallback StremThru)
    const streamMeta = {
      title: displayTitle,
      year,
      formattedSeasons: (type === "series" && parsed.season != null)
        ? `S${String(parsed.season).padStart(2, "0")}${parsed.episode != null ? `E${String(parsed.episode).padStart(2, "0")}` : ""}`
        : "",
    };

    const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
    if (parsed.isAnime && !enabledCats.includes("anime"))                       { releaseLock(); return res.json({ streams: [] }); }
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) { releaseLock(); return res.json({ streams: [] }); }
    if (type === "movie" && !enabledCats.includes("movie"))                      { releaseLock(); return res.json({ streams: [] }); }

    if (isStremThruMode) {
      const _stStart = Date.now();
      const maxOut = prefs.maxResults || 20;
      const proxyManifestUrl = buildStremThruProxyManifestUrl(req, prefs, req.params.userConfig);
      const addonName = prefs.addonName || "ProwJack";
      // Fluxo ST puro:
      // 1) ProwJack expõe /internal como upstream P2P.
      // 2) StremThru Wrap consulta esse upstream e resolve via stores configurados.
      // 3) ProwJack recebe apenas a resposta do Wrap, organiza e entrega ao Stremio.
      const proxyStreams = proxyManifestUrl
        ? await fetchScrapStreams(proxyManifestUrl, type, id, { timeout: STREMTHRU_PROXY_TIMEOUT_MS, label: "STREMTHRU", preserveBadges: true, prefs })
        : [];
      console.log(`[PERF] stremthru=${Date.now() - _stStart}ms`);
      console.log(`[STREMTHRU] ${proxyStreams.length} streams recebidos do Wrap`);

      // Constrói streams finais somente a partir do Wrap.
      const combined = [];

      // Streams do StremThru: somente streams COM url = debrid efetivamente resolvido.
      // Quando StremThru não tem o torrent em cache, passa os streams P2P brutos do
      // addon interno (infoHash/sources sem url). Esses NÃO são debrid — são descartados.
      const stStreams = proxyStreams
          .filter(s => !!s.url)
          .filter(s => {
             const isPrivate = String(s.description || "").includes("Tracker Privado");
             const isUncached = String(s.name || "").includes("⬇️");
             return !(isPrivate && isUncached);
          })
          .map(s => {
          let desc = s.description || s.title || "";
          const filename = s.behaviorHints?.filename;
          if (filename && !desc.includes(filename)) {
            desc += `\n📂 ${filename}`;
          }
          const cleanName = (s.name || "")
            .split("\n")
            .map(l => l.trim())
            .filter(Boolean)
            .join("\n");
          return {
            ...s,
            name: cleanName || s.name,
            description: desc.trim(),
            sources: undefined,
            title: undefined,
            _filename: undefined,
            _sourceType: "debrid",
            _stremThruProxy: true,
            _cached: true,
          };
        });
      combined.push(...stStreams);

      // [QB] no StremThru — abordagem correta:
      // A rota interna já rodou jackettSearch e populou o cache Redis.
      // A cache key não inclui debrid/stConfig, então as duas rotas compartilham a mesma
      // entrada → esta chamada é um cache hit quase instantâneo.
      // Filtramos private trackers, recuperamos o buffer .torrent do Redis (separado do
      // cache JSON do jackettSearch, que não sobrevive à serialização de Buffer) e
      // criamos os jobs qBit da mesma forma que o fluxo nativo faz.
      if (qbitEnabledForPrefs) {
        try {
          const stIndexers = await resolveSearchIndexers(prefs, parsed.isAnime);
          const allCachedResults = await jackettSearch({ parsed, queries, search }, stIndexers, prefs);

          const privateResults = allCachedResults.filter(r =>
            r._resolved?.infoHash && isPrivateTrackerCandidate(r, r._resolved)
          );

          if (privateResults.length > 0) {
            console.log(`[QB/ST] ${privateResults.length} tracker(s) privado(s) no cache → criando jobs qBit`);

            const qbitJobs = await Promise.all(
              privateResults.slice(0, 5).map(async r => {
                try {
                  const ihKey = String(r._resolved.infoHash || "").toLowerCase();
                  if (!ihKey) return null;

                  // Buffer via Redis — o JSON do cache jackettSearch não preserva objetos Buffer
                  const buf = await rc.getBuffer(`torrent:${ihKey}`).catch(() => null);
                  if (!buf) return null;

                  let torrentB64;
                  try { torrentB64 = injectTrackers(buf).toString("base64"); }
                  catch  { torrentB64 = buf.toString("base64"); }

                  const magnet = buildMagnet(r._resolved.infoHash, null, "");
                  const jobToken = await saveQbitJob({
                    infoHash: r._resolved.infoHash,
                    link:     (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
                    magnet,
                    fileIdx:  null,
                    fileName: null,
                    torrentB64,
                  });

                  const indexerName = r._indexerName || r.Tracker || r.TrackerId || "Unknown";
                  const { resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, false, streamMeta);

                  return {
                    name:          `\n${addonName}\n⬇️ ${resLabel || "QB"} [QB]`,
                    description:   String(r.Title || ""),
                    url:           `${getPublicBase(req)}/${req.params.userConfig}/qbit/${jobToken}`,
                    behaviorHints: { notWebReady: false },
                    _sourceType:   "http",
                    _cached:       false,
                  };
                } catch (e) {
                  console.log(`[QB/ST] Erro no job qBit para ${r._resolved?.infoHash}: ${e.message}`);
                  return null;
                }
              })
            );

            combined.push(...qbitJobs.filter(Boolean));
          }
        } catch (e) {
          console.log(`[QB/ST] Erro ao buscar private trackers do cache: ${e.message}`);
        }
      }
      // Priorização por idioma/keyword também no fluxo StremThru. Sem isso, os
      // streams vindos do Wrap eram entregues na ordem de resolução do debrid
      // (tipicamente idioma original primeiro), ignorando o PT-BR priorizado e as
      // keywords mesmo com onlyDubbed desmarcado.
      const _stPriorityLang = prefs.priorityLang ?? "pt-br";
      const _stHasPriorityLang = (s) => {
        const t = [s.description, s.name, s.behaviorHints?.filename, s._title].filter(Boolean).join(" ");
        const langs = getLangs(t, parsed.isAnime);
        return !!(
          (_stPriorityLang && langs.some(l => l.code === _stPriorityLang)) ||
          (_stPriorityLang === "pt-br" && /(dublado|dubbed.*pt|pt[-_. ]?br|\bpor\b|\bpt\b|portugu[eê]s|portuguese|brazilian)/i.test(t))
        );
      };
      const _stHasKeyword = (s) => !!(prefs.keywordBoost && matchesKeywordBoost([s.description, s.name, s.behaviorHints?.filename].filter(Boolean).join(" "), prefs.keywordBoost));
      combined.sort((a, b) => {
        const da = a._cached ? 0 : (a._sourceType === "debrid" ? 1 : 2);
        const db = b._cached ? 0 : (b._sourceType === "debrid" ? 1 : 2);
        if (da !== db) return da - db;
        if (a._priorityIndexer && !b._priorityIndexer) return -1;
        if (!a._priorityIndexer && b._priorityIndexer) return 1;
        const dpl = (_stHasPriorityLang(b) ? 0 : 1) - (_stHasPriorityLang(a) ? 0 : 1);
        const dkw = (_stHasKeyword(b) ? 0 : 1) - (_stHasKeyword(a) ? 0 : 1);
        // Keyword priorizada sobre o idioma selecionado:
        if (dkw !== 0) return dkw;
        if (dpl !== 0) return dpl;
        return 0;
      });

      const finalStreamsCombined = combined.slice(0, maxOut);

      // Remove campos internos antes de enviar ao Stremio
      const isStremThruProxyClient = /stremthru|go-http-client/i.test(req.headers["user-agent"] || "");
        let finalStreamsToProcess = finalStreamsCombined;
        if (ENV.enablePureP2P === false && !isStremThruProxyClient) {
          finalStreamsToProcess = finalStreamsToProcess.filter(s => s._sourceType !== "p2p");
        }
        const finalStreams = finalStreamsToProcess.map(s => {
        delete s._cached; delete s._sourceType; delete s._scrapSource;
        delete s._stremThruProxy; delete s._title; delete s._seeders;
        delete s._sizeGb; delete s._sizeBytes; delete s._priorityIndexer;
        return s;
      });

      if (finalStreams.length > 0) {
        const ttl = reqCtx.hasTimedOut ? 5 : 10800;
        await rc.set(streamCacheKey, JSON.stringify(finalStreams), ttl).catch(() => {});
        const finalShape = finalStreams.slice(0, 5).map(s => ({
          name: String(s.name || "").replace(/\n/g, " | ").slice(0, 80),
          url: !!s.url,
          externalUrl: !!s.externalUrl,
          infoHash: !!s.infoHash,
        }));
        console.log(`[STREMTHRU] Enviando ${finalStreams.length} streams totais`);
        console.log(`[STREMTHRU] Shape: ${JSON.stringify(finalShape)}`);
        releaseLock(finalStreams);
        return res.json({ streams: finalStreams });
      }

      console.log(`[STREMTHRU] Wrap retornou 0 streams (${Date.now() - _stStart}ms) — fallback para busca direta via debrid`);
      releaseLock([]);
    }


    const indexers     = await resolveSearchIndexers(prefs, parsed.isAnime);

    // Fast-path: tenta encontrar resultados no cache RSS antes de buscar nos indexers
    let results = [];
    let rssMatchedResults = [];
    const rssType = parsed.rssType || (parsed.isAnime ? "anime" : type === "movie" ? "movie" : "series");
    let usedRssFastPath = false;
    const isOwnRssCatalogItem = parsed.source === "rssmovie" || parsed.source === "rssitem";
    const preferredRssIndexers = Array.isArray(prefs.rssIndexers) && prefs.rssIndexers.length
      ? prefs.rssIndexers
      : (Array.isArray(prefs.indexers) && prefs.indexers.length && !prefs.indexers.includes("all") ? prefs.indexers : null);
    const bypassRssFilters = parsed.source === "rssitem" || !!preferredRssIndexers?.length;

    if (parsed.source === "rssmovie") {
      // Filme do catálogo RSS — busca só no cache RSS, sem jackettSearch
      const rssHits = await loadRssItemsForType(prefs, "movie");
      const matched = rssHits.filter(r => normalizeImdbId(r.ImdbId) === normalizeImdbId(parsed.metaId));
      if (matched.length) {
        results = matched.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
        usedRssFastPath = true;
        console.log(`[RSS Fast-path] ${results.length} resultados do cache RSS para ${parsed.metaId}`);
      } else {
        releaseLock();
        return res.json({ streams: [] });
      }
    } else if (parsed.source === "rssitem" && parsed.rssToken) {
      const rssHits = await loadRssItemsForType(prefs, parsed.rssType || rssType);
      const exactItem = findRssItemByToken(rssHits, parsed.rssToken);
      if (exactItem) {
        results = [{ ...exactItem, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: 0 }];
        usedRssFastPath = true;
      } else {
        releaseLock();
        return res.json({ streams: [] });
      }
    } else if (parsed.source === "rssitem") {
      const rssHits = await loadRssItemsForType(prefs, parsed.rssType || rssType);
      const requestedEpisode = parsed.episode ?? 0;
      const exactItems = matchRssItemsByMarker(
        rssHits,
        parsed.rssType || rssType,
        parsed.metaId,
        parsed.season ?? 1,
        requestedEpisode
      );
      if (exactItems.length) {
        results = exactItems.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
        usedRssFastPath = true;
      } else {
        releaseLock();
        return res.json({ streams: [] });
      }
    } else if (requestedImdbId || aliases.length) {
      const allowedRss = preferredRssIndexers;
      const rssPattern = allowedRss
        ? null // busca por chaves específicas abaixo
        : `rss:${CACHE_VERSION}:*:${rssType}:*`;
      const rssKeys = allowedRss
        ? await Promise.all(allowedRss.map(ix => rc.keys(`rss:${CACHE_VERSION}:${ix}:${rssType}:*`))).then(a => a.flat())
        : await rc.keys(rssPattern);
      if (rssKeys.length > 0) {
        const rssHits = (await Promise.all(
          rssKeys.map(async key => {
            try { const raw = await rc.get(key); return raw ? JSON.parse(raw) : []; }
            catch { return []; }
          })
        )).flat();

        const matched = rssHits
          .map((r, idx) => {
            const resultImdbId = normalizeImdbId(r.ImdbId);
            const byImdb = !!(requestedImdbId && resultImdbId && resultImdbId === requestedImdbId);
            const titleScore = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const effectiveScore = Math.max(titleScore, (parsed.isAnime || type === "series") ? relaxedScore * 0.85 : 0);
            const minAliasScore = parsed.isAnime ? 0.45 : type === "series" ? 0.5 : 0.6;
            const byAlias = effectiveScore >= minAliasScore;
            if (!byImdb && !byAlias) return null;
            return {
              ...r,
              _metaIdMatch: byImdb,
              _titleMatchScore: effectiveScore,
              _rssPreferred: bypassRssFilters,
              _rssOrder: idx,
            };
          })
          .filter(Boolean);

        if (matched.length > 0) {
          console.log(`[RSS Fast-path] ${matched.length} resultados do cache RSS para ${requestedImdbId || displayTitle}`);
          rssMatchedResults = matched;
        }
      }
    }

    // Busca scrap sempre, integrando os resultados na pipeline do ProwJack
    const scrapResults = ENV.scrapManifests.length > 0
      ? await Promise.all(ENV.scrapManifests.map(async (m, idx) => {
          const streams = await fetchScrapStreams(m, type, id, { prefs });
          console.log(`[SCRAP ${idx}] ${m.slice(0, 60)}... → ${streams.length} streams`);
          let scrapName = "Scrap Externo";
          try {
            const host = new URL(m).hostname;
            const parts = host.split('.');
            let rawName = parts.length >= 2 ? (parts[0] === 'www' || parts[0] === 'api' ? parts[1] : parts[0]) : host;
            scrapName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          } catch {}
          return streams.map(s => ({ ...s, _scrapName: scrapName }));
        }))
      : [];

    if (!isOwnRssCatalogItem) {
      // Busca Jackett
      const _tSearch = Date.now();
      const jackettResults = await jackettSearch({ parsed, queries, search }, indexers, prefs);
      if (jackettResults._incomplete) reqCtx.hasTimedOut = true;
      console.log(`[PERF] search=${Date.now() - _tSearch}ms (${jackettResults.length} resultados)`);
      results = [...rssMatchedResults, ...jackettResults];
      if (rssMatchedResults.length) {
        console.log(`[RSS + Live] ${rssMatchedResults.length} resultados RSS combinados com ${jackettResults.length} resultados ao vivo`);
      }
    }
    
    // Converte streams do scrap para formato de candidatos Jackett-like
    const scrapStreams = scrapResults.flat();
    const usenetCount = scrapStreams.filter(s => s.externalUrl && !s.url).length;
    const torrentCount = scrapStreams.filter(s => s.url || s.infoHash).length;
    console.log(`[SCRAP] Recebidos ${scrapStreams.length} streams de ${ENV.scrapManifests.length} addon(s) externo(s) (${torrentCount} torrent, ${usenetCount} usenet)`);
    
    const scrapCandidates = scrapStreams.map(s => {
      const titleText = s._title || [s.title, s.name, s.description, s.behaviorHints?.filename].filter(Boolean).join("\n") || "Scrap Stream";
      const fname = s._filename || s.behaviorHints?.filename || "";
      const hash = s.infoHash || (s.url && s.url.match(/btih:([a-f0-9]{40})/i)?.[1]) || null;
      const streamUrl = s.url || s.externalUrl || null;
      
      return {
        Title: titleText,
        InfoHash: hash,
        MagnetUri: hash ? `magnet:?xt=urn:btih:${hash}` : null,
        Link: streamUrl || 'scrap-stream',
        Size: s._sizeBytes || s.behaviorHints?.videoSize || 0,
        Seeders: s._seeders || 0,
        _scrapStream: s,
        _scrapSource: true,
        _indexerName: s._scrapName || 'Scrap Externo',
        Tracker: s._scrapName || 'Scrap Externo',
        TrackerId: 'scrap',
        Indexer: s._scrapName || 'Scrap Externo',
        _priorityIndexer: true,
        _isCached: true
      };
    });
    
    console.log(`[SCRAP] Convertidos ${scrapCandidates.length} candidatos (${scrapCandidates.filter(c => c.InfoHash).length} com hash, ${scrapCandidates.filter(c => c._scrapStream.url || c._scrapStream.externalUrl).length} com url/usenet)`);
    
    // Adiciona candidatos do scrap ao results
    results = [...results, ...scrapCandidates];
    const priorityLang = prefs.priorityLang ?? "pt-br";

    console.log(`Filtros ativos: onlyDubbed=${prefs.onlyDubbed}, priorityLang=${priorityLang}, keywordBoost=${prefs.keywordBoost ? 'SIM' : 'NÃO'}, priorityIndexers=[${(prefs.priorityIndexers||[]).join(",")}], maxPerIndexer=${prefs.maxResultsPerIndexer||0}`);

    const candidates = (bypassRssFilters && usedRssFastPath
      ? results
          .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
          .filter(r => {
            if (parsed.source === "rssitem") return true;
            if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
            if (type === "series") return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            return true;
          })
          .map(r => {
            r._originalScore = 1_000_000 - (r._rssOrder || 0);
            return r;
          })
      : results
          .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
          .filter(r => {
            const isPrio = isPriorityIndexerResult(r, prefs);
            if (isPrio) r._priorityIndexer = true;
            return isPrio || r._scrapSource || !prefs.skipBadReleases || !BAD_RE.test(r.Title || "");
          })
          .filter(r => r._priorityIndexer || r._scrapSource || type !== "movie" || !looksLikeEpisodeRelease(r.Title || ""))
          .filter(r => {
            if (r._priorityIndexer || r._scrapSource) return true;
            if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
            if (type === "series") {
              // Resultados de busca estruturada (tvsearch com season/ep) já foram filtrados
              // pelo indexador — não descartar por falta de marcador no título.
              // Mas ainda verifica se o título não é claramente de outra temporada/episódio.
              if (r._structuredMatch) {
                const rank = episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
                // rank=0 significa que o título tem marcador de OUTRA temporada/episódio — descartar
                // rank>=2: season-only, complete pack da temporada certa, ou episódio exato — aceitar
                // rank=1: complete pack sem marcador de temporada — aceitar (pack genérico)
                return rank !== 0;
              }
              // Resultados com ImdbId correspondente: ainda verifica episódio para evitar
              // retornar S05E05 quando pediu S05E07
              const resultImdbId = getResultImdbId(r);
              if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
                return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
              }
              return seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
            }
            return true;
          })
          .filter(r => {
            // keywordBoost sempre passa (independente de idioma)
            if (prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost)) {
              r._titleMatchScore = 1; r._keywordMatch = true; return true;
            }
            // Scrap externo (ex.: BrasilRD): usuário já optou por essas fontes e
            // elas retornam conteúdo dublado/legendado em PT-BR — manter mesmo com
            // onlyDubbed (senão esconde streams dublados cujo nome não marca idioma).
            if (r._scrapSource) {
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              return true;
            }
            // onlyDubbed=true: filtra por idioma os resultados regulares
            if (prefs.onlyDubbed && priorityLang) {
              const titleForLang = r.Title || r._title || "";
              const langs = getLangs(titleForLang, parsed.isAnime);
              const hasLang = langs.some(l => l.code === priorityLang);
              if (!hasLang) return false;
            }
            if (r._priorityIndexer) {
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              return true;
            }
            return true;
          })
          .filter(r => {
            if (r._keywordMatch) return true;
            const resultImdbId = getResultImdbId(r);
            if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
              // ImdbId bate: ainda verifica episódio para séries
              if (type === "series") {
                if (!seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode)) return false;
              }
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              r._metaIdMatch = true; return true;
            }
            if (r._priorityIndexer || r._scrapSource || r._metaIdMatch) return true;
            const langs   = getLangs(r.Title || "", parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;

            // onlyDubbed: itens que chegaram aqui já passaram pelo filtro de idioma — aceita direto
            if (prefs.onlyDubbed && priorityLang && hasLang) {
              r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
              return true;
            }

            const sc           = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
            const episodeRank  = parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
            const minScore     = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
            const finalScore   = Math.max(sc, type === "series" ? relaxedScore * 0.8 : 0);
            if (hasLang && finalScore >= 0.1) r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
            r._titleMatchScore = Math.max(r._titleMatchScore || 0, finalScore);
            return finalScore >= minScore || (hasLang && finalScore >= 0.1);
          })
          .filter(r => { if (r._priorityIndexer || r._scrapSource) return true; if (type !== "movie" || !year) return true; const ry = extractReleaseYear(r.Title || ""); return !ry || Math.abs(ry - year) <= 1; })
          .map(r => {
            const t       = r.Title || "";
            const langs   = getLangs(t, parsed.isAnime);
            const hasLang = priorityLang ? langs.some(l => l.code === priorityLang) : false;
            const isMulti = /(multi)[-.\\s]?(audio)?/i.test(t);
            const langPriority = (prefs.keywordBoost && matchesKeywordBoost(t, prefs.keywordBoost)) ? 4 : (hasLang ? 3 : (isMulti ? 1 : 0));
            r._originalScore = ((r._priorityIndexer ? 1 : 0) * 5000000) +
              (langPriority * 100000) +
              ((r._metaIdMatch    ? 1 : 0) * 40000) +
              ((r._structuredMatch ? 1 : 0) * 20000) +
              (parsed.isAnime ? animeEpisodeMatchRank(r.Title || "", episode) : episodeMatchRank(r.Title || "", parsed.season, parsed.episode)) * 10000 +
              (r._titleMatchScore || 0) * 1000 +
              score(r, prefs.weights, parsed.isAnime, priorityLang);
            return r;
          })
          .sort((a, b) => b._originalScore - a._originalScore));

    console.log(`Resultados: ${results.length} brutos → ${candidates.length} após filtros (idioma, título, ano)`);
    if (prefs.keywordBoost) {
      const withKeywords = candidates.filter(r => matchesKeywordBoost(r.Title || "", prefs.keywordBoost));
      console.log(`Keywords: ${withKeywords.length}/${candidates.length} releases com boost`);
    }

    // maxResultsPerIndexer é aplicado aqui apenas para limitar candidatos enviados ao cache check.
    // O limite real por indexer na lista final é aplicado após a ordenação dos streams (abaixo).
    const filteredCandidates = candidates;

    const maxOut              = prefs.maxResults || 20;

    const candidateHasKeyword = r => !!(prefs.keywordBoost && matchesKeywordBoost(r.Title || "", prefs.keywordBoost));
    const candidateHasPriorityLang = r => {
      const t = r.Title || "";
      const langs = getLangs(t, parsed.isAnime);
      return !!(
        (priorityLang && langs.some(l => l.code === priorityLang)) ||
        ((priorityLang === "pt-br" && /(dublado|dubbed.*pt|pt[-_. ]?br|\bpor\b|\bpt\b|portugu[eê]s|portuguese|brazilian)/i.test(t)))
      );
    };

    const cacheCheckCandidates = (() => {
      if (!isDebridMode || prefs.stConfig) {
        const priority = filteredCandidates.filter(r => r._priorityIndexer || candidateHasPriorityLang(r) || candidateHasKeyword(r) || r._scrapSource);
        const regular = filteredCandidates.filter(r => !r._priorityIndexer && !candidateHasPriorityLang(r) && !candidateHasKeyword(r) && !r._scrapSource).slice(0, Math.max(maxOut * 3, 80));
        return [...priority, ...regular];
      }
      const direct = filteredCandidates.filter(hasDirectInfoHash);
      const httpOnly = filteredCandidates.filter(r => !hasDirectInfoHash(r));
      const priorityDirect = direct.filter(r => r._priorityIndexer || candidateHasPriorityLang(r) || candidateHasKeyword(r) || r._scrapSource);
      const regularDirect = direct.filter(r => !r._priorityIndexer && !candidateHasPriorityLang(r) && !candidateHasKeyword(r) && !r._scrapSource);
      const priorityHttp = httpOnly.filter(r => r._priorityIndexer || r._keywordMatch || candidateHasPriorityLang(r) || candidateHasKeyword(r) || r._scrapSource).slice(0, 15);
      const regularHttp = httpOnly.filter(r => !r._priorityIndexer && !r._keywordMatch && !candidateHasPriorityLang(r) && !candidateHasKeyword(r) && !r._scrapSource).slice(0, Math.max(4, Math.ceil(maxOut / 3)));
      const directLimit = Math.max(maxOut * 3, 80);
      const selected = [...priorityDirect, ...regularDirect.slice(0, directLimit), ...priorityHttp, ...regularHttp];
      const seen = new Set();
      return selected.filter(r => {
        const key = r.InfoHash || r.MagnetUri || r.Link || r.Guid || r.Title;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })();
    const topCandidates = cacheCheckCandidates;
    const directCount = topCandidates.filter(hasDirectInfoHash).length;
    console.log(`Extraindo InfoHashes de ${topCandidates.length} candidatos (${directCount} diretos, ${topCandidates.length - directCount} via .torrent)...`);

    const withHashes = (await (async () => {
      const results = new Array(topCandidates.length).fill(null);
      const CONCURRENCY = 10;
      let idx = 0;
      async function worker() {
        while (idx < topCandidates.length) {
          const i = idx++;
          const candidate = topCandidates[i];
          
          // Candidatos do scrap não precisam de resolveInfoHash — já têm URL de streaming
          if (candidate._scrapSource) {
            results[i] = { ...candidate, _resolved: { infoHash: candidate.InfoHash || null, files: [] } };
            continue;
          }
          
          const resolved = await resolveInfoHash(candidate, reqCtx);
          results[i] = resolved?.infoHash ? { ...candidate, _resolved: resolved } : null;
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return results;
    })()).filter(Boolean);

      let rdCacheMap = {};
      let tbCacheMap = {};
      let stCacheMap = {};

    if (isDebridMode && !prefs.stConfig && withHashes.length > 0) {
      const _tDebrid = Date.now();
      const { mode, torboxKey, rdKey } = prefs.debridConfig;
      const { rdBatchCheckCache, torboxBatchCheckCache } = require("../debrid");

      const privateHashes = new Set(
        withHashes.filter(r => !r.MagnetUri && r._resolved?.buffer).map(r => r._resolved.infoHash)
      );
      const bufferMap = {};
      for (const r of withHashes) {
        if (r._resolved?.buffer) bufferMap[r._resolved.infoHash] = r._resolved.buffer;
      }

      // Pré-filtra hashes excluídos pelo RD antes do cache check para reduzir chamadas à API
      const rdExcludedHashes = new Set(
        (mode === "realdebrid" || mode === "dual")
          ? withHashes
              .filter(r => isRdExcludedResult(r, prefs, r._indexerName || r.Tracker || r.TrackerId || r.Indexer || ""))
              .map(r => r._resolved.infoHash)
          : []
      );
      if (rdExcludedHashes.size) console.log(`[RD Exclude] ${rdExcludedHashes.size} hashes excluídos antes do cache check`);

      const allHashes = [...new Set(
        withHashes
          .filter(r => mode === "torbox" || !rdExcludedHashes.has(r._resolved.infoHash))
          .map(r => String(r._resolved.infoHash || "").toLowerCase())
          .filter(Boolean)
      )];
      // Para TorBox no modo dual, inclui todos (RD excluído não afeta TB)
      const allHashesForTB = [...new Set(withHashes.map(r => String(r._resolved.infoHash || "").toLowerCase()).filter(Boolean))];

      const [rdResult, tbResult] = await Promise.all([
        (mode === "realdebrid" || mode === "dual") && rdKey && allHashes.length
          ? rdBatchCheckCache(allHashes, rdKey, bufferMap, privateHashes) : Promise.resolve({}),
        (mode === "torbox"     || mode === "dual") && torboxKey
          ? torboxBatchCheckCache(allHashesForTB, torboxKey, privateHashes) : Promise.resolve({}),
      ]);
      rdCacheMap = rdResult;
      tbCacheMap = tbResult;

      const debridCached = new Set();
      withHashes.forEach(r => {
        r._isCached = false;
        const h = String(r._resolved.infoHash || "").toLowerCase();
        if ((mode === "realdebrid" || mode === "dual") && rdCacheMap[h]?.rd?.length > 0) {
          r._isCached = true; debridCached.add(h);
        }
        if ((mode === "torbox" || mode === "dual") && tbCacheMap[h] && typeof tbCacheMap[h] === 'object' && tbCacheMap[h] !== false) {
          r._isCached = true; debridCached.add(h);
        }
      });
      console.log(`[DEBRID] cached=${debridCached.size} uncached=${withHashes.length - debridCached.size}`);
      console.log(`[PERF] debrid=${Date.now() - _tDebrid}ms`);
    } else if (prefs.stConfig && withHashes.length > 0) {
      console.log(`[STREMTHRU] Executando cache check nativo via API do StremThru...`);
      const _tDebrid = Date.now();
      const allHashesST = [...new Set(withHashes.map(r => String(r._resolved?.infoHash || "").toLowerCase()).filter(Boolean))];
      const axios = require("axios");

      const stStore = prefs.stConfig.stores[0];
      if (stStore) {
        const stHeaders = { "X-StremThru-Store-Name": stStore.c, "X-StremThru-Store-Authorization": `Bearer ${stStore.t}` };
        const stBase = prefs.stConfig.url.replace(/\/+$/, "");

        // Passo 1: Busca status de cache de todos os hashes
        await Promise.all(allHashesST.map(async hash => {
          try {
            const checkRes = await axios.get(`${stBase}/v0/store/magnets/check?magnet=${hash}`, {
              headers: stHeaders, validateStatus: () => true, timeout: 5000,
            });
            if (checkRes.status === 200 && checkRes.data?.data?.items) {
              const torrent = checkRes.data.data.items.find(t => t.hash?.toLowerCase() === hash);
              if (torrent && (torrent.status === "downloaded" || (torrent.files && torrent.files.length > 0))) {
                stCacheMap[hash] = torrent;
              }
            }
          } catch {}
        }));

        // Passo 2: Busca IDs via Torz list para hashes em cache que não têm id
        const missingIds = Object.entries(stCacheMap).filter(([, v]) => !v?.id).map(([k]) => k);
        if (missingIds.length) {
          try {
            const listRes = await axios.get(`${stBase}/v0/store/torz?limit=500`, {
              headers: stHeaders, timeout: 10000, validateStatus: s => s < 400,
            });
            const items = listRes.data?.data?.items || [];
            for (const item of items) {
              const h = (item.hash || "").toLowerCase();
              if (h && stCacheMap[h] && !stCacheMap[h].id && item.id) {
                stCacheMap[h] = { ...stCacheMap[h], id: item.id, files: item.files || stCacheMap[h].files };
              }
            }
          } catch {}
        }
      }

      let cachedCount = 0;
      for (const r of withHashes) {
        if (r._resolved?.infoHash && stCacheMap[r._resolved.infoHash.toLowerCase()]) {
          r._isCached = true;
          cachedCount++;
        }
      }
      console.log(`[STREMTHRU] Cache check concluído em ${Date.now() - _tDebrid}ms. Cacheados: ${cachedCount}`);
    }

    const availabilityFiltered = (() => {
      const filtered = withHashes.filter(r => {
        const cached = r._isCached === true || r._scrapStream?._cached === true;
        return cached || visibleSeedCount(r) >= MIN_STREAM_SEEDS;
      });
      if (filtered.length < withHashes.length) {
        console.log(`[Seeds] ${withHashes.length - filtered.length} candidato(s) abaixo de MIN_STREAM_SEEDS=${MIN_STREAM_SEEDS} removidos por não estarem em cache`);
      }
      return filtered;
    })();

    const dedupedWithHashes = (bypassRssFilters || prefs.dedupe === false)
      ? availabilityFiltered
      : dedupeWithCachePriority(availabilityFiltered, isDebridMode && !prefs.stConfig);
    if (!bypassRssFilters && prefs.dedupe !== false && dedupedWithHashes.length < withHashes.length) {
      const removed = withHashes.length - dedupedWithHashes.length;
      console.log(`[DEDUP] ${withHashes.length} → ${dedupedWithHashes.length} candidatos (-${removed} duplicatas, preferiu público cacheado)`);
    }
    const candidateCacheRank = r => r._isCached ? 0 : 1;
    const candidateLangRank = r => candidateHasPriorityLang(r) ? 0 : 1;
    const candidateKeywordRank = r => candidateHasKeyword(r) ? 0 : 1;
    const candidateResScore = r => { const rr = first(RESOLUTION, r.Title || ""); return rr ? rr.score : 0; };
    const candidateQualScore = r => { const q = first(QUALITY, r.Title || ""); return q ? q.score : 0; };
    const sortedCandidates = dedupedWithHashes
      .slice()
      .sort((a, b) => {
        const dc = candidateCacheRank(a) - candidateCacheRank(b); if (dc !== 0) return dc;
        const dpi = (b._priorityIndexer ? 1 : 0) - (a._priorityIndexer ? 1 : 0); if (dpi !== 0) return dpi;
        const dk = candidateKeywordRank(a) - candidateKeywordRank(b); if (dk !== 0) return dk;
        const dl = candidateLangRank(a) - candidateLangRank(b); if (dl !== 0) return dl;
        const dq = candidateQualScore(b) - candidateQualScore(a); if (dq !== 0) return dq;
        const dr = candidateResScore(b) - candidateResScore(a); if (dr !== 0) return dr;
        const dz = (b.Size || 0) - (a.Size || 0); if (dz !== 0) return dz;
        return (b.Seeders || 0) - (a.Seeders || 0);
      });
    const streamCandidateLimit = Math.max(maxOut * 3, 80);
    const priorityCandidates = sortedCandidates.filter(r => candidateHasPriorityLang(r) || candidateHasKeyword(r));
    const regularCandidates = sortedCandidates.filter(r => !candidateHasPriorityLang(r) && !candidateHasKeyword(r));
    const regularLimit = Math.max(0, streamCandidateLimit - priorityCandidates.length);
    const streamCandidates = [...priorityCandidates, ...regularCandidates.slice(0, regularLimit)];
    if (dedupedWithHashes.length > streamCandidates.length) {
      console.log(`[LIMIT] resolvendo ${streamCandidates.length}/${dedupedWithHashes.length} candidatos (${priorityCandidates.length} idioma/keyword preservados)`);
    }

    // streamMeta definido antes do bloco StremThru (linha ~2812)

    const resolvedAll = await Promise.all(
      streamCandidates.map(async r => {
        try {
          // Scrap sem infoHash (link direto/usenet) já vem resolvido pelo addon externo.
          if (r._scrapSource && r._scrapStream && !r._resolved?.infoHash) {
            const ss = r._scrapStream;
            const desc = [ss.description || ss.title || "", ss._scrapName ? `📂 ${ss._scrapName}` : ""]
              .filter(Boolean).join("\n");
            return {
              name: ss.name || `[Scrap] ${ss._scrapName || ""}`,
              description: desc,
              url: ss.url,
              externalUrl: ss.externalUrl,
              behaviorHints: ss.behaviorHints || { notWebReady: false },
              _sourceType: "http",
              _cached: true
            };
          }
          
          const resolved     = r._resolved;
          const indexerName  = r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "Unknown";
          const rdExcluded   = isRdExcludedResult(r, prefs, indexerName);
          // Scrap com infoHash: formata usando a formatação nativa do addon (Scrap Externo)
          const { name, description: descNoSeeds, resLabel } = formatStream(r, indexerName, parsed.isAnime, prefs, false, streamMeta);
          const { description } = formatStream(r, indexerName, parsed.isAnime, prefs, true, streamMeta);
          const matchedFile  = (type === "series" || parsed.isAnime)
            ? pickEpisodeFile(resolved.files, parsed.season, parsed.episode ?? episode, parsed.isAnime)
            : null;
          if ((type === "series" || parsed.isAnime) && resolved.files?.length && !matchedFile) {
            console.log(`[WARN] pickEpisodeFile: nenhum arquivo encontrado para S${parsed.season}E${parsed.episode ?? episode} em "${r.Title?.slice(0,60)}"`);
          } else if (matchedFile) {
            console.log(`[FILE] Arquivo selecionado: "${matchedFile.name}" (idx=${matchedFile.idx}) para S${parsed.season}E${parsed.episode ?? episode}`);
          }
          const displayFile = matchedFile || (Array.isArray(resolved.files) && resolved.files.length
            ? resolved.files
                .filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name || ""))
                .sort((a, b) => (b.size || 0) - (a.size || 0))[0]
              || resolved.files.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0]
            : null);
          const fallbackTitle = (r.Title && !r.Title.includes('\n')) ? r.Title : "";
          const displayFileName = displayFile?.name || r._scrapStream?._filename || fallbackTitle;
          const filenameLine = displayFileName ? `📂 ${displayFileName}` : "";
          // Descarta streams cujo arquivo selecionado não é reproduzível (iso, rar, zip, etc.)
          if (displayFile?.name && BAD_EXT_RE.test(displayFile.name)) return null;
          const magnet      = buildMagnet(resolved.infoHash, r.MagnetUri, r.Title);
          const publicBase  = getPublicBase(req);
          const localPlayable = !isDebridMode && qbitEnabledForPrefs
            ? await getPlayableLocalFile(resolved.infoHash, matchedFile?.idx ?? null, matchedFile?.name || null, qbitCreds).catch(() => null)
            : null;

          // Tracker privado = resultado por link .torrent sem MagnetUri, mesmo quando o buffer veio do cache.
          const isPrivateTracker = isPrivateTrackerCandidate(r, resolved);

          let qbitStreamPromise = null;
          const buildQbitStream = async () => {
            if (qbitStreamPromise) return qbitStreamPromise;
            qbitStreamPromise = (async () => {
            // FIX: salva o buffer .torrent já baixado no job (evita re-download que pode falhar)
            // para trackers privados sem MagnetUri o re-download frequentemente falha por expiração
            // de sessão do Jackett. O buffer é enriquecido com trackers extras antes de salvar.
            let torrentB64 = null;
            if (resolved.buffer) {
              try {
                torrentB64 = injectTrackers(resolved.buffer).toString("base64");
              } catch {
                torrentB64 = resolved.buffer.toString("base64");
              }
            }
            const jobToken = await saveQbitJob({
              infoHash: resolved.infoHash,
              link:     (r.Link && !r.Link.startsWith("magnet:")) ? r.Link : null,
              magnet,
              fileIdx:  matchedFile?.idx  ?? null,
              fileName: matchedFile?.name || null,
              torrentB64,
            });
            const qbitName = localPlayable
              ? `${prefs.addonName || "ProwJack"}\n⚡️ ${resLabel || "Links"} [QB]`
              : `${prefs.addonName || "ProwJack"}\n⬇️ ${resLabel || "Links"} [QB]`;
            return {
              name: qbitName,
              description: [description, filenameLine, isPrivateTracker ? "🔒 Tracker Privado" : ""].filter(Boolean).join("\n"),
              url:   `${publicBase}/${req.params.userConfig}/qbit/${jobToken}`,
              indexer: renameIndexer(indexerName),
              _cached: !!localPlayable,
              _sourceType: "http",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: {
                filename:   displayFileName,
                videoSize:  displayFile?.size,
                bingeGroup: `prowjack|qbit|${resolved.infoHash}`,
                notWebReady: false,
              },
            };
            })();
            return qbitStreamPromise;
          };

          if (isDebridMode) {
            const debridMode = prefs.debridConfig?.mode;
            // No modo realdebrid puro, bloqueia o torrent inteiro se excluído
            if (rdExcluded && debridMode === "realdebrid") {
              console.log(`[RD Exclude] ${r.Title?.slice(0, 80)} (${indexerName})`);
              return null;
            }
            // No modo torbox puro, rdExcluded não deve ter efeito algum
            // No modo dual, rdExcluded só filtra o stream RD (dentro do resultsArray.filter abaixo)
            const debridData = await resolveDebridStream(
              resolved.infoHash,
              magnet,
              r.Title,
              parsed.season,
              parsed.episode ?? episode,
              parsed.isAnime,
              prefs.debridConfig,
              resolved.files,
              rdCacheMap[resolved.infoHash],
              tbCacheMap[resolved.infoHash],
              resolved.buffer
            );

            if (!debridData) {
              // Tracker privado sem cache no debrid: oferecer qBit se habilitado
              if (shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds) && resolved.buffer) {
                return buildQbitStream();
              }
              return null;
            }
            const resultsArray = debridData.multi ? debridData.multi : [debridData];

            return Promise.all(resultsArray.filter(resObj => {
              if (rdExcluded && resObj.provider === "Real-Debrid") {
                console.log(`[RD Exclude] ${r.Title?.slice(0, 80)} (${indexerName})`);
                return false;
              }
              return true;
            }).map(async resObj => {
              const addonName    = prefs.addonName || "ProwJack";
              const resLabelStr  = resLabel || "Links";
              const isDual       = prefs.debridConfig?.mode === "dual";
              const providerTag  = resObj.provider === "TorBox" ? "[TB]" : "[RD]";

              if (resObj.url && !resObj.queued) {
                const debridFilename = resObj.filename || displayFileName;
                const streamName = `${addonName}\n⚡️ ${resLabelStr} ${providerTag}`;
                return {
                  name: streamName,
                  description: [descNoSeeds, debridFilename ? `📂 ${debridFilename}` : ""].filter(Boolean).join("\n"),
                  url:     resObj.url,
                  _cached: true,
                  _sourceType: "debrid",
                  _priorityIndexer: !!r._priorityIndexer,
                  behaviorHints: {
                    filename:   debridFilename || displayFileName,
                    videoSize:  displayFile?.size,
                    bingeGroup: `prowjack|debrid|${resolved.infoHash}`,
                    notWebReady: false,
                  },
                };
              }

              if (resObj.queued) {
                const provider   = (resObj.provider || "Debrid").toLowerCase().replace(/[^a-z]/g, "");
                const hostUrl    = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
                const linkParam   = r.Link ? `&link=${encodeURIComponent(r.Link)}` : "";
                const fileParam   = resObj.fileId != null ? `&file_id=${encodeURIComponent(resObj.fileId)}` : "";
                const cachedParam = resObj.cached ? "&cached=1" : "";
                const seasonParam  = parsed.season  != null ? `&season=${parsed.season}`   : "";
                const episodeParam = (parsed.episode ?? episode) != null ? `&episode=${parsed.episode ?? episode}` : "";
                const animeParam   = parsed.isAnime ? "&anime=1" : "";
                const addUrl     = `${hostUrl}/${req.params.userConfig}/debrid-add/${provider}/${resolved.infoHash}?magnet=${encodeURIComponent(magnet)}${linkParam}${fileParam}${cachedParam}${seasonParam}${episodeParam}${animeParam}`;
                const cacheEmoji = resObj.cached ? "⚡️" : "⬇️";
                const streamName = `${addonName}\n${cacheEmoji} ${resLabelStr} ${providerTag}`;

                const debridOption = {
                  name: streamName,
                  description: [description, filenameLine].filter(Boolean).join("\n"),
                  url:     addUrl,
                  _cached: !!resObj.cached,
                  _sourceType: "debrid",
                  _priorityIndexer: !!r._priorityIndexer,
                  behaviorHints: { filename: displayFileName, videoSize: displayFile?.size, notWebReady: true },
                };

                if (shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds)) {
                  const qbitOption = await buildQbitStream();
                  return [debridOption, qbitOption];
                }

                return debridOption;
              }
              return null;
            })).then(items => items.filter(Boolean));
          }

          // ── Modo StremThru direto (sem debrid nativo) ──────────────────
          if (!isDebridMode && prefs.stConfig && resolved.infoHash) {
            const _addonName = prefs.addonName || "ProwJack";
            const _stStore = prefs.stConfig.stores[0];
            if (!_stStore) return null;
            const _stAxios = require("axios");
            const _stHeaders = { "X-StremThru-Store-Name": _stStore.c, "X-StremThru-Store-Authorization": `Bearer ${_stStore.t}` };
            const _baseUrl = prefs.stConfig.url.replace(/\/+$/, "");

            async function stResolveLink(torrentId, stFiles) {
              if (!torrentId || !stFiles?.length) return null;
              const pickIdx = matchedFile?.idx ?? 0;
              const file = stFiles[pickIdx] || stFiles[0];
              if (!file) return null;
              if (file.link) return { link: file.link, name: file.name || file.filename, size: file.size };
              try {
                const lr = await _stAxios.get(`${_baseUrl}/v0/store/torz/${torrentId}`, {
                  headers: _stHeaders, timeout: 10000, validateStatus: s => s < 400,
                });
                const freshFile = (lr.data?.data?.files || [])[pickIdx];
                if (freshFile?.link) return { link: freshFile.link, name: freshFile.name, size: freshFile.size };
              } catch {}
              return null;
            }

            function stStreamObj(emoji, cached, link, fileName, fileSize) {
              return {
                name: `${_addonName}\n${emoji} ${resLabel || "Links"} [ST]`,
                description: [descNoSeeds, fileName ? `📂 ${fileName}` : ""].filter(Boolean).join("\n"),
                url: link,
                _cached: cached, _sourceType: "debrid",
                _priorityIndexer: !!r._priorityIndexer,
                behaviorHints: {
                  filename: fileName || displayFileName,
                  videoSize: fileSize || displayFile?.size,
                  bingeGroup: `prowjack|stremthru|${resolved.infoHash}`,
                  notWebReady: false,
                },
              };
            }

            const cachedTorrent = stCacheMap[resolved.infoHash.toLowerCase()];
            if (cachedTorrent && cachedTorrent.id) {
              const resolved_link = await stResolveLink(cachedTorrent.id, cachedTorrent.files);
              if (resolved_link) {
                return stStreamObj("⚡️", true, resolved_link.link, resolved_link.name, resolved_link.size);
              }
            }

            try {
              const addRes = await _stAxios.post(`${_baseUrl}/v0/store/torz`,
                { link: magnet },
                { headers: _stHeaders, timeout: 15000, validateStatus: () => true }
              );
              if (addRes.status >= 200 && addRes.status < 300 && addRes.data?.data) {
                const td = addRes.data.data;
                const stStatus = td.status;
                if (stStatus === "downloaded" || stStatus === "cached") {
                  const resolved_link = await stResolveLink(td.id, td.files);
                  if (resolved_link) {
                    return stStreamObj("⚡️", true, resolved_link.link, resolved_link.name, resolved_link.size);
                  }
                }
                return stStreamObj("⏳", false, `${_baseUrl}/v0/store/torz/${td.id}`, displayFileName, displayFile?.size);
              }
            } catch (err) {
              console.log(`[STREMTHRU] Erro add magnet: ${err.message}`);
            }
            return null;
          }

          // ── Modo P2P (sem debrid) ──────────────────────────────────────
          const shouldOfferQbit = shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds);

          if (shouldOfferQbit && (localPlayable || r.Link || magnet)) {
            const qbitStream = await buildQbitStream();

            if (isPrivateTracker && !r.MagnetUri) {
              if (!resolved.infoHash) return qbitStream;
              const sources = EXTRA_TRACKERS.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);
              const p2pPrivate = {
                name, description: [description, filenameLine].filter(Boolean).join("\n"),
                infoHash: resolved.infoHash, sources,
                _sourceType: "p2p", _priorityIndexer: !!r._priorityIndexer,
                behaviorHints: { filename: displayFileName, bingeGroup: `prowjack|${resolved.infoHash}` },
              };
              if (matchedFile?.idx != null) p2pPrivate.fileIdx = matchedFile.idx;
              return [qbitStream, p2pPrivate];
            }

            let _qbitTrackers = [];
            if (resolved.buffer) {
              _qbitTrackers = extractTrackers(resolved.buffer);
            } else if (r.MagnetUri) {
              for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
                try { _qbitTrackers.push(decodeURIComponent(m[1])); } catch {}
              }
            }
            const _qbitAllTrackers = _qbitTrackers.length ? _qbitTrackers : EXTRA_TRACKERS;
            const sources = _qbitAllTrackers.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);
            if (!resolved.infoHash) return qbitStream;

            const p2pStream = {
              name,
              description: [description, filenameLine].filter(Boolean).join("\n"),
              infoHash: resolved.infoHash,
              sources,
              _sourceType: "p2p",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: {
                filename:   displayFileName,
                videoSize:  displayFile?.size || undefined,
                bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
              },
            };
            if (matchedFile?.idx != null) p2pStream.fileIdx = matchedFile.idx;
            return [qbitStream, p2pStream];
          }

          // Tracker privado sem MagnetUri e sem P2P habilitado
          if (isPrivateTracker && !r.MagnetUri && !prefs.enableP2P) return null;

          // P2P nativo: só retorna se P2P habilitado, sem debrid nativo e sem proxy StremThru.
          if (prefs.enableP2P !== false && !isDebridMode && !prefs.stConfig) {
            if (!resolved.infoHash) return null;

            // Formato exato do Torrentio (referência oficial):
            // sources = trackers.map(t => `tracker:${t}`).concat(`dht:${infoHash}`)
            let trackerList = [];
            if (resolved.buffer) {
              trackerList = extractTrackers(resolved.buffer);
            } else if (r.MagnetUri) {
              for (const m of (r.MagnetUri.matchAll(/[&?]tr=([^&]+)/g) || [])) {
                try { trackerList.push(decodeURIComponent(m[1])); } catch {}
              }
            }
            const allTrackers = trackerList.length ? trackerList : EXTRA_TRACKERS;
            const sources = allTrackers.map(t => `tracker:${t}`).concat(`dht:${resolved.infoHash}`);

            const stream = {
              name,
              description: [description, filenameLine].filter(Boolean).join("\n"),
              infoHash: resolved.infoHash,
              sources,
              _sourceType: "p2p",
              _priorityIndexer: !!r._priorityIndexer,
              behaviorHints: {
                filename:   displayFileName,
                videoSize:  displayFile?.size || undefined,
                bingeGroup: parsed.isAnime ? `prowjack|anime|${displayTitle}` : `prowjack|${resolved.infoHash}`,
              },
            };

            if (matchedFile?.idx != null) stream.fileIdx = matchedFile.idx;

            return stream;
          }

          // StremThru sem proxy manifest legado: retorna magnet/infoHash para o wrapper externo.
          // Configurações novas usam proxyManifestUrl e são injetadas abaixo como streams externos,
          // mantendo a URL própria do ProwJack instalada no Stremio.
          if (prefs.stConfig && !prefs.stConfig.proxyManifestUrl) {
            const sources = r.MagnetUri
              ? [r.MagnetUri]
              : (resolved.infoHash ? [buildMagnet(resolved.infoHash, null, r.Title)] : []);
            if (!sources.length) return null;
            
            if (isPrivateTracker && !r._isCached) {
              if (shouldOfferQbitForResult(prefs, isPrivateTracker, qbitCreds)) {
                return await buildQbitStream();
              }
              return null;
            }
            
            const storeCodeMap = { torbox: "TB", realdebrid: "RD" };
            const desc = [description, filenameLine].filter(Boolean).join("\n");
            const bh   = { filename: displayFileName, videoSize: displayFile?.size, bingeGroup: `prowjack|${resolved.infoHash}`, notWebReady: true };
            const cacheEmoji = r._isCached ? "??" : "??";
            return prefs.stConfig.stores.map(s => {
              const tag = storeCodeMap[s.c] || s.c.toUpperCase();
              return { name: `${name.split("\n")[0]}\n${cacheEmoji} ${resLabel || "Links"} [${tag}]`, description: desc, url: sources[0], _sourceType: "debrid", _priorityIndexer: !!r._priorityIndexer, behaviorHints: bh };
            });
          }

          return null;
        } catch { return null; }
      })
    );

    const allStreams = resolvedAll.flat(2).filter(Boolean);


    resolvedAll.forEach((streamOrArr, i) => {
      const r = streamCandidates[i];
      if (!r) return;
      const items = Array.isArray(streamOrArr) ? streamOrArr.flat() : [streamOrArr];
      for (const s of items) {
        if (!s) continue;
        s._originalScore = r._originalScore || 0;
        s._title   = r.Title   || "";
        s._seeders = r.Seeders || 0;
        s._sizeGb  = (r.Size   || 0) / 1e9;
        // Garante que _priorityIndexer do resultado Jackett seja propagado para o stream
        if (r._priorityIndexer && !s._priorityIndexer) s._priorityIndexer = true;
        // Propaga _isCached do resultado para _cached do stream (campos distintos)
        if (r._isCached && s._cached == null) s._cached = true;
        // Chave do indexer para maxResultsPerIndexer na ordenação final
        s._indexerKey = String(r.TrackerId || r.Tracker || r._indexerName || r.Indexer || "unknown").toLowerCase();
      }
    });

    const dedupedStreams = prefs.dedupe === false ? allStreams : (() => {
      const out = [];
      const seenQbit = new Set();
      // Dedup scrap vs Jackett: scrap tem prioridade por infoHash idêntico OU tamanho similar (±5%)
      const scrapHashes = new Set(allStreams.filter(s => s._scrapSource && s.infoHash).map(s => s.infoHash.toLowerCase()));
      const scrapSizes  = allStreams.filter(s => s._scrapSource && (s._sizeBytes > 0)).map(s => s._sizeBytes);
      const jackettHashes = new Set(allStreams.filter(s => !s._scrapSource && s.infoHash).map(s => s.infoHash.toLowerCase()));
      const isSimilarSize = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.05;
      for (const s of allStreams) {
        // Scrap: marca _cached=true se mesmo hash que Jackett
        if (s._scrapSource && s.infoHash && jackettHashes.has(s.infoHash.toLowerCase())) {
          s._cached = true;
        }
        // Jackett: remove se scrap cobre mesmo hash OU tamanho similar
        if (!s._scrapSource) {
          const hash = s.infoHash?.toLowerCase();
          const size = s.behaviorHints?.videoSize || s._sizeBytes || 0;
          if (hash && scrapHashes.has(hash)) continue;
          if (size > 0 && scrapSizes.some(ss => isSimilarSize(ss, size))) continue;
        }
        const isQbit = s?._sourceType === "http" && typeof s.url === "string" && s.url.includes("/qbit/");
        if (isQbit) {
          const key = `${s.behaviorHints?.bingeGroup || ""}|${s.behaviorHints?.filename || ""}`;
          if (seenQbit.has(key)) continue;
          seenQbit.add(key);
        }
        out.push(s);
      }
      return out;
    })();

    const _sourceRank = (s) => {
      if (s?._sourceType === "http")   return 2;
      if (s?._sourceType === "debrid") return 0;
      if (s?._sourceType === "p2p")    return 1;
      return 3;
    };

    const _resScore  = (s) => { const r = first(RESOLUTION, s._title || ""); return r ? r.score  : 0; };
    const _qualScore = (s) => { const q = first(QUALITY,    s._title || ""); return q ? q.score  : 0; };

    const _hasKeyword = (s) => !!(prefs.keywordBoost && matchesKeywordBoost([s._title, s.description, s.name, s.behaviorHints?.filename].filter(Boolean).join(" "), prefs.keywordBoost));
    const _hasPriorityLang = (s) => {
      const t = [s._title, s.description, s.name, s.behaviorHints?.filename].filter(Boolean).join(" ");
      const langs = getLangs(t, parsed.isAnime);
      return !!(
        (priorityLang && langs.some(l => l.code === priorityLang)) ||
        ((priorityLang === "pt-br" && /(dublado|dubbed.*pt|pt[-_. ]?br|\bpor\b|\bpt\b|portugu[eê]s|portuguese|brazilian)/i.test(t)))
      );
    };
    const _isMulti = (s) => /(multi|dual)[-.\\s]?(audio)?/i.test(s._title || "");
    const _sizeScore = (s) => {
      const size = Number(s._sizeGb || 0);
      return size > 0 ? size : 0;
    };

    const _httpRank = (s) => s?._sourceType === "http" ? 1 : 0;
    const _cacheRank = (s) => s._cached ? 0 : 1;
    const _langRank = (s) => _hasPriorityLang(s) ? 0 : 1;
    const _keywordRank = (s) => _hasKeyword(s) ? 0 : 1;
    const _priorityIndexerRank = (s) => s._priorityIndexer ? 0 : 1;

    dedupedStreams.sort((a, b) => {
      const dh = _httpRank(a) - _httpRank(b); if (dh !== 0) return dh;
      const dc = _cacheRank(a) - _cacheRank(b); if (dc !== 0) return dc;
      const dpi = _priorityIndexerRank(a) - _priorityIndexerRank(b); if (dpi !== 0) return dpi;
      const dk = _keywordRank(a) - _keywordRank(b); if (dk !== 0) return dk;
      const dl = _langRank(a) - _langRank(b); if (dl !== 0) return dl;
      const ds = (b._originalScore || 0) - (a._originalScore || 0); if (ds !== 0) return ds;
      const dq = _qualScore(b) - _qualScore(a); if (dq !== 0) return dq;
      const dr = _resScore(b)  - _resScore(a);  if (dr !== 0) return dr;
      const dz = _sizeScore(b) - _sizeScore(a); if (dz !== 0) return dz;
      return (b._seeders || 0) - (a._seeders || 0);
    });

    let finalStreams = (() => {
      const isQbStream = s => s?._sourceType === "http" && typeof s.url === "string" && s.url.includes("/qbit/");

      const applyCoverage = (pool, limit) => {
        const selected = [];
        const seen = new Set();
        const keyOf = s => s.infoHash || s.url || s.externalUrl || s.behaviorHints?.bingeGroup || s.description || s.name;
        const add = s => {
          if (!s || selected.length >= limit) return;
          const key = keyOf(s);
          if (key && seen.has(key)) return;
          if (key) seen.add(key);
          selected.push(s);
        };

        for (const s of pool) {
          if (_hasPriorityLang(s) || _hasKeyword(s)) add(s);
        }
        for (const s of pool) add(s);
        return selected;
      };

      let normalPool = dedupedStreams.filter(s => !isQbStream(s));
      if (!bypassRssFilters && prefs.maxResultsPerIndexer > 0) {
        const applyPerIndexerLimit = pool => {
          const countByIndexer = new Map();
          return pool.filter(s => {
            const key = s._indexerKey || "unknown";
            const n = (countByIndexer.get(key) || 0) + 1;
            countByIndexer.set(key, n);
            return n <= prefs.maxResultsPerIndexer;
          });
        };
        const priorityPool = applyPerIndexerLimit(normalPool.filter(s => _hasPriorityLang(s) || _hasKeyword(s)));
        const priorityKeys = new Set(priorityPool.map(s => s.infoHash || s.url || s.externalUrl || s.behaviorHints?.bingeGroup || s.description || s.name).filter(Boolean));
        const regularPool = applyPerIndexerLimit(normalPool.filter(s => {
          const key = s.infoHash || s.url || s.externalUrl || s.behaviorHints?.bingeGroup || s.description || s.name;
          return !_hasPriorityLang(s) && !_hasKeyword(s) && (!key || !priorityKeys.has(key));
        }));
        normalPool = [...priorityPool, ...regularPool];
      }

      const limitedNormal = applyCoverage(normalPool, maxOut);
      if (QB_EXTRA_SLOTS <= 0) return limitedNormal;

      const normalKeys = new Set(limitedNormal.map(s => s.infoHash || s.behaviorHints?.bingeGroup || s.url).filter(Boolean));
      const qbExtra = dedupedStreams
          .filter(isQbStream)
          .sort((a, b) => {
            const seedA = (a._seeders || a.Seeders || 0);
            const seedB = (b._seeders || b.Seeders || 0);
            if (seedB !== seedA) return seedB - seedA;
            const sizeA = (a._sizeGb || a.Size || 0);
            const sizeB = (b._sizeGb || b.Size || 0);
            return sizeB - sizeA;
          })
          .slice(0, QB_EXTRA_SLOTS);

      if (qbExtra.length) console.log(`[QB] ${qbExtra.length} streams [QB] adicionados como slots extras (QB_EXTRA_SLOTS=${QB_EXTRA_SLOTS})`);
      return [...limitedNormal, ...qbExtra];
    })();
    if (dedupedStreams.length > 0) {
      const top = dedupedStreams.slice(0, Math.min(5, dedupedStreams.length));
      console.log(`[ORDEM] top${top.length}: ` + top.map(s => `[cache=${s._cached?1:0} prio=${s._priorityIndexer?1:0} lang=${_hasPriorityLang(s)?1:0} key=${_hasKeyword(s)?1:0} prioRank=${_priorityIndexerRank(s)} size=${_sizeScore(s).toFixed(1)} res=${_resScore(s).toFixed(1)} qb=${s._sourceType==="http"?1:0} ix=${s._indexerKey||"?"}] ${(s._title||"").slice(0,40)}`).join(" | "));
    }
    const isStremThruProxyClient = /stremthru|go-http-client/i.test(req.headers["user-agent"] || "");
      if (ENV.enablePureP2P === false && !isStremThruProxyClient) {
        finalStreams = finalStreams.filter(s => s._sourceType !== "p2p");
      }
      finalStreams.forEach(s => {
      delete s._cached;
      delete s._originalScore;
      delete s._title;
      delete s._seeders;
      delete s._sizeGb;
      delete s._priorityIndexer;
      delete s._indexerKey;
      delete s._sourceType;
      delete s._scrapSource;
      delete s._stremThruProxy;
      delete s._sizeBytes;
      delete s.indexer; // Campo não usado pelo Stremio
    });

    if (finalStreams.length > 0) {
      const topFinal = finalStreams.slice(0, Math.min(5, finalStreams.length))
        .map(s => `${(s.name || "").split("\n")[0]} => ${(s.behaviorHints?.filename || s.title || s.description || "").slice(0, 60)}`);
      console.log(`[FINAL] top${topFinal.length}: ${topFinal.join(" | ")}`);
    }

    if (isDebridMode) {
      const cached = finalStreams.filter(s => s.externalUrl || (s.url && !s.url.includes('/debrid-add/'))).length;
      const queued = finalStreams.filter(s => s.url &&  s.url.includes('/debrid-add/')).length;
      console.log(`[DEBRID] Streams listados: ${cached} ⚡️ cached + ${queued} ⬇️ on-demand`);
    } else if (isStremThruMode) {
      const stCached = finalStreams.filter(s => (s.name || "").includes("⚡️")).length;
      const stQueued = finalStreams.length - stCached;
      console.log(`[STREMTHRU] Streams listados: ${stCached} ⚡️ cached + ${stQueued} ⏳ on-demand`);
    } else {
      console.log(`Magnets listados: Enviando ${finalStreams.length} torrents!`);
    }
    console.log(`=========================================\n`);
    // Salva streams resolvidos no cache (TTL 3h) — só se tiver resultados
    if (finalStreams.length > 0) {
      const ttl = reqCtx.hasTimedOut ? 5 : 10800; // 5 segundos se incompleto, 3 horas se completo
      rc.set(streamCacheKey, JSON.stringify(finalStreams), ttl).catch(() => {});
    }
    console.log(`[DEBUG] Provider retornou: ${results.length} | Candidatos: ${candidates.length} | Com hash: ${withHashes.length} | Dedupe: ${dedupedWithHashes.length} | Final: ${finalStreams.length}`);
    console.log(`[PERF] total=${Date.now() - _t0}ms`);
    releaseLock(finalStreams);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro no processamento: ${err.message}`);
    releaseLock([]);
    res.json({ streams: [] });
  }
});

module.exports = router;