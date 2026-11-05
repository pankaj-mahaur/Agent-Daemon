// L4a: `ad mistakes` end to end, spawned like a user runs it. It asks before
// reading, then writes nothing (under HOME, the cwd and the repo), opens no
// socket, resolves no name and starts no process.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildScenario } from "../testkit/agent-history.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// Loaded with --import before the CLI: any network call, child process,
// worker or file write trips a marker on stderr (named ESM imports included:
// syncBuiltinESMExports pushes the patches into them); reading a transcript
// before consent is logged too.
const GUARD = `
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import cp from "node:child_process";
import wt from "node:worker_threads";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const trip = (what) => function () { process.stderr.write("TRIPPED " + what + "\\n"); throw new Error("blocked: " + what); };
net.connect = net.createConnection = trip("net.connect");
net.Socket.prototype.connect = trip("socket.connect");
tls.connect = trip("tls.connect");
for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) dns[k] = trip("dns." + k);
for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) dns.promises[k] = trip("dns.promises." + k);
http.request = http.get = trip("http");
https.request = https.get = trip("https");
http2.connect = trip("http2");
dgram.createSocket = trip("dgram");
globalThis.fetch = trip("fetch");
globalThis.WebSocket = trip("WebSocket");
for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[k] = trip("child_process." + k);
wt.Worker = trip("worker_threads.Worker");
for (const k of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "renameSync", "rmSync", "rmdirSync", "unlinkSync", "copyFileSync", "cpSync", "symlinkSync", "linkSync", "truncateSync", "chmodSync", "utimesSync", "createWriteStream", "writeFile", "appendFile", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "unlink", "copyFile", "cp", "symlink", "truncate"]) fs[k] = trip("fs." + k);
for (const k of ["writeFile", "appendFile", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "unlink", "copyFile", "cp", "symlink", "truncate"]) fs.promises[k] = trip("fs.promises." + k);
const readOnly = (flags) => flags === undefined || typeof flags === "function" || flags === "r" || flags === fs.constants.O_RDONLY;
const openSync = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  if (!readOnly(flags)) return trip("fs.openSync(" + flags + ")")();
  return openSync.call(this, p, flags, ...rest);
};
const open = fs.open;
fs.open = function (p, flags, ...rest) {
  if (!readOnly(flags)) return trip("fs.open(" + flags + ")")();
  return open.call(this, p, flags, ...rest);
};
const popen = fs.promises.open;
fs.promises.open = function (p, flags, ...rest) {
  if (!readOnly(flags)) return trip("fs.promises.open(" + flags + ")")();
  return popen.call(this, p, flags, ...rest);
};
const readFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === "string" && /\\.jsonl(?:\\.zst)?$/.test(p)) process.stderr.write("READ " + p + "\\n");
  return readFileSync.call(this, p, ...rest);
};
syncBuiltinESMExports();
`;

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[p] = "dir";
        walk(p);
      } else {
        const st = fs.statSync(p);
        out[p] = `${st.size}:${st.mtimeMs}:${crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")}`;
      }
    }
  };
  walk(dir);
  return out;
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ad-mistakes-cli-"));
  const s = buildScenario(base);
  const guard = path.join(base, "guard.mjs");
  fs.writeFileSync(guard, GUARD);
  return { base, s, guard };
}

