"use strict";

const crypto  = require("crypto");
const express = require("express");
const axios   = require("axios");
const Redis   = require("ioredis");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────
// CORS — obrigatório para o Stremio aceitar o addon
// ─────────────────────────────────────────────────────────
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (_, res) => res.sendStatus(200));

// ─────────────────────────────────────────────────────────
// CONFIGURAÇÃO VIA ENV (Docker)
// ─────────────────────────────────────────────────────────
const ENV = {
  jackettUrl: (process.env.JACKETT_URL     || "http://localhost:9117").replace(/\/$/, ""),
  apiKey:      process.env.JACKETT_API_KEY  || "",
  indexers:   (process.env.INDEXERS || "all").split(",").map(s => s.trim()).filter(Boolean),
  port:        process.env.PORT || 7014,
  redisUrl:    process.env.REDIS_URL || "redis://localhost:6379",
};

// ─────────────────────────────────────────────────────────
// REDIS
// ─────────────────────────────────────────────────────────
let redis = null;
try {
  redis = new Redis(ENV.redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  redis.on("error", () => {});
} catch {}

const rc = {
  async get(k)          { try { return redis ? await redis.get(k) : null; } catch { return null; } },
  async set(k, v, ttl)  { try { redis && await redis.set(k, v, "EX", ttl); } catch {} },
  async del(k)          { try { redis && await redis.del(k); } catch {} },
  async keys(p)         { try { return redis ? await redis.keys(p) : []; } catch { return []; } },
};

// ─────────────────────────────────────────────────────────
// CONFIG CODEC  (apenas preferências — sem credenciais)
// ─────────────────────────────────────────────────────────
function encodeUserCfg(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function decodeUserCfg(str) {
  try { return JSON.parse(Buffer.from(str, "base64url").toString()); } catch { return null; }
}

// Config base quando não há nada codificado na URL
function defaultPrefs() {
  return {
    indexers:        ENV.indexers,        // vindos da env
    categories:      ["movie", "series"],
    weights:         { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5 },
    maxResults:      20,
    slowThreshold:   8000,
    skipBadReleases: true,
  };
}

// Sempre usa credenciais da env; sobrepõe com prefs da URL.
// Regra de indexers:
//   ENV.indexers=['all']        → usa o que o usuário configurou na UI
//   ENV.indexers=['capybarabr'] → NUNCA deixa 'all' da UI sobrescrever; filtra subconjunto
function resolvePrefs(encoded) {
  const userPrefs = encoded ? (decodeUserCfg(encoded) || {}) : {};
  const merged = { ...defaultPrefs(), ...userPrefs };

  const envIsAll  = ENV.indexers.length === 1 && ENV.indexers[0] === "all";
  const userIsAll = !merged.indexers?.length || merged.indexers.includes("all");

  if (!envIsAll && userIsAll) {
    // Env tem indexers específicos, UI escolheu 'all' → usa env
    merged.indexers = ENV.indexers;
  } else if (!envIsAll && !userIsAll) {
    // Ambos específicos → intersecção (só usa o que está na env)
    const envSet = new Set(ENV.indexers);
    merged.indexers = merged.indexers.filter(ix => envSet.has(ix));
    if (!merged.indexers.length) merged.indexers = ENV.indexers;
  }
  // envIsAll → usa o que vier da UI (comportamento original)

  return merged;
}

// ─────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────
const RESOLUTION = [
  { re: /\b(4k|2160p)\b/i,  label: "2160p", emoji: "🎞️ 4K",  score: 4   },
  { re: /\b1440p\b/i,       label: "1440p", emoji: "🎞️ 2K",  score: 3.5 },
  { re: /\b1080p\b/i,       label: "1080p", emoji: "🎞️ FHD", score: 3   },
  { re: /\b720p\b/i,        label: "720p",  emoji: "💿 HD",   score: 2   },
  { re: /\b576p\b/i,        label: "576p",  emoji: "📼 576P", score: 1   },
  { re: /\b480p\b/i,        label: "480p",  emoji: "📼 480P", score: 0.5 },
];
const QUALITY = [
  { re: /remux/i,             label: "REMUX",  emoji: "📀", score: 5  },
  { re: /blu[-.]?ray/i,       label: "BluRay", emoji: "💿", score: 4  },
  { re: /web[-.]?dl/i,        label: "WEBDL",  emoji: "🌐", score: 3  },
  { re: /webrip/i,            label: "WEBRip", emoji: "🖥️", score: 2.5},
  { re: /hdrip/i,             label: "HDRip",  emoji: "💾", score: 2  },
  { re: /dvdrip/i,            label: "DVDRip", emoji: "💾", score: 1.5},
  { re: /hdtv/i,              label: "HDTV",   emoji: "📺", score: 1  },
  { re: /\b(ts|tc|hcts)\b/i,  label: "TS",     emoji: "⚠️", score: -2 },
  { re: /\bcam(rip)?\b/i,     label: "CAM",    emoji: "⛔", score: -5 },
];
const CODEC = [
  { re: /\bav1\b/i,           label: "AV1",   score: 4 },
  { re: /[hx]\.?265|hevc/i,   label: "H.265", score: 3 },
  { re: /[hx]\.?264|avc/i,    label: "H.264", score: 2 },
  { re: /xvid|divx/i,         label: "XViD",  score: 0 },
];
const AUDIO = [
  { re: /atmos/i,             label: "Atmos"  },
  { re: /dts[-.]?x\b/i,       label: "DTS-X"  },
  { re: /dts[-.]?hd/i,        label: "DTS-HD" },
  { re: /\bdts\b/i,           label: "DTS"    },
  { re: /truehd/i,            label: "TrueHD" },
  { re: /dd\+|eac[-.]?3/i,   label: "DD+"    },
  { re: /\b(dd|ac[-.]?3)\b/i, label: "DD"     },
  { re: /\baac\b/i,           label: "AAC"    },
  { re: /\bmp3\b/i,           label: "MP3"    },
  { re: /\bopus\b/i,          label: "Opus"   },
];
const VISUAL = [
  { re: /hdr10\+/i,                      label: "HDR10+" },
  { re: /hdr10\b/i,                      label: "HDR10"  },
  { re: /dolby.?vision|dovi|\bdv\b/i,    label: "DV"     },
  { re: /\bhdr\b/i,                      label: "HDR"    },
  { re: /\bsdr\b/i,                      label: "SDR"    },
];
const LANG = [
  { re: /(dublado|dual.?audio|pt[-.]?br|portugu[eê]s|portuguese|brazilian)/i,
    code: "pt-br", emoji: "🇧🇷", label: "PT-BR" },
  { re: /\b(english|eng)\b/i,
    code: "en",    emoji: "🇺🇸", label: "EN"    },
  { re: /(espa[nñ]ol|spanish|\besp\b)/i,
    code: "es",    emoji: "🇪🇸", label: "ES"    },
  { re: /(fran[cç]ais|french|\bfre\b)/i,
    code: "fr",    emoji: "🇫🇷", label: "FR"    },
];

const first = (map, t) => map.find(e => e.re.test(t));
const all   = (map, t) => map.filter(e => e.re.test(t));

// Converte base32 (32 chars A-Z2-7) → hex (40 chars)
function base32ToHex(b32) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of b32.toUpperCase()) {
    const v = alpha.indexOf(c);
    if (v === -1) return null;
    bits += v.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4)
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.length === 40 ? hex : null;
}

