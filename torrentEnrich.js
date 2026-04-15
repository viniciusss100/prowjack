"use strict";

const EXTRA_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://wepzone.net:6969/announce",
  "http://tracker.bt4g.com:2095/announce",
  "udp://tracker.filemail.com:6969/announce",
  "udp://tracker-udp.gbitt.info:80/announce",
  "https://tracker.ghostchu-services.top:443/announce",
];

function bdecode(buf, offset = 0) {
  const ch = buf[offset];
  if (ch === 0x69) {
    const end = buf.indexOf(0x65, offset + 1);
    return { value: parseInt(buf.slice(offset + 1, end).toString("ascii"), 10), end: end + 1 };
  }
  if (ch === 0x6c) {
    const list = []; let i = offset + 1;
    while (buf[i] !== 0x65) { const item = bdecode(buf, i); list.push(item.value); i = item.end; }
    return { value: list, end: i + 1 };
  }
  if (ch === 0x64) {
    const dict = {}; let i = offset + 1;
    while (buf[i] !== 0x65) { const k = bdecode(buf, i); i = k.end; const v = bdecode(buf, i); i = v.end; dict[k.value.toString("ascii")] = v.value; }
    return { value: dict, end: i + 1 };
  }
  const colon = buf.indexOf(0x3a, offset);
  const len = parseInt(buf.slice(offset, colon).toString("ascii"), 10);
  return { value: buf.slice(colon + 1, colon + 1 + len), end: colon + 1 + len };
}

function bencode(value) {
  if (value && value._raw) return value._raw;
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  if (typeof value === "object" && value !== null) {
    const parts = [];
    for (const k of Object.keys(value).sort()) { parts.push(bencode(k)); parts.push(bencode(value[k])); }
    return Buffer.concat([Buffer.from("d"), ...parts, Buffer.from("e")]);
  }
  throw new Error(`bencode: tipo não suportado: ${typeof value}`);
}

function findBencodeEnd(buf, start) {
  const ch = buf[start];
  if (ch === 0x64 || ch === 0x6c) {
    let i = start + 1;
    while (i < buf.length && buf[i] !== 0x65) {
      if (ch === 0x64) { const k = findBencodeEnd(buf, i); if (k === -1) return -1; const v = findBencodeEnd(buf, k); if (v === -1) return -1; i = v; }
      else { const e = findBencodeEnd(buf, i); if (e === -1) return -1; i = e; }
    }
    return i + 1;
  }
  if (ch === 0x69) { const end = buf.indexOf(0x65, start + 1); return end === -1 ? -1 : end + 1; }
  if (ch >= 0x30 && ch <= 0x39) {
    const colon = buf.indexOf(0x3a, start);
    if (colon === -1) return -1;
    return colon + 1 + parseInt(buf.slice(start, colon).toString("ascii"), 10);
  }
  return -1;
}

function extractInfoRaw(buf) {
  const needle = Buffer.from("4:info");
  for (let i = 0; i <= buf.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) { if (buf[i + j] !== needle[j]) { found = false; break; } }
    if (found) {
      const end = findBencodeEnd(buf, i + needle.length);
      return end === -1 ? null : buf.slice(i + needle.length, end);
    }
  }
  return null;
}

function injectTrackers(buffer, extraTrackers = EXTRA_TRACKERS) {
  try {
    const torrent = bdecode(buffer, 0).value;
    if (typeof torrent !== "object" || Array.isArray(torrent)) return buffer;

    const existing = new Set();
    const ann = torrent["announce"];
    if (ann) { const s = Buffer.isBuffer(ann) ? ann.toString("utf8") : String(ann); if (s.startsWith("http") || s.startsWith("udp")) existing.add(s); }
    if (Array.isArray(torrent["announce-list"])) {
      for (const tier of torrent["announce-list"]) {
        for (const tr of (Array.isArray(tier) ? tier : [tier])) {
          const s = Buffer.isBuffer(tr) ? tr.toString("utf8") : String(tr);
          existing.add(s);
        }
      }
    }

    const existingLower = new Set([...existing].map(t => t.toLowerCase()));
    const allTrackers = [...existing, ...extraTrackers.filter(t => !existingLower.has(t.toLowerCase()))];

    const infoRaw = extractInfoRaw(buffer);
    const newTorrent = {
      "announce": allTrackers[0] || EXTRA_TRACKERS[0],
      "announce-list": allTrackers.map(t => [t]),
    };
    for (const key of Object.keys(torrent)) {
      if (key === "info" || key === "announce" || key === "announce-list") continue;
      newTorrent[key] = torrent[key];
    }
    newTorrent["info"] = infoRaw ? { _raw: infoRaw } : torrent["info"];

    return bencode(newTorrent);
  } catch (e) {
    console.error(`[torrentEnrich] Erro: ${e.message}`);
    return buffer;
  }
}

module.exports = { injectTrackers, EXTRA_TRACKERS };
