"use strict";
const crypto = require("crypto");
const Redis = require("ioredis");

// ─── Configuração via ENV ────────────────────────────────────────────────────
// Importado depois que ENV é definido no addon.js; aqui lemos direto do process.env
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let redis = null;
const memoryStore = new Map();

try {
  redis = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
  let hasLoggedError = false;
  redis.on("connect", () => {
    console.log(`✅ Redis conectado: ${REDIS_URL}`);
    hasLoggedError = false;
  });
  redis.on("error",   (err) => {
    if (!hasLoggedError) {
      console.log(`❌ Redis erro: ${err.message} (logs adicionais de erro silenciados)`);
      hasLoggedError = true;
    }
  });
  redis.on("close",   () => {
    if (hasLoggedError) return; // Se já deu erro, não repete o 'desconectado' eternamente
    console.log(`⚠️ Redis desconectado`);
  });
} catch (err) {
  console.log(`❌ Redis falha na inicialização: ${err.message}`);
}

function memoryGet(k) {
  const entry = memoryStore.get(k);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memoryStore.delete(k);
    return null;
  }
  return entry.value;
}

function memorySet(k, v, ttl) {
  memoryStore.set(k, { value: v, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
}

function memoryDel(k) {
  memoryStore.delete(k);
}

function cleanExpiredMemory() {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
}

setInterval(cleanExpiredMemory, 60000);

// rc: interface unificada Redis + memória
const rc = {
  async get(k) {
    try {
      if (redis) {
        const value = await redis.get(k);
        if (value != null) return value;
      }
    } catch {}
    return memoryGet(k);
  },
  async set(k, v, ttl) {
    memorySet(k, v, ttl);
    try { if (redis) await redis.set(k, v, "EX", ttl); } catch {}
  },
  async del(k) {
    memoryDel(k);
    try { if (redis) await redis.del(k); } catch {}
  },
  async setBuffer(k, buf, ttl) {
    const b64 = buf.toString("base64");
    memorySet(k, b64, ttl);
    try { if (redis) await redis.set(k, b64, "EX", ttl); } catch {}
  },
  async getBuffer(k) {
    try {
      if (redis) {
        const v = await redis.get(k);
        if (v) return Buffer.from(v, "base64");
      }
    } catch {}
    const mem = memoryGet(k);
    return mem ? Buffer.from(mem, "base64") : null;
  },
  async keys(p) {
    const regex = new RegExp(`^${String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
    const memoryKeys = [...memoryStore.keys()].filter(key => regex.test(key));
    try {
      if (redis) {
        const redisKeys = await redis.keys(p);
        return [...new Set([...redisKeys, ...memoryKeys])];
      }
    } catch {}
    return memoryKeys;
  },
};

async function saveQbitJob(payload, ttl = 6 * 3600) {
  const token = crypto.randomBytes(18).toString("base64url");
  await rc.set(`qbitjob:${token}`, JSON.stringify(payload), ttl);
  return token;
}

async function loadQbitJob(token) {
  const raw = await rc.get(`qbitjob:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

module.exports = {
  rc,
  redis,
  saveQbitJob,
  loadQbitJob, };
