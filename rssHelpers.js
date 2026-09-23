"use strict";
const { rc } = require("./cache");
const { normalizeImdbId, isCompletePack } = require("./scoring");
const { CACHE_VERSION } = require("./constants");

function toBase64Url(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getPreferredRssIndexers(prefs) {
  if (Array.isArray(prefs?.rssIndexers) && prefs.rssIndexers.length) return prefs.rssIndexers.filter(Boolean);
  if (Array.isArray(prefs?.indexers) && prefs.indexers.length && !prefs.indexers.includes("all")) return prefs.indexers.filter(Boolean);
  return null;
}

async function loadRssItemsForType(prefs, rssType) {
  const allowedRss = getPreferredRssIndexers(prefs);
  const keys = allowedRss
    ? await Promise.all(allowedRss.map(ix => rc.keys(`rss:${CACHE_VERSION}:${ix}:${rssType}:*`))).then(a => a.flat())
    : await rc.keys(`rss:${CACHE_VERSION}:*:${rssType}:*`);
  if (!keys.length) return [];

  const items = (await Promise.all(keys.map(async key => {
    try {
      const raw = await rc.get(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }))).flat();

  return items;
}

function rssCatalogMetaId(item, catalogType) {
  const imdb = normalizeImdbId(item?.ImdbId);
  if (!imdb) return null;
  return catalogType === "movie" ? `rssmovie:${imdb}` : `rssmeta:${catalogType}:${imdb.replace(/^tt/i, "")}`;
}

function getRssItemToken(item) {
  const raw = item?.InfoHash || item?.Guid || item?.Link || item?.MagnetUri || "";
  return raw ? toBase64Url(raw) : null;
}

function parseRssMetaId(id) {
  const s = String(id || "");
  if (!s.startsWith("rssmeta:") && !s.startsWith("prowjack:")) return null;
  const parts = s.split(":");
  if (parts.length < 3) return null;
  const rawId = parts.slice(2).join(":");
  const metaId = /^\d+$/.test(rawId) ? `tt${rawId}` : rawId;
  return { catalogType: parts[1], metaId };
}

function parseRssItemId(id) {
  if (!String(id || "").startsWith("rssitem:")) return null;
  const parts = String(id).split(":");
  if (parts.length < 5) return null;
  const season = parseInt(parts[3], 10);
  const episode = parseInt(parts[4], 10);
  return {
    catalogType: parts[1],
    metaId: parts[2],
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
    token: parts.length > 5 ? parts.slice(5).join(":") : null,
  };
}

function extractSeriesFeedMarker(title) {
  const t = String(title || "");
  let m = t.match(/\bS(\d{1,2})E(\d{1,3})\b/i) || t.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) {
    return {
      season: parseInt(m[1], 10),
      episode: parseInt(m[2], 10),
      label: `S${String(m[1]).padStart(2, "0")}E${String(m[2]).padStart(2, "0")}`,
      pack: false,
    };
  }
  m = t.match(/\b(?:S|Season\s?|Temporada\s?)(\d{1,2})\b/i);
  if (m && isCompletePack(t)) {
    return {
      season: parseInt(m[1], 10),
      episode: 0,
      label: `Temporada ${String(m[1]).padStart(2, "0")} (Pack RSS)`,
      pack: true,
    };
  }
  return null;
}

function extractAnimeFeedMarker(title) {
  const t = String(title || "").replace(/\./g, " ");
  let m = t.match(/-\s*0*(\d{1,3})(?:v\d+)?\b/i)
    || t.match(/\[(\d{1,3})(?:v\d+)?\]/i)
    || t.match(/\bE(?:p(?:isode)?)?\s*0*(\d{1,3})\b/i);
  if (m) {
    return {
      season: 1,
      episode: parseInt(m[1], 10),
      label: `Episodio ${String(m[1]).padStart(2, "0")}`,
      pack: false,
    };
  }
  if (isCompletePack(t)) {
    return { season: 1, episode: 0, label: "Temporada/Batch RSS", pack: true };
  }
  return null;
}

function buildRssVideos(items, catalogType, metaId) {
  const matched = items.filter(item => normalizeImdbId(item.ImdbId) === normalizeImdbId(metaId));
  const seen = new Set();
  const videos = [];
  for (const item of matched) {
    const marker = catalogType === "anime" ? extractAnimeFeedMarker(item.Title) : extractSeriesFeedMarker(item.Title);
    if (!marker) continue;
    const key = `${marker.season}:${marker.episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      id: `rssitem:${catalogType}:${metaId}:${marker.season ?? 1}:${marker.episode ?? 0}`,
      title: marker.pack ? marker.label : `${marker.label}`,
      season: marker.season ?? 1,
      episode: marker.episode ?? 0,
      released: item.PublishDate || null,
      overview: item.Title || null,
    });
  }
  videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || String(b.released || "").localeCompare(String(a.released || "")));
  return videos;
}

function findRssItemByToken(items, token) {
  return items.find(item => getRssItemToken(item) === token) || null;
}

function matchRssItemsByMarker(items, catalogType, metaId, season, episode) {
  return items.filter(item => {
    if (normalizeImdbId(item.ImdbId) !== normalizeImdbId(metaId)) return false;
    const marker = catalogType === "anime" ? extractAnimeFeedMarker(item.Title) : extractSeriesFeedMarker(item.Title);
    if (!marker) return false;
    if (marker.season === season && marker.episode === episode) return true;
    if (marker.pack === true && marker.season === season) return true;
    return false;
  });
}

module.exports = {
  getPreferredRssIndexers,
  loadRssItemsForType,
  rssCatalogMetaId,
  getRssItemToken,
  parseRssMetaId,
  parseRssItemId,
  extractSeriesFeedMarker,
  extractAnimeFeedMarker,
  buildRssVideos,
  findRssItemByToken,
  matchRssItemsByMarker
};
