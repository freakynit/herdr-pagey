#!/usr/bin/env node
// Pagey Site plugin CLI for Herdr.
//
// Publishes static sites to https://pagey.site from inside Herdr — from a
// keybound action, a plugin pane, or straight from an agent pane.
// Node 18+, zero dependencies.
//
// Token lookup order:
//   1. --token flag
//   2. PAGEY_API_TOKEN env var
//   3. HERDR_PLUGIN_CONFIG_DIR/.env  (written by `pagey.mjs setup`)
//   4. ./.env next to this file (local-dev fallback, never commit a token)
//
// State (last published site) lives in HERDR_PLUGIN_STATE_DIR/last-site.json,
// with an XDG/state-home fallback for local runs.

import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DEFAULT = "https://pagey.site/api";
const API = process.env.PAGEY_API_URL?.trim() || API_DEFAULT;
if (API !== API_DEFAULT && !/^http:\/\/127\.0\.0\.1:[0-9]+\/api$/u.test(API)) {
  console.error("Invalid Pagey API address. Only https://pagey.site/api or a loopback URL is accepted.");
  process.exit(1);
}

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

// Hidden paths, dependency folders, databases, source maps, key material.
const BLOCKED_RE = /(^|\/)(\.[^/]+|node_modules|vendor|coverage|__MACOSX)(\/|$)|\.(pem|key|p12|pfx|sqlite|sqlite3|db|map)$/iu;
// Private keys + common token prefixes. A generic password scan would false-positive
// on demo content, so this stays narrow; review build output before publishing.
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY|(?:ghp_|github_pat_|sk-(?:live|test|proj)-|xox[bpas]-)[A-Za-z0-9_-]{8,}/u;

class PageyError extends Error {}

const fail = (message) => {
  throw new PageyError(message);
};

// ---------------------------------------------------------------------------
// tiny .env loader (HERDR_PLUGIN_CONFIG_DIR first, local fallback last)
// ---------------------------------------------------------------------------
function loadDotEnvFile(path) {
  let content;
  try {
    content = BunSafeRead(path);
  } catch {
    return;
  }
  if (content === undefined) return;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

// sync read helper without extra imports
import { readFileSync as _readFileSync, existsSync as _existsSync } from "node:fs";
function BunSafeRead(path) {
  try {
    return _readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
  loadDotEnvFile(join(process.env.HERDR_PLUGIN_CONFIG_DIR, ".env"));
}
loadDotEnvFile(join(HERE, ".env"));

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flag(flags, ...names) {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name];
  }
  return undefined;
}

function boolFlag(flags, ...names) {
  const value = flag(flags, ...names);
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// token / state
// ---------------------------------------------------------------------------
function getToken(flags) {
  const fromFlag = flag(flags, "token");
  if (typeof fromFlag === "string" && fromFlag.trim()) return fromFlag.trim();
  const fromEnv = process.env.PAGEY_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return "";
}

function requireToken(flags) {
  const token = getToken(flags);
  if (!token) {
    fail(
      "No Pagey API token. Run `pagey setup` (or the Herdr action “Pagey: Set API token”), " +
        "paste a token from https://pagey.site/dashboard/api-tokens, or set PAGEY_API_TOKEN.",
    );
  }
  return token;
}

function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || HERE;
  const base = process.env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(base, "herdr-pagey");
}

function configDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || HERE;
  const base = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "herdr", "plugins", "pagey.publish");
}

