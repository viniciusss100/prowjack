module.exports = {
  jackettUrl: process.env.JACKETT_URL,
  apiKey: process.env.JACKETT_API_KEY,
  indexers: process.env.INDEXERS || "all"
};
