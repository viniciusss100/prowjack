"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const repo = process.env.PROJACK_REPO || "/home/vinicius/docker/apps/prowjack";
const { setCacheControl } = require(`${repo}/routeHelpers`);

function fakeRes() {
  return { headers: {}, set(k, v) { this.headers[k] = v; } };
}

test("setCacheControl: público com s-maxage (CDN)", () => {
  const res = fakeRes();
  setCacheControl(res, { maxAge: 300, sMaxAge: 900 });
  assert.equal(res.headers["Cache-Control"], "public, max-age=300, s-maxage=900");
});

test("setCacheControl: private não expõe s-maxage", () => {
  const res = fakeRes();
  setCacheControl(res, { maxAge: 60, isPrivate: true });
  assert.equal(res.headers["Cache-Control"], "private, max-age=60");
});

test("setCacheControl: sem valores cai para público simples", () => {
  const res = fakeRes();
  setCacheControl(res, {});
  assert.equal(res.headers["Cache-Control"], "public");
});
