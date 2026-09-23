const fs = require('fs');
const acorn = require('acorn');

let code = fs.readFileSync('addon.js', 'utf8');
const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });

const routes = {
  api: [],
  manifest: [],
  configure: [],
  catalog: [],
  qbit: [],
  stream: []
};

let nodesToRemove = [];

for (const node of ast.body) {
  if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
    const callee = node.expression.callee;
    if (callee.type === 'MemberExpression' && callee.object.name === 'app') {
      const method = callee.property.name;
      if (['get', 'post', 'use'].includes(method)) {
        if (node.expression.arguments.length > 0 && node.expression.arguments[0].type === 'Literal') {
          const path = node.expression.arguments[0].value;

          let target = null;
          if (path.startsWith('/api/')) target = 'api';
          else if (path === '/manifest.json' || path === '/:userConfig/manifest.json' || path === '/internal/:userConfig/manifest.json') target = 'manifest';
          else if (path === '/configure' || path === '/:userConfig/configure' || path === '/') target = 'configure';
          else if (path.includes('/catalog/') || path.includes('/meta/')) target = 'catalog';
          else if (path.includes('/qbit/') || path.includes('/debrid-add/')) target = 'qbit';
          else if (path.includes('/stream/')) target = 'stream';
          else if (path === '/:userConfig/*') target = 'global_middleware';

          if (target && target !== 'global_middleware') {
            const snippet = code.slice(node.start, node.end);
            routes[target].push(snippet.replace(/^app\./, 'router.'));
            nodesToRemove.push(node);
          }
        }
      }
    }
  }
}

const commonImports = `const express = require("express");
const router = express.Router();
const path = require("path");
const crypto = require("crypto");
const { ENV, CACHE_VERSION, STREAM_CACHE_VERSION, TORRENT_DOWNLOAD_TIMEOUT_MS } = require("../constants");
const { rc, redis, saveQbitJob, loadQbitJob } = require("../cache");
const { decodeUserCfg } = require("../configStore");
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
const {\n  RESOLUTION, QUALITY, CODEC, AUDIO, VISUAL, LANG,\n  TITLE_CLEANUP_REGEX, STOPWORDS,\n  first, matchAll, uniq, normTitle,\n  getLangs, score,\n  normalizeTitleTokens, escapedWordRegex,\n  titleMatchScore, relaxedTitleMatchScore,\n  extractReleaseYear, normalizeImdbId, getResultImdbId,\n  looksLikeEpisodeRelease, isCompletePack,\n  parseEpisodeRanges, hasAnyEpisodeMarker,\n  episodeMatchRank, animeEpisodeMatchRank,\n  seriesEpisodeMatches, animeEpisodeMatches,\n  normalizeForDedupe, dedupeResults, dedupeWithCachePriority,\n  extractGroup, fmtBytes,\n  renameIndexer, stripSourceBadges,\n  visibleSeedCount, matchesKeywordBoost,\n  splitFilterTerms, textHasAnyTerm,\n  resultIndexerText, isPriorityIndexerResult, isRdExcludedResult,\n  hasDirectInfoHash, formatStream\n} = require("../scoring");
const {\n  base32ToHex, extractInfoHash, extractInfoBuf, decodeBencode, extractTorrentFiles,\n  pickEpisodeFile, normalizeTorrentLink, torrentFailureKeys, torrentDownloadRecentlyFailed,\n  markTorrentDownloadFailed, infoHashQueueKey, InfoHashQueue, infoHashQueue, resolveInfoHash\n} = require("../torrentUtils");
const {\n  jackettFetchIndexers, fetchIndexerPrivacyMap, jackettSearch, buildQueries, resolveSearchIndexers\n} = require("../jackettSearch");
const {\n  getPreferredRssIndexers, loadRssItemsForType, rssCatalogMetaId, getRssItemToken,\n  parseRssMetaId, parseRssItemId, extractSeriesFeedMarker, extractAnimeFeedMarker,\n  buildRssVideos, findRssItemByToken, matchRssItemsByMarker\n} = require("../rssHelpers");
const { fetchStremThruStoreLinks } = require("../debrid");
const { fetchTmdbMeta, getImdbIdFromTmdb } = require("../metadata");
const { enrichWithTorrentData, enrichJackettResults } = require("../torrentEnrich");
const { torboxAddMagnet, torboxGetInfo, torboxRequestDownload, torboxGetDownloadLink } = require("../providers/torbox");
const { rdAddMagnet, rdSelectFiles, rdGetItem, rdUnrestrictLink } = require("../providers/realdebrid");
const { qbitAddMagnet } = require("../providers/qbittorrent");
`;

for (const [name, snippets] of Object.entries(routes)) {
  if (snippets.length === 0) continue;
  const fileCode = commonImports + "\n\n" + snippets.join("\n\n") + "\n\nmodule.exports = router;\n";
  fs.writeFileSync("routes/" + name + ".js", fileCode);
  console.log("Created routes/" + name + ".js");
}

nodesToRemove.sort((a,b) => b.start - a.start);
for (const n of nodesToRemove) {
  code = code.slice(0, n.start) + code.slice(n.end);
}

// Add the router middleware to addon.js
const routeRequires = `
app.use("/", require("./routes/api"));
app.use("/", require("./routes/manifest"));
app.use("/", require("./routes/configure"));
app.use("/", require("./routes/catalog"));
app.use("/", require("./routes/qbit"));
app.use("/", require("./routes/stream"));
`;

// Insert routeRequires right before module.exports = app or app.listen
let injectPoint = code.indexOf('module.exports = app');
if (injectPoint === -1) injectPoint = code.lastIndexOf('app.listen');
if (injectPoint !== -1) {
  code = code.slice(0, injectPoint) + routeRequires + '\\n' + code.slice(injectPoint);
}

fs.writeFileSync('addon.js', code);
console.log('Routes extracted from addon.js');