async function readLastSite() {
  try {
    const raw = await readFile(join(stateDir(), "last-site.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLastSite(site) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "last-site.json"),
    JSON.stringify({ id: site.id, url: site.url, subdomain: site.subdomain, savedAt: new Date().toISOString() }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// herdr context (workspace cwd for publish-auto)
// ---------------------------------------------------------------------------
function herdrContext() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function contextCwd() {
  const ctx = herdrContext();
  return ctx.focused_pane_cwd || ctx.workspace_cwd || process.cwd();
}

// ---------------------------------------------------------------------------
// output helpers (token is never printed; redact if it leaks via API echo)
// ---------------------------------------------------------------------------
let ACTIVE_TOKEN = "";
function redact(text) {
  let out = String(text);
  if (ACTIVE_TOKEN) out = out.split(ACTIVE_TOKEN).join("[REDACTED]");
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED]")
    .replace(/(?:ghp_|github_pat_|sk-(?:live|test|proj)-|xox[bpas]-)[A-Za-z0-9_-]{8,}/gu, "[REDACTED]");
}

function print(text) {
  process.stdout.write(`${redact(text)}\n`);
}

function printJson(value) {
  process.stdout.write(`${redact(JSON.stringify(value, null, 2))}\n`);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

// Keep only safe site fields: never surface passwords, tokens, or storage paths.
function pickSite(value) {
  if (!value || typeof value.id !== "string" || !/^[a-z0-9-]{1,63}$/u.test(value.subdomain ?? "")) {
    fail("Invalid site response from Pagey.");
  }
  const site = { id: value.id, url: `https://${value.subdomain}.pagey.site` };
  for (const key of [
    "subdomain",
    "title",
    "status",
    "isPasswordProtected",
    "maintenanceMode",
    "expiresAt",
    "contentRevision",
    "createdAt",
    "updatedAt",
    "lastPublishedAt",
    "tags",
  ]) {
    if (value[key] !== undefined) site[key] = value[key];
  }
  return site;
}

function showSite(site) {
  print(`id:         ${site.id}`);
  print(`url:        ${site.url}`);
  if (site.title !== undefined) print(`title:      ${site.title ?? "(none)"}`);
  if (site.status !== undefined) print(`status:     ${site.status}`);
  if (site.isPasswordProtected !== undefined) print(`password:   ${site.isPasswordProtected ? "protected" : "public"}`);
  if (site.maintenanceMode !== undefined) print(`maintenance:${site.maintenanceMode ? " ON" : " off"}`);
  if (site.expiresAt !== undefined) print(`expires:    ${site.expiresAt ?? "never"}`);
  if (site.tags !== undefined) print(`tags:       ${Array.isArray(site.tags) && site.tags.length ? site.tags.join(", ") : "(none)"}`);
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
async function apiRequest(token, method, route, body) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let response;
  try {
    response = await fetch(API + route, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof PageyError) throw error;
    fail(`Could not reach Pagey (${error?.name === "TimeoutError" ? "request timed out after 60s" : "network error"}). Before retrying, run \`pagey list\` — the operation may already have completed.`);
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      fail(`Pagey refused the request (HTTP ${response.status}). Check the API token with \`pagey whoami\`. A timeout response can still have completed server-side — run \`pagey list\` before retrying.`);
    }
    if (response.status === 429) {
      fail("Pagey rate limit or quota reached (HTTP 429). Wait before retrying; daily site-creation allowances reset at midnight UTC.");
    }
    if (response.status === 409) fail("Pagey reported a conflict (HTTP 409) — the subdomain or email is already in use.");
    if (response.status === 410) fail("That site has expired or the form no longer accepts responses (HTTP 410).");
    fail(`Pagey returned HTTP ${response.status}. A failed upload response can have an unknown outcome — check \`pagey list\` before uploading again.`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response;
}

// ---------------------------------------------------------------------------
// packaging: scan a folder / html / zip, enforce safety limits, repack
// ---------------------------------------------------------------------------
function crc32(buffer) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crc32.table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    header.writeUInt16LE(0, 28);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    header.copy(centralHeader, 6, 4, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt32LE(offset, 42);
    chunks.push(header, filename, compressed);
    central.push(centralHeader, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

// Validate a ZIP's central directory, then repack it (drops links / extras).
function parseZip(data) {
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < data.length - 65557 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) {
    fail("Unsupported ZIP archive (multi-disk or with a comment block).");
  }
  const count = data.readUInt16LE(end + 10);
  if (count > MAX_FILES) fail("The archive has too many files (limit 1000).");
  const files = [];
  const names = new Set();
  let position = data.readUInt32LE(end + 16);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50) fail("Invalid ZIP archive.");
    const flags = data.readUInt16LE(position + 8);
    const method = data.readUInt16LE(position + 10);
    const size = data.readUInt32LE(position + 24);
    const length = data.readUInt16LE(position + 28);
    const extra = data.readUInt16LE(position + 30);
    const comment = data.readUInt16LE(position + 32);
    const mode = data.readUInt32LE(position + 38) >>> 16;
    const name = data.subarray(position + 46, position + 46 + length).toString("utf8");
    if (flags & 1 || ![0, 8].includes(method) || (mode & 0o170000) === 0o120000) {
      fail("Encrypted files, symlinks, and this ZIP method are not supported.");
    }
    if (position + 46 + length + extra + comment > end) fail("Invalid ZIP entry.");
    if (!name.endsWith("/")) {
      total += size;
      if (total > MAX_BYTES || names.has(name)) fail("The archive is too large or has duplicate paths.");
      const local = data.readUInt32LE(position + 42);
      if (local + 30 > position || data.readUInt32LE(local) !== 0x04034b50) fail("Invalid ZIP file header.");
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      const finish = start + data.readUInt32LE(position + 20);
      if (finish > position) fail("Invalid ZIP file size.");
      const raw = data.subarray(start, finish);
      const content = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) : raw;
      if (content.length !== size || crc32(content) !== data.readUInt32LE(position + 16)) {
        fail("Invalid ZIP file content (checksum mismatch).");
      }
      checkAsset(name, content);
      names.add(name);
      files.push([name, content]);
    }
    position += 46 + length + extra + comment;
  }
  return files;
}

function checkAsset(name, data) {
  if (
    !name ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === ".." || part === "." || !part) ||
    /^[A-Za-z]:/u.test(name) ||
    BLOCKED_RE.test(name)
  ) {
    fail(
      `Rejected "${name}": hidden files, source maps, databases, dependency folders, or secret files are not uploaded. Publish a clean static build folder.`,
    );
  }
  const text = data.toString("utf8");
  if ((ACTIVE_TOKEN && text.includes(ACTIVE_TOKEN)) || SECRET_RE.test(text)) {
    fail(`Rejected "${name}": it looks like it contains a credential. Remove secrets before publishing.`);
  }
}

async function readAsset(file, root) {
  const resolved = await realpath(file);
  const local = relative(root, resolved);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    fail("A file escapes the selected folder. Publish files inside the build folder.");
  }
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) fail("The upload exceeds the file limit.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Returns { data (zip), digest, files:[{path,bytes}], bytes }
async function prepareUpload(input) {
  if (!isAbsolute(input)) fail("Use an absolute path to a build folder, HTML file, or ZIP archive.");
  const source = resolve(input);
  let stat;
  try {
    stat = await lstat(source);
  } catch {
    fail(`Path not found: ${source}`);
  }
  if (stat.isSymbolicLink()) fail("Select a real file or folder, not a symlink.");
  const files = [];
  let total = 0;
  const add = (name, data) => {
    checkAsset(name, data);
    total += data.length;
    if (files.length >= MAX_FILES || total > MAX_BYTES) {
      fail("Use at most 1000 files and 50 MiB of build output.");
    }
    files.push([name, data]);
  };
  if (stat.isDirectory()) {
    const root = await realpath(source);
    const walk = async (folder, prefix = "") => {
      const entries = await readdir(folder, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const name = prefix + entry.name;
        if (BLOCKED_RE.test(name)) {
          fail(`Rejected "${name}": hidden files or build inputs. Select a clean static build folder.`);
        }
        if (entry.isSymbolicLink()) fail("The upload contains a symlink. Use files inside the build folder.");
        if (entry.isDirectory()) await walk(join(folder, entry.name), `${name}/`);
        else if (entry.isFile()) add(name, await readAsset(join(folder, entry.name), root));
        else fail("The upload contains a special file.");
      }
    };
    await walk(root);
  } else if (stat.isFile()) {
    if (BLOCKED_RE.test(basename(source))) fail("Select a public HTML file or ZIP archive, not a hidden file.");
    const data = await readAsset(source, await realpath(join(source, "..")));
    if (extname(source).toLowerCase() === ".zip") {
      for (const [name, content] of parseZip(data)) add(name, content);
    } else if (extname(source).toLowerCase() === ".html" || extname(source).toLowerCase() === ".htm") {
      add("index.html", data);
    } else {
      fail("Select an HTML file, a ZIP archive, or a static build folder.");
    }
  } else {
    fail("Select a file or folder.");
  }
  if (!files.some(([name]) => name === "index.html")) {
    fail("The upload needs index.html at its root.");
  }
  files.sort(([a], [b]) => a.localeCompare(b));
  const data = buildZip(files);
  if (data.length > MAX_BYTES) fail("The ZIP exceeds 50 MiB.");
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(data).digest("hex");
  return { data, digest, files: files.map(([name, content]) => ({ path: name, bytes: content.length })), bytes: total };
}

function showPreview(prepared) {
  print(`files: ${prepared.files.length}   total: ${fmtBytes(prepared.bytes)}`);
  const shown = prepared.files.slice(0, 25);
  for (const file of shown) print(`  ${file.path} (${fmtBytes(file.bytes)})`);
  if (prepared.files.length > shown.length) print(`  … and ${prepared.files.length - shown.length} more`);
  print(`digest: ${prepared.digest}`);
}

async function confirm(promptText, flags) {
  if (boolFlag(flags, "yes", "y")) return true;
  if (!process.stdin.isTTY) {
    fail("Refusing without confirmation: re-run with --yes in non-interactive use.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${promptText} [y/N] `, resolve));
    return /^[yY](es)?\s*$/.test(answer.trim());
  } finally {
    rl.close();
  }
}

function validateUuid(value, label = "ID") {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value ?? "")) fail(`Invalid ${label}: ${value}`);
  return value;
}

function validateFutureDate(value, label = "date") {
  if (value == null) return value;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= Date.now()) fail(`Invalid ${label}: use a future ISO timestamp.`);
  return new Date(time).toISOString();
}

function requireSiteId(positional, flags, slot = 0) {
  const direct = positional[slot] ?? flag(flags, "site", "site-id", "id");
  if (direct) return validateUuid(String(direct), "site ID");
  return null;
}

async function resolveSiteId(positional, flags, slot = 0) {
  const direct = requireSiteId(positional, flags, slot);
  if (direct) return direct;
  const last = await readLastSite();
  if (last?.id) {
    print(`using last published site ${last.id} (${last.url})`);
    return last.id;
  }
  fail("No site ID given and no last-published site remembered. Pass a site ID from `pagey list`.");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdSetup(flags) {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  let token = flag(flags, "token");
  if (typeof token !== "string" || !token.trim()) {
    if (!process.stdin.isTTY) {
      fail("No --token given and stdin is not a terminal. Re-run with `pagey setup --token <token>` or set PAGEY_API_TOKEN.");
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      token = await new Promise((resolve) => rl.question("Paste your Pagey API token (https://pagey.site/dashboard/api-tokens): ", resolve));
    } finally {
      rl.close();
    }
  }
  token = String(token).trim();
  if (!token) fail("Empty token — nothing saved.");
  const path = join(dir, ".env");
  await writeFile(path, `# Pagey Site token for the Herdr plugin.\n# Created by \`pagey setup\`. Keep this file private.\nPAGEY_API_TOKEN=${token}\n`, { mode: 0o600 });
  print(`Saved token to ${path}`);
  ACTIVE_TOKEN = token;
  const me = await apiRequest(token, "GET", "/auth/me");
  print(`Connected as ${me.user?.email ?? "(unknown)"} — token works.`);
}

async function cmdWhoami(flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const me = await apiRequest(token, "GET", "/auth/me");
  if (boolFlag(flags, "json")) return printJson(me);
  const user = me.user ?? {};
  print(`email:    ${user.email ?? "(unknown)"}`);
  print(`tier:     ${user.tier ?? "(unknown)"}`);
  print(`verified: ${user.isEmailVerified ?? user.is_email_verified ?? "(unknown)"}`);
}

async function cmdList(flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const query = new URLSearchParams();
  for (const key of ["page", "pageSize", "status", "search", "page-size"]) {
    const value = flag(flags, key);
    if (value !== undefined) query.set(key === "page-size" ? "pageSize" : key, String(value));
  }
  const result = await apiRequest(token, "GET", `/sites?${query}`);
  if (boolFlag(flags, "json")) return printJson(result);
  if (!result.items?.length) {
    print("No sites yet. Publish one with `pagey publish <folder>`.");
    return;
  }
  print(`showing ${result.items.length} of ${result.total} site(s):`);
  for (const raw of result.items) {
    const site = pickSite(raw);
    print(`- ${site.subdomain}  ${site.url}  [${site.id}]${site.title ? `  “${site.title}”` : ""}`);
  }
}

async function cmdGet(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const result = await apiRequest(token, "GET", `/sites/${id}`);
  const site = pickSite(result.site);
  if (boolFlag(flags, "json")) return printJson({ site });
  showSite(site);
}

async function doPublish(token, path, opts, flags) {
  const prepared = await prepareUpload(resolve(path));
  if (!boolFlag(flags, "json")) showPreview(prepared);
  if (opts.expectedDigest && prepared.digest !== opts.expectedDigest) {
    fail("Files changed after the preview. Run the preview/publish again on the current files.");
  }
  const ok = await confirm(`Publish ${prepared.files.length} file(s) (${fmtBytes(prepared.bytes)}) to Pagey?`, flags);
  if (!ok) fail("Cancelled — nothing uploaded.");
  const form = new FormData();
  form.set("file", new Blob([prepared.data], { type: "application/zip" }), "site.zip");
  for (const key of ["title", "password", "expiresAt", "customSubdomain"]) {
    if (opts[key] !== undefined) form.set(key, opts[key]);
  }
  const result = await apiRequest(token, "POST", opts.anonymous ? "/public/sites" : "/sites", form);
  const site = pickSite(result.site);
  if (!opts.anonymous) await writeLastSite(site);
  if (boolFlag(flags, "json")) return printJson({ site, files: prepared.files.length, bytes: prepared.bytes });
  print("");
  print(`Live at ${site.url}`);
  print(`id: ${site.id}`);
  if (!opts.anonymous) print("Remembered as the last-published site for `pagey update-last` / `pagey analytics-last`.");
  else print("Anonymous site: keep the URL — set a password at creation if you want to update it later.");
  return site;
}

async function cmdPublish(positional, flags) {
  const anonymous = boolFlag(flags, "anonymous");
  const token = anonymous ? "" : requireToken(flags);
  ACTIVE_TOKEN = token;
  const path = positional[0] ?? flag(flags, "path");
  if (!path) fail("Usage: pagey publish <folder|file.html|archive.zip> [--title T] [--subdomain S] [--expires-at ISO] [--password P] [--anonymous] [--yes]");
  const opts = { anonymous };
  const title = flag(flags, "title");
  if (title !== undefined) opts.title = String(title).slice(0, 255);
  const subdomain = flag(flags, "subdomain", "custom-subdomain", "customSubdomain");
  if (subdomain !== undefined) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(subdomain))) fail("Invalid subdomain: lowercase letters, numbers, hyphens, max 63 chars.");
    opts.customSubdomain = String(subdomain);
  }
  const expires = flag(flags, "expires-at", "expiresAt", "expires");
  if (expires !== undefined) opts.expiresAt = validateFutureDate(String(expires), "expiry");
  const password = flag(flags, "password");
  if (password !== undefined) {
    if (String(password).length < 6) fail("Password must be at least 6 characters.");
    opts.password = String(password);
  }
  const digest = flag(flags, "expected-digest", "expectedDigest", "digest");
  if (digest !== undefined) opts.expectedDigest = String(digest);
  await doPublish(token, path, opts, flags);
}

