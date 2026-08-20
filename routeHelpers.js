const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { rc, redis } = require("./cache");
const { getPreferredRssIndexers, loadRssItemsForType, buildRssVideos, matchRssItemsByMarker } = require("./rssHelpers");
const { stripSourceBadges } = require("./scoring");
const { ENV, PUBLIC_TRACKERS } = require("./constants");
const { isConfigured: isQbitConfigured } = require("./providers/qbittorrent");

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_THRESHOLD = 100;

const memoryStore = {
  ips: new Map(),
  hashes: new Map()
};

function checkRateLimit(ip) {
  const now = Date.now();

  if (rateLimitStore.size > 10000) {
    for (const [key, entry] of rateLimitStore) {
      if (entry.resetAt <= now) rateLimitStore.delete(key);
    }
  }

  const entry = rateLimitStore.get(ip);
  
  if (!entry) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (entry.resetAt <= now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (entry.count >= RATE_LIMIT_THRESHOLD) return false;
  entry.count++;
  return true;
}

function getPublicBase(req) {
  if (ENV.addonPublicUrl) return ENV.addonPublicUrl.replace(/\/+$/, "");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host     = req.headers["x-forwarded-host"]  || req.get("host");
  return `${protocol}://${host}`;
}

// Garante que a URL usada como upstream interno no StremThru tenha protocolo
// válido. Sem o "https://", o StremThru não conseguia alcançar o upstream e a
// busca retornava vazio.
function absolutePublicBase(req) {
  const base = getPublicBase(req);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `https://${base}`;
}

function buildStremThruProxyManifestUrl(req, prefs, userConfig) {
  if (!prefs?.stConfig?.url || !Array.isArray(prefs.stConfig.stores) || !prefs.stConfig.stores.length) {
    return null;
  }
  // Usa a rota interna como upstream — evita loop de StremThru chamando StremThru
  const internalManifest = `${absolutePublicBase(req)}/internal/${userConfig}/manifest.json`;
  const storeCodeMap = { torbox: "tb", realdebrid: "rd", alldebrid: "ad", debridlink: "dl", premiumize: "pm", offcloud: "oc" };
  const wrapEncoded = Buffer.from(JSON.stringify({
    upstreams: [{ u: internalManifest }],
    stores: prefs.stConfig.stores.map(s => ({ c: storeCodeMap[s.c] || s.c, t: s.t })),
    name: prefs.addonName || "ProwJack [ST]",
  }), "utf8").toString("base64");
  return `${prefs.stConfig.url.replace(/\/+$/, "")}/stremio/wrap/${encodeURIComponent(wrapEncoded)}/manifest.json`;
}

function isQbitEnabledForPrefs(prefs, creds = null) {
  if (prefs?.enableP2P === false) return false;
  if (!["always", "private"].includes(String(prefs?.qbitMode || ""))) return false;
  return isQbitConfigured(creds);
}

function shouldOfferQbitForResult(prefs, isPrivateTracker, creds = null) {
  if (!isQbitEnabledForPrefs(prefs, creds)) return false;
  return prefs.qbitMode === "always" || (prefs.qbitMode === "private" && isPrivateTracker);
}

function getRequestAccessToken(req) {
  return String(req.headers["x-access-token"] || req.query.token || "").trim();
}

function hasAdminAccess(req) {
  return !ENV.accessToken || getRequestAccessToken(req) === ENV.accessToken;
}

function requireAdminAccess(req, res, next) {
  if (hasAdminAccess(req)) return next();
  return res.status(403).json({ ok: false, error: "Acesso negado" });
}

async function getRssFastPathResults(parsed, prefs, type) {
  if (parsed.source !== "rssitem" && parsed.source !== "rssmovie") return null;

  const rssType = parsed.rssType || (parsed.isAnime ? "anime" : type === "movie" ? "movie" : "series");

  if (parsed.source === "rssmovie") {
    const rssHits = await loadRssItemsForType(prefs, "movie");
    const matched = rssHits.filter(r => normalizeImdbId(r.ImdbId) === normalizeImdbId(parsed.metaId));
    if (matched.length) {
      console.log(`[RSS Fast-path] ${matched.length} resultados do cache RSS para ${parsed.metaId}`);
      return matched.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
    }
    return [];
  } 
  
  if (parsed.source === "rssitem") {
    const rssHits = await loadRssItemsForType(prefs, rssType);
    if (parsed.rssToken) {
      const exactItem = findRssItemByToken(rssHits, parsed.rssToken);
      if (exactItem) {
        console.log(`[RSS Fast-path] Token encontrado no cache RSS`);
        return [{ ...exactItem, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: 0 }];
      }
      return [];
    } else {
      const requestedEpisode = parsed.episode ?? 0;
      const exactItems = matchRssItemsByMarker(
        rssHits,
        rssType,
        parsed.metaId,
        parsed.season ?? 1,
        requestedEpisode
      );
      if (exactItems.length) {
        console.log(`[RSS Fast-path] ${exactItems.length} resultados do cache RSS para S${parsed.season}E${requestedEpisode}`);
        return exactItems.map((item, idx) => ({ ...item, _metaIdMatch: true, _titleMatchScore: 1, _rssPreferred: true, _rssOrder: idx }));
      }
      return [];
    }
  }
  return null;
}

function sendConfigurePage(res) {
  res.sendFile(path.join(__dirname, "public", "configure.html"));
}

async function fetchScrapStreams(manifestUrl, type, id, options = {}) {
  try {
    const base = manifestUrl.replace(/\/manifest\.json$/i, "");
    const url  = `${base}/stream/${type}/${id}.json`;
    const res  = await axios.get(url, { timeout: options.timeout || 8000, validateStatus: s => s < 400 });
    const streams = res.data?.streams;
    if (!Array.isArray(streams)) return [];
    return streams
      .filter(s => s.infoHash || s.externalUrl || (s.url && !s.url.startsWith("magnet:")))
      .map(s => {
        const nameStr = s.name || "";
        const titleStr = s.title || "";
        const descStr = s.description || "";
        const filenameStr = s.behaviorHints?.filename || "";
        
        const cleanStream = {
          ...s,
          name: options.preserveBadges ? nameStr : stripSourceBadges(nameStr),
          title: options.preserveBadges ? titleStr : stripSourceBadges(titleStr),
          description: options.preserveBadges ? descStr : stripSourceBadges(descStr),
          behaviorHints: {
            ...(s.behaviorHints || {}),
            filename: options.preserveBadges ? filenameStr : stripSourceBadges(filenameStr),
            // notWebReady=true impede exibição no Stremio web/mobile — sempre forçar false
            notWebReady: false,
          },
        };
        // Extrai título do campo name ou title para scoring de idioma/resolução
        const rawName = cleanStream.name || "";
        const desc    = cleanStream.description || cleanStream.title || "";
        // Combina name + description para que os filtros de idioma/qualidade encontrem as tags
        const titleForFilters = [rawName, desc].filter(Boolean).join(" ");
        const size = cleanStream.behaviorHints?.videoSize || 0;
        const seedFields = [
          cleanStream._seeders,
          cleanStream.seeders,
          cleanStream.seeds,
          cleanStream.sources?.seeders,
          cleanStream.stats?.seeders,
          cleanStream.behaviorHints?.seeders,
          cleanStream.behaviorHints?.seeds,
        ];
        let seeders = 0;
        for (const value of seedFields) {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            seeders = Math.max(0, parsed);
            break;
          }
        }
        if (!seeders) {
          const seedText = [
            cleanStream.name,
            cleanStream.title,
            cleanStream.description,
            cleanStream.behaviorHints?.filename,
          ].filter(Boolean).join(" ");
          const match = seedText.match(/(?:🌱|👤|👥|seeders?|seeds?|s:)\s*(\d{1,6})/i);
          if (match) seeders = parseInt(match[1], 10) || 0;
        }
        const directUrl = typeof cleanStream.url === "string" && cleanStream.url && !cleanStream.url.startsWith("magnet:");
        const directExternal = typeof cleanStream.externalUrl === "string" && cleanStream.externalUrl;
        const cached = cleanStream._cached === true || cleanStream.cached === true || cleanStream.behaviorHints?.cached === true || directUrl || directExternal;
        return {
          ...cleanStream,
          _sourceType:  "debrid",
          _scrapSource: true,
          _cached:      cached,
          _title:       titleForFilters,
          _filename:    cleanStream.behaviorHints?.filename || "",
          _sizeBytes:   size,
          _seeders:     seeders,
          _sizeGb:      size / 1e9,
        };
      });
  } catch (err) {
    if (options.label) {
      const reason = err.code === "ECONNABORTED"
        ? `timeout após ${options.timeout || 8000}ms`
        : err.message;
      console.log(`[WARN] ${options.label}: ${reason}`);
    }
    return [];
  }
}

function isPrivateTrackerCandidate(r, resolved = null) {
  if (resolved?.isPrivate !== undefined) return !!resolved.isPrivate;
  if (resolved?.buffer) {
    return resolved.buffer.toString("latin1").includes("7:privatei1e");
  }
  
  const indexerName = (r._indexerName || r.Tracker || r.TrackerId || r.Indexer || "").toLowerCase();
  const isKnownPublic = PUBLIC_TRACKERS.some(t => indexerName.includes(t));
  
  if (isKnownPublic) return false;
  if (r?.MagnetUri) return false;
  if (r?.Link && !r.Link.startsWith("magnet:")) return true;
  return false;
}

module.exports = {
  memoryStore,
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
};