function extractInfoHash(magnet) {
  if (!magnet) return null;
  // Hex hash (40 chars) — formato mais comum
  const hex = magnet.match(/btih:([a-fA-F0-9]{40})(?:[&?]|$)/i);
  if (hex) return hex[1].toLowerCase();
  // Base32 hash (32 chars A-Z2-7) — alguns indexers API
  const b32 = magnet.match(/btih:([A-Za-z2-7]{32})(?:[&?]|$)/i);
  if (b32) return base32ToHex(b32[1]);
  // Hex sem delimitador exato
  const loose = magnet.match(/btih:([a-fA-F0-9]{40})/i);
  if (loose) return loose[1].toLowerCase();
  return null;
}
// Extrai o info dict de um buffer .torrent (bencode mínimo)
function extractInfoBuf(buf) {
  const s   = buf.toString("latin1");
  const pos = s.indexOf("4:info");
  if (pos === -1) return null;
  let i     = pos + 6;
  let depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === "d" || c === "l") { depth++; i++; }
    else if (c === "e")         { depth--; i++; if (depth === 0) break; }
    else if (c === "i")         { i = s.indexOf("e", i + 1) + 1; }
    else if (c >= "0" && c <= "9") {
      const colon = s.indexOf(":", i);
      if (colon === -1) break;
      i = colon + 1 + parseInt(s.slice(i, colon), 10);
    } else { i++; }
  }
  return depth === 0 ? buf.slice(start, i) : null;
}