async function findBuildDir(base) {
  const candidates = ["dist", "out", "build", ".output/public", "public", "."];
  for (const candidate of candidates) {
    const dir = resolve(base, candidate);
    try {
      await lstat(join(dir, "index.html"));
      const stat = await lstat(dir);
      if (stat.isDirectory() || candidate === ".") return candidate === "." ? dir : dir;
    } catch {
      // try next
    }
  }
  return null;
}

async function cmdPublishAuto(flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const base = resolve(contextCwd());
  print(`workspace: ${base}`);
  const explicit = flag(flags, "path");
  let dir = explicit ? resolve(String(explicit)) : await findBuildDir(base);
  if (!dir) {
    fail("No build output found. Looked for dist/, out/, build/, .output/public/, public/, and ./ with index.html at its root. Pass a path explicitly.");
  }
  print(`build: ${dir}`);
  const opts = {};
  const title = flag(flags, "title");
  if (title !== undefined) opts.title = String(title).slice(0, 255);
  const subdomain = flag(flags, "subdomain", "custom-subdomain", "customSubdomain");
  if (subdomain !== undefined) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(subdomain))) fail("Invalid subdomain.");
    opts.customSubdomain = String(subdomain);
  }
  await doPublish(token, dir, opts, flags);
}

async function cmdUpdate(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags, 0);
  const pathIndex = positional[0] && /^[0-9a-f-]{36}$/iu.test(positional[0]) ? 1 : 0;
  const path = positional[pathIndex] ?? flag(flags, "path");
  if (!path) fail("Usage: pagey update <site-id> <folder|file.html|archive.zip> --confirm-replace [--yes]");
  if (!boolFlag(flags, "confirm-replace", "confirmReplace", "confirm")) {
    fail("Replacing content removes the site's current files. Re-run with --confirm-replace once the site owner approves.");
  }
  const prepared = await prepareUpload(resolve(String(path)));
  if (!boolFlag(flags, "json")) {
    print(`This REPLACES every file on ${id}. The address stays the same; old files are removed.`);
    showPreview(prepared);
  }
  const digest = flag(flags, "expected-digest", "expectedDigest", "digest");
  if (digest !== undefined && prepared.digest !== String(digest)) fail("Files changed after the preview. Preview again.");
  const ok = await confirm("Replace ALL site content?", flags);
  if (!ok) fail("Cancelled — nothing uploaded.");
  const form = new FormData();
  form.set("file", new Blob([prepared.data], { type: "application/zip" }), "site.zip");
  const result = await apiRequest(token, "PUT", `/sites/${id}/content`, form);
  const site = pickSite(result.site);
  await writeLastSite(site);
  if (boolFlag(flags, "json")) return printJson({ site });
  print(`Updated — still live at ${site.url}`);
}

