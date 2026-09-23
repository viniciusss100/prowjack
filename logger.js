"use strict";

// Logger com níveis de verbosidade controlados por LOG_LEVEL:
//   error  → apenas erros
//   warn   → erros + avisos
//   info   → informações básicas (PADRÃO)
//   debug  → detalhes de fluxo interno (diagnóstico)
//   silent → nenhum log
//
// Ex.: LOG_LEVEL=debug npm start   (detalhado)
//      LOG_LEVEL=info  npm start   (básico, padrão)

const RAW = String(process.env.LOG_LEVEL || "info").toLowerCase().trim();
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LEVEL = LEVELS[RAW] !== undefined ? LEVELS[RAW] : LEVELS.info;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function write(levelName, args) {
  if (LEVEL >= LEVELS[levelName]) {
    console.log(`[${ts()}] [${levelName.toUpperCase()}]`, ...args);
  }
}

const logger = {
  silent: () => LEVELS[RAW] === 0,
  level: RAW,
  debug: (...a) => write("debug", a),
  info:  (...a) => write("info", a),
  warn:  (...a) => write("warn", a),
  error: (...a) => write("error", a),
};

module.exports = logger;