// Resolve infoHash por todas as fontes possíveis (com fallback para fetch do torrent)
async function resolveInfoHash(r) {
  // 1. InfoHash direto do Jackett
  if (r.InfoHash) return r.InfoHash.toLowerCase();

  // 2. Extrair do MagnetUri
  if (r.MagnetUri) {
    const h = extractInfoHash(r.MagnetUri);
    if (h) return h;
  }

  // 3. Seguir o Link do Jackett server-side
  if (!r.Link) return null;

  try {
    const res = await axios.get(r.Link, {
      timeout:            10000,
      maxRedirects:       10,
      responseType:       "arraybuffer",
      maxContentLength:   8 * 1024 * 1024,
      validateStatus:     s => s < 400,
    });

    // 3a. URL final é magnet?
    const finalUrl = res.request?.res?.responseUrl || "";
    if (finalUrl.startsWith("magnet:")) return extractInfoHash(finalUrl);

    const buf = Buffer.from(res.data);
    const bodyStr = buf.toString("utf8", 0, Math.min(buf.length, 200));

    // 3b. Corpo é magnet em texto?
    if (bodyStr.trimStart().startsWith("magnet:")) return extractInfoHash(bodyStr.trim());

    // 3c. É um .torrent? (bencode começa com 'd')
    if (buf[0] === 0x64) {
      const infoBuf = extractInfoBuf(buf);
      if (infoBuf) return crypto.createHash("sha1").update(infoBuf).digest("hex");
    }
  } catch (e) {
    console.log(`  ⚠️  resolveInfoHash: ${e.message}`);
  }

  return null;
}