async function cmdUpdateLast(positional, flags) {
  const last = await readLastSite();
  if (!last?.id) fail("No last-published site remembered. Publish first, or pass a site ID to `pagey update`.");
  await cmdUpdate([last.id, ...positional], flags);
}

async function cmdUpdateMeta(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const body = {};
  const title = flag(flags, "title");
  if (title !== undefined) body.title = title === "null" || boolFlag(flags, "clear-title") ? null : String(title);
  else if (boolFlag(flags, "clear-title")) body.title = null;
  const expires = flag(flags, "expires-at", "expiresAt", "expires");
  if (expires !== undefined) body.expiresAt = String(expires).toLowerCase() === "null" ? null : validateFutureDate(String(expires), "expiry");
  else if (boolFlag(flags, "clear-expiry", "remove-expiry")) body.expiresAt = null;
  const password = flag(flags, "password");
  if (password !== undefined) {
    const value = String(password);
    body.password = value === "" || value.toLowerCase() === "null" ? null : value;
    if (body.password && body.password.length < 6) fail("Password must be at least 6 characters.");
  } else if (boolFlag(flags, "clear-password", "remove-password")) body.password = null;
  if (Object.keys(body).length === 0) fail("Nothing to change. Use --title, --expires-at, --password, or a --clear-* flag.");
  const result = await apiRequest(token, "PATCH", `/sites/${id}`, body);
  const site = pickSite(result.site);
  if (boolFlag(flags, "json")) return printJson({ site });
  showSite(site);
}

async function cmdMaintenance(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  let enabled;
  if (boolFlag(flags, "on", "enable")) enabled = true;
  else if (boolFlag(flags, "off", "disable")) enabled = false;
  else fail("Usage: pagey maintenance <site-id> --on|--off");
  const result = await apiRequest(token, "PATCH", `/sites/${id}/maintenance`, { enabled });
  const site = pickSite(result.site);
  if (boolFlag(flags, "json")) return printJson({ site });
  print(enabled ? `Maintenance ON — visitors see a maintenance page at ${site.url}` : `Maintenance OFF — ${site.url} is public again.`);
}

async function cmdSubdomain(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const subdomain = positional[1] ?? flag(flags, "subdomain", "to");
  if (!subdomain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(subdomain))) {
    fail("Usage: pagey subdomain <site-id> <new-subdomain>");
  }
  const result = await apiRequest(token, "PATCH", `/sites/${id}/subdomain`, { subdomain: String(subdomain) });
  const site = pickSite(result.site);
  await writeLastSite(site);
  if (boolFlag(flags, "json")) return printJson({ site });
  print(`New address: ${site.url} (the old subdomain stops working immediately)`);
}

async function cmdTags(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const raw = positional[1] ?? flag(flags, "tags") ?? "";
  const tags = String(raw).split(",").map((t) => t.trim()).filter(Boolean).slice(0, 5);
  const result = await apiRequest(token, "PUT", `/sites/${id}/tags`, { tags });
  const site = pickSite(result.site);
  if (boolFlag(flags, "json")) return printJson({ site });
  print(`tags: ${site.tags?.length ? site.tags.join(", ") : "(none)"}`);
}

async function cmdDelete(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  if (!boolFlag(flags, "confirm")) fail("Deletion is one-way. Re-run with --confirm to soft-delete the site.");
  const ok = await confirm(`Delete site ${id}? This is one-way.`, flags);
  if (!ok) fail("Cancelled.");
  await apiRequest(token, "DELETE", `/sites/${id}`);
  print(`Deleted ${id}. (Pagey deletions are one-way; files are removed after retention.)`);
}

