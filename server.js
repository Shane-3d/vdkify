#!/usr/bin/env node
/* ===================================================================
   vdkify — deploy files, get domains, connect GitHub.
   Zero-dependency Node server (node:sqlite, Node >= 22.5).

   - Every site gets a free domain instantly:  <name>.localhost:PORT
     (browsers resolve *.localhost to 127.0.0.1 natively — no DNS).
     Path fallback for anything else:          /s/<name>/
   - Deploy by dropping files/folders/zips on the dashboard, or
     connect a GitHub repo and (re)deploy it with one click.
   - Every deploy is versioned; roll back from the dashboard.

   Run:  node server.js      (config in env/.env, see env/.env.example)
   =================================================================== */
"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;

/* ---------------- env ---------------- */

function loadEnv() {
  const p = path.join(ROOT, "env", ".env");
  const out = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}
const ENV = loadEnv();
const cfg = (k, d) => (process.env[k] ?? ENV[k] ?? d);

const PORT = Number(cfg("PORT", 4400));
const BASE_DOMAIN = String(cfg("BASE_DOMAIN", "localhost")).toLowerCase();
// how site URLs are DISPLAYED (useful behind a reverse proxy / Cloudflare
// Tunnel where the public scheme/port differ from the local listener)
const PUBLIC_SCHEME = String(cfg("PUBLIC_SCHEME", "http"));
const PUBLIC_PORT = String(cfg("PUBLIC_PORT", String(PORT)));
const DATA_DIR = path.resolve(ROOT, cfg("DATA_DIR", "data"));
const DB_PATH = path.resolve(ROOT, cfg("DB_PATH", path.join("data", "vdkify.db")));
const SESSION_HOURS = Number(cfg("SESSION_HOURS", 24 * 7));
const MAX_DEPLOY_MB = Number(cfg("MAX_DEPLOY_MB", 200));
const KEEP_DEPLOYS = Number(cfg("KEEP_DEPLOYS", 10));

const SITES_DIR = path.join(DATA_DIR, "sites");
fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/* ---------------- db ---------------- */

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sites (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    active_deploy TEXT,
    repo TEXT, branch TEXT, gh_token TEXT,
    env TEXT
  );
  CREATE TABLE IF NOT EXISTS deploys (
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    files INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    error TEXT
  );
`);

// migrate DBs created before newer columns existed
try { db.exec("ALTER TABLE sites ADD COLUMN env TEXT"); } catch { /* exists */ }
try { db.exec("ALTER TABLE deploys ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE deploys ADD COLUMN error TEXT"); } catch { /* exists */ }

const getSetting = (k) => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);

/* ---------------- auth (single admin password) ---------------- */

function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString("hex"); }

function checkPassword(pw) {
  const salt = getSetting("pw_salt"), hash = getSetting("pw_hash");
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), salt, 64);
  let b; try { b = Buffer.from(hash, "hex"); } catch { b = Buffer.alloc(0); }
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, expires_at) VALUES (?,?)")
    .run(token, Date.now() + SESSION_HOURS * 3600000);
  return token;
}

function authed(req) {
  const m = (req.headers.authorization || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return false;
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  return !!db.prepare("SELECT 1 FROM sessions WHERE token=? AND expires_at>=?").get(m[1], Date.now());
}

// login rate limit: 5 fails per IP -> 60s lockout, doubling
const loginGuard = new Map();
function ipOf(req) { return String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""); }
function lockedFor(ip) { const e = loginGuard.get(ip); return e && e.lockUntil > Date.now() ? Math.ceil((e.lockUntil - Date.now()) / 1000) : 0; }
function loginFail(ip) {
  const e = loginGuard.get(ip) || { fails: 0, lockUntil: 0, locks: 0 };
  if (++e.fails >= 5) { e.locks++; e.lockUntil = Date.now() + 60000 * 2 ** (e.locks - 1); e.fails = 0; }
  loginGuard.set(ip, e);
}

/* ---------------- helpers ---------------- */

const VALID_SITE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/; // dns-label-ish
const RESERVED = new Set(["www", "api", "admin", "dashboard", "app", "mail", "s"]);

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  };
}

function sendJson(res, status, obj, extra) {
  res.writeHead(status, Object.assign(
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    securityHeaders(), extra || {}
  ));
  res.end(JSON.stringify(obj));
}

function readBody(req, limitBytes) {
  const limit = limitBytes || MAX_DEPLOY_MB * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`body too large (limit ${Math.round(limit / 1048576)} MB)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  try { return JSON.parse(buf.toString("utf8") || "{}"); }
  catch { throw new Error("bad json"); }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".map": "application/json", ".md": "text/plain; charset=utf-8"
};

