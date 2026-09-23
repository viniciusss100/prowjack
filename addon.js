"use strict";
// Precisa rodar ANTES de qualquer módulo que leia process.env no require
// (ex.: providers/qbittorrent.js lê QBIT_URL/QBIT_USER/QBIT_PASS no load).
require("dotenv").config();
const express = require("express");
const path    = require("path");

const { rc, redis } = require("./cache");
const { isConfigured: isQbitConfigured } = require("./providers/qbittorrent");
const { startRssPoller } = require("./rssPoller");
const { ENV } = require("./constants");
const { checkRateLimit } = require("./routeHelpers");
const logger = require("./logger");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Rate limit excedido" });
  }
  next();
});

app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || ["*"];
  const origin = req.headers.origin;
  if (allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin))) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use("/", require("./routes/api"));
app.use("/", require("./routes/manifest"));
app.use("/", require("./routes/configure"));
app.use("/", require("./routes/catalog"));
app.use("/", require("./routes/qbit"));
app.use("/", require("./routes/stream"));

app.listen(ENV.port, "0.0.0.0", () => {
  // Nunca logar credenciais: REDIS_URL pode conter user:pass.
  const safeRedis = (() => {
    try {
      const u = new URL(ENV.redisUrl);
      if (u.username) u.username = "***";
      if (u.password) u.password = "***";
      return u.toString();
    } catch { return ENV.redisUrl ? "(configurado)" : "(vazio)"; }
  })();
  logger.info(`===== Application Startup at ${new Date().toISOString().replace('T', ' ').slice(0, 19)} =====`);
  logger.info(`ProwJack v3.3.2 -> http://localhost:${ENV.port}/configure (log level: ${logger.level})`);
  logger.info(`   Jackett : ${ENV.jackettUrl || "(vazio)"}   Redis: ${safeRedis}`);
  logger.info(`   qBittorrent: ${ENV.enableQbit && isQbitConfigured() ? "ativo" : `desativado${isQbitConfigured() ? " (flag desabilitada)" : ""}`}`);
  logger.info(`   Feature flags: ENABLE_QBITTORRENT=${ENV.enableQbit} ENABLE_RSS_CATALOG=${ENV.enableRssCatalog}`);
  if (ENV.enableRssCatalog) {
    startRssPoller(ENV.jackettUrl, ENV.apiKey, rc, redis);
  } else {
    logger.info("[RSS] ENABLE_RSS_CATALOG=false — poller desabilitado.");
  }
});
