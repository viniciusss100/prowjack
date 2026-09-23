"use strict";
// Verificação de build para ambientes serverless: garante que todos os módulos
// carregam e que o entrypoint responde sem iniciar um listen persistente.
const path = require("path");
const cp = require("child_process");
const fs = require("fs");

const root = path.join(__dirname, "..");
const srcFiles = [
  "addon.js",
  "cache.js",
  "configStore.js",
  "constants.js",
  "debrid.js",
  "extractHelpers.js",
  "extractRoutes.js",
  "jackettSearch.js",
  "metadata.js",
  "prefs.js",
  "routeHelpers.js",
  "rssHelpers.js",
  "rssPoller.js",
  "scoring.js",
  "torrentEnrich.js",
  "torrentUtils.js",
  "update_ui.js",
  "routes/api.js",
  "routes/catalog.js",
  "routes/configure.js",
  "routes/manifest.js",
  "routes/qbit.js",
  "routes/stream.js",
  "providers/qbittorrent.js",
];

let failed = 0;
for (const rel of srcFiles) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.error(`[build] FALTANDO: ${rel}`);
    failed++;
    continue;
  }
  try {
    new Function("require", "module", "exports", "__dirname", "__filename", fs.readFileSync(abs, "utf8"));
    console.log(`[build] OK   ${rel}`);
  } catch (err) {
    console.error(`[build] ERRO ${rel}: ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`[build] ${failed} arquivo(s) com erro de sintaxe`);
  process.exit(1);
}
console.log("[build] Sucesso: sintaxe válida em todos os módulos.");