async function cmdDownload(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const out = positional[1] ?? flag(flags, "out", "output") ?? `${id}.zip`;
  const response = await apiRequest(token, "GET", `/sites/${id}/download`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(resolve(String(out)), buffer);
  print(`Downloaded ${fmtBytes(buffer.length)} to ${out}`);
}

async function cmdFiles(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const sub = positional[1] ?? flag(flags, "path");
  const query = sub ? `?path=${encodeURIComponent(String(sub))}` : "";
  const result = await apiRequest(token, "GET", `/sites/${id}/files${query}`);
  if (boolFlag(flags, "json")) return printJson(result);
  const walk = (nodes, prefix = "") => {
    for (const node of nodes ?? []) {
      print(`${node.type === "directory" ? "▸" : "•"} ${prefix}${node.name}${node.size != null ? ` (${fmtBytes(node.size)})` : ""}`);
      if (node.children) walk(node.children, `${prefix}${node.name}/`);
    }
  };
  walk(result.files ?? result.items ?? result.tree ?? []);
  if (result.contentRevision !== undefined) print(`content revision: ${result.contentRevision}`);
}

async function cmdAnalytics(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const query = new URLSearchParams();
  for (const key of ["from", "to"]) {
    const value = flag(flags, key);
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString() ? `?${query}` : "";
  const result = await apiRequest(token, "GET", `/sites/${id}/analytics${qs}`);
  if (boolFlag(flags, "json")) return printJson(result);
  const a = result.analytics ?? {};
  print(`page views: ${a.pageViews ?? "?"}   unique visitors: ${a.uniqueVisitors ?? "?"}   sessions: ${a.sessions ?? "?"}`);
  for (const [label, key, sub] of [["top pages", "topPages", "path"], ["referrers", "referrers", "referrer"], ["countries", "countries", "countryCode"]]) {
    const rows = a[key];
    if (Array.isArray(rows) && rows.length) {
      print(`${label}:`);
      for (const row of rows.slice(0, 8)) print(`  ${row[sub] ?? "?"} — ${row.count ?? row.pageViews ?? "?"}`);
    }
  }
}

async function cmdAnalyticsLast(positional, flags) {
  const last = await readLastSite();
  if (!last?.id) fail("No last-published site remembered.");
  await cmdAnalytics([last.id, ...positional], flags);
}

async function cmdLast(flags) {
  const last = await readLastSite();
  if (!last?.id) {
    print("No site published yet from this machine.");
    return;
  }
  if (boolFlag(flags, "json")) return printJson(last);
  print(`last site: ${last.url}`);
  print(`id:        ${last.id}`);
}

// --- share tokens ----------------------------------------------------------
async function cmdShare(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const sub = positional[0] ?? "list";
  const id = sub === "revoke-all" ? await resolveSiteId(positional.slice(1), flags) : await resolveSiteId(positional.slice(1), flags);
  if (sub === "create") {
    const expires = flag(flags, "expires-at", "expiresAt", "expires");
    if (!expires) fail("Usage: pagey share create <site-id> --expires-at <future ISO> [--label T] [--no-bypass]");
    const body = { expiresAt: validateFutureDate(String(expires), "expiry") };
    const label = flag(flags, "label");
    if (label !== undefined) body.label = String(label).slice(0, 50);
    body.canBypassMaintenance = !boolFlag(flags, "no-bypass");
    const result = await apiRequest(token, "POST", `/sites/${id}/tokens`, body);
    if (boolFlag(flags, "json")) return printJson(result);
    print("Share URL (raw token shown ONCE — copy it now):");
    print(result.url ?? result.token ?? JSON.stringify(result));
    return;
  }
  if (sub === "list") {
    const status = flag(flags, "status");
    const result = await apiRequest(token, "GET", `/sites/${id}/tokens${status ? `?status=${encodeURIComponent(String(status))}` : ""}`);
    if (boolFlag(flags, "json")) return printJson(result);
    for (const t of result.tokens ?? []) {
      print(`- ${t.id}  label=${t.label ?? "(none)"}  revoked=${t.revoked ?? false}  expires=${t.expiresAt ?? "?"}`);
    }
    if (!(result.tokens ?? []).length) print("(no tokens)");
    return;
  }
  if (sub === "update") {
    const tokenId = positional[2] ?? flag(flags, "token-id", "tokenId");
    validateUuid(String(tokenId ?? ""), "token ID");
    const body = {};
    const label = flag(flags, "label");
    if (label !== undefined) body.label = String(label).toLowerCase() === "null" ? null : String(label).slice(0, 50);
    if (flags["can-bypass-maintenance"] !== undefined || flags["canBypassMaintenance"] !== undefined) {
      body.canBypassMaintenance = !boolFlag(flags, "no-bypass") && String(flag(flags, "can-bypass-maintenance", "canBypassMaintenance")) !== "false";
    }
    if (Object.keys(body).length === 0) fail("Nothing to update. Use --label and/or --can-bypass-maintenance.");
    const result = await apiRequest(token, "PATCH", `/sites/${id}/tokens/${tokenId}`, body);
    if (boolFlag(flags, "json")) return printJson(result);
    print("Token updated.");
    return;
  }
  if (sub === "revoke") {
    const tokenId = positional[2] ?? flag(flags, "token-id", "tokenId");
    validateUuid(String(tokenId ?? ""), "token ID");
    await apiRequest(token, "DELETE", `/sites/${id}/tokens/${tokenId}`);
    print("Token revoked.");
    return;
  }
  if (sub === "revoke-all") {
    const result = await apiRequest(token, "POST", `/sites/${id}/tokens/revoke-all`);
    if (boolFlag(flags, "json")) return printJson(result);
    print(`Revoked ${result.revokedCount ?? "all"} token(s).`);
    return;
  }
  fail("Usage: pagey share <create|list|update|revoke|revoke-all> <site-id> [...]");
}

// --- visitor sessions -------------------------------------------------------
async function cmdVisitors(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const sub = positional[0] ?? "list";
  const id = await resolveSiteId(positional.slice(1), flags);
  if (sub === "list") {
    const status = flag(flags, "status");
    const result = await apiRequest(token, "GET", `/sites/${id}/access-sessions${status ? `?status=${encodeURIComponent(String(status))}` : ""}`);
    if (boolFlag(flags, "json")) return printJson(result);
    for (const s of result.sessions ?? []) print(`- ${s.id}  expires=${s.expires_at ?? s.expiresAt ?? "?"}`);
    if (!(result.sessions ?? []).length) print("(no sessions)");
    return;
  }
  if (sub === "revoke") {
    const sessionId = positional[2] ?? flag(flags, "session-id", "sessionId");
    validateUuid(String(sessionId ?? ""), "session ID");
    await apiRequest(token, "DELETE", `/sites/${id}/access-sessions/${sessionId}`);
    print("Access session revoked.");
    return;
  }
  if (sub === "revoke-all") {
    const result = await apiRequest(token, "POST", `/sites/${id}/access-sessions/revoke-all`);
    if (boolFlag(flags, "json")) return printJson(result);
    print(`Revoked ${result.revokedCount ?? "all"} session(s). Visitors must re-enter the password.`);
    return;
  }
  fail("Usage: pagey visitors <list|revoke|revoke-all> <site-id> [...]");
}

// --- forms (the backend OpenBot's first plugin couldn't ship) ----------------
function parseJsonInput(value, label) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) fail(`Empty ${label}.`);
  const fromFile = text.startsWith("@");
  try {
    const raw = fromFile ? BunSafeRead(resolve(text.slice(1))) : text;
    if (raw === undefined) fail(`File not found: ${text.slice(1)}`);
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof PageyError) throw error;
    fail(`Invalid ${label}: ${error.message}`);
  }
}

const FORM_FIELD_TYPES = ["text", "email", "tel", "textarea", "number", "date", "url", "select", "radio", "checkbox"];

function validateFormDefinition({ title, fields, description, settings, styles }) {
  if (typeof title !== "string" || !title.trim() || title.length > 255) fail("Form title is required (1–255 chars).");
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 25) fail("Forms need 1–25 fields.");
  const names = new Set();
  for (const field of fields) {
    if (!field || typeof field !== "object") fail("Each field must be an object.");
    if (!/^[a-z][a-z0-9_]*$/.test(field.name ?? "") || (field.name ?? "").length > 64) {
      fail(`Bad field name "${field.name}": lowercase snake_case, max 64 chars.`);
    }
    if (["constructor", "prototype"].includes(field.name)) fail(`Reserved field name: ${field.name}`);
    if (names.has(field.name)) fail(`Duplicate field name: ${field.name}`);
    names.add(field.name);
    if (typeof field.label !== "string" || !field.label.trim() || field.label.length > 150) {
      fail(`Field "${field.name}" needs a label (1–150 chars).`);
    }
    if (!FORM_FIELD_TYPES.includes(field.type)) fail(`Field "${field.name}": bad type (use ${FORM_FIELD_TYPES.join("/")}).`);
    if (field.placeholder !== undefined && String(field.placeholder).length > 200) fail(`Field "${field.name}": placeholder too long.`);
    if (["select", "radio"].includes(field.type)) {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 50) {
        fail(`Field "${field.name}": choice fields need 1–50 options.`);
      }
    }
  }
  const body = { title: title.trim(), fields };
  if (description !== undefined) body.description = String(description).slice(0, 1000);
  if (settings !== undefined) body.settings = settings;
  if (styles !== undefined) body.styles = styles;
  return body;
}

