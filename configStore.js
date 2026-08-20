"use strict";
const crypto = require("crypto");
const fs     = require("fs");
const { normalizePrefs } = require("./prefs");
const path   = require("path");

// Lidos diretamente do ambiente para que rotas e streams compartilhem a mesma
// persistência sem depender de cada chamador repassar esses valores.
function getConfigDbUrl(value) {
  return value || process.env.CONFIG_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
}

function getConfigDbTable(value) {
  const table = value || process.env.CONFIG_DATABASE_TABLE || "prowjack_configs";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) {
    throw new Error("CONFIG_DATABASE_TABLE inválida");
  }
  return table;
}

// ─── Postgres ────────────────────────────────────────────────────────────────
let configPgPool = null;
let configPgInit = null;

function shouldUseConfigDb(configDbUrl) {
  return !!getConfigDbUrl(configDbUrl);
}

function buildConfigPgOptions(rawUrl) {
  let connectionString = rawUrl;
  let sslMode = "";
  let hostname = "";
  try {
    const parsed = new URL(rawUrl);
    hostname = parsed.hostname;
    sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("uselibpqcompat");
    connectionString = parsed.toString();
  } catch {}

  const isRemote = /^postgres/i.test(rawUrl) && !/^(localhost|127\.0\.0\.1|::1)$/i.test(hostname);
  const ssl = isRemote && sslMode !== "disable"
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined;
  return { connectionString, ssl };
}

function getConfigPgPool(configDbUrl) {
  configDbUrl = getConfigDbUrl(configDbUrl);
  if (!shouldUseConfigDb(configDbUrl)) return null;
  if (configPgPool) return configPgPool;
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (err) {
    throw new Error("CONFIG_DATABASE_URL/POSTGRES_URL configurado, mas a dependência 'pg' não está instalada. Rode npm install.");
  }
  configPgPool = new Pool(buildConfigPgOptions(configDbUrl));
  return configPgPool;
}

async function ensureConfigDb(configDbUrl, configDbTable) {
  configDbUrl = getConfigDbUrl(configDbUrl);
  configDbTable = getConfigDbTable(configDbTable);
  const pool = getConfigPgPool(configDbUrl);
  if (!pool) return null;
  if (!configPgInit) {
    configPgInit = pool.query(`
      CREATE TABLE IF NOT EXISTS ${configDbTable} (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  await configPgInit;
  return pool;
}

async function cfgDbLoad(id, configDbUrl, configDbTable) {
  configDbUrl = getConfigDbUrl(configDbUrl);
  configDbTable = getConfigDbTable(configDbTable);
  const pool = await ensureConfigDb(configDbUrl, configDbTable);
  if (!pool) return null;
  const r = await pool.query(`SELECT payload FROM ${configDbTable} WHERE id = $1`, [id]);
  const payload = r.rows[0]?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}

async function cfgDbSave(id, prefs, configDbUrl, configDbTable) {
  configDbUrl = getConfigDbUrl(configDbUrl);
  configDbTable = getConfigDbTable(configDbTable);
  const pool = await ensureConfigDb(configDbUrl, configDbTable);
  if (!pool) return false;
  await pool.query(
    `INSERT INTO ${configDbTable} (id, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [id, JSON.stringify(prefs)]
  );
  return true;
}

// ─── File-based store ────────────────────────────────────────────────────────
const CONFIG_FILE = (() => {
  const dir = process.env.CONFIG_DATA_DIR || "/data";
  return path.join(dir, "prowjack_configs.json");
})();

function cfgFileLoad() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { return {}; }
}

function cfgFileSave(store) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(store), "utf8");
  } catch (err) {
    console.error(`[CFG] Falha ao salvar configs: ${err.message}`);
  }
}

let _cfgStore = null;
function cfgStore() {
  if (!_cfgStore) _cfgStore = cfgFileLoad();
  return _cfgStore;
}

// ─── saveStoredConfig / loadStoredUserCfg ────────────────────────────────────
async function saveStoredConfig(prefs, configDbUrl, configDbTable) {
  configDbUrl = getConfigDbUrl(configDbUrl);
  configDbTable = getConfigDbTable(configDbTable);
  const id = crypto.createHash("sha256").update(JSON.stringify(prefs)).digest("base64url").slice(0, 32);
  if (shouldUseConfigDb(configDbUrl)) {
    await cfgDbSave(id, prefs, configDbUrl, configDbTable);
    return `cfg_${id}`;
  }
  const store = cfgStore();
  store[id] = JSON.stringify(prefs);
  cfgFileSave(store);
  return `cfg_${id}`;
}

function decodeUserCfg(str) {
  try {
    if (!str || typeof str !== "string" || str.length > 10000) return null;
    const b64     = str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof decoded !== "object" || Array.isArray(decoded)) return null;
    return decoded;
  } catch { return null; }
}

async function loadStoredUserCfg(str, configDbUrl, configDbTable) {
  if (!str || typeof str !== "string" || !str.startsWith("cfg_")) return null;
  const id = str.slice(4);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(id)) return null;
  configDbUrl = getConfigDbUrl(configDbUrl);
  configDbTable = getConfigDbTable(configDbTable);
  if (shouldUseConfigDb(configDbUrl)) {
    const dbPayload = await cfgDbLoad(id, configDbUrl, configDbTable);
    if (dbPayload) return dbPayload;
  }
  const raw = cfgStore()[id];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolvePrefs(encoded) {
  const stored = encoded ? await loadStoredUserCfg(encoded) : null;
  const decoded = stored || (encoded ? (decodeUserCfg(encoded) || {}) : {});
  return normalizePrefs(decoded);
}

module.exports = {
  resolvePrefs,
  shouldUseConfigDb,
  saveStoredConfig,
  decodeUserCfg,
  loadStoredUserCfg,
};
