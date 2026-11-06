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
const { build, closure, specifiers, HOOK_ENTRIES } = await import("../scripts/build-memory-package.mjs");
const { PRODUCT } = await import("../src/product.mjs");
const { claudeProjectSlug } = await import("../src/mistakes/history.mjs");
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
  // The hook dispatcher (the stable launcher runs it, L3) and L4a's `mistakes` ship too.
  for (const f of ["bin/hook.mjs", "src/memory/migrate-job.mjs", "src/mistakes/cli.mjs", "src/rules/match.mjs"]) assert.ok(c.files.includes(f), f);
  // All of engine/ is the brand zone, the adapter's names included (invariant 7).
  assert.ok(!c.files.some((f) => /^src\/(engine|harness|tui)\//.test(f)), c.files.join(","));
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
  // Any engine/ module is caught, not only the adapter itself.
  fs.mkdirSync(path.join(root, "src", "engine"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "b.mjs"), 'import "./engine/names.mjs";\n');
  fs.writeFileSync(path.join(root, "src", "engine", "names.mjs"), "");
  assert.match(closure(["src/b.mjs"], root).problems.join("; "), /src\/engine\/names\.mjs is outside/);
});

test("the hook paths need no npm package but the optional SQLite driver, and no installer module", () => {
  // Every shipped tree runs them, the plugin's included, where nothing can be installed.
  const c = closure(HOOK_ENTRIES);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.bare, ["better-sqlite3"]);
  assert.deepEqual(c.files.filter((f) => f.startsWith("src/memory-install/")), []);
  // The dispatcher's events are dynamic imports with literal paths: the scanner follows them.
  for (const f of ["src/hooks/tool-before.mjs", "src/hooks/routes.mjs", "src/memory/no-migrate.mjs"]) assert.ok(c.files.includes(f), f);
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
  assert.ok(files.includes("dist/bin/hook.mjs") && files.includes("dist/src/memory/migrate-job.mjs"));
  // One identity module names the product everywhere (L3, Decision 1).
  assert.equal(pkg.name, PRODUCT.package);
  assert.equal(pkg.mcpName, PRODUCT.mcpName);
  assert.equal(Object.keys(pkg.bin ?? {})[0] ?? pkg.name, PRODUCT.bin);
});

test("the built package's `mistakes` (L4a, read-only): the consent screen names the npm command, nothing is read", () => {
  const out = tmp("ad-pkg-mistakes-");
  build({ out });
  // The physical path: the CLI's cwd is what hosts record (macOS /private/var).
  const home = fs.realpathSync.native(tmp("ad-pkg-mistakes-home-"));
  const project = path.join(home, "work", "app");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const slugDir = path.join(home, ".claude", "projects", claudeProjectSlug(project));
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, "s1.jsonl"), JSON.stringify({ type: "user", uuid: "u1", cwd: project, message: { role: "user", content: "use pnpm, not npm" } }) + "\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AD_ROOT", "AD_HOME"]) delete env[k];
  const cli = path.join(out, "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [cli, "mistakes"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, new RegExp(`^npx ${PRODUCT.package} mistakes counts the corrections`));
  assert.match(r.stderr, /Run it again with --yes to read them\./);
  assert.doesNotMatch(r.stderr, /\bad mistakes\b/, "npm users have no `ad`");
  const help = spawnSync(process.execPath, [cli, "mistakes", "--help"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.match(help.stdout, new RegExp(`^Usage: npx ${PRODUCT.package} mistakes `));
});

test("the product's names live in one module: no name literal in runtime/src or runtime/scripts", () => {
  // A rename (owner checkpoint C-L3-NAME) is then one change in src/product.mjs.
  // Code and text only: comment lines may name the product. The TOML block markers stay
  // fixed on purpose: the installer searches for them to find blocks it already wrote.
  const KEEP = new Set(["src/memory-install/edit-toml.mjs:BEGIN", "src/memory-install/edit-toml.mjs:END"]);
  const hits = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith(".mjs") && !p.endsWith(path.join("src", "product.mjs"))) {
        const rel = path.relative(RUNTIME, p).split(path.sep).join("/");
        fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || !/\bagent-daemon-memory\b/.test(line)) return;
          const name = /^export const (\w+) =/.exec(line)?.[1];
          if (!KEEP.has(`${rel}:${name}`)) hits.push(`${rel}:${i + 1}`);
        });
      }
    }
  };
  scan(path.join(RUNTIME, "src"));
  scan(path.join(RUNTIME, "scripts"));
  scan(path.join(RUNTIME, "bin"));
  assert.deepEqual(hits, []);
});

test("the Codex wire format covers the value ad 2.x wrote for its engine", async () => {
  // hooks/io.mjs reads ENGINE_WIRE_HOSTS instead of the engine adapter's names (they stay out
  // of the shipped trees); the list must keep covering that old value.
  const { ENGINE_WIRE_HOSTS } = await import("../src/memory/host-ids.mjs");
  const { LEGACY } = await import("../src/engine/attribution.mjs");
  assert.ok(ENGINE_WIRE_HOSTS.includes("ad") && ENGINE_WIRE_HOSTS.includes(LEGACY.productValue));
  const { renderDecision } = await import("../src/hooks/io.mjs");
  for (const host of ENGINE_WIRE_HOSTS) assert.deepEqual(renderDecision("block", "no", { host, event: "PreToolUse" }).hookSpecificOutput?.permissionDecision, "deny");
  for (const host of ["claude", "claude-code"]) assert.deepEqual(renderDecision("block", "no", { host, event: "PreToolUse" }), { decision: "block", reason: "no" });
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
