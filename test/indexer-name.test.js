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
  // Simula um addon externo marcando a fonte real com ⚙️ (ex.: BrasilRD antigo).
  assert.equal(extractScrapIndexer("Meca.Area.2024.1080p.mkv\n⚙️ Comando Torrents\n🌐 pt-BR"), "Comando Torrents");
  assert.equal(extractScrapIndexer("Filme X [BluRay]\n⚙️ Bludv"), "Bludv");
  assert.equal(extractScrapIndexer("Filme Y"), "");
});

test("scrapers externos: extrai indexador real no formato BrasilRD (🔍)", () => {
  // BrasilRD (render/vercel) marca o indexador com 🔍 dentro do título.
  const brasilrdTitle =
    "Duna 2021 1080p WEB-DL FULL HD DUAL 5.1\n👤 26 🔍 Comando Torrents\n💿 1080p 🌐 PT-BR 🇧🇷 🇺🇸 📅 08/09/2026";
  assert.equal(extractScrapIndexer(brasilrdTitle), "Comando Torrents");
  // Outros indexadores marcados com 🔍.
  assert.equal(extractScrapIndexer("O.Poço.2025\n👤 12 🔍 Bludv\n🌐 pt-BR"), "Bludv");
  // Sem marcador, retorna vazio (cai para o 📡 do addon).
  assert.equal(extractScrapIndexer("nome-do-addon\n1080p SemMarcador"), "");
  // 🔗 (seeds) não deve ser confundido com indexador.
  assert.equal(extractScrapIndexer("🔗 13 ⚙️ Comando Torrents"), "Comando Torrents");
});

test("scrapExternalDescription: mantém indexador e fonte sem duplicar linha", () => {
  const { scrapExternalDescription } = routeHelpers;
  const stream = {
    name: "brasilrd-render\n1080p",
    title: "Duna 2021 1080p\n👤 26 🔍 Comando Torrents\n🌐 PT-BR 🇧🇷",
    description: "",
    behaviorHints: { filename: "Duna 2021 1080p.mkv" },
  };
  const desc = scrapExternalDescription(stream, "brasilrd-render");
  assert.ok(desc.includes("⚙️ Comando Torrents"), desc);
  assert.ok(desc.includes("📡 brasilrd-render"), desc);
  assert.ok(desc.includes("🌱 26"), desc);
  // O título não deve aparecer em linha duplicada com o marcador 🔍 cru.
  assert.ok(!desc.includes("🔍"), desc);
});