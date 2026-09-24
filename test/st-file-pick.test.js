"use strict";
// Regressão: seleção de arquivo do fluxo StremThru direto. Antes o ST pegava
// stFiles[0], que pode ser .url/.png/.nfo → reprodução falha ("arquivo inválido").

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";

const { pickEpisodeFile } = require(`${repo}/torrentUtils`);

// Replica stPickStreamFile do routes/stream.js
function stPickStreamFile(stFiles, parsed, episode) {
  if (!Array.isArray(stFiles) || !stFiles.length) return null;
  const normalized = stFiles.map((f, i) => ({
    idx: (f.index != null ? Number(f.index) : i),
    name: String(f.name || f.filename || ""),
    size: Number(f.size || f.length || 0) || 0,
    raw: f,
  }));
  if (parsed?.season != null || parsed?.isAnime) {
    const ep = parsed.episode ?? episode;
    const matched = pickEpisodeFile(normalized, parsed.season ?? 1, ep, parsed.isAnime || false);
    if (matched) {
      const raw = normalized.find(f => f.idx === matched.idx);
      return raw || matched;
    }
  }
  const VIDEO_EXT = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv|webm)$/i;
  const videos = normalized.filter(f => VIDEO_EXT.test(f.name));
  const pool = videos.length ? videos : normalized;
  const best = pool.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a), pool[0]);
  return best;
}

test("ST: filme escolhe o maior arquivo de vídeo (ignora .url/.png)", () => {
  const files = [
    { index: 0, name: "Filme.url", size: 1 },
    { index: 1, name: "Filme.png", size: 500 },
    { index: 2, name: "movie-info.nfo", size: 100 },
    { index: 3, name: "Filme.2024.1080p.mkv", size: 4000000000 },
    { index: 4, name: "filme.sample.mp4", size: 50000000 },
  ];
  const picked = stPickStreamFile(files, { season: null, episode: null, isAnime: false }, null);
  assert.ok(picked, "deve selecionar um arquivo");
  assert.equal(picked.idx, 3);
  assert.equal(picked.name, "Filme.2024.1080p.mkv");
});

test("ST: filme sem vídeo cai para o maior arquivo (fallback)", () => {
  const files = [
    { index: 0, name: "a.url", size: 2 },
    { index: 1, name: "b.png", size: 1000 },
  ];
  const picked = stPickStreamFile(files, { season: null, episode: null }, null);
  assert.equal(picked.idx, 1);
});

test("ST: série escolhe episódio correspondente", () => {
  const files = [
    { index: 0, name: "pasta.url", size: 10 },
    { index: 1, name: "S01E01.mkv", size: 1000000000 },
    { index: 2, name: "S01E02.mkv", size: 1100000000 },
  ];
  const picked = stPickStreamFile(files, { season: 1, episode: 2, isAnime: false }, null);
  assert.equal(picked.name, "S01E02.mkv");
});

test("ST: lista vazia retorna null", () => {
  assert.equal(stPickStreamFile([], {}, null), null);
});
