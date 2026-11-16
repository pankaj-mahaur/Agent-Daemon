// The copies of ad's memory code the stable launcher can run (MCP launch plan L3,
// Decisions 4–6). Dependency-free: install copies this file next to the launcher
// (adRoot()/memory/launch/), and hooks import it from wherever they run.
//
//   <root>/memory/launch/dists.json = {
//     version: 1,
//     dists: [ { path, version, route: "npm"|"clone", hook, cli?, at }
//            | { route: "plugin", pluginId, pluginsFile, at } ],
//     disabledHosts: [ "<host id>", … ]
//   }
//   hook: the dispatcher to run (<dist>/bin/hook.mjs); cli: the CLI for other verbs.
//   A plugin is followed by its id through Claude Code's installed_plugins.json, so
//   an update (which moves the plugin to a new folder) never reads as "gone".
//
// A file that can't be read right now is not the same as nothing installed: the
// launcher stays quiet on "unknown" and speaks only on a definite "gone".

import fs from "node:fs";
import path from "node:path";

export const launchDir = (root) => path.join(root, "memory", "launch");
export const distsFile = (root) => path.join(launchDir(root), "dists.json");
export const launcherFile = (root) => path.join(launchDir(root), "run.mjs");
/** The guard copy's record (MCP launch plan L7, D10): its own file, so registerDist can't lose it. */
export const guardFile = (root) => path.join(launchDir(root), "guard.json");
/** The guard copy's manifest (every file's sha256), at the copy's top. */
export const MANIFEST = "guard-manifest.json";

const empty = () => ({ version: 1, dists: [], disabledHosts: [] });

// → the parsed value, null when missing, or undefined when present but unreadable
// (`busy` set when it couldn't be read at all, as opposed to read but garbled).
let lastReadBusy = false;
const readJson = (file) => {
  lastReadBusy = false;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    lastReadBusy = true;
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const validEntry = (d) => d && (d.route === "plugin" ? typeof d.pluginId === "string" && typeof d.pluginsFile === "string" : typeof d.hook === "string" && typeof d.path === "string");

/**
 * The list (empty when missing). `unreadable`: "garbled" when it was read but isn't a
 * list (a writer starts it again), "busy" when it couldn't be read (a writer refuses).
 */
export function readDists(file) {
  const j = readJson(file);
  if (j === null) return empty();
  if (j === undefined || j.version !== 1 || !Array.isArray(j.dists)) return { ...empty(), unreadable: lastReadBusy ? "busy" : "garbled" };
  return { version: 1, dists: j.dists.filter(validEntry), disabledHosts: Array.isArray(j.disabledHosts) ? j.disabledHosts.filter((h) => typeof h === "string") : [] };
}

// For writers: a list that couldn't be read now is never overwritten (it would lose
// its entries and the hosts turned off); a garbled one is started again.
function readForWrite(file) {
  const d = readDists(file);
  if (d.unreadable === "busy") throw new Error(`${file} can't be read right now; try again`);
  return d;
}

export function writeDists(file, d) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, dists: d.dists, disabledHosts: d.disabledHosts }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const samePath = (a, b) => {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const sameEntry = (a, b) => (a.route === "plugin" || b.route === "plugin" ? a.pluginId != null && a.pluginId === b.pluginId : samePath(a.path, b.path));

/** Add or refresh one dist (a plugin by its id, any other by its path). */
export function registerDist(file, entry, { now = new Date() } = {}) {
  const d = readForWrite(file);
  d.dists = d.dists.filter((x) => !sameEntry(x, entry));
  d.dists.push({ ...entry, at: now.toISOString() });
  writeDists(file, d);
  return d;
}

/** Forget one dist (an old version removed from disk, a plugin set up again elsewhere). */
export function unregisterDist(file, entry) {
  const d = readForWrite(file);
  d.dists = d.dists.filter((x) => !sameEntry(x, entry));
  writeDists(file, d);
  return d;
}

/*
 * The guard copy (L7, D10; design S2): the copy `tool.before` and the rules jobs run,
 * whatever the plugin record says. Written only by setup, install and repair (user-run,
 * under the ledger lock), never by a hook.
 *
 *   <root>/memory/launch/guard.json = {
 *     version: 1, route: "npm" | "clone", path, distVersion,
 *     manifestSha256: sha256 of <path>/guard-manifest.json (npm) | null (clone), at
 *   }
 *
 * An npm copy lives at <root>/memory/dist/<version>, inside ad's protected root; a
 * record naming any other folder isn't one install wrote. The clone route's guard is
 * the checkout itself (stated: it isn't under ad's root).
 */

const realOr = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/** → { route, path, version, manifestSha256, hook, job } | { missing: true } | { unreadable: "busy" | "garbled" } */
export function readGuard(root) {
  const j = readJson(guardFile(root));
  if (j === null) return { missing: true };
  if (j === undefined) return { unreadable: lastReadBusy ? "busy" : "garbled" };
  const garbled = { unreadable: "garbled" };
  if (!j || j.version !== 1 || typeof j.path !== "string" || !path.isAbsolute(j.path) || typeof j.distVersion !== "string") return garbled;
  if (j.route === "npm") {
    if (!/^[0-9a-f]{64}$/.test(String(j.manifestSha256))) return garbled;
    // Real paths on both sides: the launcher's own path is its real one (node resolves the
    // main module's links), install's may go through a link (/var vs /private/var, 8.3 names).
    const rel = path.relative(realOr(path.join(root, "memory", "dist")), realOr(j.path));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(/[\\/]/).length !== 1) return garbled;
  } else if (j.route !== "clone") return garbled;
  return {
    route: j.route,
    path: j.path,
    version: j.distVersion,
    manifestSha256: j.route === "npm" ? j.manifestSha256 : null,
    hook: path.join(j.path, "bin", "hook.mjs"),
    job: path.join(j.path, "src", "memory", "guards-refresh-job.mjs"),
  };
}

