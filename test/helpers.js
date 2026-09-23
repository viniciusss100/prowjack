"use strict";
// Helpers compartilhados para os testes: mock de servidor Prowlarr + utilitários.

const http = require("http");

// Simula o endpoint /api/v1/search do Prowlarr. Em vez de consultar indexadores
// reais, expõe os parâmetros recebidos para o teste inspecionar (via response
// custom `_echo`) e/ou retorna uma lista de resultados conforme `handler`.
function startMockProwlarr({ onSearch, onIndexers } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/v1/search") {
      const params = {};
      // Axios serializa arrays como `categories[]=2000`; normaliza para `categories`.
      const asArray = new Set();
      for (const [k] of url.searchParams) {
        if (k.endsWith("[]")) asArray.add(k.slice(0, -2));
      }
      for (const [k, v] of url.searchParams) {
        const key = k.replace(/\[\]$/, "");
        if (asArray.has(key)) {
          params[key] = params[key] !== undefined ? [...(Array.isArray(params[key]) ? params[key] : [params[key]]), v] : [v];
        } else {
          params[key] = v;
        }
      }
      if (params._echo) return res.end(JSON.stringify({ _echo: params }));
      if (typeof onSearch === "function") {
        try {
          const result = onSearch(params);
          if (result && result.then) return result.then(d => res.end(JSON.stringify(d)), () => { res.statusCode = 500; res.end("{}"); });
          return res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          return res.end("{}");
        }
      }
      return res.end("[]");
    }
    if (url.pathname === "/api/v1/indexer") {
      if (typeof onIndexers === "function") {
        const result = onIndexers();
        return res.end(JSON.stringify(result));
      }
      return res.end(JSON.stringify([]));
    }
    if (url.pathname === "/api/v1/system/status") return res.end("{}");
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) });
    });
  });
}

// Torznab XML idêntico ao retornado pelo Zilean (para o parser do addon).
function zileanTorznabXml(items = []) {
  const rows = items
    .map(it => `<item>
      <title>${it.title}</title>
      <guid>${it.guid || "guid1"}</guid>
      <type>Zilean</type>
      <pubDate>${it.pubDate || "Sat, 19 Sep 2026 17:01:03 +0000"}</pubDate>
      <size>${it.size || 5789135360}</size>
      <link>magnet:?xt=urn:btih:${it.hash || "081fc11f1604033db77f024da41a08f5948d5856"}</link>
      <category>${it.category || "2000"}</category>
      <enclosure url="magnet:?xt=urn:btih:${it.hash || "081fc11f1604033db77f024da41a08f5948d5856"}" length="${it.size || 5789135360}" type="application/x-bittorrent" />
      <torznab:attr name="category" value="${it.category || "2000"}" />
      <torznab:attr name="imdbid" value="${it.imdbId || "tt0309338"}" />
      <torznab:attr name="seeders" value="${it.seeders ?? 999}" />
      <torznab:attr name="infohash" value="${it.hash || "081fc11f1604033db77f024da41a08f5948d5856"}" />
      <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${it.hash || "081fc11f1604033db77f024da41a08f5948d5856"}" />
    </item>`)
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Zilean Indexer</title>${rows}</channel></rss>`;
}

module.exports = { startMockProwlarr, zileanTorznabXml };