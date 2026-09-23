"use strict";
// Regressão do BUG CRÍTICO 1: a busca estruturada via /api/v1/search do Prowlarr
// deve enviar `query` preenchida (com o título), senão o Prowlarr ignora o imdbId
// e varre o catálogo inteiro, derrubando os dois indexadores.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";
const { startMockProwlarr } = require("./helpers");

// O módulo jackettSearch lê JACKETT_URL/JACKETT_API_KEY no require e tem cache
// interno de tipo de servidor; usamos require limpo por teste.
function freshJackettSearch() {
  const p = `${repo}/jackettSearch`;
  delete require.cache[require.resolve(p)];
  delete require.cache[require.resolve(`${repo}/cache`)];
  return require(p);
}

test("prowlarrStructuredSearch envia query com o título (não vazio) — BUG 1", async () => {
  const requests = [];
  const mock = await startMockProwlarr({
    onSearch(params) {
      requests.push(params);
      return [
        {
          title: "Dune Part One 2021 2160p",
          downloadUrl: "magnet:?xt=urn:btih:" + "a".repeat(40),
          magnetUrl: "magnet:?xt=urn:btih:" + "a".repeat(40),
          infoHash: "a".repeat(40),
          size: 21474836480,
          seeders: 999,
          indexer: "Zilean",
          imdbId: "tt1160419",
        },
      ];
    },
  });

  const jackettSearch = freshJackettSearch();
  try {
    const results = await jackettSearch.prowlarrStructuredSearch(
      { mode: "movie", title: "Dune Part One", imdbId: "tt1160419" },
      "2",
      mock.base,
      "testkey",
      5000
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].InfoHash, "a".repeat(40));
  } finally {
    await mock.close();
  }

  assert.ok(requests.length > 0, "deveria ter enviado ao menos uma requisição");
  const sent = requests[0];
  assert.ok(sent && typeof sent.query === "string" && sent.query.length > 0, `query deve estar preenchida, recebido=${JSON.stringify(sent)}`);
  assert.equal(sent.imdbId, "1160419");
  assert.equal(sent.type, "movie");
  assert.deepEqual(sent.categories, ["2000"]);
});

test("prowlarrStructuredSearch envia season/episode em tvsearch", async () => {
  const requests = [];
  const mock = await startMockProwlarr({
    onSearch(params) {
      requests.push(params);
      return [];
    },
  });
  const jackettSearch = freshJackettSearch();
  try {
    await jackettSearch.prowlarrStructuredSearch(
      { mode: "tvsearch", title: "Severance", imdbId: "tt1655384", season: 1, episode: 1 },
      "1",
      mock.base,
      "k",
      5000
    );
  } finally {
    await mock.close();
  }
  const sent = requests[0];
  assert.equal(sent.type, "tvsearch");
  assert.equal(sent.season, "1");
  assert.equal(sent.episode, "1");
  assert.deepEqual(sent.categories, ["5000"]);
  assert.ok(sent.query.length > 0);
});

test("jackettSearch: falha de um indexador não derruba os resultados dos demais", async () => {
  const mock = await startMockProwlarr({
    onSearch(params) {
      const ids = Array.isArray(params.indexerIds) ? params.indexerIds : [params.indexerIds];
      if (ids.includes("2")) {
        // Betor falha com 500
        throw Object.assign(new Error("HTTP 500"), { response: { status: 500 } });
      }
      // Zilean responde normalmente
      return [
        {
          title: "American Hostage S01E01 My Town Indy 2160p AMZN",
          downloadUrl: "magnet:?xt=urn:btih:" + "b".repeat(40),
          magnetUrl: "magnet:?xt=urn:btih:" + "b".repeat(40),
          infoHash: "b".repeat(40),
          size: 999,
          seeders: 5,
          indexer: "Zilean",
          indexerId: 1,
          imdbId: "tt3468612",
        },
      ];
    },
  });
  const jackettSearch = freshJackettSearch();
  const normalizePrefs = require(`${repo}/prefs`).normalizePrefs;
  try {
    const prefs = normalizePrefs({
      // jackett local aponta para o mock (jackettSearch lê prefs.jackett)
      jackett: { url: mock.base, key: "k" },
      indexers: ["1", "2"],
      slowThreshold: 3000,
      maxResults: 20,
      dedupe: true,
    });
    const plan = {
      queries: ["American Hostage"],
      search: { mode: "movie", title: "American Hostage", imdbId: "tt3468612" },
      parsed: { type: "movie", season: null, episode: null },
    };
    const res = await jackettSearch.jackettSearch(plan, ["1", "2"], prefs);
    assert.ok(Array.isArray(res));
    // O indexador que falhou não deve eliminar resultados do que respondeu.
    assert.ok(res.length > 0, "deveria manter resultados do indexador saudável");
    const trackerNames = new Set(res.map(r => r.Tracker));
    assert.ok(trackerNames.has("Zilean"), "resultados do Zilean devem estar presentes");
    assert.ok(!trackerNames.has("Betor") || res.some(r => r.Tracker !== "Betor"));
  } finally {
    await mock.close();
  }
});