async function cmdForms(positional, flags) {
  const sub = positional[0];
  if (sub === "embed") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    const url = `https://pagey.site/api/public/forms/${id}/embed`;
    if (boolFlag(flags, "json")) return printJson({ embedUrl: url });
    print("Paste this iframe wherever the form should appear (any website works):");
    print(`<iframe src="${url}" title="Contact form" width="100%" height="600"></iframe>`);
    print(`Submit endpoint: https://pagey.site/api/public/forms/${id}/submit`);
    return;
  }
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  if (sub === "usage") {
    const result = await apiRequest(token, "GET", "/forms/usage");
    if (boolFlag(flags, "json")) return printJson(result);
    print(`active forms: ${result.forms} / ${result.limits?.maxForms ?? "?"}`);
    print(`submissions this month: ${result.submissionsThisMonth} / ${result.limits?.maxFormSubmissionsPerMonth ?? "?"}`);
    print(`stored per form/site: up to ${result.limits?.maxFormSubmissionsPerSite ?? "?"}`);
    return;
  }
  if (sub === "list") {
    const query = new URLSearchParams();
    for (const [from, to] of [["site-id", "siteId"], ["page", "page"], ["page-size", "pageSize"]]) {
      const value = flag(flags, from);
      if (value !== undefined) query.set(to, String(value));
    }
    const result = await apiRequest(token, "GET", `/forms?${query}`);
    if (boolFlag(flags, "json")) return printJson(result);
    for (const form of result.items ?? []) {
      print(`- ${form.id}  “${form.title ?? "(AI form)"}”  responses=${form.responseCount ?? "?"}${form.siteSubdomain ? `  site=${form.siteSubdomain}.pagey.site` : ""}`);
    }
    if (!(result.items ?? []).length) print("(no forms)");
    return;
  }
  if (sub === "create") {
    const title = flag(flags, "title");
    const fields = parseJsonInput(flag(flags, "fields", "fields-json"), "fields JSON (or @file.json)");
    if (fields === undefined) fail("Usage: pagey forms create --title T --fields '[{...}]' (or --fields @fields.json)");
    const body = validateFormDefinition({
      title,
      fields,
      description: flag(flags, "description"),
      settings: parseJsonInput(flag(flags, "settings", "settings-json"), "settings JSON"),
      styles: parseJsonInput(flag(flags, "styles", "styles-json"), "styles JSON"),
    });
    const result = await apiRequest(token, "POST", "/forms", body);
    if (boolFlag(flags, "json")) return printJson(result);
    print(`Form created: ${result.form?.id}`);
    print(`Embed it with: pagey forms embed ${result.form?.id}`);
    return;
  }
  if (sub === "get") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    const result = await apiRequest(token, "GET", `/forms/${id}`);
    if (boolFlag(flags, "json")) return printJson(result);
    print(`title: ${result.form?.title ?? "(AI form)"}`);
    for (const field of result.form?.definition?.fields ?? []) {
      print(`  - ${field.name} (${field.type})${field.required ? " required" : ""} — ${field.label}`);
    }
    return;
  }
  if (sub === "replace") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    const title = flag(flags, "title");
    const fields = parseJsonInput(flag(flags, "fields", "fields-json"), "fields JSON (or @file.json)");
    if (title === undefined || fields === undefined) fail("Usage: pagey forms replace <id> --title T --fields '[...]' (full definition).");
    const body = validateFormDefinition({
      title,
      fields,
      description: flag(flags, "description"),
      settings: parseJsonInput(flag(flags, "settings", "settings-json"), "settings JSON"),
      styles: parseJsonInput(flag(flags, "styles", "styles-json"), "styles JSON"),
    });
    const result = await apiRequest(token, "PUT", `/forms/${id}`, body);
    if (boolFlag(flags, "json")) return printJson(result);
    print("Form definition replaced. Existing embed URLs keep working; responses are retained.");
    return;
  }
  if (sub === "rename") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    const title = flag(flags, "title");
    if (title === undefined) fail("Usage: pagey forms rename <id> --title T");
    const result = await apiRequest(token, "PATCH", `/forms/${id}`, { title: String(title) });
    if (boolFlag(flags, "json")) return printJson(result);
    print(`Renamed to: ${result.form?.title ?? "(cleared)"}`);
    return;
  }
  if (sub === "delete") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    if (!boolFlag(flags, "confirm")) fail("Re-run with --confirm. The form stops accepting responses (stored responses still count toward monthly quota).");
    await apiRequest(token, "DELETE", `/forms/${id}`);
    print("Form deleted.");
    return;
  }
  if (sub === "responses") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    const query = new URLSearchParams();
    for (const [from, to] of [["page", "page"], ["page-size", "pageSize"], ["search", "search"]]) {
      const value = flag(flags, from);
      if (value !== undefined) query.set(to, String(value));
    }
    const result = await apiRequest(token, "GET", `/forms/${id}/responses?${query}`);
    if (boolFlag(flags, "json")) return printJson(result);
    print(`total: ${result.total ?? "?"} (form: ${result.form?.title ?? id})`);
    for (const item of result.items ?? []) {
      print(`- ${item.submittedAt ?? item.submitted_at ?? "?"}  ${item.email ?? "(no email)"}  ${JSON.stringify(item.extraFields ?? item.extra_fields ?? {})}`);
    }
    return;
  }
  if (sub === "csv") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "form ID");
    const out = positional[2] ?? flag(flags, "out", "output");
    if (!out) fail("Usage: pagey forms csv <id> <out.csv> [--search T]");
    const search = flag(flags, "search");
    const response = await apiRequest(token, "GET", `/forms/${id}/responses/csv${search ? `?search=${encodeURIComponent(String(search))}` : ""}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(resolve(String(out)), buffer);
    print(`Exported ${fmtBytes(buffer.length)} to ${out}`);
    return;
  }
  fail("Usage: pagey forms <usage|list|create|get|replace|rename|delete|responses|csv|embed> [...]");
}

// --- AI builder -------------------------------------------------------------
async function cmdAi(positional, flags) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const sub = positional[0] ?? "usage";
  if (sub === "usage") {
    const result = await apiRequest(token, "GET", "/ai/usage");
    if (boolFlag(flags, "json")) return printJson(result);
    const u = result.usage ?? {};
    print(`sessions this month: ${u.sessionsThisMonth ?? "?"} / ${u.maxSessionsPerMonth ?? "?"} (remaining: ${u.remainingSessions ?? "?"})`);
    print(`prompts per session: up to ${u.maxPromptsPerSession ?? "?"}`);
    return;
  }
  if (sub === "sessions") {
    const query = new URLSearchParams();
    for (const key of ["status", "page", "pageSize"]) {
      const value = flag(flags, key);
      if (value !== undefined) query.set(key, String(value));
    }
    const result = await apiRequest(token, "GET", `/ai/sessions?${query}`);
    if (boolFlag(flags, "json")) return printJson(result);
    for (const s of result.items ?? []) {
      print(`- ${s.id}  “${s.title}”  prompts=${s.userPromptCount ?? "?"}  html=${s.hasGeneratedHtml ? "yes" : "no"}${s.deployedSiteId ? `  site=${s.deployedSiteId}` : ""}`);
    }
    if (!(result.items ?? []).length) print("(no sessions)");
    return;
  }
  if (sub === "create") {
    const title = flag(flags, "title");
    const result = await apiRequest(token, "POST", "/ai/sessions", title === undefined ? {} : { title: String(title).slice(0, 255) });
    if (boolFlag(flags, "json")) return printJson(result);
    print(`Session: ${result.session?.id} (“${result.session?.title}”)`);
    print(`Next: pagey ai generate ${result.session?.id} --message "A dark portfolio for a photographer"`);
    return;
  }
  if (sub === "show") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "session ID");
    const result = await apiRequest(token, "GET", `/ai/sessions/${id}`);
    if (boolFlag(flags, "json")) return printJson(result);
    print(`“${result.session?.title}”  prompts=${result.session?.userPromptCount ?? "?"}`);
    for (const m of (result.messages ?? []).slice(-10)) {
      print(`[${m.role}/${m.contentType}] ${String(m.content ?? "").slice(0, 200)}`);
    }
    return;
  }
  if (sub === "rename") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "session ID");
    const title = flag(flags, "title");
    if (title === undefined) fail("Usage: pagey ai rename <session-id> --title T");
    const result = await apiRequest(token, "PATCH", `/ai/sessions/${id}`, { title: String(title) });
    if (boolFlag(flags, "json")) return printJson(result);
    print(`Renamed to: ${result.session?.title}`);
    return;
  }
  if (sub === "delete") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "session ID");
    if (!boolFlag(flags, "confirm")) fail("Re-run with --confirm. Deleted sessions still count toward the monthly allowance.");
    await apiRequest(token, "DELETE", `/ai/sessions/${id}`);
    print("Session deleted.");
    return;
  }
  if (sub === "generate") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "session ID");
    const message = flag(flags, "message", "m");
    if (!message) fail('Usage: pagey ai generate <session-id> --message "..." [--model M] [--out file.html]');
    const body = { message: String(message) };
    const model = flag(flags, "model");
    if (model !== undefined) body.model = String(model);
    const result = await apiRequest(token, "POST", `/ai/sessions/${id}/generate`, body);
    const out = flag(flags, "out", "output");
    if (result.type === "html" && out) {
      await writeFile(resolve(String(out)), result.html ?? "");
      print(`Saved ${fmtBytes(Buffer.byteLength(result.html ?? ""))} of HTML to ${out}`);
    }
    if (boolFlag(flags, "json")) return printJson(result);
    if (result.type === "html") print(`${result.message ?? "HTML generated."} Deploy with: pagey ai deploy ${id}`);
    else if (result.type === "question") print(`Pagey asks: ${result.question}  options: ${(result.options ?? []).join(" / ")}`);
    else print(result.message ?? JSON.stringify(result).slice(0, 500));
    return;
  }
  if (sub === "deploy") {
    const id = validateUuid(String(positional[1] ?? flag(flags, "id") ?? ""), "session ID");
    const body = {};
    for (const [from, to] of [["title", "title"], ["subdomain", "customSubdomain"], ["password", "password"]]) {
      const value = flag(flags, from);
      if (value !== undefined) body[to] = String(value);
    }
    const result = await apiRequest(token, "POST", `/ai/sessions/${id}/deploy`, body);
    const site = pickSite(result.site);
    await writeLastSite(site);
    if (boolFlag(flags, "json")) return printJson({ site });
    print(`Deployed AI site at ${site.url}`);
    return;
  }
  fail("Usage: pagey ai <usage|sessions|create|show|rename|delete|generate|deploy> [...]");
}

async function cmdSiteInfo(positional, flags) {
  const subdomain = positional[0] ?? flag(flags, "subdomain");
  if (!subdomain) fail("Usage: pagey site-info <subdomain>  (public, no token needed)");
  const response = await fetch(`${API}/public/sites/${encodeURIComponent(String(subdomain))}`, {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) fail(`No public info for "${subdomain}" (HTTP ${response.status}).`);
  const result = await response.json();
  if (boolFlag(flags, "json")) return printJson(result);
  const site = result.site ?? {};
  print(`subdomain: ${site.subdomain}   title: ${site.title ?? "(none)"}   status: ${site.status}`);
}

async function cmdOpen(positional, flags) {
  const token = getToken(flags);
  ACTIVE_TOKEN = token;
  let url = null;
  const maybeId = positional[0];
  if (maybeId && /^[0-9a-f-]{36}$/iu.test(maybeId) && token) {
    const result = await apiRequest(token, "GET", `/sites/${maybeId}`);
    url = pickSite(result.site).url;
  } else if (maybeId && !/^[0-9a-f-]{36}$/iu.test(maybeId)) {
    url = `https://${maybeId}.pagey.site`;
  } else {
    const last = await readLastSite();
    if (!last?.url) fail("Nothing to open. Publish first, or pass a site ID / subdomain.");
    url = last.url;
  }
  print(url);
}

