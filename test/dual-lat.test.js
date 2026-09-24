"use strict";
// Áudio duplo latino/espanhol (dual-lat) NÃO é português e não deve ser
// tratado como PT-BR no idioma prioritário/dublado.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";
const { hasPtBrKeyword, hasPtBrResult, getLangs, score } = require(`${repo}/scoring`);

test("dual-lat não é PT-BR (todas as variações)", () => {
  const notPtBr = [
    "Show S01E01 DUAL-LAT 1080p",
    "Show S01E01 DUAL LATINO 1080p",
    "Show S01E01 DUAL.AUDIO.LATINO",
    "Show S01E01 DUAL AUDIO LAT",
    "Show S01E01 DUAL ESP",
    "Show S01E01 DUAL SPA",
    "Show S01E01 DUAL AUDIO ESPAÑOL",
    "Show S01E01 DUAL AUDIO ESPANHOL",
    "Show S01E01 DUAL AUDIO LATINO 5.1",
  ];
  for (const t of notPtBr) {
    assert.equal(hasPtBrKeyword(t), false, `não deveria ser pt-br: ${t}`);
    assert.equal(hasPtBrResult({ Title: t }), false, `result não deveria ser pt-br: ${t}`);
  }
});

test("dual-lat é marcado como espanhol", () => {
  const langs = getLangs("Show S01E01 DUAL-LAT 1080p");
  assert.ok(langs.some(l => l.code === "es"), `deveria ser es: ${JSON.stringify(langs)}`);
  const langs2 = getLangs("Show S01E01 DUAL AUDIO LATINO");
  assert.ok(langs2.some(l => l.code === "es"));
});

test("dual audio genérico (sem lat/esp) permanece PT-BR", () => {
  assert.equal(hasPtBrKeyword("Show S01E01 DUAL AUDIO 5.1"), true);
});

test("dublado/pt-br prevalece quando presente junto a dual-lat", () => {
  assert.equal(hasPtBrKeyword("Show S01 E01 DUAL-LAT DUBLADO"), true);
  assert.equal(hasPtBrKeyword("Show S01 E01 DUAL-LAT PORTUGUES"), true);
});

test("score não prioriza dual-lat como pt-br", () => {
  const dualLat = score({ Title: "Show S01E01 DUAL-LAT 1080p 5.1", Seeders: 0, Size: 0 }, {}, false, "pt-br");
  const dualAudio = score({ Title: "Show S01E01 DUAL AUDIO 1080p 5.1", Seeders: 0, Size: 0 }, {}, false, "pt-br");
  assert.ok(dualLat < dualAudio, `dual-lat (${dualLat}) deveria pontuar menos que dual audio (${dualAudio})`);
});
