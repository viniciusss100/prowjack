"use strict";
// Filtro de qualidade (Skip CAM/TS): releases de baixa qualidade de indexadores
// E de scrapers externos não devem entrar na lista quando prefs.skipBadReleases
// está ativo (padrão).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";

const { BAD_RE, BAD_EXT_RE } = require(`${repo}/constants`);
const { normalizePrefs } = require(`${repo}/prefs`);

test("BAD_RE: detecta releases de baixa qualidade (cam/ts/telesync/etc)", () => {
  const bad = [
    "Duna 2021 CAM 1080p mkv",
    "Filme X HDCAM x264",
    "Filme Y CAMRip",
    "Serie S01E01 TELESYNC",
    "Filme Z Telesync 720p",
    "Clássico Telecine x264",
    "Release TSRIP mkv",
    "Filme DVDSCR 720p",
    "Screener x264",
    "Workprint 1080p",
    "Filme 2024 1080p CAM CineCalidad",
    "Filme 2024 HDTS CineCalidad x264",
  ];
  for (const t of bad) {
    assert.ok(BAD_RE.test(t), `deveria bloquear: ${t}`);
  }
});

test("BAD_RE: NÃO bloqueia releases normais", () => {
  const ok = [
    "Duna 2021 1080p WEB-DL x264",
    "Filme X BluRay 4K",
    "Serie S01E01 720p HDTV",
    "Filme Y WEB-DL HDR",
    "Duna 2021 2160p UHD REMUX",
  ];
  for (const t of ok) {
    assert.ok(!BAD_RE.test(t), `não deveria bloquear: ${t}`);
  }
});

test("BAD_EXT_RE: bloqueia arquivos não-reproduzíveis", () => {
  assert.ok(BAD_EXT_RE.test("arquivo.iso"));
  assert.ok(BAD_EXT_RE.test("arquivo.rar"));
  assert.ok(BAD_EXT_RE.test("arquivo.zip"));
  assert.ok(BAD_EXT_RE.test("arquivo.r01"));
  assert.ok(!BAD_EXT_RE.test("arquivo.mkv"));
  assert.ok(!BAD_EXT_RE.test("arquivo.mp4"));
});

test("skipBadReleases: o padrão é ligado (true)", () => {
  const prefs = normalizePrefs({});
  assert.equal(prefs.skipBadReleases, true);
  assert.equal(normalizePrefs({ skipBadReleases: false }).skipBadReleases, false);
});
