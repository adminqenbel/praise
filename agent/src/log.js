// Tiny leveled logger. Rule: never page text, never URLs, never tokens. Domains appear only at debug level (off by default).
"use strict";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger({ level = "info", stream = process.stderr } = {}) {
  const max = LEVELS[level] ?? LEVELS.info;
  function emit(name, msg, fields) {
    if (LEVELS[name] > max) return;
    let tail = "";
    if (fields) {
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") tail += ` ${k}=${String(v).slice(0, 120)}`;
      }
    }
    try { stream.write(`${new Date().toISOString()} ${name} ${msg}${tail}\n`); } catch (e) { /* logging must never throw */ }
  }
  return {
    debugOn: max >= LEVELS.debug,
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}

const silent = { debugOn: false, error() {}, warn() {}, info() {}, debug() {} };

module.exports = { createLogger, silent };
