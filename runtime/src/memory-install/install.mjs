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
import { resolveCommand } from "../safe-spawn.mjs";
import { HOSTS, SERVER_NAME, claudePluginEnabled, hostById } from "./hosts.mjs";
import { backup, inspect, sha256, writeChecked } from "./fsx.mjs";
import { readLedger, writeLedger } from "./ledger.mjs";
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
  const viaLauncher = o.viaLauncher ?? pkg.name === SERVER_NAME;
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
    return { ...item, action: "refuse", reason: "Claude Code already has a user-scope server named agent-daemon-memory that ad didn't add", snippet: claudeSnippet(entry) };
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

export async function install(opts = {}) {
  const ctx = opts.ctx ?? makeContext(opts);
  const { out } = ctx;
  if (opts.capture && !CAPTURES.includes(opts.capture)) {
    out(`--capture must be one of ${CAPTURES.join(", ")}`);
    return 1;
  }
  let hosts;
  try {
    hosts = selected(ctx, opts.hosts);
  } catch (e) {
    out(e.message);
    return 1;
  }
  const found = hosts.filter((h) => h.detect(ctx).found);
  const missing = hosts.filter((h) => !found.includes(h));
  out("ad memory — install");
  out(`Found: ${found.map((h) => h.name).join(", ") || "none"}.${missing.length ? ` Not found: ${missing.map((h) => h.name).join(", ")}.` : ""}`);
  if (!found.length) {
    out("Nothing to set up. Install one of the hosts, or pass --host for one ad didn't find.");
    return 1;
  }
  const ledger = readLedger(ctx.root);
  const plans = [];
  for (const h of found) plans.push(await planHost(ctx, h, { capture: opts.capture, adopt: opts.adopt, ledger }));
  for (const p of plans) out(planLine(ctx, p));
  out(`Memory stays on this computer: ${ctx.display(path.join(ctx.root, "episodic.db"))}. No account.`);
  const todo = plans.filter((p) => p.action === "add" || p.action === "update");
  if (opts.dryRun) {
    out("Dry run: nothing written.");
    for (const p of plans.filter((x) => x.snippet)) out(`\n${p.host.name}:\n${p.snippet}`);
    return 0;
  }
  if (todo.length) {
    const symlinked = todo.some((p) => p.target?.symlink);
    if (!opts.yes || symlinked) {
      const answer = String(await ctx.ask(symlinked && opts.yes ? "A config is a link (shown above). Write through it? [y/N] " : "Continue? [Y/n] ")).trim().toLowerCase();
      const ok = symlinked ? answer === "y" || answer === "yes" : answer === "" || answer === "y" || answer === "yes";
      if (!ok) {
        out("Nothing changed.");
        return 1;
      }
    }
  }
  // npx: hosts start the launcher, so an upgrade is a new copy (even when every entry is unchanged).
  if (ctx.viaLauncher && (todo.length || plans.some((p) => p.action === "same")) && currentPackage(ctx.root)?.version !== ctx.version) {
    try {
      installPackage(ctx);
      out(`· the launcher now starts agent-daemon-memory ${ctx.version}`);
    } catch (e) {
      out(`✗ couldn't copy the package to ${ctx.display(path.join(ctx.root, "memory", "pkg"))}: ${e.message}`);
      return 1;
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
  return failCount === 0 ? 0 : okCount ? 2 : 1;
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
  if (!got.present) ctx.out(`  note: ${got.otherScope ? `Claude Code also has an agent-daemon-memory in its ${got.otherScope} scope, which wins where it applies` : "claude mcp get doesn't show the new entry"}`);
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
  const { out } = ctx;
  const ledger = readLedger(ctx.root);
  // Who set up what, before this run removes it: ad's own entries mean ad shares the memory.
  const adOwned = Object.values(ledger.hosts).some((h) => h.installedBy === "ad");
  let ids = opts.hosts?.length ? opts.hosts : Object.keys(ledger.hosts);
  const unknown = ids.filter((id) => !hostById(id));
  if (unknown.length) {
    out(`unknown host: ${unknown.join(", ")}`);
    return 1;
  }
  ids = ids.filter((id) => ledger.hosts[id]);
  if (!ids.length && !opts.purgeData) {
    out("Nothing to remove: ad's installer didn't set up any host here.");
    return 0;
  }
  let fails = 0;
  for (const id of ids) {
    const host = hostById(id);
    const rec = ledger.hosts[id];
    try {
      const msg = rec.driver === "cli" ? await removeCli(ctx, rec) : await removeFile(ctx, host, rec);
      // Skill folders ad published there (P5.7), when nobody changed them.
      for (const line of (await import("../skills/publish.mjs")).removePublishedSkills(rec)) out(`· ${host.name}: ${line}`);
      delete ledger.hosts[id];
      await writeLedger(ctx.root, ledger);
      out(`✓ ${host.name}: ${msg}`);
    } catch (e) {
      out(`✗ ${host.name}: ${e.message}`);
      fails++;
    }
  }
  // No host uses the copied package any more: the launcher and its copies go too.
  if (!Object.keys(ledger.hosts).length && fs.existsSync(path.join(ctx.root, "memory", "bin"))) {
    for (const p of ["pkg", "bin", "current.json"]) fs.rmSync(path.join(ctx.root, "memory", p), { recursive: true, force: true });
    out(`· removed the launcher (${ctx.display(path.join(ctx.root, "memory", "bin", "launch.mjs"))}): an entry you added by hand that starts it stops working`);
  }
  const removed = ids.length - fails;
  let purgeFailed = false;
  if (opts.purgeData) purgeFailed = Boolean(await purgeData(ctx, adOwned, opts));
  if (!fails && !purgeFailed) return 0;
  return removed > 0 ? 2 : 1;
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
  if (!Buffer.from(t.text, "utf8").equals(t.bytes)) throw new Error(`it isn't UTF-8 text any more, so ad can't edit it without changing other bytes; remove agent-daemon-memory from ${ctx.display(rec.file)} yourself`);
  const plan = host.driver === "toml" ? planTomlRemove(t.text, { entry: rec.entry }) : planJsonRemove(t.text, { entry: rec.entry });
  if (plan.action === "absent") return "ad's entry is gone already";
  if (plan.action === "edited") throw new Error(plan.reason);
  if (plan.action === "refuse") throw new Error(`${plan.reason}; remove agent-daemon-memory from ${ctx.display(rec.file)} yourself`);
  await writeChecked(t.realFile, plan.text, t.bytes);
  return "removed ad's entry (everything else in the file is kept)";
}

async function removeCli(ctx, rec) {
  const resolved = ctx.resolve("claude");
  if (!resolved) throw new Error("the claude command isn't on PATH: run `claude mcp remove --scope user agent-daemon-memory` yourself");
  await claudeRemove(resolved, ctx.claudeOpts);
  const got = await claudeGet(resolved, null, ctx.claudeOpts);
  if (got.error) throw new Error(got.error);
  if (got.present) throw new Error("claude mcp get still shows a user-scope agent-daemon-memory");
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
  ctx.out(`agent-daemon-memory ${ctx.version}${current ? ` (installed: ${current.version})` : ""}`);
  const ids = Object.keys(ledger.hosts);
  if (!ids.length) ctx.out("No hosts set up by the installer.");
  for (const id of ids) {
    const r = ledger.hosts[id];
    ctx.out(`  ${(hostById(id)?.name ?? id).padEnd(12)} ${r.driver === "cli" ? "claude mcp (user scope)" : ctx.display(r.file)}  capture ${r.capture}, ${r.version}, by ${r.installedBy}`);
  }
  return 0;
}
