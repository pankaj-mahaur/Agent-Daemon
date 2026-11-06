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
//   run.mjs <verb> …                       the CLI of the newest npm or clone dist
//
// Next to it only dists.mjs (the dist list, loaded inside the guard below so a
// missing or older copy can't fail a hook) and product.json (names and version for
// the messages), both written by install. A hook always exits 0 with JSON on stdout.

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
    pinned: (v) => (p.package ? `npx -y ${p.package}${p.version ? `@${p.version}` : ""} ${v}` : `the memory package's ${v}`),
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

async function runCli({ distsFile, pickDist, readDists }) {
  const dist = pickDist(readDists(distsFile(root)), { needCli: true });
  if (!dist?.cli) {
    // stderr: for `serve`, stdout belongs to the MCP protocol.
    const { shown, pinned } = product();
    process.stderr.write(`${shown} isn't installed here any more: run ${pinned(verb ?? "install")}\n`);
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
  if (verb === "hook") await runHook(lib);
  else await runCli(lib);
} catch (e) {
  // A hook never fails or blocks: anything unexpected is {} and exit 0.
  if (verb !== "hook") throw e;
  process.stderr.write(`${product().shown}: ${e?.message ?? e}\n`);
  print({});
  process.exitCode = 0;
}