function extractGroup(title) {
  const m = title.match(/[-.]([A-Z0-9]{2,12})(?:\[.+?\])?$/i);
  return m ? m[1].toUpperCase() : null;
}
function fmtBytes(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

// ─────────────────────────────────────────────────────────
// SCORE
// ─────────────────────────────────────────────────────────
function score(r, weights = {}) {
  const w = { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5, ...weights };
  const t = r.Title || "";
  let s = 0;

  const lang = first(LANG, t);
  if (lang?.code === "pt-br") s += w.language * 25;
  else if (lang?.code === "en") s += w.language * 5;

  const res = first(RESOLUTION, t);
  if (res) s += res.score * w.resolution * 10;

  const qual = first(QUALITY, t);
  if (qual) s += qual.score * 50;

  s += (r.Seeders || 0) * (w.seeders / 10);

  const gb = (r.Size || 0) / 1e9;
  if (gb > 0) s += Math.max(0, 10 - Math.abs(gb - 8)) * w.size;

  const codec = first(CODEC, t);
  if (codec) s += codec.score * w.codec * 5;

  return s;
}

// ─────────────────────────────────────────────────────────
// FORMATTER  (estilo aiostreams)
// ─────────────────────────────────────────────────────────
function formatStream(r, indexerName) {
  const t      = r.Title || "";
  const res    = first(RESOLUTION, t);
  const qual   = first(QUALITY, t);
  const codec  = first(CODEC, t);
  const audios = all(AUDIO, t);
  const vis    = all(VISUAL, t);
  const langs  = all(LANG, t);
  const group  = extractGroup(t);
  const size   = fmtBytes(r.Size);
  const seeds  = r.Seeders || 0;

  // ── NAME  (3 linhas no card do Stremio)
  const nameLine1 = `🔍 ProwJack · ${indexerName}`;
  const nameLine2 = [
    res  ? res.emoji          : "❔",
    qual ? `${qual.emoji} ${qual.label}` : "",
    vis.length ? vis.map(v => v.label).join(" | ") : "",
  ].filter(Boolean).join("  ");
  const nameLine3 = [
    langs.length ? langs.map(l => l.emoji).join(" ") : "🌐",
    codec ? `🎞️ ${codec.label}` : "",
    seeds > 0 ? `🌱 ${seeds}` : "",
  ].filter(Boolean).join("  ");

  // ── DESCRIPTION  (expandido no Stremio)
  const clean = t
    .replace(/\b\d{4}\b\.?/g, " ")
    .replace(/\./g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const desc = [
    `🎬 ${clean}`,
    [
      qual   ? `🎥 ${qual.label}`                        : "",
      vis.length ? `📺 ${vis.map(v => v.label).join(" | ")}` : "",
      codec  ? `🎞️ ${codec.label}`                      : "",
      res    ? `📐 ${res.label}`                         : "",
    ].filter(Boolean).join("  "),
    [
      audios.length ? `🎧 ${audios.map(a => a.label).join(" | ")}` : "",
      langs.length  ? `🗣️ ${langs.map(l => `${l.emoji} ${l.label}`).join(" / ")}` : "",
    ].filter(Boolean).join("  "),
    [
      size      ? `📦 ${size}`        : "",
      seeds > 0 ? `🌱 ${seeds} seeds` : "",
      `📡 ${indexerName}`,
    ].filter(Boolean).join("  "),
    group ? `🏷️ ${group}` : "",
    [
      "⚠️ P2P",
      langs.some(l => l.code === "pt-br") ? "🇧🇷 PT-BR" : "",
    ].filter(Boolean).join("  "),
  ].filter(Boolean).join("\n");

  return {
    name:        [nameLine1, nameLine2, nameLine3].join("\n"),
    description: desc,
  };
}

// ─────────────────────────────────────────────────────────
// JACKETT  (credenciais sempre da ENV)
// ─────────────────────────────────────────────────────────
async function jackettFetchIndexers() {
  // Estratégia 1: /api/v2.0/indexers (versões recentes do Jackett)
  const strategies = [
    () => axios.get(`${ENV.jackettUrl}/api/v2.0/indexers`,
            { params: { apikey: ENV.apiKey }, timeout: 8000 }),
    // Estratégia 2: com configured=true (algumas versões)
    () => axios.get(`${ENV.jackettUrl}/api/v2.0/indexers`,
            { params: { apikey: ENV.apiKey, configured: "true" }, timeout: 8000 }),
    // Estratégia 3: header X-Api-Key (Jackett v0.21+)
    () => axios.get(`${ENV.jackettUrl}/api/v2.0/indexers`,
            { headers: { "X-Api-Key": ENV.apiKey }, timeout: 8000 }),
  ];

  for (const attempt of strategies) {
    try {
      const res  = await attempt();
      const list = (res.data || []).filter(ix => ix.configured !== false);
      if (list.length) return list;
    } catch {}
  }

  // Fallback: se nenhuma estratégia funcionar, retorna os indexers da ENV como lista sintética
  console.warn("⚠️  Não foi possível listar indexers do Jackett — usando lista da ENV");
  return ENV.indexers.map(id => ({ id, name: id, configured: true }));
}

async function trackMetrics(indexer, ms, count, ok) {
  const key = `metrics:${indexer}`;
  const raw = await rc.get(key);
  const m = raw ? JSON.parse(raw) :
    { calls: 0, totalMs: 0, totalResults: 0, failures: 0 };
  m.calls++;
  m.totalMs      += ms;
  m.totalResults += count;
  if (!ok) m.failures++;
  m.avgMs      = Math.round(m.totalMs / m.calls);
  m.avgResults = Math.round(m.totalResults / m.calls);
  m.successRate = Math.round(((m.calls - m.failures) / m.calls) * 100);
  m.lastCall    = new Date().toISOString();
  await rc.set(key, JSON.stringify(m), 86400);
}

async function jackettSearch(query, prefs) {
  // Indexers sempre da ENV — seleção pela UI desativada temporariamente
  const indexers  = (ENV.indexers.length === 1 && ENV.indexers[0] === "all")
    ? ["all"]
    : ENV.indexers;

  const cacheKey = `search:${query}:${indexers.join(",")}`;
  const cached   = await rc.get(cacheKey);
  if (cached) {
    console.log(`⚡ Cache HIT: ${query}`);
    return JSON.parse(cached);
  }

  const threshold = prefs.slowThreshold || 8000;

  console.log(`🌐 Jackett search: "${query}" [${indexers.join(", ")}]`);

  const requests = indexers.map(async indexer => {
    const t0  = Date.now();
    try {
      const res = await axios.get(
        `${ENV.jackettUrl}/api/v2.0/indexers/${indexer}/results`,
        { params: { apikey: ENV.apiKey, Query: query }, timeout: threshold }
      );
      const ms      = Date.now() - t0;
      const results = res.data.Results || [];
      await trackMetrics(indexer, ms, results.length, true);
      console.log(`  ✅ ${indexer}: ${results.length} (${ms}ms)`);
      return results;
    } catch (err) {
      const ms = Date.now() - t0;
      await trackMetrics(indexer, ms, 0, false);
      console.log(`  ❌ ${indexer}: ${err.response?.status || ""} ${err.message}`);
      return [];
    }
  });

  const all = (await Promise.all(requests)).flat();
  console.log(`📦 Total: ${all.length}`);
  // Só cacheia se tiver resultados — evita travar buscas válidas
  if (all.length > 0) {
    await rc.set(cacheKey, JSON.stringify(all), 600);
  }
  return all;
}

// ─────────────────────────────────────────────────────────
// CINEMETA
// ─────────────────────────────────────────────────────────
async function getTitle(type, imdbId) {
  try {
    const res  = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 5000 }
    );
    const meta = res.data?.meta;
    return meta?.name || meta?.originalName || imdbId;
  } catch { return imdbId; }
}

