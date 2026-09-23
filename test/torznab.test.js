"use strict";
// Testes do parser Torznab/XML e de resultados Prowlarr (Zilean/Betor).

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Carrega o módulo com caminho absoluto; os testes precisam do process.cwd() do repo.
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";
const jackettSearch = require(`${repo}/jackettSearch`);
const { zileanTorznabXml } = require("./helpers");

test("parseTorznabResults: converte XML Torznab do Zilean corretamente", () => {
  const xml = zileanTorznabXml([
    { title: "Dune 2021 1080p WEB-DL", hash: "a".repeat(40), imdbId: "tt1160419", seeders: 42, size: 5789135360 },
  ]);
  const items = jackettSearch.parseTorznabResults(xml, "Zilean");
  assert.equal(items.length, 1);
  const r = items[0];
  assert.equal(r.Title, "Dune 2021 1080p WEB-DL");
  assert.equal(r.InfoHash, "a".repeat(40));
  assert.equal(r.Size, 5789135360);
  assert.equal(r.Seeders, 42);
  assert.equal(r.ImdbId, "tt1160419");
  assert.equal(r.Tracker, "Zilean");
  assert.equal(r.TrackerId, "Zilean");
  assert.match(r.Link, /^magnet:/);
  assert.equal(r._structuredMatch, true);
});

test("parseTorznabResults: aceita infohash vindo de attrs e propaga MagnetUri", () => {
  const hash = "b".repeat(40);
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
    <item><title>Show S01E01 1080p</title><guid>g1</guid>
    <torznab:attr name="infohash" value="${hash}" />
    <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${hash}" />
    <torznab:attr name="size" value="1073741824" />
    <torznab:attr name="seeders" value="7" /></item>
  </channel></rss>`;
  const items = jackettSearch.parseTorznabResults(xml, "Betor");
  assert.equal(items.length, 1);
  assert.equal(items[0].MagnetUri, `magnet:?xt=urn:btih:${hash}`);
  assert.equal(items[0].Size, 1073741824);
});

test("parseTorznabResults: resultados sem título são descartados", () => {
  const xml = `<rss version="2.0"><channel><item><guid>sem-titulo</guid></item></channel></rss>`;
  assert.equal(jackettSearch.parseTorznabResults(xml, "x").length, 0);
});

test("parseProwlarrResults: converter resultados JSON da API v1 do Prowlarr", () => {
  const items = jackettSearch.parseProwlarrResults(
    [
      {
        title: "Dune Part One 2021 2160p",
        downloadUrl: "magnet:?xt=urn:btih:" + "c".repeat(40),
        magnetUrl: "magnet:?xt=urn:btih:" + "c".repeat(40),
        infoHash: "c".repeat(40),
        size: 21474836480,
        seeders: 999,
        indexer: "Zilean",
        indexerId: 2,
        imdbId: "tt1160419",
      },
    ],
    "Zilean"
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].InfoHash, "c".repeat(40));
  assert.equal(items[0].Tracker, "Zilean");
  assert.equal(items[0].ImdbId, "tt1160419");
  assert.equal(items[0].Seeders, 999);
});

test("normalizeProwlarrInfoHash: normaliza hashes hex e base32-ascii", () => {
  const h = "d".repeat(40);
  assert.equal(jackettSearch.normalizeProwlarrInfoHash(h), h);
  assert.equal(jackettSearch.normalizeProwlarrInfoHash(Buffer.from(h, "hex").toString("hex")), h);
  assert.equal(jackettSearch.normalizeProwlarrInfoHash(""), null);
  assert.equal(jackettSearch.normalizeProwlarrInfoHash("nope"), null);
});

test("titleMatchesEpisode: lida com ranges, packs e episódios avulsos", () => {
  assert.equal(jackettSearch.titleMatchesEpisode("Show S01E03 1080p", 1, 3), true);
  assert.equal(jackettSearch.titleMatchesEpisode("Show S01E03 1080p", 1, 4), false);
  assert.equal(jackettSearch.titleMatchesEpisode("Show S01E01-E05", 1, 3), true);
  assert.equal(jackettSearch.titleMatchesEpisode("Show S01E01E03", 1, 3), true);
  assert.equal(jackettSearch.titleMatchesEpisode("Show Season 1 Complete", 1, 3), true);
  assert.equal(jackettSearch.titleMatchesEpisode("Show S02 Complete", 1, 3), false);
  assert.equal(jackettSearch.titleMatchesEpisode("Show 1x03", 1, 3), true);
});

test("filterBadMatches: mantém episódios corretos e remove falsos positivos", () => {
  const parsed = { type: "series", season: 1, episode: 3 };
  const plan = { queries: ["Show S01E03", "Show"] };
  const good = jackettSearch.filterBadMatches(
    [
      { Title: "Show S01E03 1080p WEB-DL", Tracker: "Zilean" },
      { Title: "Show.2024.S01E06.1080p", Tracker: "Zilean" },
    ],
    parsed,
    plan
  );
  assert.equal(good.length, 1);
  assert.equal(good[0].Title, "Show S01E03 1080p WEB-DL");
});