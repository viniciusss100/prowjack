const express = require("express");
const axios = require("axios");
const { isConfigured: isQbitConfigured } = require("../providers/qbittorrent");
const { ENV } = require("../constants");
const { rc, redis } = require("../cache");
const { saveStoredConfig } = require("../configStore");
const { normalizePrefs, sanitizeUserPrefs, validateServiceUrl } = require("../prefs");
const { getPublicBase, buildStremThruProxyManifestUrl, getRequestAccessToken, requireAdminAccess } = require("../routeHelpers");
const { jackettFetchIndexers, fetchIndexerPrivacyMap, isProwlarrServer } = require("../jackettSearch");

const router = express.Router();

router.post("/api/config", async (req, res) => {
  try {
    const rawPrefs = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!rawPrefs) return res.status(400).json({ ok: false, error: "Configuração inválida" });
    const prefs = sanitizeUserPrefs(rawPrefs);
    if (ENV.accessToken && prefs.token !== ENV.accessToken && getRequestAccessToken(req) !== ENV.accessToken) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }
    const userConfig = await saveStoredConfig(prefs);
    const normalizedPrefs = normalizePrefs(prefs);

    // ✨ FIX: Sempre retornar addonUrl como principal, StremThru só para resolver streams
    const addonUrl = `${getPublicBase(req)}/${userConfig}/manifest.json`;
    const stremthruUrl = normalizedPrefs.stConfig ? buildStremThruProxyManifestUrl(req, normalizedPrefs, userConfig) : null;

    res.json({ ok: true, userConfig, addonUrl, stremthruUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.use("/api/debrid", requireAdminAccess);

router.use("/api/indexers", requireAdminAccess);

router.use("/api/test", requireAdminAccess);

router.use("/api/metrics", requireAdminAccess);

router.get("/api/debrid/test/:provider", async (req, res) => {
  const { provider } = req.params;
  const key = (req.query.key || "").trim();
  if (!key) return res.json({ ok: false, error: "API Key não informada" });
  try {
    if (provider === "torbox") {
      const r = await axios.get("https://api.torbox.app/v1/api/user/me",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      const d = r.data?.data || {};
      return res.json({ ok: true, name: d.email || d.customer || "Usuário", plan: d.plan || "" });
    }
    if (provider === "realdebrid") {
      const r = await axios.get("https://api.real-debrid.com/rest/1.0/user",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      return res.json({ ok: true, name: r.data?.username || "Usuário", plan: r.data?.type || "" });
    }
    if (provider === "stremthru") {
      const r = await axios.get("https://stremthru.13377001.xyz/api/v1/user",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      return res.json({ ok: true, name: r.data?.email || "Usuário", plan: r.data?.subscription || "" });
    }
    return res.json({ ok: false, error: "Provider desconhecido" });
  } catch (err) {
    const s = err.response?.status;
    return res.json({ ok: false, error: s === 401 ? "Key inválida (401)" : s === 403 ? "Acesso negado (403)" : err.message });
  }
});

router.get("/api/env", async (_, res) => {
  let redisOk = false;
  try {
    if (redis) {
      await redis.ping();
      redisOk = true;
    }
  } catch {}
  const jUrl = ENV.jackettUrl;
  const jKey = ENV.apiKey;
  const isProwlarr = isProwlarrServer(jUrl, jKey);
  res.json({
    jackettConfigured: !!ENV.jackettUrl,
    jackettKeyConfigured: !!ENV.apiKey,
    isProwlarr: isProwlarr === true,
    serverType: isProwlarr === true ? "prowlarr" : isProwlarr === false ? "jackett" : "unknown",
    qbitConfigured: isQbitConfigured(),
    redisOk,
    port: ENV.port,
    accessProtected: !!ENV.accessToken,
  });
});

router.get("/api/indexers", async (req, res) => {
  let url;
  try {
    url = req.query.url ? validateServiceUrl(req.query.url) : ENV.jackettUrl;
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message, indexers: [] });
  }
  // Evita expor a chave manual na URL, no histórico do navegador e em logs.
  // O query param permanece como compatibilidade temporária com clientes antigos.
  const key = String(req.headers["x-jackett-api-key"] || req.query.key || "").trim() || ENV.apiKey;
  try   {
    const [indexers, privacyMap] = await Promise.all([
      jackettFetchIndexers(url, key),
      fetchIndexerPrivacyMap(url, key),
    ]);
    const enriched = indexers.map(ix => ({
      ...ix,
      private: !!privacyMap.get(String(ix.id))?.private,
      privacy: privacyMap.get(String(ix.id))?.privacy || null,
    }));
    res.json({ ok: true, count: enriched.length, indexers: enriched });
  }
  catch (err) { res.json({ ok: false, error: err.message, indexers: [] }); }
});

router.get("/api/test", async (_, res) => {
  try   { const indexers = await jackettFetchIndexers(); res.json({ ok: true, count: indexers.length, indexers }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

router.get("/api/metrics", async (_, res) => {
  const keys = await rc.keys("metrics:*");
  const out  = {};
  for (const k of keys) {
    const raw = await rc.get(k);
    if (!raw) continue;
    try { out[k.replace("metrics:", "")] = JSON.parse(raw); } catch {}
  }
  res.json(out);
});

module.exports = router;