// ─────────────────────────────────────────────────────────
// ROTAS DE API   (antes das rotas parametricas /:config/)
// ─────────────────────────────────────────────────────────

// Status da conexão env
app.get("/api/env", (_, res) => {
  res.json({
    jackettUrl: ENV.jackettUrl,
    apiKeySet:  !!ENV.apiKey,
    indexers:   ENV.indexers,
  });
});

// Testa conexão com o Jackett usando credenciais da env
app.get("/api/test", async (_, res) => {
  try {
    const indexers = await jackettFetchIndexers();
    const fromEnv  = indexers.every(ix => ENV.indexers.includes(ix.id || ix.name));
    res.json({
      ok: true,
      count: indexers.length,
      indexers,
      note: indexers[0]?._synthetic
        ? "Lista da ENV (endpoint /indexers indisponível nesta versão do Jackett)"
        : null,
    });
  } catch (err) {
    res.json({
      ok: false,
      error: `${err.response?.status || ""} ${err.message}`.trim(),
    });
  }
});

// Métricas
app.get("/api/metrics", async (_, res) => {
  const keys = await rc.keys("metrics:*");
  const out  = {};
  for (const k of keys) {
    const raw = await rc.get(k);
    if (raw) out[k.replace("metrics:", "")] = JSON.parse(raw);
  }
  res.json(out);
});

