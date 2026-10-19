// P5.3: the agent-daemon-memory npm package (scripts/build-memory-package.mjs).
// Built into a temp folder: its closure stays out of ad's engine, harness and
// TUI; `npm pack` ships only dist/, README and LICENSE with no install script;
// and the installed copy (adRoot()/memory/pkg/<version>) serves through the
// launcher with no dependencies and no native module.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build, closure, specifiers } = await import("../scripts/build-memory-package.mjs");
const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  made.push(d);
  return d;
};

test("the closure reaches no engine, harness or TUI code, and only allowed packages", () => {
  const c = closure();
  assert.deepEqual(c.problems, []);
  assert.ok(c.files.includes("src/mcp/memory-server.mjs") && c.files.includes("src/memory-install/install.mjs"));
  assert.ok(!c.files.some((f) => /^src\/(engine\/codex|harness|tui)\//.test(f)), c.files.join(","));
  assert.deepEqual(c.bare, ["better-sqlite3", "jsonc-parser", "smol-toml"]);
  // The scanner sees every import shape the code uses.
  assert.deepEqual(specifiers(`import a from "./a.mjs";\nimport { b } from './b.mjs';\nimport "./c.mjs";\nexport { d } from "./d.mjs";\nconst e = await import("./e.mjs");\n// import "./not.mjs"\n`), ["./a.mjs", "./b.mjs", "./c.mjs", "./d.mjs", "./e.mjs"]);
  // A forbidden import is caught.
  const root = tmp("ad-closure-");
  fs.mkdirSync(path.join(root, "src", "harness"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.mjs"), 'import "./harness/x.mjs";\nimport "chokidar";\n');
  fs.writeFileSync(path.join(root, "src", "harness", "x.mjs"), "");
  const bad = closure(["src/a.mjs"], root);
  assert.equal(bad.problems.length, 2, bad.problems.join("; "));
});

test("npm pack: only dist/, README, LICENSE and package.json; no install scripts; no native dependency", () => {
  const out = tmp("ad-pkg-");
  build({ out });
  const pkg = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8"));
  assert.equal(pkg.name, "agent-daemon-memory");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["jsonc-parser", "smol-toml"]);
  for (const [, v] of Object.entries(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, "exact pins");
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[s], undefined);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["pack", "--dry-run", "--json"], { cwd: out, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path.replace(/\\/g, "/"));
  for (const f of files) assert.ok(/^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(f), f);
  assert.ok(files.includes("dist/cli.mjs") && files.includes("dist/src/mcp/memory-server.mjs"));
});

function run(cmd, args, { env, input, cwd }) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err }));
    c.stdin.end(input ?? "");
  });
}

test("install through the built package: the installed copy serves via the launcher with no dependencies", async () => {
  const out = tmp("ad-pkg-run-");
  build({ out });
  // npx installs the parsers next to the package; the copy it installs has none.
  for (const dep of ["jsonc-parser", "smol-toml"]) fs.cpSync(path.join(RUNTIME, "node_modules", dep), path.join(out, "node_modules", dep), { recursive: true });
  const home = tmp("ad-pkg-home-");
  fs.mkdirSync(path.join(home, ".cursor"));
  const proj = path.join(tmp("ad-pkg-proj-"), "app");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, AD_ROOT: path.join(home, ".agent-daemon"), CODEX_HOME: path.join(home, ".codex-none") };
  const cli = path.join(out, "dist", "cli.mjs");
  const help = await run(process.execPath, [cli, "help"], { env });
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /install \[--host/);
  const inst = await run(process.execPath, [cli, "install", "--host", "cursor", "--yes"], { env });
  assert.equal(inst.code, 0, inst.out + inst.err);
  assert.match(inst.out, /✓ Cursor: added/);
  const cur = JSON.parse(fs.readFileSync(path.join(env.AD_ROOT, "memory", "current.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(cur.path, "cli.mjs")));
  assert.ok(!fs.existsSync(path.join(cur.path, "node_modules")), "the installed copy has no dependencies");
  const entry = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["agent-daemon-memory"];
  assert.equal(entry.args[1], path.join(env.AD_ROOT, "memory", "bin", "launch.mjs"));
  // Start the entry as Cursor would (with the project instead of ${workspaceFolder}).
  const args = entry.args.map((a) => (a === "${workspaceFolder}" ? proj : a));
  const served = await run(entry.command, args, {
    env,
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_stats", arguments: {} } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n",
  });
  const answers = Object.fromEntries(served.out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.ok(answers[2]?.result?.tools?.some((t) => t.name === "memory_record_correction"), served.err);
  assert.match(answers[3].result.content[0].text, /^scope: project \(arg\)/);
  assert.ok(!/ExperimentalWarning/.test(served.err), "the entry silences node:sqlite's warning");
  // Doctor through the package agrees, and uninstall removes it.
  const doc = await run(process.execPath, [cli, "doctor", "--json"], { env, cwd: home });
  const checks = JSON.parse(doc.out.trim().split("\n").at(-1));
  assert.ok(checks.find((c) => c.code === "smoke.modern" && c.host === "cursor")?.ok, doc.out);
  assert.ok(checks.find((c) => c.code === "sqlite.driver").ok);
  const un = await run(process.execPath, [cli, "uninstall"], { env });
  assert.equal(un.code, 0, un.out);
  assert.ok(!fs.existsSync(path.join(home, ".cursor", "mcp.json")), "it didn't exist before");
});
