// The memory installer (P5.3): one command adds ad's memory server to the
// hosts it finds, shows the plan first, keeps a backup and a ledger, and
// removes exactly what it added. Memory stays local (~/.agent-daemon/episodic.db).
//
//   install({hosts, yes, dryRun, capture, adopt, ...ctx}) → exit code (0 all ok, 2 partial, 1 nothing done)
//   uninstall({hosts, purgeData, force, ...ctx}) → exit code
//   status({json}) → exit code
//
// Two ways in, one code path:
//   npx agent-daemon-memory install  copies the package to adRoot()/memory/pkg/<version>/
//                                    and points hosts at the version-independent
//                                    launcher adRoot()/memory/bin/launch.mjs
//   ad memory install                points hosts at this clone's server file
// Hosts never start the server through npx, and get the absolute node path (GUI
// hosts often lack the shell's PATH).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adRoot } from "../ad-root.mjs";
import { PRODUCT, pinnedCommand } from "../product.mjs";
import { resolveCommand } from "../safe-spawn.mjs";
import { HOSTS, SERVER_NAME, claudePluginEnabled, hostById } from "./hosts.mjs";
import { backup, inspect, sha256, writeChecked } from "./fsx.mjs";
import { readLedger, writeLedger } from "./ledger.mjs";
import { dropItem, mergeV1, openLedger2ForWrite, readLedger2, uninstallReport, writeLedger2 } from "./ledger2.mjs";
import { cmpVersion, distsFile, launchDir, launcherFile, registerDist, setHostDisabled, unregisterDist } from "../memory/launch/dists.mjs";
import { SETUP_HOSTS, claudeSettingsFile, launcherReferences, parseSettings, removeSettingsItems, removeTomlItems, setup, setupPending, setupWork, withLedgerLock } from "./setup.mjs";
import { codexConfigFile, codexHooksFile, safeToml } from "./setup-codex.mjs";
import { ourHandlers } from "../hooks/routes.mjs";
import { createRequire } from "node:module";
import { jsonEntry, planJsonAdd, planJsonRemove } from "./edit-json.mjs";
import { isDeepStrictEqual } from "node:util";
import { planTomlAdd, planTomlRemove, tomlBlock } from "./edit-toml.mjs";
import { claudeAdd, claudeGet, claudeRemove, claudeSnippet } from "./claude-cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The folder holding this code's package.json: the npm package's root, or the clone's runtime/. */
export const PACKAGE_ROOT = path.resolve(HERE, "..", "..");
export const CAPTURES = ["auto", "hooks", "tools"];

export function packageInfo(root = PACKAGE_ROOT) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return { name: j.name, version: j.version };
  } catch {
    return { name: null, version: "0.0.0" };
  }
}

const entrySha = (entry) => sha256(Buffer.from(JSON.stringify(entry)));

/** The run's context; every part injectable for tests. */
export function makeContext(o = {}) {
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  const root = o.root ?? adRoot({ env, homedir: () => home });
  const pkg = packageInfo(o.packageRoot ?? PACKAGE_ROOT);
  const viaLauncher = o.viaLauncher ?? pkg.name === PRODUCT.package;
  return {
    env,
    home,
    root,
    node: o.node ?? process.execPath,
    viaLauncher,
    target: o.target ?? (viaLauncher ? path.join(root, "memory", "bin", "launch.mjs") : path.join(PACKAGE_ROOT, "src", "mcp", "memory-server.mjs")),
    packageRoot: o.packageRoot ?? PACKAGE_ROOT,
    version: pkg.version,
    installedBy: viaLauncher ? "npx" : "ad",
    resolve: o.resolve ?? ((name) => {
      const r = resolveCommand(name, { env, overrideVar: name === "claude" ? "AD_CLAUDE_BIN" : undefined });
      return r.cmd ? r : null;
    }),
    out: o.out ?? ((l) => console.log(l)),
    ask: o.ask ?? (async () => ""),
    display: (p) => (p.startsWith(home + path.sep) ? `~${p.slice(home.length).replace(/\\/g, "/")}` : p),
    claudeOpts: { env },
    /** A real terminal on stdin and stdout (setup's own step needs one). */
    isTTY: o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY)),
    /** Rules exist (L7 wires this): removing tool.before or the marker then needs the review token. None at L3. */
    rulesExist: o.rulesExist ?? (() => false),
    /** → true once the review gate (review.mjs, the review service's token) passed in the user's own terminal. */
    confirmReview:
      o.confirmReview ??
      (async () => {
        const { confirmInOwnTerminal } = await import("../review.mjs");
        return (await confirmInOwnTerminal({ ask: o.ask ?? (async () => ""), out: o.out ?? ((l) => console.log(l)), env, isTTY: o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY)) })).ok;
      }),
    claudeVersion: o.claudeVersion ?? (async () => (await import("../hooks/hook-doctor.mjs")).claudeCodeVersion()),
    /** What the user types for a verb: the pinned npx command, or ad's own from a clone. */
    command: (verb) => (viaLauncher ? pinnedCommand(verb, pkg.version) : `ad memory ${verb}`),
    lockWaitMs: o.lockWaitMs,
    platform: o.platform ?? process.platform,
    beforeWrite: o.beforeWrite,
    noSetup: o.noSetup,
  };
}

/* ------------------------------------------------------------------ */
/* The package copy and the launcher (npx only)                        */
/* ------------------------------------------------------------------ */

