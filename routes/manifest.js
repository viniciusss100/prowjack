const express = require("express");
const { resolvePrefs } = require("../configStore");
const { getPublicBase } = require("../routeHelpers");

const router = express.Router();

router.get("/manifest.json", (req, res) => {
  res.json({
    id: "org.prowjack.pro", version: "3.3.1", name: "ProwJack",
    logo: `${getPublicBase(req)}/logo.svg`,
    icon: `${getPublicBase(req)}/logo.svg`,
    description: "Qbittorrent+Prowlarr/Jackett+Debrid+Filtros por keywords",
    resources: ["stream", "meta"], types: ["movie", "series"],
    idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "rssitem:"],
    catalogs: [], behaviorHints: { configurable: true, configurationRequired: true, p2p: true },
  });
});

router.get("/internal/:userConfig/manifest.json", async (req, res) => {
  try {
    const rawPrefs = await resolvePrefs(req.params.userConfig);
    const prefs = { ...rawPrefs, debrid: false, stConfig: null, enableP2P: true };
    const name = prefs.addonName || "ProwJack";
    const types = [...new Set((prefs.categories || ["movie", "series"]).map(c => c === "movies" ? "movie" : c === "anime" ? "series" : c))];
    res.json({
      id: `org.prowjack.internal.${req.params.userConfig}`,
      version: "3.3.1",
      name: `${name} Internal`,
      description: "Upstream interno do ProwJack para StremThru",
      logo: `${getPublicBase(req)}/logo.svg`,
      types,
      resources: [{ name: "stream", types, idPrefixes: ["tt", "kitsu:"] }],
      catalogs: [],
      behaviorHints: { configurable: false, configurationRequired: false },
    });
  } catch (err) {
    res.json({ id: `org.prowjack.internal.err`, version: "3.3.1", name: "ProwJack Internal (Error)", resources: [], types: [], catalogs: [] });
  }
});

router.get("/:userConfig/manifest.json", async (req, res) => {
  const prefs  = await resolvePrefs(req.params.userConfig);

  const types  = [...new Set((prefs.categories || ["movie","series"]).map(c => c==="movies"?"movie":c==="anime"?"series":c))];
  const name   = prefs.addonName || "ProwJack";
  const isStremThruActive = !!(prefs.stConfig && Array.isArray(prefs.stConfig.stores) && prefs.stConfig.stores.length);
  const isDebridActive = !isStremThruActive && prefs.debrid && prefs.debridConfig &&
    (prefs.debridConfig.torboxKey || prefs.debridConfig.rdKey);
  const hasP2P = !isStremThruActive && !isDebridActive && prefs.enableP2P !== false;

  const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
  const catalogs = [];
  const catalogFilter = (process.env.RSS_CATALOG_INDEXERS || "").trim();
  // O catálogo aparece apenas se enableCatalog=true E a variável de ambiente estiver configurada
  if (prefs.enableCatalog && catalogFilter) {
    if (enabledCats.includes("movie"))  catalogs.push({ type: "movie",  id: "prowjack_rss_movie",  name: `${name} - Recentes`, extra: [{ name: "skip", isRequired: false }] });
    if (enabledCats.includes("series")) catalogs.push({ type: "series", id: "prowjack_rss_series", name: `${name} - Recentes`, extra: [{ name: "skip", isRequired: false }] });
  }

  res.json({
    id: "org.prowjack.pro", version: "3.3.1", name,
    logo: `${getPublicBase(req)}/logo.svg`,
    icon: `${getPublicBase(req)}/logo.svg`,
    description: "Qbittorrent+Prowlarr/Jackett+Debrid+Filtros por keywords",
    resources: [
      "catalog",
      { name: "meta",   types, idPrefixes: ["rssmovie:", "rssmeta:", "prowjack:", "rssitem:"] },
      { name: "stream", types },
    ],
    types, idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "prowjack:", "rssitem:"], catalogs,
    behaviorHints: { configurable: true, configurationRequired: false, p2p: hasP2P },
  });
});

module.exports = router;