function run({ s, guard }, args, { cwd = s.project, input = "" } = {}) {
  const env = { ...process.env, HOME: s.home, USERPROFILE: s.home };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AD_HOME"]) delete env[k];
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, CLI, "mistakes", ...args], { cwd, env, input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("without a terminal or --yes: the consent screen, then nothing is read", () => {
  const ctx = setup();
  // stdout isn't a terminal here, so the screen goes to stderr and stdout keeps only the report.
  const r = run(ctx, []);
  assert.equal(r.code, 2, r.err);
  assert.equal(r.out, "");
  assert.ok(r.err.includes("It will read, without changing anything:"));
  assert.match(r.err, /Claude Code\s+~[\\/]\.claude[\\/]projects\s+3 project folders, 4 sessions, /);
  assert.match(r.err, /Codex\s+~[\\/]\.codex[\\/]sessions and archived_sessions\s+7 sessions in all projects \(only this project's are counted\), /);
  assert.ok(r.err.includes("Also: the CLAUDE.md and AGENTS.md files of this project and in your user folders"));
  assert.ok(r.err.includes(`Scope: this project only (${ctx.s.project}).`));
  assert.ok(r.err.includes("Run it again with --yes to read them."));
  assert.ok(!r.err.includes("Mistakes report"));
  assert.ok(!r.err.includes("READ "), `read before consent:\n${r.err}`);
  // --json keeps stdout for the report: the screen goes to stderr.
  const j = run(ctx, ["--json"]);
  assert.equal(j.code, 2);
  assert.equal(j.out, "");
  assert.ok(j.err.includes("It will read"));
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test("--yes: the report, with zero writes, no network and no child process", () => {
  const ctx = setup();
  const before = snapshot(ctx.base);
  const runs = {
    text: run(ctx, ["--yes"]),
    json: run(ctx, ["--yes", "--json"]),
    share: run(ctx, ["-y", "--share"]),
    all: run(ctx, ["--yes", "--all-projects"]),
    sub: run(ctx, ["--yes"], { cwd: path.join(ctx.s.project, "packages", "web") }),
  };
  for (const [name, r] of Object.entries(runs)) {
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.ok(!r.err.includes("TRIPPED"), `${name} tried the network or a process:\n${r.err}`);
  }
  assert.deepEqual(snapshot(ctx.base), before, "ad mistakes changed a file");
  assert.ok(!fs.existsSync(path.join(ctx.s.home, ".agent-daemon")));
  assert.ok(!fs.existsSync(path.join(ctx.s.project, ".git", "info", "exclude")));

  assert.ok(runs.text.out.includes("Mistakes report: this project (app)."));
  assert.ok(runs.text.out.includes("You corrected your agents 8 times in 10 typed prompts"));
  assert.equal(JSON.parse(runs.json.out).corrections, 8);
  assert.ok(runs.share.out.startsWith("## My coding agents' repeated mistakes"));
  assert.ok(runs.all.out.includes("Mistakes report: all projects."));
  assert.ok(runs.all.out.includes("You corrected your agents 10 times in 12 typed prompts"));
  assert.ok(runs.sub.out.includes("You corrected your agents 8 times"), "a subfolder reports its project");
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test("the guard trips: a network call or a process start would be caught", () => {
  const { base, guard } = setup();
  for (const code of [
    "import net from 'node:net'; try { net.connect(80, 'example.test'); } catch {}",
    "try { await fetch('http://example.test'); } catch {}",
    "import cp from 'node:child_process'; try { cp.spawnSync('node'); } catch {}",
    "import { spawnSync } from 'node:child_process'; try { spawnSync('node'); } catch {}",
    "import { writeFileSync } from 'node:fs'; try { writeFileSync('x.txt', 'x'); } catch {}",
    "import { openSync } from 'node:fs'; try { openSync('x.txt', 'w'); } catch {}",
    "import { mkdir } from 'node:fs/promises'; try { await mkdir('xdir'); } catch {}",
    "import { open } from 'node:fs/promises'; try { await open('x.txt', 'a'); } catch {}",
    "import { open } from 'node:fs'; try { open('x.txt', 'w', () => {}); } catch {}",
    "import { Worker } from 'node:worker_threads'; try { new Worker('0', { eval: true }); } catch {}",
  ]) {
    // In the temp folder: if the guard ever fails, the write lands there.
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, "--input-type=module", "-e", code], { cwd: base, encoding: "utf8", timeout: 30_000 });
    assert.match(r.stderr, /TRIPPED/, code);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test("no history, --help and bad flags", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ad-mistakes-cli-"));
  const home = path.join(base, "home");
  const project = path.join(base, "p");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const guard = path.join(base, "guard.mjs");
  fs.writeFileSync(guard, GUARD);
  const ctx = { s: { home, project }, guard };
  const none = run(ctx, []);
  assert.equal(none.code, 0);
  assert.ok(none.out.startsWith("No Claude Code or Codex history found for this project."));
  assert.ok(none.out.includes("--all-projects"));
  const help = run(ctx, ["--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.out.startsWith("Usage: ad mistakes"));
  const bad = run(ctx, ["--al-projects"]);
  assert.equal(bad.code, 2);
  assert.ok(bad.err.includes("Usage: ad mistakes"));
  assert.equal(run(ctx, ["--share", "--json"]).code, 2);
  fs.rmSync(base, { recursive: true, force: true });
});