const LAUNCHER = `#!/usr/bin/env node
// agent-daemon-memory launcher: hosts start this file, which runs the installed
// version named in ../current.json (written by \`npx agent-daemon-memory install\`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(fs.readFileSync(path.join(here, "..", "current.json"), "utf8"));
await import(pathToFileURL(path.join(current.path, "cli.mjs")).href);
`;

/** The version the launcher starts now, or null. */
export function currentPackage(root) {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(root, "memory", "current.json"), "utf8"));
    return fs.existsSync(path.join(cur.path, "cli.mjs")) ? cur : null;
  } catch {
    return null;
  }
}

/** Copy this package to pkg/<version>, point current.json at it, keep the two newest. */
export function installPackage(ctx) {
  const pkgDir = path.join(ctx.root, "memory", "pkg");
  const dest = path.join(pkgDir, ctx.version);
  if (path.resolve(ctx.packageRoot) !== path.resolve(dest)) {
    // Copied next to its place, then renamed: current.json never points at a half copy.
    // The package's own files only (npx keeps it inside a node_modules folder; its
    // dependencies are for install and doctor, which run through npx, not serve).
    const tmp = `${dest}.tmp-${process.pid}`;
    // Leftover copies from a run that couldn't rename (a locked folder on Windows).
    if (fs.existsSync(pkgDir)) for (const d of fs.readdirSync(pkgDir).filter((n) => n.includes(".tmp-"))) fs.rmSync(path.join(pkgDir, d), { recursive: true, force: true });
    fs.cpSync(ctx.packageRoot, tmp, { recursive: true, filter: (src) => !path.relative(ctx.packageRoot, src).split(path.sep).includes("node_modules") });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  }
  fs.mkdirSync(path.join(ctx.root, "memory", "bin"), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, "memory", "current.json"), JSON.stringify({ version: ctx.version, path: dest }, null, 2) + "\n");
  fs.writeFileSync(path.join(ctx.root, "memory", "bin", "launch.mjs"), LAUNCHER);
  const versions = fs.readdirSync(pkgDir).filter((v) => !v.includes(".tmp-") && fs.statSync(path.join(pkgDir, v)).isDirectory());
  const byTime = versions.sort((a, b) => fs.statSync(path.join(pkgDir, b)).mtimeMs - fs.statSync(path.join(pkgDir, a)).mtimeMs);
  for (const old of byTime.filter((v) => v !== ctx.version).slice(1)) fs.rmSync(path.join(pkgDir, old), { recursive: true, force: true });
  return dest;
}

// The folder of a dependency as this running code resolves it: under npx that is the
// package being installed, so the copy gets the very versions it was built with.
function dependencyFolder(name) {
  let p = path.dirname(createRequire(import.meta.url).resolve(name));
  for (let i = 0; i < 8 && p !== path.dirname(p); i++, p = path.dirname(p)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")).name === name) return p;
    } catch {
      // not the package root yet
    }
  }
  throw new Error(`can't find the ${name} package`);
}

const versionOf = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
};

/**
 * An npm copy for the stable launcher: memory/dist/<version>, with the two parsers
 * its install, doctor and uninstall need (3.1.0's pkg/ copy runs only `serve`).
 * A version already in place is left alone, so a repair or re-install never opens a
 * window in which running hooks find no copy.
 */