async function cmdConsole() {
  if (!process.stdin.isTTY) fail("The console needs a terminal. Use individual `pagey <command>` calls instead.");
  print("Pagey console — type a command (list, publish-auto, last, forms-usage, ai-usage, help, quit).");
  print("Anything after the command name is passed through, e.g. `get <site-id>`, `publish /abs/path --yes`.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "pagey> " });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      rl.prompt();
      continue;
    }
    if (["quit", "exit", "q"].includes(trimmed.toLowerCase())) break;
    const parts = trimmed.split(/\s+/);
    try {
      await dispatch(parts[0], parts.slice(1));
    } catch (error) {
      if (error instanceof PageyError) console.error(redact(`error: ${error.message}`));
      else console.error(`error: ${error?.message ?? error}`);
    }
    rl.prompt();
  }
  rl.close();
}

async function cmdOpenClicked(flags) {
  const ctx = herdrContext();
  const url = process.env.HERDR_PLUGIN_CLICKED_URL || ctx.clicked_url || "";
  const match = String(url).match(/^https:\/\/([a-z0-9-]+)\.pagey\.site(?:\/.*)?$/u);
  if (!match) fail("Could not read a pagey.site address from the clicked link.");
  await cmdSiteInfo([match[1]], flags);
}

function helpText() {
  return `Pagey Site for Herdr — free static hosting with no cap on total sites.

SETUP
  pagey setup [--token T]        Save your API token (from pagey.site/dashboard/api-tokens)
  pagey whoami                   Verify the token and show the account

PUBLISH (the main flow)
  pagey publish <path> [opts]    Publish a folder, index.html, or ZIP (new site, new URL)
    --title T --subdomain S --expires-at ISO --password P --anonymous --yes
  pagey publish-auto [--path P]  Publish dist/|out/|build/|public/ under the Herdr workspace
  pagey update <site> <path>     Replace ALL files at the same URL (--confirm-replace --yes)
  pagey update-last <path>       Update the last-published site on this machine
  pagey update-meta <site>       Change title/expiry/password (--title T, --clear-title, ...)

MANAGE
  pagey list [--search T] [--status active] [--page N] [--page-size N]
  pagey get <site>               Show metadata + URL (defaults to last-published site)
  pagey last                     Show the last-published site on this machine
  pagey open [site|subdomain]    Print the public URL (clickable in Herdr panes)
  pagey site-info <subdomain>    Public info, no token needed
  pagey maintenance <site> --on|--off
  pagey subdomain <site> <slug>  Move the site to a new address (old one stops working)
  pagey tags <site> [--tags a,b]  Replace tags (empty clears)
  pagey download <site> [out.zip]
  pagey delete <site> --confirm  One-way soft delete
  pagey analytics <site> [--from ISO] [--to ISO]
  pagey analytics-last [...]

FILES (in-place edits, no full re-upload)
  pagey files <site> [--path dir]
  pagey files-upload <site> <local...> [--dest dir] [--overwrite]
  pagey files-mkdir <site> <dir-path>
  pagey files-move <site> <src> <dst>
  pagey files-rm <site> <path...>

SHARING (password/maintenance bypass links)
  pagey share create <site> --expires-at ISO [--label T]
  pagey share list <site> [--status active]
  pagey share update <site> <token-id> [--label T]
  pagey share revoke <site> <token-id>
  pagey share revoke-all <site>
  pagey visitors list <site> [--status active]
  pagey visitors revoke <site> <session-id>
  pagey visitors revoke-all <site>

FORMS (contact/waitlist/feedback backend — no separate service needed)
  pagey forms usage
  pagey forms list [--site-id ID]
  pagey forms create --title T --fields '[{...}]'  (or --fields @file.json)
  pagey forms get <id> | rename <id> --title T | replace <id> --title T --fields ...
  pagey forms delete <id> --confirm
  pagey forms responses <id> [--search T] [--page N]
  pagey forms csv <id> <out.csv>
  pagey forms embed <id>         Prints the iframe snippet + submit endpoint

AI BUILDER (generate a one-page site from a prompt, then deploy it)
  pagey ai usage | sessions | create [--title T] | show <id> | rename <id> --title T
  pagey ai delete <id> --confirm
  pagey ai generate <id> --message "..." [--out site.html]
  pagey ai deploy <id> [--title T] [--subdomain S] [--password P]

GLOBAL FLAGS
  --yes        Skip confirmation prompts (scripts, agents)
  --json       Machine-readable output (token redacted)
  --token T    Use this token instead of the saved one

Free allowances: 25 new sites/day per account (10/day anonymous), unlimited total
sites, 90-day analytics, 25 active forms, 5000 form responses/month, 5 AI sessions
per month with 5 prompts each. Full docs: https://pagey.site/api-docs`;
}

