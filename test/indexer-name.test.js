"use strict";
// O topo do nome do stream é sempre o nome do addon (ProwJack);
// a fonte real (indexador) fica no campo `indexer` e na linha ⚙️ da descrição.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";

const spotting = require(`${repo}/scoring`);
const routeHelpers = require(`${repo}/routeHelpers`);
const { renameIndexer } = spotting;
const { extractScrapIndexer } = routeHelpers;

test("formatStream: name mantém o addon no topo; indexer no campo indexer", () => {
  const r = {
    Title: "Dune Part One 2021 2160p UHD BluRay REMUX DV HDR10+ TrueHD Atmos",
    Size: 5789135360,
    Seeders: 50,
    _displaySeeds: 50,
  };
  const { name, indexer } = spotting.formatStream(r, "Zilean", false, { addonName: "ProwJack" }, true, {});
  assert.ok(name.startsWith("ProwJack"), `name deveria começar com o addon, recebido: ${name.split("\n")[0]}`);
  assert.equal(indexer, "Zilean");
  assert.match(name, /ProwJack/);
});

test("formatStream: descreve a fonte real na linha ⚙️ da descrição", () => {
  const r = { Title: "American.Hostage.S01E01-02.WEB-DL.1080p.x264.DUAL", Size: 5368709120, Seeders: 10 };
  const { description, indexer } = spotting.formatStream(r, "Betor", false, { addonName: "ProwJack" }, true, {});
  assert.equal(indexer, "Betor");
  assert.ok(description.includes("⚙️ Betor"), description);
});

test("formatStream: fallback para addonName quando indexador é vazio", () => {
  const r = { Title: "Alguma Coisa 1080p", Size: 1000000000, Seeders: 5 };
  const { name, indexer } = spotting.formatStream(r, "", false, { addonName: "ProwJack" }, true, {});
  assert.ok(name.startsWith("ProwJack"));
  assert.equal(indexer, "");
});

test("renameIndexer: normaliza e remove badges", () => {
  assert.equal(renameIndexer("Zilean"), "Zilean");
  assert.equal(renameIndexer("[TORRENT 🧲] 1337x"), "1337x");
  assert.equal(renameIndexer("🇧🇷 Rede"), "Rede Torrent");
});

test("scrapers externos: indexador marcado pelo addon é extraído (⚙️ Bludv/Comando)", () => {
  // Simula um addon externo marcando a fonte real com ⚙️ (ex.: BrasilRD).
  assert.equal(extractScrapIndexer("Meca.Area.2024.1080p.mkv\n⚙️ Comando Torrents\n🌐 pt-BR"), "Comando Torrents");
  assert.equal(extractScrapIndexer("Filme X [BluRay]\n⚙️ Bludv"), "Bludv");
  assert.equal(extractScrapIndexer("Filme Y"), "");
});