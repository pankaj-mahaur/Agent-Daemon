#!/usr/bin/env node
// The stable launcher (MCP launch plan L3, Decisions 4–6), copied to
// adRoot()/memory/launch/run.mjs. Every hook and server entry the memory product
// writes starts this file, never a versioned copy, so an update, a moved plugin or a
// removed package can't leave an entry that fails or blocks a tool call. Its path
// never moves: a host that trusts hooks by their exact command (after the user
// reviews them) would ask again if it did.
//
//   run.mjs hook <event> [--host <id>] …   the hook dispatcher of the current dist,
//                                          memory steps only (--memory-only)
//   run.mjs hook tool.before …             the guard copy's dispatcher (L7, D10)
//   run.mjs job guards-refresh             the rules snapshot's refresh, from the guard copy
//   run.mjs <verb> …                       the CLI of the newest npm or clone dist
//
// Next to it only dists.mjs (the dist list, loaded inside the guard below so a
// missing or older copy can't fail a hook) and product.json (names and version for
// the messages), both written by install. A hook always exits 0 with JSON on stdout.
//
// tool.before (L7, design S2–S3): it runs the guard copy that setup, install or repair
// recorded in guard.json, never the plugin or another dist. While rules are active
// (guards.active), a layer that can't run that copy — no record, a changed manifest, a
// copy gone or failing to load — prints a decision instead of letting the call through:
// ask on Claude Code in a mode known to show one, deny otherwise. Exit 1 only when even
// that fails (the host's onFailure decides).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const [verb, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const print = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
// Hooks and jobs read ad's root where this launcher lives, whatever AD_ROOT says (L7, D10):
// a call can't be checked against another root's rules, nor a job pointed at another store.
if (verb === "hook" || verb === "job") process.env.AD_ROOT = root;
const isToolBefore = verb === "hook" && rest[0] === "tool.before";
// Rules are active while guards.active exists — unless the current snapshot, matching it
// (the same rule count and store), pauses every rule: `rules pause --all` (the user's,
// with the token) then makes a guard that can't run L3's case, so the recovery the
// decision names works (D10, D15). A sentinel that can't be read counts as active.
function rulesActive() {
  let active;
  try {
    active = JSON.parse(fs.readFileSync(path.join(root, "guards.active"), "utf8"));
  } catch (e) {
    return e?.code !== "ENOENT";
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, "guards.json"), "utf8"));
    const p = s?.pausedAll;
    const paused = p === true || (Boolean(p) && typeof p === "object" && (p.until == null || Date.parse(p.until) > Date.now()));
    if (paused && typeof s.store_id === "string" && s.store_id === active?.store_id && Number.isInteger(active?.ruleCount) && Number(s.ruleCount) === active.ruleCount) return false;
  } catch {
    // no readable snapshot: the sentinel decides
  }
  return true;
}

// Read only when a message is printed (the common path stays at node's start-up).
function product() {
  let p = {};
  try {
    p = JSON.parse(fs.readFileSync(path.join(here, "product.json"), "utf8"));
  } catch {
    // missing: generic words below
  }
  return {
    shown: p.displayName ?? "ad's memory",
    // ad's clone route runs ad's own install, whose version may not be published: ad's own
    // commands (`ad rules …`, `ad memory repair`).
    pinned: (v) => (p.route === "clone" ? (v.startsWith("rules ") ? `ad ${v}` : `ad memory ${v}`) : p.package ? `npx -y ${p.package}${p.version ? `@${p.version}` : ""} ${v}` : `the memory package's ${v}`),
  };
}

// The hook's session id. Tool payloads can be large (a whole file written) and a
// host may leave stdin open: read at most 64 KB for 1 s, then let go of stdin.
async function sessionId() {
  if (process.stdin.isTTY) return "";
  const raw = await new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners("data");
      process.stdin.destroy();
      resolve(buf);
    };
    setTimeout(done, 1000).unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      if (buf.length > 64 * 1024) done();
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
  return /"session_id"\s*:\s*"([^"]{1,200})"/.exec(raw)?.[1] ?? "";
}

