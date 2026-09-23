require("dotenv").config();

const { isConfigured: qbitEnvConfigured } = require("./providers/qbittorrent");
const logger = require("./logger");

// Garante que uma URL pública sempre tenha protocolo. Um ADDON_PUBLIC_URL sem
// esquema (ex.: "prowjack.example.com") quebrava o buildStremThruProxyManifestUrl,
// gerando um upstream sem "https://" que o StremThru não conseguia buscar → buscas
// falhavam quando o StremThru era selecionado como debrid.
function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const noSlash = raw.replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(noSlash)) return noSlash.replace(/\/+$/, "");
  return `https://${noSlash.replace(/\/+$/, "")}`;
}

const ENV = {
  jackettUrl:      (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:          (process.env.JACKETT_API_KEY || "").trim(),
  redisUrl:        (process.env.REDIS_URL || "redis://127.0.0.1:6379").trim(),
  port:            parseInt(process.env.PORT || "7014", 10),
  addonPublicUrl:  normalizePublicUrl(process.env.ADDON_PUBLIC_URL || ""),
  accessToken:     (process.env.ACCESS_TOKEN || "").trim(),
  scrapManifests:  (process.env.SCRAP_MANIFEST_URLS || "").split(",").map(s => s.trim()).filter(Boolean),
  stremThruUrl:    (process.env.STREMTHRU_URL || "").trim().replace(/\/+$/, ""),
  stremThruProxyTimeoutMs: Math.max(
    15000,
    parseInt(process.env.STREMTHRU_PROXY_TIMEOUT_MS || "60000", 10) || 60000
  ),
  enablePureP2P:   process.env.ENABLE_PURE_P2P !== "false",
  rssUpdateIntervalMinutes: parseInt(process.env.RSS_UPDATE_INTERVAL_MINUTES || "30", 10),
  // Feature flags para a instância pública. Em produção não expõem funcionalidades
  // experimentais (qBittorrent / Catálogo RSS) a menos que explicitamente ativadas.
  // Backend também respeita essas flags, não apenas a UI.
  enableQbit:   process.env.ENABLE_QBITTORRENT != null
    ? String(process.env.ENABLE_QBITTORRENT).toLowerCase() !== "false"
    : qbitEnvConfigured(),
  enableRssCatalog: process.env.ENABLE_RSS_CATALOG != null
    ? String(process.env.ENABLE_RSS_CATALOG).toLowerCase() !== "false"
    : !!((process.env.RSS_CATALOG_INDEXERS || "").trim()),
  qbitConfig: {
    url:      (process.env.QBIT_URL || "").trim().replace(/\/+$/, ""),
    // Aceita tanto QBIT_USER/QBIT_PASS (histórico do projeto) quanto
    // QBIT_USERNAME/QBIT_PASSWORD por compatibilidade.
    username: (process.env.QBIT_USERNAME || process.env.QBIT_USER || "").trim(),
    password: (process.env.QBIT_PASSWORD || process.env.QBIT_PASS || "").trim(),
    saveDir:  (process.env.QBIT_SAVE_DIR || "").trim()
  }
};

const CACHE_VERSION = "v12-native-debrid";
const STREAM_CACHE_VERSION = "v52-unified-ranking";
const TORRENT_DOWNLOAD_TIMEOUT_MS = 15000;

const PUBLIC_TRACKERS = ["1337x", "thepiratebay", "eztv", "yts", "torrentgalaxy", "rutracker", "nyaasi", "nyaa", "nyaa.si", "limetorrents", "torlock", "kickass", "demonoid", "rarbg", "bitsearch", "solidtorrents", "magnetdl", "bt4g", "idope", "extratorrent", "comando", "bludv", "lapumia", "ondebaixa", "thepiratafilmes", "baixar", "torrentdosfilmes", "betor", "bitmagnet", "knaben", "stremthru", "torrentio"];
// Releases de baixa qualidade (cam/ts/telesync/etc). Usado quando o usuário ativa
// "Skip CAM/TS" (prefs.skipBadReleases, padrão ligado). Aplica-se a indexadores E
// a streams que vêm de addons externos (SCRAP_MANIFEST_URLS).
// "cinecalidad" é uma fonte/release famosa por CAM/TS em espanhol.
const BAD_RE = /\b(cam(hd)?|camrip|hdcam|telesync|telsync|telecine|tsrip|tcrip|hdts|hdrip-ts|dvdscr|screener|workprint|cinecalidad)\b/i;
const BAD_EXT_RE = /\.(iso|r\d{2}|zip|rar|7z|tar|gz|zipx|arj|txt|nfo|jpg|png|pdf|exe|bat|cmd|scr|msi|ps1|vbs|js|jar|com|pif|reg|dll|sys|lnk|url)$/i;

const TORRENT_FAILURE_TTL = 3600000;
// A primeira chamada também dispara a busca do upstream interno. Ela pode
// consumir o timeout do indexador mais a resolução dos arquivos .torrent.
// Com 15s, o proxy desistia enquanto a chamada ainda aquecia os caches.
const STREMTHRU_PROXY_TIMEOUT_MS = ENV.stremThruProxyTimeoutMs;
const QB_EXTRA_SLOTS = parseInt(process.env.QB_EXTRA_SLOTS || "5", 10);
const MIN_STREAM_SEEDS = 1;

logger.debug(`[Config] QB_EXTRA_SLOTS = ${QB_EXTRA_SLOTS} (env: ${process.env.QB_EXTRA_SLOTS})`);

module.exports = {
  ENV,
  CACHE_VERSION,
  STREAM_CACHE_VERSION,
  TORRENT_DOWNLOAD_TIMEOUT_MS,
  TORRENT_FAILURE_TTL,
  STREMTHRU_PROXY_TIMEOUT_MS,
  QB_EXTRA_SLOTS,
  MIN_STREAM_SEEDS,
  PUBLIC_TRACKERS,
  BAD_RE,
  BAD_EXT_RE
};
