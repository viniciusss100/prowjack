const fs = require('fs');
const acorn = require('acorn');

let code = fs.readFileSync('addon.js', 'utf8');

const helpersToExtract = new Set([
  'getPublicBase',
  'buildStremThruProxyManifestUrl',
  'isQbitEnabledForPrefs',
  'shouldOfferQbitForResult',
  'getRequestAccessToken',
  'hasAdminAccess',
  'requireAdminAccess',
  'getRssFastPathResults',
  'sendConfigurePage',
  'fetchScrapStreams',
  'isPrivateTrackerCandidate',
  'checkRateLimit'
]);

const funcsToRemove = new Set([
  ...helpersToExtract,
  'resolvePrefs',
  'saveQbitJob',
  'loadQbitJob'
]);

const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
let extractedFuncs = [];
let nodesToRemove = [];
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && node.id) {
    if (helpersToExtract.has(node.id.name)) {
      extractedFuncs.push(code.slice(node.start, node.end));
      nodesToRemove.push(node);
    } else if (funcsToRemove.has(node.id.name)) {
      nodesToRemove.push(node);
    }
  } else if (node.type === 'VariableDeclaration') {
    let shouldRemove = false;
    for (const decl of node.declarations) {
      if (decl.id && decl.id.type === 'Identifier' && decl.id.name === 'memoryStore') {
         shouldRemove = true; // the ratelimit memory store
      }
    }
    if (shouldRemove) {
        nodesToRemove.push(node);
    }
  }
}

// Generate routeHelpers.js
let helperCode = `const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { rc, redis } = require("./cache");
const { getPreferredRssIndexers, loadRssItemsForType, buildRssVideos, matchRssItemsByMarker } = require("./rssHelpers");
const { stripSourceBadges } = require("./scoring");

const memoryStore = {
  ips: new Map(),
  hashes: new Map()
};

`;
helperCode += extractedFuncs.join('\n\n');
helperCode += `\n\nmodule.exports = {
  memoryStore,
  ${Array.from(helpersToExtract).join(',\n  ')}
};
`;

fs.writeFileSync('routeHelpers.js', helperCode);

nodesToRemove.sort((a,b) => b.start - a.start);
for (const n of nodesToRemove) {
  code = code.slice(0, n.start) + code.slice(n.end);
}

fs.writeFileSync('addon.js', code);
console.log('Helpers extracted and removed from addon.js');