/* ---------------- zip extraction (from scratch, node:zlib) ---------------- */

function extractZip(buf, destDir) {
  // locate End Of Central Directory
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip (central directory)");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    // normalize separators — Windows' Compress-Archive writes backslashes
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen).replace(/\\/g, "/");
    entries.push({ name, method, csize, lho });
    off += 46 + nameLen + extraLen + cmtLen;
  }

  // strip a single common root folder (GitHub zipballs: repo-sha/...)
  const fileEntries = entries.filter((e) => !e.name.endsWith("/"));
  let strip = "";
  if (fileEntries.length) {
    const first = fileEntries[0].name;
    const rootEnd = first.indexOf("/");
    if (rootEnd > 0) {
      const root = first.slice(0, rootEnd + 1);
      if (fileEntries.every((e) => e.name.startsWith(root))) strip = root;
    }
  }

  let files = 0, bytes = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue; // directories are implied
    let rel = e.name.slice(strip.length);
    if (!rel) continue;
    rel = rel.replace(/\\/g, "/");
    const target = path.resolve(destDir, rel);
    if (!target.startsWith(destDir + path.sep)) continue; // traversal guard

    // local file header -> data offset
    if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error("corrupt zip (local header)");
    const nameLen = buf.readUInt16LE(e.lho + 26);
    const extraLen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.csize);

    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${e.method}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++; bytes += data.length;
  }
  if (!files) throw new Error("zip contained no files");
  return { files, bytes };
}

/* ---------------- GitHub fetch ---------------- */

