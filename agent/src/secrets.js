// Secret and state files: owner-only permissions, atomic writes (temp + rename), tolerant reads.
// The agent bearer token and the Praise API device token are separate files and are never logged or echoed.
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const AGENT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;      // 32 random bytes, base64url
const DEVICE_TOKEN_RE = /^[\x21-\x7e]{16,512}$/;   // printable ASCII, no spaces: it goes into an Authorization header

// Windows ignores POSIX modes, so reset the ACL to "this user only" (best effort; the profile directory is already per-user).
function hardenWindows(target, isDir) {
  if (process.platform !== "win32") return;
  try {
    const who = `${process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : ""}${process.env.USERNAME || ""}`;
    if (!process.env.USERNAME) return;
    execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `${who}:${isDir ? "(OI)(CI)F" : "F"}`],
      { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } catch (e) { /* best effort */ }
}

function ensureDir(dir, { harden = true } = {}) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed) {
    if (process.platform === "win32") { if (harden) hardenWindows(dir, true); }
    else { try { fs.chmodSync(dir, 0o700); } catch (e) { /* not ours */ } }
  }
}

// Write temp file next to the target (exclusive create, 0600), fsync, rename over the target. A crash leaves either the old or the new file.
function writeFileAtomic(file, data, { mode = 0o600, harden = false } = {}) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch (e) { /* some filesystems refuse */ }
  } finally { fs.closeSync(fd); }
  if (harden) hardenWindows(tmp, false);
  let lastErr;
  for (let i = 0; i < 5; i++) {       // Windows can briefly refuse a rename while a scanner holds the file
    try { fs.renameSync(tmp, file); return; } catch (e) {
      lastErr = e;
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") break;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* short spin: this path is rare */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  throw lastErr;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; }
}

// On POSIX, tighten a secret file that somebody made group/world readable.
function enforceOwnerOnly(file) {
  if (process.platform === "win32") return false;
  try {
    const st = fs.statSync(file);
    if (st.mode & 0o077) { fs.chmodSync(file, 0o600); return true; }
  } catch (e) { /* missing */ }
  return false;
}

function readAgentToken(file) {
  const t = (readText(file) || "").trim();
  return AGENT_TOKEN_RE.test(t) ? t : null;
}

function newAgentToken() { return crypto.randomBytes(32).toString("base64url"); }

// Read the per-install bearer token, creating it on first use.
function loadOrCreateAgentToken(file, opts = {}) {
  enforceOwnerOnly(file);
  const existing = readAgentToken(file);
  if (existing) return existing;
  ensureDir(path.dirname(file), opts);
  const token = newAgentToken();
  writeFileAtomic(file, token + "\n", { harden: opts.harden !== false });
  return token;
}

function rotateAgentToken(file, opts = {}) {
  ensureDir(path.dirname(file), opts);
  const token = newAgentToken();
  writeFileAtomic(file, token + "\n", { harden: opts.harden !== false });
  return token;
}

function validDeviceToken(t) { return typeof t === "string" && DEVICE_TOKEN_RE.test(t); }

function readDeviceToken(file) {
  enforceOwnerOnly(file);
  const t = (readText(file) || "").trim();
  return validDeviceToken(t) ? t : null;
}

function writeDeviceToken(file, token, opts = {}) {
  if (!validDeviceToken(token)) throw new Error("device token has an unexpected format");
  ensureDir(path.dirname(file), opts);
  writeFileAtomic(file, token + "\n", { harden: opts.harden !== false });
}

// Compare a presented secret with the real one in constant time. Both are hashed first so the comparison length is fixed
// and the length of the real token does not leak through timing.
function secretsEqual(presented, expectedDigest) {
  if (typeof presented !== "string") return false;
  const d = crypto.createHash("sha256").update(presented).digest();
  return crypto.timingSafeEqual(d, expectedDigest);
}

function digestOf(secret) { return crypto.createHash("sha256").update(secret).digest(); }

module.exports = {
  ensureDir, writeFileAtomic, readText, enforceOwnerOnly, loadOrCreateAgentToken, rotateAgentToken, readAgentToken,
  readDeviceToken, writeDeviceToken, validDeviceToken, secretsEqual, digestOf, hardenWindows, AGENT_TOKEN_RE,
};
