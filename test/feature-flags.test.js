"use strict";
// Feature flags: ENABLE_QBITTORRENT / ENABLE_RSS_CATALOG protegendo UI e backend.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";

function loadWith(env) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const reqPath = `${repo}/constants`;
  delete require.cache[require.resolve(reqPath)];
  const cleanReq = (p) => {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
    return require(resolved);
  };
  const constants = cleanReq(reqPath);
  return { constants, restore: () => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    delete require.cache[require.resolve(reqPath)];
  } };
}

test("ENABLE_QBITTORRENT=false desabilita flag mesmo com credenciais no env", () => {
  const { constants, restore } = loadWith({
    ENABLE_QBITTORRENT: "false",
    QBIT_URL: "http://127.0.0.1:8080",
    QBIT_USER: "admin",
    QBIT_PASS: "senha",
  });
  try {
    assert.equal(constants.ENV.enableQbit, false);
  } finally { restore(); }
});

test("ENABLE_QBITTORRENT=true habilita flag", () => {
  const { constants, restore } = loadWith({ ENABLE_QBITTORRENT: "true" });
  try {
    assert.equal(constants.ENV.enableQbit, true);
  } finally { restore(); }
});

test("ENABLE_RSS_CATALOG=false desabilita mesmo com RSS_CATALOG_INDEXERS set", () => {
  const { constants, restore } = loadWith({
    ENABLE_RSS_CATALOG: "false",
    RSS_CATALOG_INDEXERS: "5,11",
  });
  try {
    assert.equal(constants.ENV.enableRssCatalog, false);
  } finally { restore(); }
});

test("ENABLE_RSS_CATALOG=true + RSS_CATALOG_INDEXERS habilita", () => {
  const { constants, restore } = loadWith({
    ENABLE_RSS_CATALOG: "true",
    RSS_CATALOG_INDEXERS: "5,11",
  });
  try {
    assert.equal(constants.ENV.enableRssCatalog, true);
  } finally { restore(); }
});

test("padrão: enableRssCatalog segue RSS_CATALOG_INDEXERS (vazio = false)", () => {
  const { constants, restore } = loadWith({ RSS_CATALOG_INDEXERS: "" });
  try {
    assert.equal(constants.ENV.enableRssCatalog, false);
  } finally { restore(); }
});

test("backend: isQbitEnabledForPrefs retorna false quando flag desabilitada", () => {
  const { constants, restore } = loadWith({
    ENABLE_QBITTORRENT: "false",
    QBIT_URL: "http://127.0.0.1:8080",
    QBIT_USER: "admin",
    QBIT_PASS: "senha",
  });
  try {
    delete require.cache[require.resolve(`${repo}/routeHelpers`)];
    delete require.cache[require.resolve(`${repo}/providers/qbittorrent`)];
    const { isQbitEnabledForPrefs } = require(`${repo}/routeHelpers`);
    // Mesmo que o usuário peça qbitMode=always e creds existam, o servidor bloqueia.
    assert.equal(isQbitEnabledForPrefs({ qbitMode: "always", enableP2P: true }, null), false);
  } finally { restore(); }
});