async function cmdFilesMut(positional, flags, op) {
  const token = requireToken(flags);
  ACTIVE_TOKEN = token;
  const id = await resolveSiteId(positional, flags);
  const rest = positional[0] && /^[0-9a-f-]{36}$/iu.test(positional[0]) ? positional.slice(1) : positional;
  if (op === "upload") {
    const paths = rest.length ? rest : [].concat(flag(flags, "file", "files") ?? []);
    if (!paths.length) fail("Usage: pagey files-upload <site> <local-path...> [--dest dir] [--overwrite]");
    const { FormData: FD } = globalThis;
    const form = new FD();
    const dest = flag(flags, "dest", "destination");
    const overwrite = boolFlag(flags, "overwrite");
    const pathList = [];
    let index = 0;
    for (const local of paths) {
      const abs = resolve(String(local));
      const stat = await lstat(abs).catch(() => fail(`Not found: ${abs}`));
      if (stat.isDirectory()) fail(`Pass files, not folders: ${abs}`);
      if (stat.isSymbolicLink()) fail(`Not a real file: ${abs}`);
      const data = await readAsset(abs, await realpath(join(abs, "..")));
      checkAsset(basename(abs), data);
      form.set(`files`, new Blob([data]), basename(abs));
      pathList.push(basename(abs));
      index++;
    }
    if (dest !== undefined) form.set("destination", String(dest));
    if (pathList.length) form.set("paths", JSON.stringify(pathList));
    if (overwrite) form.set("overwrite", "true");
    const result = await apiRequest(token, "POST", `/sites/${id}/files/upload`, form);
    if (boolFlag(flags, "json")) return printJson(result);
    print("Uploaded. The live folder was updated in place.");
    return;
  }
  if (op === "mkdir") {
    if (!rest[0]) fail("Usage: pagey files-mkdir <site> <dir-path>");
    await apiRequest(token, "POST", `/sites/${id}/directories`, { path: String(rest[0]) });
    print(`Created ${rest[0]}`);
    return;
  }
  if (op === "move") {
    if (!rest[0] || !rest[1]) fail("Usage: pagey files-move <site> <source-path> <destination-path>");
    await apiRequest(token, "PATCH", `/sites/${id}/files/move`, { sourcePath: String(rest[0]), destinationPath: String(rest[1]) });
    print(`Moved ${rest[0]} → ${rest[1]}`);
    return;
  }
  if (op === "rm") {
    if (!rest.length) fail("Usage: pagey files-rm <site> <path...>");
    await apiRequest(token, "DELETE", `/sites/${id}/files`, { paths: rest.map(String) });
    print(`Deleted ${rest.length} path(s). (index.html itself cannot be deleted.)`);
    return;
  }
  fail("unknown files op");
}

// ---------------------------------------------------------------------------
async function dispatch(command, argv) {
  const { positional, flags } = parseArgs(argv);
  if (boolFlag(flags, "help", "h") || command === "help" || !command) {
    print(helpText());
    return;
  }
  if (boolFlag(flags, "version", "v") || command === "version") {
    print("herdr-pagey 1.0.0");
    return;
  }
  switch (command) {
    case "setup": return cmdSetup(flags);
    case "whoami": case "me": return cmdWhoami(flags);
    case "list": case "sites": return cmdList(flags);
    case "get": case "site": return cmdGet(positional, flags);
    case "publish": return cmdPublish(positional, flags);
    case "publish-auto": case "autopublish": return cmdPublishAuto(flags);
    case "update": return cmdUpdate(positional, flags);
    case "update-last": return cmdUpdateLast(positional, flags);
    case "update-meta": case "meta": return cmdUpdateMeta(positional, flags);
    case "maintenance": return cmdMaintenance(positional, flags);
    case "subdomain": return cmdSubdomain(positional, flags);
    case "tags": case "tag": return cmdTags(positional, flags);
    case "delete": case "rm-site": return cmdDelete(positional, flags);
    case "download": return cmdDownload(positional, flags);
    case "files": case "ls": return cmdFiles(positional, flags);
    case "files-upload": case "upload": return cmdFilesMut(positional, flags, "upload");
    case "files-mkdir": case "mkdir": return cmdFilesMut(positional, flags, "mkdir");
    case "files-move": case "move": return cmdFilesMut(positional, flags, "move");
    case "files-rm": case "rm": return cmdFilesMut(positional, flags, "rm");
    case "analytics": return cmdAnalytics(positional, flags);
    case "analytics-last": return cmdAnalyticsLast(positional, flags);
    case "last": return cmdLast(flags);
    case "share": return cmdShare(positional, flags);
    case "visitors": return cmdVisitors(positional, flags);
    case "forms": return cmdForms(positional, flags);
    case "forms-usage": return cmdForms(["usage"], flags);
    case "ai": return cmdAi(positional, flags);
    case "ai-usage": return cmdAi(["usage"], flags);
    case "site-info": case "public": return cmdSiteInfo(positional, flags);
    case "open": return cmdOpen(positional, flags);
    case "open-clicked": return cmdOpenClicked(flags);
    case "console": return cmdConsole();
    default: fail(`Unknown command "${command}". Run \`pagey help\`.`);
  }
}

try {
  const [command, ...argv] = process.argv.slice(2);
  await dispatch(command, argv);
} catch (error) {
  if (error instanceof PageyError) {
    console.error(redact(`error: ${error.message}`));
    process.exit(1);
  }
  console.error(redact(`error: ${error?.message ?? error}`));
  process.exit(1);
}
