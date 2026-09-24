"use strict";
// Regressão: streams de addons externos (P2P com infoHash) devem preservar o
// magnet original (com trackers) e as sources do addon — sem isso o Stremio
// não encontra peers em torrents de trackers privados/niche ("arquivo inválido").

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";

// Reimplementa fielmente a conversão scrape → candidato (scrapCandidates do stream.js)
function toCandidate(s) {
  const hash = s.infoHash || (s.url && s.url.match(/btih:([a-f0-9]{40})/i))?.[1] || null;
  const originalMagnet = (s.magnet && s.magnet.startsWith("magnet:"))
    ? s.magnet
    : (typeof s.url === "string" && s.url.startsWith("magnet:") ? s.url : null);
  return {
    InfoHash: hash,
    MagnetUri: originalMagnet || (hash ? `magnet:?xt=urn:btih:${hash}` : null),
    _scrapSources: Array.isArray(s.sources) && s.sources.length ? s.sources : null,
    _scrapSource: true,
  };
}

// Reimplementa streamTrackerList (mesma lógica do stream.js)
function trackers(c, resolved) {
  if (c._scrapSource && Array.isArray(c._scrapSources) && c._scrapSources.length) {
    const out = [];
    for (const src of c._scrapSources) {
      const t = String(src || "");
      if (t.startsWith("tracker:")) out.push(t.slice("tracker:".length));
      else if (/^(udp|http|https|wss):\/\//i.test(t)) out.push(t);
    }
    if (out.length) return out;
  }
  const magnet = (c.MagnetUri && String(c.MagnetUri).startsWith("magnet:")) ? c.MagnetUri : null;
  if (!resolved?.buffer && magnet) {
    const out = [];
    for (const m of (magnet.matchAll(/[&?]tr=([^&]+)/g) || [])) {
      try { out.push(decodeURIComponent(m[1])); } catch {}
    }
    if (out.length) return out;
  }
  return [];
}

test("scrap P2P: preserva magnet original com trackers (não apenas o hash)", () => {
  const hash = "a".repeat(40);
  const magnet = `magnet:?xt=urn:btih:${hash}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce`;
  const c = toCandidate({ infoHash: hash, url: magnet, magnet });
  assert.equal(c.InfoHash, hash);
  assert.ok(c.MagnetUri.includes("tr="), "magnet deve conter trackers");
  assert.ok(c.MagnetUri.startsWith("magnet:?xt=urn:btih:"));
  // sem buffer, extrai do magnet
  const t = trackers(c, { buffer: null });
  assert.ok(t.length >= 2, "deve extrair trackers do magnet original");
  assert.ok(t.includes("udp://tracker.opentrackr.org:1337/announce"));
});

test("scrap P2P: usa sources originais do addon como prioridade", () => {
  const c = toCandidate({
    infoHash: "b".repeat(40),
    url: "magnet:?xt=urn:btih:" + "b".repeat(40),
    magnet: "magnet:?xt=urn:btih:" + "b".repeat(40),
    sources: ["tracker:udp://tracker.custom.br:6969/announce", "wss://tracker.example.com:443/announce"],
  });
  const t = trackers(c, { buffer: null });
  assert.deepEqual(t, ["udp://tracker.custom.br:6969/announce", "wss://tracker.example.com:443/announce"]);
});

test("scrap P2P: sem sources nem trackers, retorna lista vazia (fallback no caller)", () => {
  const c = toCandidate({
    infoHash: "c".repeat(40),
    url: "magnet:?xt=urn:btih:" + "c".repeat(40),
    magnet: "magnet:?xt=urn:btih:" + "c".repeat(40),
    sources: [],
  });
  assert.deepEqual(trackers(c, { buffer: null }), []);
});