// Said once per session: a leftover entry must not repeat itself on every tool call.
async function sayOnce(message) {
  const crypto = await import("node:crypto");
  const id = crypto.createHash("sha256").update((await sessionId()) || "no-session").digest("hex").slice(0, 16);
  try {
    fs.writeFileSync(path.join(here, `told-${id}`), String(Date.now()), { flag: "wx" });
  } catch {
    return print({});
  }
  // Markers older than a week go (a session that long is told again then; fine).
  try {
    for (const f of fs.readdirSync(here).filter((x) => x.startsWith("told-"))) {
      const p = path.join(here, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86_400_000) fs.rmSync(p, { force: true });
    }
  } catch {
    // best effort
  }
  print({ systemMessage: message });
}

async function runHook({ distsFile, pickDist, readDists }) {
  const host = flag("--host") ?? "claude-code";
  const d = readDists(distsFile(root));
  // Uninstalled for this host: a kept entry captures nothing.
  if (d.disabledHosts.includes(host)) return print({});
  const dist = pickDist(d, { host });
  // Can't tell right now (a file mid-write, a plugin mid-update): quiet, and no
  // marker, so a real "gone" is still said later in the session.
  if (dist?.unknown) return print({});
  if (!dist || dist.gone) {
    const { shown, pinned } = product();
    const what = dist?.gone === "turned off" ? `the ${shown} plugin is turned off` : dist?.gone ? `the ${shown} plugin was removed` : `${shown} isn't installed any more`;
    return sayOnce(`${what}: run ${pinned("uninstall")} to remove its hooks`);
  }
  process.argv = [process.argv[0], dist.hook, ...rest, "--memory-only"];
  await import(pathToFileURL(dist.hook).href);
}