function fetchUrl(url, headers, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) { reject(new Error("too many redirects")); return; }
    const req = https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(fetchUrl(new URL(res.headers.location, url).href, headers, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub responded ${res.statusCode} — check the repo name, branch, and (for private repos) the token`));
        return;
      }
      const chunks = []; let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_DEPLOY_MB * 1024 * 1024) { req.destroy(); reject(new Error("repo download too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("GitHub download timed out")); });
    req.on("error", reject);
  });
}

function parseRepo(input) {
  let s = String(input || "").trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function downloadRepoZip(repo, branch, token) {
  const ref = branch ? `/${encodeURIComponent(branch)}` : "";
  const url = `https://api.github.com/repos/${repo}/zipball${ref}`;
  const headers = { "User-Agent": "vdkify", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetchUrl(url, headers, 5);
}

/* ---------------- deploys ---------------- */

function siteDir(name) { return path.join(SITES_DIR, name); }
function deployDir(name, id) { return path.join(siteDir(name), id); }

function newDeployId() {
  return Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
}

function activateDeploy(site, id, source, files, bytes, meta) {
  db.prepare("INSERT INTO deploys (id, site, created_at, source, files, bytes, meta, status) VALUES (?,?,?,?,?,?,?,'ready')")
    .run(id, site, Date.now(), source, files, bytes, meta ? JSON.stringify(meta) : null);
  db.prepare("UPDATE sites SET active_deploy=? WHERE name=?").run(id, site);
  // prune old READY deploys beyond KEEP_DEPLOYS (failed rows are just log lines)
  const old = db.prepare(
    "SELECT id FROM deploys WHERE site=? AND status='ready' ORDER BY created_at DESC LIMIT -1 OFFSET ?"
  ).all(site, KEEP_DEPLOYS);
  for (const r of old) {
    db.prepare("DELETE FROM deploys WHERE id=?").run(r.id);
    fs.rmSync(deployDir(site, r.id), { recursive: true, force: true });
  }
  db.prepare("DELETE FROM deploys WHERE site=? AND status='failed' AND created_at < ?")
    .run(site, Date.now() - 30 * 86400000);
}

// every deploy attempt is visible in the feed — including the ones that fail
function recordFailedDeploy(site, id, source, meta, error) {
  db.prepare("INSERT INTO deploys (id, site, created_at, source, files, bytes, meta, status, error) VALUES (?,?,?,?,0,0,?,'failed',?)")
    .run(id, site, Date.now(), source, meta ? JSON.stringify(meta) : null, String(error).slice(0, 500));
}

function writeJsonFiles(site, id, list) {
  const dest = deployDir(site, id);
  let files = 0, bytes = 0;
  for (const f of list) {
    if (!f || typeof f.path !== "string" || typeof f.b64 !== "string") throw new Error("bad file entry");
    const rel = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || rel.length > 512) throw new Error("bad file path");
    const target = path.resolve(dest, rel);
    if (!target.startsWith(dest + path.sep)) throw new Error("path escapes deploy root");
    const data = Buffer.from(f.b64, "base64");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++; bytes += data.length;
  }
  if (!files) throw new Error("no files in deploy");
  return { files, bytes };
}

async function deployFromGitHub(siteRow) {
  if (!siteRow.repo) throw new Error("no GitHub repo connected to this site");
  const meta = { repo: siteRow.repo, branch: siteRow.branch || "(default)" };
  const id = newDeployId();
  const dest = deployDir(siteRow.name, id);
  try {
    const zip = await downloadRepoZip(siteRow.repo, siteRow.branch || "", siteRow.gh_token || "");
    fs.mkdirSync(dest, { recursive: true });
    const { files, bytes } = extractZip(zip, dest);
    activateDeploy(siteRow.name, id, "github", files, bytes, meta);
    return { id, files, bytes };
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    recordFailedDeploy(siteRow.name, id, "github", meta, e.message);
    throw e;
  }
}

/* ---------------- public tunnel (Go public — like Netlify, instantly) ----------------
   Spawns `ssh -R 80:localhost:PORT nokey@localhost.run` — a free public
   tunnel that needs no account and no installs (OpenSSH ships with
   Windows 10+ and every Pi). All sites are reachable through it via
   their /s/<name>/ path routes. */

const tunnel = { proc: null, url: null, status: "off", error: null, startedAt: 0 };

function startTunnel() {
  if (tunnel.proc) return;
  tunnel.url = null; tunnel.error = null; tunnel.status = "starting"; tunnel.startedAt = Date.now();
  let proc;
  try {
    proc = spawn("ssh", [
      "-T",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ServerAliveInterval=30",
      "-o", "ExitOnForwardFailure=yes",
      "-R", "80:localhost:" + PORT,
      "nokey@localhost.run"
    ], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    tunnel.status = "error"; tunnel.error = e.message; return;
  }
  tunnel.proc = proc;
  const onData = (b) => {
    if (tunnel.status !== "starting") return;
    // The banner is full of unrelated links (openssh.com, admin.localhost.run).
    // The real tunnel address is on the line "…tunneled with tls termination,
    // https://<id>.lhr.life" — prefer that line, fall back to any *.lhr.life.
    for (const line of b.toString().split(/\r?\n/)) {
      let m = /tunneled/i.test(line) ? line.match(/https:\/\/[a-z0-9][a-z0-9.-]+/i) : null;
      if (!m) m = line.match(/https:\/\/[a-z0-9][a-z0-9-]*\.lhr\.life/i);
      if (m) { tunnel.url = m[0]; tunnel.status = "on"; break; }
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("error", (e) => {
    tunnel.proc = null; tunnel.status = "error"; tunnel.url = null;
    tunnel.error = e.code === "ENOENT"
      ? "ssh not found — install the OpenSSH client (built into Windows 10+ and Raspberry Pi OS)"
      : e.message;
  });
  proc.on("exit", (code) => {
    const wasOn = tunnel.status === "on";
    tunnel.proc = null; tunnel.url = null;
    if (tunnel.status !== "error") {
      tunnel.status = wasOn ? "off" : "error";
      if (!wasOn) tunnel.error = `tunnel exited (code ${code}) — is outbound SSH (port 22) allowed on your network?`;
    }
  });
}

function stopTunnel() {
  if (tunnel.proc) { try { tunnel.proc.kill(); } catch { /* already dead */ } }
  tunnel.proc = null; tunnel.url = null; tunnel.status = "off"; tunnel.error = null;
}

process.on("exit", () => { if (tunnel.proc) { try { tunnel.proc.kill(); } catch { /* noop */ } } });

function tunnelInfo() {
  return { status: tunnel.status, url: tunnel.url, error: tunnel.error };
}

/* ---------------- per-site env vars ---------------- */
// Stored per site; served to the deployed app at /__env.js (window.ENV)
// and /__env.json so static sites get runtime config without rebuilds.

const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function siteEnv(row) {
  try { return row.env ? JSON.parse(row.env) : {}; } catch { return {}; }
}

function validateEnv(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("env must be an object of key/value strings");
  const out = {};
  const keys = Object.keys(obj);
  if (keys.length > 100) throw new Error("too many env vars (max 100)");
  let total = 0;
  for (const k of keys) {
    if (!VALID_ENV_KEY.test(k)) throw new Error(`bad env key "${k}" — letters, digits, underscores; can't start with a digit`);
    const v = String(obj[k] ?? "");
    total += k.length + v.length;
    if (total > 32 * 1024) throw new Error("env too large (32 KB max)");
    out[k] = v;
  }
  return out;
}

function siteUrls(name) {
  const hidePort =
    PUBLIC_PORT === "" ||
    (PUBLIC_SCHEME === "http" && PUBLIC_PORT === "80") ||
    (PUBLIC_SCHEME === "https" && PUBLIC_PORT === "443");
  const portPart = hidePort ? "" : `:${PUBLIC_PORT}`;
  return {
    domain: `${PUBLIC_SCHEME}://${name}.${BASE_DOMAIN}${portPart}/`,
    path: `/s/${name}/`,
    public: tunnel.url ? `${tunnel.url}/s/${name}/` : null
  };
}

function deployInfo(d, activeId) {
  return d ? {
    id: d.id, at: d.created_at, source: d.source, status: d.status,
    files: d.files, bytes: d.bytes, error: d.error || null,
    meta: d.meta ? JSON.parse(d.meta) : null,
    active: d.id === activeId
  } : null;
}

function siteInfo(row) {
  const deploys = db.prepare("SELECT COUNT(*) AS n FROM deploys WHERE site=?").get(row.name).n;
  const active = row.active_deploy
    ? db.prepare("SELECT * FROM deploys WHERE id=?").get(row.active_deploy) : null;
  const last = db.prepare("SELECT * FROM deploys WHERE site=? ORDER BY created_at DESC LIMIT 1").get(row.name);
  return {
    name: row.name, createdAt: row.created_at,
    repo: row.repo || null, branch: row.branch || null, hasToken: !!row.gh_token,
    urls: siteUrls(row.name),
    envCount: Object.keys(siteEnv(row)).length,
    deploys,
    active: deployInfo(active, row.active_deploy),
    lastDeploy: deployInfo(last, row.active_deploy)
  };
}

/* ---------------- api ---------------- */

async function handleApi(req, res, url) {
  const route = req.method + " " + url.pathname;

  if (route === "GET /api/status") {
    return sendJson(res, 200, {
      needsSetup: !getSetting("pw_hash"),
      baseDomain: BASE_DOMAIN, port: PORT
    });
  }

  if (route === "POST /api/setup") {
    if (getSetting("pw_hash")) return sendJson(res, 403, { error: "Already set up — sign in instead." });
    const { password } = await readJson(req, 64 * 1024);
    if (typeof password !== "string" || password.length < 10) {
      return sendJson(res, 400, { error: "Password must be at least 10 characters." });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    setSetting("pw_salt", salt);
    setSetting("pw_hash", hashPassword(password, salt));
    return sendJson(res, 200, { ok: true, token: createSession() });
  }

  if (route === "POST /api/login") {
    const ip = ipOf(req);
    const wait = lockedFor(ip);
    if (wait) return sendJson(res, 429, { error: `Too many attempts — try again in ${wait}s.` }, { "Retry-After": String(wait) });
    const { password } = await readJson(req, 64 * 1024);
    if (!checkPassword(password)) { loginFail(ip); return sendJson(res, 401, { error: "Wrong password." }); }
    loginGuard.delete(ip);
    return sendJson(res, 200, { ok: true, token: createSession() });
  }

  if (route === "POST /api/logout") {
    const m = (req.headers.authorization || "").match(/^Bearer ([a-f0-9]{64})$/);
    if (m) db.prepare("DELETE FROM sessions WHERE token=?").run(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (route === "GET /api/session") {
    return authed(req) ? sendJson(res, 200, { ok: true }) : sendJson(res, 401, { error: "Not signed in." });
  }

  /* ----- everything below needs auth ----- */
  if (!authed(req)) return sendJson(res, 401, { error: "Not signed in." });

  if (route === "GET /api/sites") {
    const rows = db.prepare("SELECT * FROM sites ORDER BY created_at DESC").all();
    return sendJson(res, 200, {
      sites: rows.map(siteInfo), baseDomain: BASE_DOMAIN, port: PORT,
      tunnel: tunnelInfo()
    });
  }

  if (route === "GET /api/tunnel") {
    return sendJson(res, 200, tunnelInfo());
  }

  if (route === "POST /api/tunnel") {
    const { action } = await readJson(req, 4096);
    if (action === "start") startTunnel();
    else if (action === "stop") stopTunnel();
    else return sendJson(res, 400, { error: "action must be start or stop" });
    return sendJson(res, 200, tunnelInfo());
  }

  if (route === "GET /api/activity") {
    const rows = db.prepare("SELECT * FROM deploys ORDER BY created_at DESC LIMIT 25").all();
    const actives = new Map(db.prepare("SELECT name, active_deploy FROM sites").all()
      .map((r) => [r.name, r.active_deploy]));
    return sendJson(res, 200, {
      activity: rows.map((d) => Object.assign({ site: d.site }, deployInfo(d, actives.get(d.site))))
    });
  }

  if (route === "POST /api/sites") {
    const body = await readJson(req, 64 * 1024);
    const name = String(body.name || "").trim().toLowerCase();
    if (!VALID_SITE.test(name)) return sendJson(res, 400, { error: "Site name: 1–40 chars, a–z, 0–9, hyphens (not at ends)." });
    if (RESERVED.has(name)) return sendJson(res, 400, { error: `"${name}" is reserved — pick another name.` });
    if (db.prepare("SELECT 1 FROM sites WHERE name=?").get(name)) {
      return sendJson(res, 409, { error: "That site name is taken." });
    }
    let repo = null;
    if (body.repo) {
      repo = parseRepo(body.repo);
      if (!repo) return sendJson(res, 400, { error: "Repo should look like owner/repo or a github.com URL." });
    }
    db.prepare("INSERT INTO sites (name, created_at, repo, branch, gh_token) VALUES (?,?,?,?,?)")
      .run(name, Date.now(), repo, String(body.branch || "").trim() || null, String(body.token || "").trim() || null);
    const row = db.prepare("SELECT * FROM sites WHERE name=?").get(name);

    if (repo) {
      try {
        const d = await deployFromGitHub(row);
        return sendJson(res, 200, { ok: true, site: siteInfo(db.prepare("SELECT * FROM sites WHERE name=?").get(name)), deployed: d });
      } catch (e) {
        return sendJson(res, 200, {
          ok: true, site: siteInfo(row),
          warning: `Site created, but the GitHub deploy failed: ${e.message}`
        });
      }
    }
    return sendJson(res, 200, { ok: true, site: siteInfo(row) });
  }

  // routes with a site name: /api/sites/<name>/...
  const m = url.pathname.match(/^\/api\/sites\/([a-z0-9-]{1,40})(\/[a-z]+)?$/);
  if (m) {
    const name = m[1], sub = m[2] || "";
    const row = db.prepare("SELECT * FROM sites WHERE name=?").get(name);
    if (!row) return sendJson(res, 404, { error: "No such site." });

    if (req.method === "DELETE" && !sub) {
      db.prepare("DELETE FROM deploys WHERE site=?").run(name);
      db.prepare("DELETE FROM sites WHERE name=?").run(name);
      fs.rmSync(siteDir(name), { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && sub === "/deploy") {
      const ct = String(req.headers["content-type"] || "");
      const id = newDeployId();
      const dest = deployDir(name, id);
      fs.mkdirSync(dest, { recursive: true });
      const source = (ct.includes("application/zip") || ct.includes("application/octet-stream")) ? "zip" : "upload";
      try {
        let files, bytes;
        if (source === "zip") {
          const buf = await readBody(req);
          ({ files, bytes } = extractZip(buf, dest));
        } else {
          const body = await readJson(req);
          if (!Array.isArray(body.files)) throw new Error("expected { files: [{path, b64}] }");
          ({ files, bytes } = writeJsonFiles(name, id, body.files));
        }
        activateDeploy(name, id, source, files, bytes, null);
        return sendJson(res, 200, { ok: true, id, files, bytes, urls: siteUrls(name) });
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true });
        recordFailedDeploy(name, id, source, null, e.message);
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.method === "POST" && sub === "/github") {
      const body = await readJson(req, 64 * 1024);
      if (body.repo !== undefined) {
        const repo = body.repo ? parseRepo(body.repo) : null;
        if (body.repo && !repo) return sendJson(res, 400, { error: "Repo should look like owner/repo or a github.com URL." });
        db.prepare("UPDATE sites SET repo=?, branch=?, gh_token=? WHERE name=?")
          .run(repo, String(body.branch || "").trim() || null, String(body.token || "").trim() || (repo === row.repo ? row.gh_token : null), name);
      }
      const fresh = db.prepare("SELECT * FROM sites WHERE name=?").get(name);
      try {
        const d = await deployFromGitHub(fresh);
        return sendJson(res, 200, { ok: true, ...d, urls: siteUrls(name) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.method === "GET" && sub === "/deploys") {
      const rows = db.prepare("SELECT * FROM deploys WHERE site=? ORDER BY created_at DESC").all(name);
      return sendJson(res, 200, {
        active: row.active_deploy,
        deploys: rows.map((d) => deployInfo(d, row.active_deploy))
      });
    }

    if (req.method === "GET" && sub === "/env") {
      return sendJson(res, 200, { env: siteEnv(row) });
    }

    if ((req.method === "PUT" || req.method === "POST") && sub === "/env") {
      const body = await readJson(req, 64 * 1024);
      let env;
      try { env = validateEnv(body.env); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      db.prepare("UPDATE sites SET env=? WHERE name=?").run(JSON.stringify(env), name);
      return sendJson(res, 200, { ok: true, count: Object.keys(env).length });
    }

    if (req.method === "POST" && sub === "/rollback") {
      const body = await readJson(req, 64 * 1024);
      const dep = db.prepare("SELECT * FROM deploys WHERE id=? AND site=? AND status='ready'").get(String(body.id || ""), name);
      if (!dep) return sendJson(res, 404, { error: "No such successful deploy for this site." });
      db.prepare("UPDATE sites SET active_deploy=? WHERE name=?").run(dep.id, name);
      return sendJson(res, 200, { ok: true, id: dep.id });
    }
  }

  return sendJson(res, 404, { error: "No such API route." });
}

/* ---------------- static file serving ---------------- */

function serveFile(res, file, cacheable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { notFound(res); return; }
    res.writeHead(200, Object.assign({
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": cacheable ? "public, max-age=60" : "no-cache"
    }, securityHeaders()));
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res, msg) {
  res.writeHead(404, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, securityHeaders()));
  res.end(`<!DOCTYPE html><meta charset="utf-8"><title>404</title>
<body style="font-family:system-ui;background:#0d0d0d;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:42px">404</div>
<div style="color:#898781">${msg || "Not found"}</div></div>`);
}

// serve a deployed site rooted at dir
function serveSite(req, res, dir, pathname, env) {
  // runtime env vars for the deployed app: window.ENV via /__env.js
  if (pathname === "/__env.js" || pathname === "/__env.json") {
    const json = JSON.stringify(env || {});
    const isJs = pathname.endsWith(".js");
    res.writeHead(200, Object.assign({
      "Content-Type": isJs ? "text/javascript; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-cache"
    }, securityHeaders()));
    res.end(isJs ? `window.ENV = Object.freeze(${json});` : json);
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const target = path.resolve(dir, "." + rel);
  if (target !== dir && !target.startsWith(dir + path.sep)) { notFound(res); return; }
  fs.stat(target, (err, st) => {
    if (!err && st.isDirectory()) {
      // redirect dir -> dir/ so relative links resolve
      res.writeHead(301, { Location: pathname + "/" }); res.end(); return;
    }
    if (!err && st.isFile()) { serveFile(res, target, true); return; }
    // SPA fallback: extensionless miss -> site's own index.html
    if (!path.extname(rel)) {
      const idx = path.join(dir, "index.html");
      if (fs.existsSync(idx)) { serveFile(res, idx, true); return; }
    }
    notFound(res, "This file doesn't exist in the current deploy.");
  });
}

function siteRootFor(name) {
  const row = db.prepare("SELECT * FROM sites WHERE name=?").get(name);
  if (!row || !row.active_deploy) return null;
  const dir = deployDir(name, row.active_deploy);
  return fs.existsSync(dir) ? { dir, env: siteEnv(row) } : null;
}

/* ---------------- request routing ---------------- */

const UI_DIR = path.join(ROOT, "ui");

function requestHandler(req, res) {
  const url = new URL(req.url, "http://x");
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");

  // 1) subdomain of BASE_DOMAIN -> serve that site
  if (host !== BASE_DOMAIN && host.endsWith("." + BASE_DOMAIN)) {
    const name = host.slice(0, -(BASE_DOMAIN.length + 1));
    if (VALID_SITE.test(name)) {
      const root = siteRootFor(name);
      if (root) { serveSite(req, res, root.dir, url.pathname, root.env); return; }
      notFound(res, `No site is deployed at <b>${name}.${BASE_DOMAIN}</b> yet.`);
      return;
    }
  }

  // 2) path route /s/<name>/... (works on any host, e.g. raw IP)
  const sm = url.pathname.match(/^\/s\/([a-z0-9-]{1,40})(\/.*)?$/);
  if (sm) {
    if (!sm[2]) { res.writeHead(301, { Location: `/s/${sm[1]}/` }); res.end(); return; }
    const root = siteRootFor(sm[1]);
    if (root) { serveSite(req, res, root.dir, sm[2], root.env); return; }
    notFound(res, `No site is deployed at <b>/s/${sm[1]}/</b> yet.`);
    return;
  }

  // 3) API + dashboard on the base host
  if (url.pathname.startsWith("/api/")) {
    Promise.resolve(handleApi(req, res, url)).catch((e) => sendJson(res, 400, { error: e.message || "Bad request." }));
    return;
  }
  if (req.method !== "GET") { res.writeHead(405, securityHeaders()); res.end(); return; }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.resolve(UI_DIR, "." + rel);
  if (!file.startsWith(UI_DIR + path.sep)) { res.writeHead(403, securityHeaders()); res.end("Forbidden"); return; }
  serveFile(res, file, false);
}

http.createServer(requestHandler).listen(PORT, () => {
  const n = db.prepare("SELECT COUNT(*) AS n FROM sites").get().n;
  console.log(`vdkify running at http://${BASE_DOMAIN}:${PORT}`);
  console.log(`  sites: ${n} · data: ${DATA_DIR}`);
  console.log(`  every site gets  http://<name>.${BASE_DOMAIN}:${PORT}/  (plus /s/<name>/)`);
  if (!getSetting("pw_hash")) console.log("  first visit will ask you to set the admin password");
});
