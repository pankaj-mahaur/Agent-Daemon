// The stable launcher and its dist list (MCP launch plan L3, part 3a): which copy
// runs, what a leftover entry says (once per session, never on a passing read
// error), stdin that is huge or never closes, and every hook event run from the
// built npm package through it. Temp roots and homes only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = await import("../src/memory/launch/dists.mjs");
const { installLauncher, makeContext } = await import("../src/memory-install/install.mjs");
const { build } = await import("../scripts/build-memory-package.mjs");
const { PRODUCT } = await import("../src/product.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-launcher-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let n = 0;
const fresh = (p = "r") => fs.mkdtempSync(path.join(TMP, `${p}${n++}-`));

// A root with the launcher folder as install writes it (dists.mjs, run.mjs, product.json).
function launchRoot() {
  const root = fresh("root");
  const dir = D.launchDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["run.mjs", "dists.mjs"]) fs.copyFileSync(path.join(RUNTIME, "src", "memory", "launch", f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "product.json"), JSON.stringify({ package: PRODUCT.package, displayName: PRODUCT.displayName, version: "9.9.9" }));
  return root;
}
// A fake dist whose hook and CLI print what they were started with.
function fakeDist(version) {
  const p = fresh("dist");
  fs.mkdirSync(path.join(p, "bin"), { recursive: true });
  const echo = (tag) => `process.stdout.write(JSON.stringify({ ${tag}: process.argv.slice(2) }) + "\\n");\n`;
  fs.writeFileSync(path.join(p, "bin", "hook.mjs"), echo("hook"));
  fs.writeFileSync(path.join(p, "cli.mjs"), echo("cli"));
  return { path: p, version, route: "npm", hook: path.join(p, "bin", "hook.mjs"), cli: path.join(p, "cli.mjs") };
}
// Claude Code's records for one plugin install (and a folder for it, unless told not to).
function claudeConfig({ installed = true, folder = true, enabled } = {}) {
  const cfg = fresh("claude");
  const pluginsFile = path.join(cfg, "plugins", "installed_plugins.json");
  const id = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
  const v2 = path.join(cfg, "plugins", "cache", "m", "p", "3.2.0");
  if (folder) {
    fs.mkdirSync(path.join(v2, "server", "bin"), { recursive: true });
    fs.writeFileSync(path.join(v2, "server", "bin", "hook.mjs"), 'process.stdout.write(JSON.stringify({ plugin: true }) + "\\n");\n');
  }
  fs.mkdirSync(path.dirname(pluginsFile), { recursive: true });
  fs.writeFileSync(pluginsFile, JSON.stringify({ version: 2, plugins: installed ? { [id]: [{ scope: "user", installPath: v2, version: "3.2.0" }] } : {} }));
  if (enabled !== undefined) fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { [id]: enabled } }));
  return { cfg, pluginsFile, id, folder: v2, entry: { route: "plugin", pluginId: id, pluginsFile } };
}
const run = (root, args, { input = "{}", env = {} } = {}) => {
  const r = spawnSync(process.execPath, [D.launcherFile(root), ...args], { input, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const json = (s) => JSON.parse(s || "null");

test("dists: one entry per path or plugin id, in any order; hosts turned off and on; versions as numbers", () => {
  const file = path.join(fresh(), "dists.json");
  const plugin = { route: "plugin", pluginId: "p@m", pluginsFile: "/c/plugins/installed_plugins.json" };
  D.registerDist(file, plugin);
  // An npm or clone copy registered after a plugin entry (which has no path).
  D.registerDist(file, { path: "/a", version: "3.1.0", route: "npm", hook: "/a/bin/hook.mjs" });
  D.registerDist(file, { path: "/a", version: "3.2.0", route: "npm", hook: "/a/bin/hook.mjs" });
  D.registerDist(file, plugin);
  assert.deepEqual(D.readDists(file).dists.map((d) => d.version ?? d.pluginId), ["3.2.0", "p@m"]);
  D.unregisterDist(file, { path: "/a" });
  assert.deepEqual(D.readDists(file).dists.map((d) => d.pluginId), ["p@m"]);
  D.setHostDisabled(file, "codex", true);
  D.setHostDisabled(file, "codex", true);
  assert.deepEqual(D.readDists(file).disabledHosts, ["codex"]);
  D.setHostDisabled(file, "codex", false);
  assert.deepEqual(D.readDists(file).disabledHosts, []);
  for (const [a, b] of [["3.10.0", "3.9.1"], ["3.2.0", "3.2.0-beta.1"], ["3.2.0-beta.10", "3.2.0-beta.2"], ["3.2.0-rc.1", "3.2.0-beta.9"]]) assert.ok(D.cmpVersion(a, b) > 0, `${a} > ${b}`);
  assert.equal(D.cmpVersion("1.0.0", "1.0.0"), 0);
  // Missing: empty. Present but garbled: unreadable (not "nothing installed").
  assert.equal(D.readDists(path.join(fresh(), "none.json")).unreadable, undefined);
  fs.writeFileSync(file, "{ garbled");
  assert.equal(D.readDists(file).unreadable, "garbled");
  assert.deepEqual(D.pickDist(D.readDists(file), {}), { unknown: true });
  // A garbled list is started again by a writer…
  D.setHostDisabled(file, "codex", true);
  assert.deepEqual(D.readDists(file).disabledHosts, ["codex"]);
  // …but one that can't be read right now is never overwritten (it would lose entries).
  const busy = path.join(fresh(), "dists.json");
  fs.mkdirSync(busy);
  assert.equal(D.readDists(busy).unreadable, "busy");
  assert.throws(() => D.registerDist(busy, { path: "/a", version: "1.0.0", route: "npm", hook: "/a/h" }), /can't be read right now/);
  assert.throws(() => D.setHostDisabled(busy, "codex", false), /can't be read right now/);
});

test("pickDist: the newest live copy; the plugin by its id; removed, turned off or unknown told apart", () => {
  const a = fakeDist("3.1.0");
  const b = fakeDist("3.2.0");
  const gone = { ...fakeDist("9.0.0"), hook: path.join(TMP, "nope", "hook.mjs") };
  const d = { version: 1, dists: [a, b, gone], disabledHosts: [] };
  assert.equal(D.pickDist(d, {}).path, b.path, "newest live; a vanished copy is skipped");
  assert.equal(D.pickDist({ ...d, dists: [a, { ...b, cli: undefined }] }, { needCli: true }).path, a.path, "a CLI verb needs a CLI");
  const c = claudeConfig();
  const withPlugin = { ...d, dists: [...d.dists, c.entry] };
  assert.equal(D.pickDist(withPlugin, { host: "claude-code" }).path, path.join(c.folder, "server"));
  assert.equal(D.pickDist(withPlugin, { host: "codex" }).path, b.path, "other hosts don't follow the plugin");
  assert.deepEqual(D.pickDist({ ...d, dists: [claudeConfig({ enabled: false }).entry] }, { host: "claude-code" }), { gone: "turned off", pluginId: c.id });
  assert.deepEqual(D.pickDist({ ...d, dists: [...d.dists, claudeConfig({ installed: false }).entry] }, { host: "claude-code" }), { gone: "removed", pluginId: c.id }, "uninstalled, even with an npm copy live");
  // Mid-update (the recorded folder not there yet) or records being rewritten: unknown.
  assert.deepEqual(D.pickDist({ ...d, dists: [claudeConfig({ folder: false }).entry] }, { host: "claude-code" }), { unknown: true });
  const garbled = claudeConfig();
  fs.writeFileSync(garbled.pluginsFile, "{ half-written");
  assert.deepEqual(D.pickDist({ ...d, dists: [garbled.entry] }, { host: "claude-code" }), { unknown: true });
});

test("the launcher: hook argv rewritten with --memory-only; CLI verbs to the newest CLI", () => {
  const root = launchRoot();
  D.registerDist(D.distsFile(root), fakeDist("3.1.0"));
  D.registerDist(D.distsFile(root), fakeDist("3.2.0"));
  const h = run(root, ["hook", "prompt.submit", "--host", "codex"]);
  assert.equal(h.code, 0, h.err);
  assert.deepEqual(json(h.out), { hook: ["prompt.submit", "--host", "codex", "--memory-only"] });
  assert.deepEqual(json(run(root, ["doctor", "--json"]).out), { cli: ["doctor", "--json"] });
  // Claude Code entries follow the plugin when one is registered.
  const c = claudeConfig();
  D.registerDist(D.distsFile(root), c.entry);
  assert.deepEqual(json(run(root, ["hook", "tool.before", "--host", "claude-code"]).out), { plugin: true });
});

test("the launcher with nothing to run: told once per session, exit 0; a passing read error says nothing", () => {
  const root = launchRoot();
  const first = run(root, ["hook", "tool.before", "--host", "claude-code"], { input: JSON.stringify({ session_id: "s1" }) });
  assert.equal(first.code, 0);
  assert.match(json(first.out).systemMessage, new RegExp(`isn't installed any more: run npx -y ${PRODUCT.package}@9\\.9\\.9 uninstall`));
  assert.deepEqual(json(run(root, ["hook", "tool.before"], { input: JSON.stringify({ session_id: "s1" }) }).out), {}, "said once");
  assert.ok(json(run(root, ["hook", "tool.before"], { input: JSON.stringify({ session_id: "s2" }) }).out).systemMessage, "a new session is told");
  // A garbled dists.json is "can't tell": quiet, and no marker for the session.
  fs.writeFileSync(D.distsFile(root), "{ half");
  const quiet = run(root, ["hook", "tool.before"], { input: JSON.stringify({ session_id: "s3" }) });
  assert.deepEqual(json(quiet.out), {});
  assert.equal(quiet.err, "", "a decided quiet answer, not the error path");
  fs.rmSync(D.distsFile(root));
  assert.ok(json(run(root, ["hook", "tool.before"], { input: JSON.stringify({ session_id: "s3" }) }).out).systemMessage, "told once it is definite");
  // A host turned off by uninstall: silent, whatever the dists.
  D.registerDist(D.distsFile(root), fakeDist("3.2.0"));
  D.setHostDisabled(D.distsFile(root), "codex", true);
  assert.deepEqual(json(run(root, ["hook", "session.start", "--host", "codex"], { input: JSON.stringify({ session_id: "s4" }) }).out), {});
  // `serve` with no CLI copy: stdout stays clean for the protocol.
  const s = run(launchRoot(), ["serve"]);
  assert.equal(s.code, 1);
  assert.equal(s.out, "");
  assert.match(s.err, /isn't installed here any more: run npx -y .*@9\.9\.9 install/, "the fix, never `serve` again");
  // A list that can't be read: says so and points at repair.
  const garbled = launchRoot();
  fs.writeFileSync(D.distsFile(garbled), "{ not json");
  const g = run(garbled, ["serve"]);
  assert.equal(g.code, 1);
  assert.equal(g.out, "");
  assert.match(g.err, /dists\.json can't be read \(garbled\): run npx -y .*@9\.9\.9 repair/);
  // No dists.mjs next to it (an interrupted install): a hook still exits 0 with JSON.
  const broken = launchRoot();
  fs.rmSync(path.join(D.launchDir(broken), "dists.mjs"));
  const b = run(broken, ["hook", "tool.before"]);
  assert.equal(b.code, 0);
  assert.deepEqual(json(b.out), {});
});

test("the launcher: a removed or turned-off plugin is named, even with an npm copy live", () => {
  for (const [opts, words] of [[{ installed: false }, /plugin was removed/], [{ enabled: false }, /plugin is turned off/]]) {
    const root = launchRoot();
    D.registerDist(D.distsFile(root), fakeDist("3.2.0"));
    D.registerDist(D.distsFile(root), claudeConfig(opts).entry);
    const r = run(root, ["hook", "tool.before", "--host", "claude-code"], { input: JSON.stringify({ session_id: "p1" }) });
    assert.match(json(r.out).systemMessage, words);
    // The other host's entries still run the npm copy.
    assert.ok(json(run(root, ["hook", "tool.before", "--host", "codex"]).out).hook);
  }
});

test("the launcher never hangs on stdin: 3 MB in, or stdin left open", async () => {
  const root = launchRoot();
  const big = run(root, ["hook", "tool.before"], { input: JSON.stringify({ session_id: "big", tool_input: { content: "x".repeat(3 * 1024 * 1024) } }) });
  assert.equal(big.code, 0, big.err);
  assert.ok(json(big.out).systemMessage);
  // A host that never closes stdin: the launcher still answers and exits.
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [D.launcherFile(root), "hook", "tool.before"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stdin.write('{"session_id":"open"');
    const kill = setTimeout(() => c.kill(), 15_000);
    c.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
  });
  assert.equal(r.code, 0);
  assert.ok(json(r.out.trim()).systemMessage);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
});

test("--memory-only: the dispatcher skips ad's own non-memory steps (the probes the next test relies on)", () => {
  const home = fresh("mo-home");
  const project = path.join(home, "work", "app");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: path.join(home, ".agent-daemon"), CLAUDE_PROJECT_DIR: project, AGENT_DAEMON_DISABLE_SWEEP: "1" };
  const hook = (event, payload, extra) =>
    spawnSync(process.execPath, [path.join(RUNTIME, "bin", "hook.mjs"), event, "--host", "claude-code", ...extra], { input: JSON.stringify({ session_id: "mo", cwd: project, ...payload }), encoding: "utf8", env, timeout: 60_000 }).stdout;
  const guard = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit --no-verify -m x" } };
  assert.match(hook("bash.guard", guard, []), /no-verify/, "without the flag, ad's Bash guard blocks it");
  assert.deepEqual(json(hook("bash.guard", guard, ["--memory-only"])), {});
  const prompt = { hook_event_name: "UserPromptSubmit", prompt: ROUTE_PROMPT };
  assert.match(hook("prompt.submit", prompt, []), ROUTE_ADVICE, "without the flag, ad's skill routing advises");
  assert.doesNotMatch(hook("prompt.submit", prompt, ["--memory-only"]), ROUTE_ADVICE);
});
// A prompt ad's skill routing answers with advice (outside --memory-only).
const ROUTE_PROMPT = "review this PR for security issues and write tests";
const ROUTE_ADVICE = /review-slice|security-review|code-review|tdd/;

test("every hook event runs from the built npm package through the launcher: valid JSON, exit 0, memory steps only", () => {
  const out = fresh("pkg");
  build({ out });
  const home = fs.realpathSync.native(fresh("home"));
  const root = path.join(home, ".agent-daemon");
  const ctx = makeContext({ env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root }, home, root, packageRoot: path.join(out, "dist"), viaLauncher: true, out: () => {} });
  const entry = installLauncher(ctx);
  assert.equal(entry.route, "npm");
  for (const name of ["jsonc-parser", "smol-toml"]) assert.ok(fs.existsSync(path.join(entry.path, "node_modules", name, "package.json")), `${name} copied into the dist`);
  // A second install of the same version leaves the copy in place (no window without one).
  fs.writeFileSync(path.join(entry.path, "kept.txt"), "x");
  installLauncher(ctx);
  assert.ok(fs.existsSync(path.join(entry.path, "kept.txt")), "not copied again");
  const project = path.join(home, "work", "app");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const env = { HOME: home, USERPROFILE: home, AD_ROOT: root, CLAUDE_PROJECT_DIR: project, AGENT_DAEMON_DISABLE_SWEEP: "1" };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AD_MEMORY_DB", "AD_HOOK_HOST"]) env[k] = "";
  const payloads = {
    "tool.before": { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    "tool.after": { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} },
    "prompt.submit": { hook_event_name: "UserPromptSubmit", prompt: ROUTE_PROMPT },
    "session.start": { hook_event_name: "SessionStart", source: "startup" },
    "session.end": { hook_event_name: "SessionEnd" },
    stop: { hook_event_name: "Stop" },
    "subagent.stop": { hook_event_name: "SubagentStop", last_assistant_message: "done" },
    "skill.use": { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: {} },
    "bash.guard": { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit --no-verify -m x" } },
    "mcp.audit": { hook_event_name: "PreToolUse", tool_name: "mcp__x__y", tool_input: {} },
  };
  for (const [event, payload] of Object.entries(payloads)) {
    for (const host of ["claude-code", "codex"]) {
      const r = run(root, ["hook", event, "--host", host], { input: JSON.stringify({ session_id: `e-${event}`, cwd: project, ...payload }), env });
      assert.equal(r.code, 0, `${event} ${host}: ${r.err}`);
      assert.doesNotThrow(() => json(r.out), `${event} ${host}: ${r.out}`);
      assert.doesNotMatch(r.err, /Cannot find module|ERR_MODULE_NOT_FOUND|routing-map/, `${event} ${host}`);
      // Memory only (the probes above show both would speak otherwise).
      if (event === "prompt.submit") assert.doesNotMatch(r.out, ROUTE_ADVICE, r.out);
      if (event === "bash.guard") assert.deepEqual(json(r.out) ?? {}, {}, "no guard under --memory-only");
    }
  }
  // A CLI verb runs the dist's CLI, parsers included.
  const doc = run(root, ["doctor", "--json"], { env });
  assert.doesNotMatch(doc.err, /Cannot find (module|package)/, doc.err);
  assert.doesNotThrow(() => json(doc.out), doc.out.slice(0, 200));
});

test("the clone route: the checkout registered as is, its CLI started through the launcher", () => {
  const home = fresh("clone-home");
  const root = path.join(home, ".agent-daemon");
  const ctx = makeContext({ env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root }, home, root, packageRoot: RUNTIME, viaLauncher: false, out: () => {} });
  const entry = installLauncher(ctx);
  assert.equal(entry.route, "clone");
  assert.equal(entry.path, RUNTIME);
  assert.ok(!fs.existsSync(path.join(root, "memory", "dist")), "no copy of a checkout");
  const r = run(root, ["help"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${PRODUCT.package}: `));
});

test("old npm copies are pruned after the new one is registered, the newest other version kept", () => {
  const home = fresh("prune-home");
  const root = path.join(home, ".agent-daemon");
  const distDir = path.join(root, "memory", "dist");
  for (const v of ["0.1.0", "0.2.0"]) {
    fs.mkdirSync(path.join(distDir, v, "bin"), { recursive: true });
    fs.writeFileSync(path.join(distDir, v, "bin", "hook.mjs"), "");
    D.registerDist(D.distsFile(root), { path: path.join(distDir, v), version: v, route: "npm", hook: path.join(distDir, v, "bin", "hook.mjs") });
  }
  const out = fresh("pkg");
  build({ out });
  const ctx = makeContext({ env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root }, home, root, packageRoot: path.join(out, "dist"), viaLauncher: true, out: () => {} });
  installLauncher(ctx);
  assert.deepEqual(fs.readdirSync(distDir).sort(), ["0.2.0", ctx.version].sort());
  assert.deepEqual(D.readDists(D.distsFile(root)).dists.map((d) => d.version).sort(), ["0.2.0", ctx.version].sort());
});