// The whole payload (up to 64 MB, 5 s): a decision needs the mode, which may come after a large input.
function readPayload(max = 64 * 1024 * 1024, ms = 5000) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners("data");
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    setTimeout(done, ms).unref();
    process.stdin.on("data", (d) => {
      chunks.push(Buffer.from(d));
      size += d.length;
      if (size > max) done();
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

// The decision a layer prints when it can't run the check while rules are active (D10):
// ask only on Claude Code in a mode known to show an ask; deny in any other mode, when
// the mode can't be read, and on Codex. The model is told to tell the user; the commands
// that pause or repair go to the user only (S4).
async function decide(why) {
  const raw = await readPayload();
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    // unparseable or cut: the raw text, read with care below
  }
  const host = flag("--host");
  let mode;
  if (input && typeof input === "object") mode = typeof input.permission_mode === "string" ? input.permission_mode : undefined;
  else {
    // Every spelling must agree: a field inside the tool's input can't stand in for the mode.
    const modes = new Set([...raw.matchAll(/"permission_mode"\s*:\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
    mode = modes.size === 1 ? [...modes][0] : undefined;
  }
  const codex = host === "codex" || host === "ad" || (input && typeof input === "object" ? "turn_id" in input : /"turn_id"\s*:/.test(raw));
  const ask = !codex && ["default", "acceptEdits", "plan", "auto"].includes(mode);
  const { shown, pinned } = product();
  print({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ask ? "ask" : "deny", permissionDecisionReason: `${shown} can't check this call against your rules (${why}). Tell the user.` },
    systemMessage: `${shown}: ${why} · pause rules: \`${pinned("rules pause --all")}\` · repair: \`${pinned("repair")}\``,
  });
}

// A record being written right now (a Windows read lock) is tried again briefly.
async function guardRecord({ readGuard }) {
  let g = readGuard(root);
  for (let i = 0; i < 5 && g.unreadable === "busy"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    g = readGuard(root);
  }
  return g;
}

async function runToolBefore(lib) {
  const host = flag("--host") ?? "claude-code";
  // Uninstalled for this host (while rules exist, only with the review token): its kept
  // entry does nothing. A list that can't be read can't say so: the check runs.
  const d = lib.readDists(lib.distsFile(root));
  if (!d.unreadable && d.disabledHosts.includes(host)) return print({});
  const active = rulesActive();
  const g = await guardRecord(lib);
  const usable = Boolean(g.path) && (await lib.guardIntact(g)) && fs.existsSync(g.hook);
  if (!active) {
    // No rules: the guard copy when there is one (self-protection runs there), else L3's way.
    if (usable) {
      try {
        return await runGuard(g);
      } catch {
        // a copy that fails to load: as before L7
      }
    }
    return runHook(lib);
  }
  if (!g.path) return decide(g.missing ? "no guard copy is set up" : "the guard copy's record can't be read");
  if (!usable) return decide("the guard copy was changed or removed");
  try {
    await runGuard(g);
  } catch (e) {
    process.stderr.write(`${product().shown}: ${e?.message ?? e}\n`);
    await decide("the rules check couldn't load");
  }
}

async function runGuard(g) {
  process.argv = [process.argv[0], g.hook, ...rest, "--memory-only"];
  await import(pathToFileURL(g.hook).href);
}

// Jobs the launcher starts from the guard copy (never the plugin or another dist).
const JOBS = new Set(["guards-refresh"]);

async function runJob(lib) {
  const name = rest[0];
  if (!JOBS.has(name)) return;
  const g = await guardRecord(lib);
  if (!g.path || !(await lib.guardIntact(g))) {
    process.stderr.write(`${product().shown}: no intact guard copy, so ${name} doesn't run\n`);
    return;
  }
  // The npm guard copy ships no better-sqlite3: node:sqlite, so none is looked up through
  // node_modules folders the agent could write (D10). The clone route's job uses the
  // clone's own (the driver loads it only from inside that tree).
  if (g.route === "npm") process.env.AD_SQLITE_DRIVER = "node:sqlite";
  else delete process.env.AD_SQLITE_DRIVER;
  // The root is this launcher's (AD_ROOT is pinned above); a clone's job can't derive it
  // from its own path as an npm copy's does, so it is passed too.
  process.env.AD_LAUNCHER_ROOT = root;
  process.argv = [process.argv[0], g.job];
  await import(pathToFileURL(g.job).href);
}

async function runCli({ distsFile, pickDist, readDists }) {
  // A list being written right now (a Windows read lock) is tried again briefly: a
  // server that gives up here is gone for the host's whole session.
  let d = readDists(distsFile(root));
  for (let i = 0; i < 5 && d.unreadable === "busy"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    d = readDists(distsFile(root));
  }
  const dist = pickDist(d, { needCli: true });
  if (!dist?.cli) {
    // stderr: for `serve`, stdout belongs to the MCP protocol. The fix is an install or
    // a repair, never the verb that was asked for (serve would start a server).
    const { shown, pinned } = product();
    const why = d.unreadable ? `${distsFile(root)} can't be read (${d.unreadable})` : "it isn't installed here any more";
    process.stderr.write(`${shown}: ${why}: run ${pinned(d.unreadable ? "repair" : "install")}\n`);
    process.exitCode = 1;
    return;
  }
  // The real path: a CLI that runs itself when started directly compares it with
  // its own (link-resolved) module path.
  let cli = dist.cli;
  try {
    cli = fs.realpathSync(dist.cli);
  } catch {
    // as registered
  }
  process.argv = [process.argv[0], cli, ...process.argv.slice(2)];
  await import(pathToFileURL(cli).href);
}

try {
  const lib = await import("./dists.mjs");
  if (isToolBefore) await runToolBefore(lib);
  else if (verb === "hook") await runHook(lib);
  else if (verb === "job") await runJob(lib);
  else await runCli(lib);
} catch (e) {
  // A hook never fails or blocks — except tool.before while rules are active, which
  // decides; a job's failure is its own (logged, exit 0).
  if (verb !== "hook" && verb !== "job") throw e;
  process.stderr.write(`${product().shown}: ${e?.message ?? e}\n`);
  if (isToolBefore && rulesActive()) {
    try {
      await decide("the rules check couldn't start");
    } catch {
      process.exitCode = 1;
    }
  } else {
    if (verb === "hook") print({});
    process.exitCode = 0;
  }
}