app.delete("/api/metrics/:indexer", async (req, res) => {
  await rc.del(`metrics:${req.params.indexer}`);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────
// MANIFEST BASE  (sem config — mostra botão "Configurar")
// O Stremio abre /configure quando configurationRequired=true
// ─────────────────────────────────────────────────────────
app.get("/manifest.json", (_, res) => {
  res.json({
    id:          "org.prowjack.pro",
    version:     "3.0.0",
    name:        "ProwJack PRO",
    description: "Busca no Jackett com ranking inteligente e prioridade PT-BR. Configure os indexers e pesos antes de instalar.",
    resources:   ["stream"],
    types:       ["movie", "series"],
    idPrefixes:  ["tt"],
    catalogs:    [],
    behaviorHints: {
      configurable:          true,
      configurationRequired: true,  // redireciona para /configure
      p2p:                   true,
    },
  });
});

// ─────────────────────────────────────────────────────────
// PÁGINA DE CONFIGURAÇÃO
// O Stremio abre essa URL no browser quando clica Configurar
// ─────────────────────────────────────────────────────────
app.get("/configure", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html"))
);

// Redireciona raiz para /configure
app.get("/", (_, res) => res.redirect("/configure"));

// ─────────────────────────────────────────────────────────
// MANIFEST COM CONFIG   (URL personalizada gerada pela UI)
// Ex: /eyJpbmRleGVycy...base64.../manifest.json
// ─────────────────────────────────────────────────────────
app.get("/:userConfig/manifest.json", (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);

  const types = [...new Set(
    (prefs.categories || ["movie", "series"]).map(c =>
      c === "movies" ? "movie" : c === "anime" ? "series" : c
    )
  )];

  const indexerLabel = (prefs.indexers || []).includes("all")
    ? "todos os indexers"
    : (prefs.indexers || []).join(", ");

  res.json({
    id:          "org.prowjack.pro",
    version:     "3.0.0",
    name:        "ProwJack PRO",
    description: `Jackett (${indexerLabel}) · Ranking PT-BR · Redis cache`,
    resources:   ["stream"],
    types,
    idPrefixes:  ["tt"],
    catalogs:    [],
    behaviorHints: {
      configurable:          true,
      configurationRequired: false,  // já configurado
      p2p:                   true,
    },
  });
});

// ─────────────────────────────────────────────────────────
// STREAMS
// ─────────────────────────────────────────────────────────
const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i;

app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs  = resolvePrefs(req.params.userConfig);
  const { type, id } = req.params;

  try {
    const imdbId = id.split(":")[0];
    let title    = await getTitle(type, imdbId);
    let query    = title;

    if (type === "series" && id.includes(":")) {
      const [, s, e] = id.split(":");
      query += ` S${String(s).padStart(2,"0")}E${String(e).padStart(2,"0")}`;
    }

    console.log(`🎬 ${type} ${id} → "${query}"`);

    const results = await jackettSearch(query, prefs);

    if (results.length > 0) {
      const s = results[0];
      console.log(`🔍 Sample: InfoHash=${s.InfoHash||"null"} MagnetUri=${s.MagnetUri?"ok":"null"} Link=${s.Link?"ok":"null"}`);
    }

    // Filtra e ordena — depois resolve infoHash de forma async (inclui fetch de .torrent)
    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => !prefs.skipBadReleases || !BAD_RE.test(r.Title || ""))
      .sort((a, b) => score(b, prefs.weights) - score(a, prefs.weights))
      .slice(0, prefs.maxResults || 20);

    const resolved = await Promise.all(
      candidates.map(async r => {
        const infoHash = await resolveInfoHash(r);
        if (!infoHash) {
          console.log(`  ⚠️  sem infoHash: "${(r.Title||"").slice(0,50)}"`);
          return null;
        }
        const indexerName = r.Tracker || r.TrackerId || "Unknown";
        const { name, description } = formatStream(r, indexerName);
        const sources = r.MagnetUri ? [r.MagnetUri] : [];
        return { name, description, infoHash, sources,
                 behaviorHints: { bingeGroup: `prowjack|${infoHash}` } };
      })
    );
    const streams = resolved.filter(Boolean);

    console.log(`✅ ${streams.length} streams → ${query}`);
    res.json({ streams });

  } catch (err) {
    console.error(`💥 ${err.message}`);
    res.json({ streams: [] });
  }
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
app.listen(ENV.port, () => {
  console.log(`🚀 ProwJack PRO → http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Indexers: ${ENV.indexers.join(", ")}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
});