function copyDist(ctx) {
  const distDir = path.join(ctx.root, "memory", "dist");
  const dest = path.join(distDir, ctx.version);
  if (path.resolve(ctx.packageRoot) === path.resolve(dest)) return dest;
  if (versionOf(dest) === ctx.version && fs.existsSync(path.join(dest, "bin", "hook.mjs")) && fs.existsSync(path.join(dest, "node_modules", "smol-toml"))) return dest;
  const tmp = `${dest}.tmp-${process.pid}`;
  // Leftovers of an interrupted install (old ones only: another install may be copying now).
  if (fs.existsSync(distDir)) {
    for (const d of fs.readdirSync(distDir).filter((n) => n.includes(".tmp-"))) {
      const p = path.join(distDir, d);
      if (Date.now() - fs.statSync(p).mtimeMs > 3_600_000) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  fs.cpSync(ctx.packageRoot, tmp, { recursive: true, filter: (src) => !path.relative(ctx.packageRoot, src).split(path.sep).includes("node_modules") });
  for (const name of ["jsonc-parser", "smol-toml"]) fs.cpSync(dependencyFolder(name), path.join(tmp, "node_modules", name), { recursive: true });
  // A broken copy of this version (no hook, no parsers) is moved aside, then replaced.
  const aside = fs.existsSync(dest) ? `${dest}.tmp-old-${process.pid}` : null;
  if (aside) fs.renameSync(dest, aside);
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (aside) fs.renameSync(aside, dest);
    throw e;
  }
  try {
    if (aside) fs.rmSync(aside, { recursive: true, force: true });
  } catch {
    // busy: an old leftover the next install sweeps (it is named .tmp-)
  }
  return dest;
}

// After registering the new copy: other versions go except the newest one besides
// this, each on its own (a folder Windows keeps busy stays for the next install).
function pruneDists(ctx, keep) {
  const distDir = path.join(ctx.root, "memory", "dist");
  let versions;
  try {
    versions = fs.readdirSync(distDir).filter((v) => !v.includes(".tmp-") && v !== keep && fs.statSync(path.join(distDir, v)).isDirectory());
  } catch {
    return;
  }
  for (const old of versions.sort((a, b) => cmpVersion(b, a)).slice(1)) {
    const p = path.join(distDir, old);
    try {
      unregisterDist(distsFile(ctx.root), { path: p });
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // still in use: tried again next time
    }
  }
}

/**
 * The stable launcher (L3, Decision 4): memory/launch/{dists.mjs, run.mjs,
 * product.json}, and this copy registered in dists.json (npm: a copy under
 * memory/dist/; the clone: the checkout itself). → the registered entry
 */
export function installLauncher(ctx, { now } = {}) {
  const dir = launchDir(ctx.root);
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, bytes) => {
    const tmp = path.join(dir, `${name}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(dir, name));
  };
  // dists.mjs first: a new run.mjs never meets an older dists.mjs.
  for (const f of ["dists.mjs", "run.mjs"]) put(f, fs.readFileSync(path.join(ctx.packageRoot, "src", "memory", "launch", f)));
  put("product.json", JSON.stringify({ package: PRODUCT.package, displayName: PRODUCT.displayName, version: ctx.version }, null, 2) + "\n");
  let entry;
  if (ctx.viaLauncher) {
    const dest = copyDist(ctx);
    entry = { path: dest, version: ctx.version, route: "npm", hook: path.join(dest, "bin", "hook.mjs"), cli: path.join(dest, "cli.mjs") };
  } else {
    entry = { path: ctx.packageRoot, version: ctx.version, route: "clone", hook: path.join(ctx.packageRoot, "bin", "hook.mjs"), cli: path.join(ctx.packageRoot, "src", "memory-install", "cli.mjs") };
  }
  registerDist(distsFile(ctx.root), entry, now ? { now } : {});
  if (ctx.viaLauncher) pruneDists(ctx, ctx.version);
  return entry;
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

const captureFor = (ctx, host, capture) => (capture && capture !== "auto" ? capture : host.defaultCapture(ctx));

function selected(ctx, ids) {
  if (!ids?.length) return HOSTS;
  const unknown = ids.filter((id) => !hostById(id));
  if (unknown.length) throw new Error(`unknown host: ${unknown.join(", ")} (known: ${HOSTS.map((h) => h.id).join(", ")})`);
  return ids.map(hostById);
}

// A path with links resolved as far as it exists (a junction or symlink can't hide where it points).
function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  try {
    head = fs.realpathSync.native(head);
  } catch {
    // unreadable: as given
  }
  return path.join(head, ...tail);
}
const inside = (child, parent) => {
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return fold(realish(child)).startsWith(fold(realish(parent)) + path.sep);
};

/** Our entry as the host's file holds it now (parsed), or undefined. */
async function fileEntry(host, text) {
  if (host.driver === "json") return jsonEntry(text).entry;
  try {
    const { parse } = await import("smol-toml");
    const e = parse(text)?.mcp_servers?.[SERVER_NAME];
    return e === undefined ? undefined : JSON.parse(JSON.stringify(e));
  } catch {
    return undefined;
  }
}

async function planHost(ctx, host, { capture, adopt, ledger }) {
  const cap = captureFor(ctx, host, capture);
  const entry = host.entry(ctx, cap);
  const rec = ledger.hosts[host.id];
  const item = { host, entry, capture: cap };
  if (host.driver === "cli") {
    const plugin = claudePluginEnabled(ctx.home, ctx.env);
    if (plugin) return { ...item, action: "plugin", reason: plugin };
    const det = host.detect(ctx);
    if (det.manualOnly) return { ...item, action: "manual", reason: det.why, snippet: claudeSnippet(entry) };
    const resolved = ctx.resolve("claude");
    const got = await claudeGet(resolved, null, ctx.claudeOpts);
    item.resolved = resolved;
    if (got.error) return { ...item, action: "refuse", reason: got.error, snippet: claudeSnippet(entry) };
    if (!got.present) return { ...item, action: "add", otherScope: got.otherScope };
    if (rec?.driver === "cli" && rec.argsSha256 === entrySha(entry)) return { ...item, action: "same" };
    // Only an entry ad itself added is replaced (Claude Code keeps no copy of a removed one).
    if (rec?.driver === "cli") return { ...item, action: "update" };
    return { ...item, action: "refuse", reason: `Claude Code already has a user-scope server named ${PRODUCT.mcpServerKey} that ad didn't add`, snippet: claudeSnippet(entry) };
  }
  const file = host.file(ctx);
  if (inside(file, ctx.root)) return { ...item, action: "refuse", reason: "that config is ad's own engine home, which ad sets up itself", file };
  const t = inspect(file);
  Object.assign(item, { file, target: t });
  if (t.readOnly) return { ...item, action: "refuse", reason: "the file is read-only", snippet: snippetFor(host, entry) };
  // Text ad would re-encode must not change: a file that isn't UTF-8 is left alone.
  if (t.exists && !Buffer.from(t.text, "utf8").equals(t.bytes)) return { ...item, action: "refuse", reason: "it isn't UTF-8 text, so ad can't edit it without changing other bytes", snippet: snippetFor(host, entry) };
  // Ad's entry counts as ad's only while it is exactly what ad wrote: a hand edit is kept.
  const current = await fileEntry(host, t.text);
  const owned = adopt || Boolean(rec?.driver === "file" && rec.entry && isDeepStrictEqual(current, rec.entry));
  const plan = host.driver === "toml" ? planTomlAdd(t.text, entry, { owned }) : planJsonAdd(t.text, entry, { owned });
  return { ...item, ...plan, snippet: plan.action === "refuse" ? snippetFor(host, entry) : undefined };
}

function snippetFor(host, entry) {
  if (host.driver === "toml") return tomlBlock(entry).trimEnd();
  if (host.driver === "json") return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
  return claudeSnippet(entry);
}

function planLine(ctx, p) {
  const name = p.host.name.padEnd(12);
  const capNote = p.capture === "hooks" ? "ad's hooks already capture here, so the record tools stay off." : "No ad hooks here, so capture uses the record tools.";
  switch (p.action) {
    case "add":
    case "update": {
      const how = p.host.driver === "cli" ? `${p.action === "add" ? "add" : "update"} the memory server with \`claude mcp add\` (user scope).` : `${p.action === "add" ? "add to" : "update in"} ${ctx.display(p.file)} (backup first).`;
      const link = p.target?.symlink ? ` It is a link to ${p.target.realFile}.` : "";
      return `  ${name} ${how}${link} ${capNote}`;
    }
    case "same":
      return `  ${name} already set up.`;
    case "manual":
      return `  ${name} ${p.reason}: add it yourself (shown below).`;
    case "plugin":
      return `  ${name} leaves it: ad's memory is already enabled here as a plugin (${p.reason}). One route per host.`;
    default:
      return `  ${name} won't change it: ${p.reason}.`;
  }
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

/**
 * install: the MCP entries (under the ledger lock), then setup's hook and marker
 * items (Decision 12) — in a terminal; without one, "finish in a terminal" and exit 2
 * when setup has work for a host found here.
 */
export async function install(opts = {}) {
  const ctx = opts.ctx ?? makeContext(opts);
  let mcp;
  try {
    mcp = await withLedgerLock(ctx, () => installMcp(ctx, opts));
  } catch (e) {
    ctx.out(`✗ ${e.message}`);
    return 1;
  }
  // --no-setup (scripts, CI): the MCP entries only, with their own exit code.
  if (mcp.stop || opts.noSetup || ctx.noSetup) return mcp.code;
  for (const s of mcp.setupPlans.filter((x) => x.w.none)) for (const n of s.w.notes) ctx.out(n);
  const todo = mcp.setupPlans.filter((s) => s.writes.length);
  if (!todo.length) return mcp.code;
  if (!ctx.isTTY()) {
    ctx.out(`Finish in a terminal (the hooks need one): ${ctx.command(opts.noPlugin ? "setup --no-plugin" : "setup")}`);
    return mcp.code === 1 ? 1 : 2;
  }
  const code = await setup({ ctx, hosts: todo.map((s) => s.id), noPlugin: opts.noPlugin });
  return code === mcp.code ? code : 2;
}

// What setup would write for each host found here (nothing is written).
async function pendingSetup(ctx, ids, opts) {
  const out = [];
  for (const id of ids) {
    const w = await setupWork(ctx, id, { noPlugin: opts.noPlugin });
    if (!w) continue;
    out.push({ id, w, writes: await setupPending(ctx, id, w) });
  }
  return out;
}

async function installMcp(ctx, opts) {
  const { out } = ctx;
  if (opts.capture && !CAPTURES.includes(opts.capture)) {
    out(`--capture must be one of ${CAPTURES.join(", ")}`);
    return { stop: true, code: 1 };
  }
  let hosts;
  try {
    hosts = selected(ctx, opts.hosts);
  } catch (e) {
    out(e.message);
    return { stop: true, code: 1 };
  }
  const found = hosts.filter((h) => h.detect(ctx).found);
  const missing = hosts.filter((h) => !found.includes(h));
  out("ad memory — install");
  out(`Found: ${found.map((h) => h.name).join(", ") || "none"}.${missing.length ? ` Not found: ${missing.map((h) => h.name).join(", ")}.` : ""}`);
  if (!found.length) {
    out("Nothing to set up. Install one of the hosts, or pass --host for one ad didn't find.");
    return { stop: true, code: 1 };
  }
  const ledger = readLedger(ctx.root);
  const plans = [];
  for (const h of found) plans.push(await planHost(ctx, h, { capture: opts.capture, adopt: opts.adopt, ledger }));
  for (const p of plans) out(planLine(ctx, p));
  // --no-setup: no preview, no question on setup's behalf.
  const setupPlans = opts.noSetup || ctx.noSetup ? [] : await pendingSetup(ctx, found.map((h) => h.id).filter((id) => SETUP_HOSTS.includes(id)), opts);
  for (const s of setupPlans) {
    for (const r of s.writes) out(`  ${hostById(s.id).name.padEnd(12)} setup: ${r.error ? `won't change ${ctx.display(r.file ?? "its config")}: ${r.error}` : `${r.action} ${r.kind === "env" ? "the agent-shell marker" : `the ${r.event} hook`} in ${ctx.display(r.file)}`}`);
  }
  out(`Memory stays on this computer: ${ctx.display(path.join(ctx.root, "episodic.db"))}. No account.`);
  const todo = plans.filter((p) => p.action === "add" || p.action === "update");
  if (opts.dryRun) {
    out("Dry run: nothing written.");
    for (const p of plans.filter((x) => x.snippet)) out(`\n${p.host.name}:\n${p.snippet}`);
    return { stop: true, code: 0 };
  }
  const setupAsks = ctx.isTTY() && setupPlans.some((s) => s.writes.length);
  if (todo.length || setupAsks) {
    const symlinked = todo.some((p) => p.target?.symlink);
    if (!opts.yes || symlinked) {
      const answer = String(await ctx.ask(symlinked && opts.yes ? "A config is a link (shown above). Write through it? [y/N] " : "Continue? [Y/n] ")).trim().toLowerCase();
      const ok = symlinked ? answer === "y" || answer === "yes" : answer === "" || answer === "y" || answer === "yes";
      if (!ok) {
        out("Nothing changed.");
        return { stop: true, code: 1 };
      }
    }
  }
  // npx: hosts start the launcher, so an upgrade is a new copy (even when every entry is unchanged).
  if (ctx.viaLauncher && (todo.length || plans.some((p) => p.action === "same")) && currentPackage(ctx.root)?.version !== ctx.version) {
    try {
      installPackage(ctx);
      out(`· the launcher now starts ${PRODUCT.package} ${ctx.version}`);
    } catch (e) {
      out(`✗ couldn't copy the package to ${ctx.display(path.join(ctx.root, "memory", "pkg"))}: ${e.message}`);
      return { stop: true, code: 1 };
    }
  }
  // The stable launcher (L3) and this copy registered as a dist it can run. Entries
  // move to it with setup; until then a failure here only warns.
  if (todo.length || plans.some((p) => p.action === "same")) {
    try {
      installLauncher(ctx);
    } catch (e) {
      out(`· couldn't set up the launcher in ${ctx.display(launchDir(ctx.root))}: ${e.message}`);
    }
  }

  let okCount = 0;
  let failCount = 0;
  const restart = [];
  for (const p of plans) {
    if (p.action === "same") {
      out(`· ${p.host.name}: already set up`);
      // ad's entry with no ledger record (a lost ledger, another AD_ROOT): record it,
      // without a byte restore (what was there before isn't known).
      if (!ledger.hosts[p.host.id] && p.host.driver !== "cli") {
        ledger.hosts[p.host.id] = { ...fileRecord(ctx, p, sha256(p.target.bytes)), preBytesSha256: undefined, originalBackup: null, restorable: false };
        await writeLedger(ctx.root, ledger);
      }
      okCount++;
      continue;
    }
    if (p.action === "plugin") {
      out(`· ${p.host.name}: memory comes from the ${p.reason} plugin; nothing added`);
      okCount++;
      continue;
    }
    if (p.action === "manual" || p.action === "refuse") {
      out(`✗ ${p.host.name}: ${p.reason}; add this yourself:\n${p.snippet}`);
      failCount++;
      continue;
    }
    try {
      const rec = p.host.driver === "cli" ? await applyCli(ctx, p, ledger) : await applyFile(ctx, p, ledger);
      ledger.hosts[p.host.id] = rec;
      await writeLedger(ctx.root, ledger);
      out(`✓ ${p.host.name}: ${p.action === "add" ? "added" : "updated"}${rec.originalBackup && p.action === "add" ? ` (backup: ${ctx.display(rec.originalBackup)})` : ""}`);
      restart.push(p.host.name);
      okCount++;
    } catch (e) {
      out(`✗ ${p.host.name}: ${e.message}`);
      failCount++;
    }
  }
  for (const name of restart) out(`Restart ${name} to load it.`);
  // Installed again: a host uninstall turned off captures again (Decision 5).
  if (fs.existsSync(distsFile(ctx.root))) {
    for (const p of plans.filter((x) => ["add", "update", "same", "plugin"].includes(x.action))) {
      try {
        setHostDisabled(distsFile(ctx.root), p.host.id, false);
      } catch (e) {
        out(`· couldn't turn ${p.host.name} back on in ${ctx.display(distsFile(ctx.root))}: ${e.message}`);
      }
    }
  }
  return { code: failCount === 0 ? 0 : okCount ? 2 : 1, setupPlans };
}

function fileRecord(ctx, p, postBytesSha256) {
  return {
    driver: "file",
    file: p.file,
    realFile: p.target.realFile,
    entryKey: SERVER_NAME,
    entry: p.entry,
    entrySha256: entrySha(p.entry),
    postBytesSha256,
    version: ctx.version,
    capture: p.capture,
    installedBy: ctx.installedBy,
    installedAt: new Date().toISOString(),
  };
}

async function applyFile(ctx, p, ledger) {
  const prev = ledger.hosts[p.host.id];
  const t = inspect(p.file);
  // The plan was made from what the file held before the question: changed since
  // (the host or the user wrote it) → don't write over that.
  if (sha256(t.bytes) !== sha256(p.target.bytes)) throw new Error("the file changed while ad was asking; run install again");
  // The first install keeps the original bytes; upgrades and repairs keep that record.
  // A byte restore on uninstall stays possible only while nobody else changed the file
  // between ad's writes: else uninstall removes just ad's entry.
  const first = !prev || prev.driver !== "file";
  const originalBackup = first ? (t.exists ? backup(ctx.root, p.host.id, p.file, t.bytes) : null) : prev.originalBackup;
  const preBytesSha256 = first ? sha256(t.bytes) : prev.preBytesSha256;
  const restorable = first ? true : prev.restorable !== false && sha256(t.bytes) === prev.postBytesSha256;
  await writeChecked(t.realFile, p.text, t.bytes);
  return { ...fileRecord(ctx, p, sha256(Buffer.from(p.text))), preBytesSha256, originalBackup, restorable };
}

async function applyCli(ctx, p) {
  if (p.action === "update") await claudeRemove(p.resolved, ctx.claudeOpts);
  const r = await claudeAdd(p.resolved, p.entry, ctx.claudeOpts);
  if (r.code !== 0) throw new Error(`claude mcp add failed: ${r.out.trim().split("\n").pop()}`);
  const got = await claudeGet(p.resolved, ctx.target, ctx.claudeOpts);
  // Added (exit 0): recorded so uninstall can remove it, even when a project or local
  // entry of the same name wins in some folders (then get shows that one).
  if (!got.present) ctx.out(`  note: ${got.otherScope ? `Claude Code also has an ${PRODUCT.mcpServerKey} in its ${got.otherScope} scope, which wins where it applies` : "claude mcp get doesn't show the new entry"}`);
  return {
    driver: "cli",
    command: "claude",
    scope: "user",
    entryKey: SERVER_NAME,
    entry: p.entry,
    argsSha256: entrySha(p.entry),
    version: ctx.version,
    capture: p.capture,
    installedBy: ctx.installedBy,
    installedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* uninstall                                                           */
/* ------------------------------------------------------------------ */

export async function uninstall(opts = {}) {
  const ctx = opts.ctx ?? makeContext(opts);
  try {
    return await withLedgerLock(ctx, () => uninstallLocked(ctx, opts));
  } catch (e) {
    ctx.out(`✗ ${e.message}`);
    return 1;
  }
}

async function uninstallLocked(ctx, opts) {
  const { out } = ctx;
  const ledger = readLedger(ctx.root);
  // Who set up what, before this run removes it: ad's own entries mean ad shares the memory.
  const adOwned = Object.values(ledger.hosts).some((h) => h.installedBy === "ad");
  const wanted = opts.hosts?.length ? opts.hosts : null;
  const unknown = (wanted ?? []).filter((id) => !hostById(id));
  if (unknown.length) {
    out(`unknown host: ${unknown.join(", ")}`);
    return 1;
  }
  const ids = (wanted ?? Object.keys(ledger.hosts)).filter((id) => ledger.hosts[id]);
  // What ledger v2 holds before this run (with v1 merged in: a 3.1.0 install may have
  // written it since), for the summary at the end.
  const all = mergeV1(readLedger2(ctx.root), ledger).items;
  const before = all.filter((i) => i.source === "v1");
  // Items setup wrote (hooks, the marker): removed per item, by content.
  const direct = all.filter((i) => !i.source && (i.kind === "hook" || i.kind === "env") && (!wanted || wanted.includes(i.host)));
  if (!ids.length && !direct.length && !opts.purgeData) {
    out("Nothing to remove: ad's installer didn't set up any host here.");
    return 0;
  }
  let fails = 0;
  // Per item, what really happened: removed, kept (and why), or already gone.
  const outcome = new Map();
  const mcpOf = (id) => before.find((i) => i.host === id && i.kind === "mcp");
  const skillOf = (id, name) => before.find((i) => i.host === id && i.kind === "skill-dir" && i.locator?.name === name);
  for (const id of ids) {
    const host = hostById(id);
    const rec = ledger.hosts[id];
    let msg;
    try {
      msg = rec.driver === "cli" ? await removeCli(ctx, rec) : await removeFile(ctx, host, rec);
    } catch (e) {
      out(`✗ ${host.name}: ${e.message}`);
      if (mcpOf(id)) outcome.set(mcpOf(id).id, { action: "kept", why: e.message });
      fails++;
      continue;
    }
    if (mcpOf(id)) outcome.set(mcpOf(id).id, { action: /gone already/.test(msg) ? "gone" : "removed" });
    try {
      // Skill folders ad published there (P5.7), when nobody changed them.
      for (const r of (await import("../skills/publish.mjs")).removePublishedSkills(rec)) {
        if (r.line) out(`· ${host.name}: ${r.line}`);
        const item = skillOf(id, r.name);
        if (item) outcome.set(item.id, { action: r.action, why: r.why });
      }
      delete ledger.hosts[id];
      await writeLedger(ctx.root, ledger);
      out(`✓ ${host.name}: ${msg}`);
    } catch (e) {
      out(`✗ ${host.name}: ${e.message}`);
      fails++;
    }
  }

  // setup's items, one write per settings file. While rules exist, removing tool.before
  // or the marker needs the review token (asked once); the rest goes either way.
  const rulesExist = Boolean(await ctx.rulesExist());
  let tokenAnswer;
  const gate = { rulesExist, token: async () => (tokenAnswer ??= Boolean(await ctx.confirmReview())) };
  const directResults = [];
  const byFile = new Map();
  for (const i of direct) byFile.set(i.file, [...(byFile.get(i.file) ?? []), i]);
  for (const [file, items] of byFile) {
    try {
      // config.toml (Codex's inline hooks, its marker) as text; JSON settings and hooks.json by structure.
      const res = /\.toml$/i.test(String(file)) ? await removeTomlItems(ctx, file, items, gate) : await removeSettingsItems(ctx, file, items, gate);
      directResults.push(...res);
      for (const n of res.notes ?? []) out(`· ${n}`);
    } catch (e) {
      for (const item of items) directResults.push({ item, action: "kept", why: `${ctx.display(file)}: ${e.message}; run uninstall again`, retry: true });
    }
  }
  for (const r of directResults) outcome.set(r.item.id, { action: r.action, why: r.why, how: r.how });
  const held = directResults.filter((r) => r.held);
  // The file was the problem (unreadable, busy, not written): those items stay ad's, to try again.
  const retries = directResults.filter((r) => r.retry);
  if (directResults.length) {
    const opened = openLedger2ForWrite(ctx.root);
    if (opened.refuse) out(`· ${opened.refuse}`);
    else {
      // Items kept for what they hold (you had it, you changed it) are the user's now;
      // ones the review gate held, or whose file couldn't be changed, stay ad's.
      for (const r of directResults) {
        if (!r.held && !r.retry) dropItem(opened.ledger, r.item.id);
        const li = r.held && r.created?.length ? opened.ledger.items.find((x) => x.id === r.item.id) : null;
        if (li) li.created = r.created;
      }
      await writeLedger2(ctx.root, opened.ledger);
    }
  }
  // Every host uninstalled here is off: a kept entry that still starts the launcher captures
  // nothing. While rules exist, turning off a host whose tool.before stays lowers that check,
  // so it needs the review token too.
  const off = [...new Set([...ids, ...direct.map((i) => i.host)])];
  const checkStays = new Set(directResults.filter((r) => r.action === "kept" && r.item.kind === "hook" && r.item.locator?.event === "tool.before").map((r) => r.item.host));
  // Also any launcher tool.before still in the settings that the ledger doesn't know of
  // (a ledger moved aside, a copy the user made).
  if (rulesExist) {
    for (const file of new Set([claudeSettingsFile(ctx), codexHooksFile(ctx), codexConfigFile(ctx), ...direct.map((i) => i.file).filter(Boolean)])) {
      try {
        const text = fs.readFileSync(file, "utf8");
        const root = /\.toml$/i.test(file) ? safeToml(text).doc : parseSettings(text).root;
        for (const o of ourHandlers(root?.hooks)) if (o.info.launcher && o.info.event === "tool.before") checkStays.add(o.info.host);
      } catch {
        // not there or unreadable: nothing found in it
      }
    }
  }
  if (fs.existsSync(distsFile(ctx.root))) {
    for (const h of off) {
      if (checkStays.has(h) && rulesExist && !(await gate.token())) {
        out(`· ${hostById(h)?.name ?? h} stays on: rules exist, and turning off its tool.before check needs your review`);
        continue;
      }
      try {
        setHostDisabled(distsFile(ctx.root), h, true);
      } catch (e) {
        out(`· couldn't mark ${h} as uninstalled in ${ctx.display(distsFile(ctx.root))}: ${e.message}`);
      }
    }
  }

  // No host uses the copied package any more: 3.1.0's launcher and its copies go too.
  if (!Object.keys(ledger.hosts).length && fs.existsSync(path.join(ctx.root, "memory", "bin"))) {
    for (const p of ["pkg", "bin", "current.json"]) fs.rmSync(path.join(ctx.root, "memory", p), { recursive: true, force: true });
    out(`· removed the launcher (${ctx.display(path.join(ctx.root, "memory", "bin", "launch.mjs"))}): an entry you added by hand that starts it stops working`);
  }
  // The stable launcher stays while anything still starts it (Decision 11).
  let launcherRefs = [];
  if (fs.existsSync(launchDir(ctx.root))) {
    launcherRefs = await launcherReferences(ctx, readLedger2(ctx.root).items.map((i) => i.file));
    if (!launcherRefs.length) {
      for (const p of [launchDir(ctx.root), path.join(ctx.root, "memory", "dist")]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch (e) {
          out(`· couldn't remove ${ctx.display(p)}: ${e.message}`);
        }
      }
    }
  }
  const removed = ids.length - fails;
  let purgeFailed = false;
  if (opts.purgeData) purgeFailed = Boolean(await purgeData(ctx, adOwned, opts));
  // The summary (L3, Decision 10): what went, what stayed and why, what is still on disk.
  const items = [...before, ...direct];
  const removedItems = items.filter((i) => outcome.get(i.id)?.action === "removed");
  const kept = items.filter((i) => outcome.get(i.id)?.action === "kept").map((item) => ({ item, why: outcome.get(item.id).why, how: outcome.get(item.id).how }));
  for (const line of uninstallReport({ removed: removedItems, kept, left: leftOnDisk(ctx, launcherRefs) }, { display: ctx.display })) out(line);
  if (held.length) out(`Run ${ctx.command("uninstall")} again in your own terminal to remove what the review gate kept.`);
  if (!fails && !purgeFailed && !held.length && !retries.length) return 0;
  return removed > 0 || directResults.some((r) => r.action === "removed") ? 2 : 1;
}

// What uninstall leaves on disk on purpose (your notes stay unless --purge-data).
const LEFT = [
  ["episodic.db", "your memory notes (remove with uninstall --purge-data)"],
  ["projects", "per-project journals and buffers"],
  [path.join("memory", "backups"), "copies of config files from before ad changed them"],
  [path.join("hooks", "hook.log"), "the hook log"],
];

// Bytes under a folder (bounded: a huge tree is reported as at least what was counted).
function treeBytes(p, budget = { files: 20_000 }) {
  let n = 0;
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let names = [];
  try {
    names = fs.readdirSync(p);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (--budget.files < 0) break;
    n += treeBytes(path.join(p, name), budget);
  }
  return n;
}

function leftOnDisk(ctx, launcherRefs = []) {
  const out = [];
  for (const [rel, what] of LEFT) {
    const p = path.join(ctx.root, rel);
    if (fs.existsSync(p)) out.push({ path: p, bytes: treeBytes(p), what });
  }
  if (fs.existsSync(launchDir(ctx.root))) {
    out.push({ path: launchDir(ctx.root), bytes: 0, what: `the launcher, still started by ${launcherRefs.map(ctx.display).join(", ") || "an entry"}` });
    const dist = path.join(ctx.root, "memory", "dist");
    if (fs.existsSync(dist)) out.push({ path: dist, bytes: treeBytes(dist), what: "the copies the launcher runs" });
  }
  return out;
}

async function removeFile(ctx, host, rec) {
  const t = inspect(rec.file);
  if (!t.exists) return "its config is gone already";
  // Unchanged since ad wrote it, and nobody wrote it between ad's writes: put back
  // exactly what was there before.
  if (rec.restorable !== false && sha256(t.bytes) === rec.postBytesSha256) {
    if (rec.preBytesSha256 === null) {
      fs.rmSync(t.realFile, { force: true });
      return "removed (the file didn't exist before)";
    }
    const original = rec.originalBackup && fs.existsSync(rec.originalBackup) ? fs.readFileSync(rec.originalBackup) : null;
    if (original && sha256(original) === rec.preBytesSha256) {
      await writeChecked(t.realFile, original, t.bytes);
      return "restored the file as it was before";
    }
  }
  // Changed since: take out only ad's entry, from text ad can write back unchanged.
  if (!Buffer.from(t.text, "utf8").equals(t.bytes)) throw new Error(`it isn't UTF-8 text any more, so ad can't edit it without changing other bytes; remove ${PRODUCT.mcpServerKey} from ${ctx.display(rec.file)} yourself`);
  const plan = host.driver === "toml" ? planTomlRemove(t.text, { entry: rec.entry }) : planJsonRemove(t.text, { entry: rec.entry });
  if (plan.action === "absent") return "ad's entry is gone already";
  if (plan.action === "edited") throw new Error(plan.reason);
  if (plan.action === "refuse") throw new Error(`${plan.reason}; remove ${PRODUCT.mcpServerKey} from ${ctx.display(rec.file)} yourself`);
  await writeChecked(t.realFile, plan.text, t.bytes);
  return "removed ad's entry (everything else in the file is kept)";
}

async function removeCli(ctx, rec) {
  const resolved = ctx.resolve("claude");
  if (!resolved) throw new Error(`the claude command isn't on PATH: run \`claude mcp remove --scope user ${PRODUCT.mcpServerKey}\` yourself`);
  await claudeRemove(resolved, ctx.claudeOpts);
  const got = await claudeGet(resolved, null, ctx.claudeOpts);
  if (got.error) throw new Error(got.error);
  if (got.present) throw new Error(`claude mcp get still shows a user-scope ${PRODUCT.mcpServerKey}`);
  return `removed with \`claude mcp remove\`${got.otherScope ? ` (the ${got.otherScope}-scope one you added yourself stays)` : ""}`;
}

const PURGE_WORD = "delete my memory";

async function purgeData(ctx, adOwned, opts) {
  const { out } = ctx;
  const adEntries = adOwned;
  const fullAd = fs.existsSync(path.join(ctx.root, "engine")) || Boolean(ctx.resolve("ad"));
  if ((adEntries || fullAd) && !opts.force) {
    out("Memory data kept: ad itself uses the same memory. Uninstall ad first, or add --force.");
    return 1;
  }
  const answer = String(await ctx.ask(`This deletes every memory note in ${ctx.display(ctx.root)}. Type "${PURGE_WORD}" to confirm: `)).trim();
  if (answer !== PURGE_WORD) {
    out("Not confirmed: memory data kept.");
    return 1;
  }
  for (const f of ["episodic.db", "episodic.db-wal", "episodic.db-shm"]) fs.rmSync(path.join(ctx.root, f), { force: true });
  fs.rmSync(path.join(ctx.root, "projects"), { recursive: true, force: true });
  out("Memory data deleted.");
  return 0;
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

export function status(opts = {}) {
  const ctx = opts.ctx ?? makeContext(opts);
  const ledger = readLedger(ctx.root);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(path.join(ctx.root, "memory", "current.json"), "utf8"));
  } catch {
    // not installed through npx
  }
  if (opts.json) {
    ctx.out(JSON.stringify({ version: ctx.version, current, hosts: ledger.hosts }));
    return 0;
  }
  ctx.out(`${PRODUCT.package} ${ctx.version}${current ? ` (installed: ${current.version})` : ""}`);
  const ids = Object.keys(ledger.hosts);
  if (!ids.length) ctx.out("No hosts set up by the installer.");
  for (const id of ids) {
    const r = ledger.hosts[id];
    ctx.out(`  ${(hostById(id)?.name ?? id).padEnd(12)} ${r.driver === "cli" ? "claude mcp (user scope)" : ctx.display(r.file)}  capture ${r.capture}, ${r.version}, by ${r.installedBy}`);
  }
  return 0;
}
