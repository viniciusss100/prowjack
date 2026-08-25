const express = require("express");
const axios = require("axios");
const { ENV } = require("../constants");
const { rc } = require("../cache");
const { resolvePrefs } = require("../configStore");
const { loadRssItemsForType, rssCatalogMetaId, parseRssMetaId, extractSeriesFeedMarker, extractAnimeFeedMarker, buildRssVideos } = require("../rssHelpers");
const { normalizeImdbId } = require("../scoring");
const { enrichMetaPtBr } = require("../metadata");
const { CATALOG_KEY } = require("../rssPoller");

const router = express.Router();

router.get("/:userConfig/catalog/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const prefs = await resolvePrefs(req.params.userConfig);
  const catalogTypeMap = {
    prowjack_rss_movie:  "movie",
    prowjack_rss_series: "series",
    prowjack_rss_anime:  "anime",
  };
  const catalogType = catalogTypeMap[id];
  if (!catalogType) return res.json({ metas: [] });

  try {
    const activeRssItems = await loadRssItemsForType(prefs, catalogType);
    const activeMetaIds = new Set(activeRssItems.map(item => rssCatalogMetaId(item, catalogType)).filter(Boolean));
    if (!activeMetaIds.size) return res.json({ metas: [] });

    const raw   = await rc.get(`${CATALOG_KEY}:${catalogType}`);
    const items = raw ? JSON.parse(raw) : [];
    const metas = await Promise.all(items.filter(m => activeMetaIds.has(m.id)).map(async m => {
      const imdbId = m.id?.startsWith("rssmovie:")
        ? m.id.slice("rssmovie:".length)
        : m.id?.startsWith("rssmeta:")
          ? `tt${m.id.split(":").slice(2).join(":").replace(/^tt/i, "")}`
          : null;
      const enriched = await enrichMetaPtBr(m, imdbId, catalogType);
      return {
        id:          m.id,
        type:        m.type,
        name:        enriched.name,
        poster:      enriched.poster,
        background:  enriched.background,
        description: enriched.description,
        releaseInfo: enriched.releaseInfo,
        imdbRating:  enriched.imdbRating,
        genres:      enriched.genres,
      };
    }));
    const filteredMetas = metas.filter(m => m.id && m.poster);
    res.json({ metas: filteredMetas });
  } catch {
    res.json({ metas: [] });
  }
});