/** For setup, install and repair only (under the ledger lock). */
export function writeGuard(root, { route, path: dir, version, manifestSha256 = null }, { now = new Date() } = {}) {
  // A record readGuard would reject is never written (every hook would then refuse it).
  if (route === "npm" && !/^[0-9a-f]{64}$/.test(String(manifestSha256))) throw new Error("an npm guard record needs its manifest's sha256");
  if (route !== "npm" && route !== "clone") throw new Error(`unknown guard route ${route}`);
  const file = guardFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, route, path: dir, distVersion: version, manifestSha256: route === "npm" ? manifestSha256 : null, at: now.toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Does the copy's manifest still hash to what the record says? One small file, not the
 * tree (S2 rests on ad's root being protected; repair checks the tree). The clone route
 * has no manifest (stated).
 */
export async function guardIntact(g) {
  if (g.route === "clone") return true;
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(g.path, MANIFEST));
  } catch {
    return false;
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex") === g.manifestSha256;
}

/** A host's hooks do nothing while it is disabled (after an uninstall); setup clears it. */
export function setHostDisabled(file, host, disabled) {
  const d = readForWrite(file);
  const others = d.disabledHosts.filter((h) => h !== host);
  d.disabledHosts = disabled ? [...others, host] : others;
  writeDists(file, d);
  return d;
}

// "3.10.0" > "3.9.1"; a pre-release sorts before its release; "beta.10" > "beta.2".
export function cmpVersion(a, b) {
  const split = (v) => {
    const [main, ...pre] = String(v ?? "0").split("-");
    return { n: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre.length ? pre.join("-").split(".") : null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const num = /^\d+$/.test(p) && /^\d+$/.test(q);
    const c = num ? Number(p) - Number(q) : p.localeCompare(q);
    if (c) return c;
  }
  return 0;
}

/**
 * The plugin's current folder through Claude Code's own records.
 * → { folder } | { gone: "removed" | "turned off" } | { unknown: true } (a file being
 *   rewritten, or unreadable: say nothing, try again on the next call)
 */
export function pluginFolder(entry, { exists = fs.existsSync } = {}) {
  const records = readJson(entry.pluginsFile);
  if (records === undefined) return { unknown: true };
  const installed = records?.plugins?.[entry.pluginId];
  const list = Array.isArray(installed) ? installed : installed ? [installed] : [];
  const rec = list.find((x) => x?.scope === "user") ?? list[0];
  if (!rec?.installPath) return { gone: "removed" };
  const settings = readJson(path.join(path.dirname(path.dirname(entry.pluginsFile)), "settings.json"));
  if (settings?.enabledPlugins?.[entry.pluginId] === false) return { gone: "turned off" };
  // Mid-update (the new folder not there yet): unknown, not gone.
  return exists(path.join(rec.installPath, "server", "bin", "hook.mjs")) ? { folder: rec.installPath } : { unknown: true };
}

/**
 * Which dist runs now. Claude Code entries follow a registered plugin; everything
 * else takes the newest live npm or clone dist.
 * → { path, hook, cli?, route } | { gone, pluginId } | { unknown: true } | null (nothing installed)
 */
export function pickDist(d, { host, needCli = false, exists = fs.existsSync } = {}) {
  if (d.unreadable) return { unknown: true };
  if (host === "claude-code" && !needCli) {
    // A live folder wins over "can't tell", which wins over "gone" (a stale entry
    // must not hide a live one).
    let gone = null;
    let unknown = false;
    for (const p of d.dists.filter((x) => x.route === "plugin")) {
      const r = pluginFolder(p, { exists });
      if (r.folder) return { path: path.join(r.folder, "server"), hook: path.join(r.folder, "server", "bin", "hook.mjs"), route: "plugin" };
      if (r.unknown) unknown = true;
      else gone ??= { gone: r.gone, pluginId: p.pluginId };
    }
    if (unknown) return { unknown: true };
    if (gone) return gone;
  }
  const live = d.dists.filter((x) => x.route !== "plugin" && exists(x.hook) && (!needCli || (x.cli && exists(x.cli))));
  live.sort((a, b) => cmpVersion(b.version, a.version) || String(b.at).localeCompare(String(a.at)));
  return live[0] ?? null;
}