router.get("/:userConfig/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const prefs = await resolvePrefs(req.params.userConfig);

  // rssmovie: — busca meta no Cinemeta pelo tt... extraído
  if (id.startsWith("rssmovie:")) {
    const ttId = id.slice("rssmovie:".length);
    try {
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${ttId}.json`, { timeout: 6000 });
      const meta = r.data?.meta;
      if (meta) return res.json({ meta: { ...(await enrichMetaPtBr(meta, ttId, "movie")), id } });
    } catch {}
    return res.json({ meta: null });
  }

  const rssMeta = parseRssMetaId(id);

  if (!rssMeta) {
    try {
      const targetType = type === "movie" ? "movie" : "series";
      const cleanId = normalizeImdbId(id) || id;
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${targetType}/${cleanId}.json`, { timeout: 5000 });
      const payload = r.data || { meta: null };
      if (payload.meta) payload.meta = await enrichMetaPtBr(payload.meta, cleanId, targetType);
      return res.json(payload);
    } catch {
      // Fallback: tenta buscar nos addons de scrap
      if (ENV.scrapManifests.length) {
        for (const manifestUrl of ENV.scrapManifests) {
          try {
            const base = manifestUrl.replace(/\/manifest\.json$/i, "");
            const r = await axios.get(`${base}/meta/${type}/${id}.json`, { timeout: 5000 });
            if (r.data?.meta) return res.json(r.data);
          } catch {}
        }
      }
      return res.json({ meta: null });
    }
  }

  try {
    // ── PASSO 1: Cinemeta primeiro (lista completa de episódios com thumbnails/títulos) ──
    // Lógica inspirada no builder.js do addon TorBox: buscar metadados ricos do Cinemeta
    // ANTES de verificar o RSS, e só depois filtrar pelos episódios disponíveis no cache.
    // Isso evita o "nenhuma informação disponível" causado por ImdbIds ainda não resolvidos.
    const metaCacheKey = `rssmeta:${rssMeta.metaId}`;
    let baseMeta = {};
    const cachedMetaRaw = await rc.get(metaCacheKey).catch(() => null);
    if (cachedMetaRaw) {
      try { baseMeta = JSON.parse(cachedMetaRaw); } catch {}
    }
    if (!baseMeta.name) {
      try {
        const r = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${rssMeta.metaId}.json`, { timeout: 6000 });
        baseMeta = r.data?.meta || {};
        baseMeta = await enrichMetaPtBr(baseMeta, rssMeta.metaId, "series");
        if (baseMeta.name) rc.set(metaCacheKey, JSON.stringify(baseMeta), 86400).catch(() => {});
      } catch {
        // Fallback: catálogo local
        const catalogRaw = await rc.get(`${CATALOG_KEY}:${rssMeta.catalogType}`).catch(() => null);
        const catalogItems = catalogRaw ? JSON.parse(catalogRaw) : [];
        const found = catalogItems.find(i => i.id === id || i.id === rssMeta.metaId);
        if (found) baseMeta = found;
      }
    }
    baseMeta = await enrichMetaPtBr(baseMeta, rssMeta.metaId, "series");

    // ── PASSO 2: Construir set de episódios disponíveis a partir do cache RSS ──
    // Mesmo padrão do builder.js: availableEps determina quais episódios mostrar.
    const rssItems = await loadRssItemsForType(prefs, rssMeta.catalogType);
    const matchedRssItems = rssItems.filter(item =>
      normalizeImdbId(item.ImdbId) === normalizeImdbId(rssMeta.metaId)
    );

    const availableEps = new Set();
    for (const item of matchedRssItems) {
      const marker = rssMeta.catalogType === "anime"
        ? extractAnimeFeedMarker(item.Title)
        : extractSeriesFeedMarker(item.Title);
      if (!marker) {
        // Não foi possível parsear — assume que cobre tudo (ex: season pack sem marker)
        availableEps.add("all");
        continue;
      }
      if (marker.pack) {
        // Season Pack: temporada inteira disponível
        availableEps.add(`season:${marker.season}`);
      } else {
        // Episódio específico
        availableEps.add(`${marker.season}:${marker.episode}`);
      }
    }

    console.log(`[Meta] ${rssMeta.metaId}: ${matchedRssItems.length} itens RSS → marcadores: [${[...availableEps].join(", ")}]`);

    // ── PASSO 3: Filtrar episódios do Cinemeta e remalear IDs para rssitem: ──
    const cinemetaVideos = baseMeta.videos || [];
    let videos;

    if (availableEps.size === 0) {
      // Nenhum item RSS encontrado para esta série ainda.
      // Retornar meta sem episódios mas com poster/nome para não quebrar o catálogo.
      videos = [];
      console.log(`[Meta] ${rssMeta.metaId}: nenhum episódio RSS disponível`);
    } else {
      videos = cinemetaVideos
        .filter(v => {
          if (!v.season || !v.episode) return false; // Ignorar entradas sem S/E
          if (availableEps.has("all"))                      return true;
          if (availableEps.has(`${v.season}:${v.episode}`)) return true;
          if (availableEps.has(`season:${v.season}`))       return true;
          return false;
        })
        .map(v => ({
          ...v,
          // Remapear ID para o formato rssitem: que o /stream sabe resolver
          id: `rssitem:${rssMeta.catalogType}:${rssMeta.metaId}:${v.season}:${v.episode}`,
        }));

      // Fallback: nenhum episódio do Cinemeta bate com os marcadores RSS
      if (videos.length === 0 && matchedRssItems.length > 0) {
        const rssVideos = buildRssVideos(rssItems, rssMeta.catalogType, rssMeta.metaId);

        if (cinemetaVideos.length === 0) {
          // Cinemeta não tem NENHUM episódio (série nova / fora do catálogo) → RSS puro
          console.log(`[Meta] ${rssMeta.metaId}: Cinemeta sem episódios → usando RSS`);
          videos = rssVideos;
        } else {
          // Cinemeta tem episódios de outra(s) temporada(s) e o RSS tem temporada mais nova
          // → merge: exibe todos os eps do Cinemeta (com ID original) + novos do RSS (com rssitem:)
          // Os eps do Cinemeta ficam com ID original (streamable via outros addons/P2P);
          // os do RSS ficam com rssitem: (streamable via este addon).
          const rssKeys = new Set(rssVideos.map(v => `${v.season}:${v.episode}`));
          const cinemetaOther = cinemetaVideos
            .filter(v => v.season && v.episode && !rssKeys.has(`${v.season}:${v.episode}`))
            .map(v => ({ ...v, id: `rssitem:${rssMeta.catalogType}:${rssMeta.metaId}:${v.season}:${v.episode}` }));
          videos = [...cinemetaOther, ...rssVideos]
            .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
          console.log(`[Meta] ${rssMeta.metaId}: temporada RSS mais recente → merge ${cinemetaOther.length} Cinemeta + ${rssVideos.length} RSS`);
        }
      }

      const rssCount   = videos.filter(v => String(v.id).startsWith("rssitem:")).length;
      const totalCount = videos.length;
      console.log(`[Meta] ${rssMeta.metaId}: ${totalCount} eps disponíveis (${rssCount} via RSS, ${totalCount - rssCount} via Cinemeta)`);
    }

    // Sem nome e sem episódios = não há o que mostrar
    if (!baseMeta.name && !videos.length) return res.json({ meta: null });

    const { videos: _ignored, imdb_id: _imdb, moviedb_id: _tmdb, slug: _slug, trailers: _tr, credits_cast: _cc, credits_crew: _cr, ...baseMetaWithoutVideos } = baseMeta;
    return res.json({
      meta: {
        ...baseMetaWithoutVideos,
        id,
        type: "series",
        videos,
        behaviorHints: { hasScheduledVideos: false },
      }
    });
  } catch (err) {
    console.error(`[Meta] Erro: ${err.message}`);
    return res.json({ meta: null });
  }
});

module.exports = router;
