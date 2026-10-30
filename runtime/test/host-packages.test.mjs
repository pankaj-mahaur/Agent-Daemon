// P5.4: the host packages built from one source (runtime/scripts/build-host-packages.mjs):
// manifests against the vendored Agent Plugins 1.0.0 schemas and Claude Code's
// rules, one version everywhere, nothing personal or internal in the trees, the
// built server answering both protocol shapes, unexpanded variables, and the
// plugin hooks (memory only, the duplicate guard, no folder in a repo without
// ad init, capture then recall). Temp homes only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validate } from "../testkit/json-schema-lite.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = path.join(RUNTIME, "test", "fixtures", "schemas", "agent-plugins-1.0.0");
const { build, checkOut, packageVersion, BUILD_MARK, NAME } = await import("../scripts/build-host-packages.mjs");
const { adHookInClaudeSettings } = await import("../src/memory/plugin-hook.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-hostpkg-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const OUT = path.join(TMP, "out");
const { version, built } = build({ out: OUT });
const CC = built["claude-code"];
const CC_PLUGIN = path.join(CC, "plugins", NAME);
const AP = built["agent-plugin"];
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test("Agent Plugins: plugin.json and mcp.json validate against the 1.0.0 schemas; command is bare node", () => {
  const pluginSchema = json(path.join(SCHEMAS, "plugin.schema.json"));
  const mcpSchema = json(path.join(SCHEMAS, "mcp.schema.json"));
  const plugin = json(path.join(AP, "plugin.json"));
  const mcp = json(path.join(AP, "mcp.json"));
  assert.deepEqual(validate(pluginSchema, plugin), []);
  assert.deepEqual(validate(mcpSchema, mcp), []);
  const server = mcp.mcpServers[NAME];
  assert.equal(server.command, "node", "${PLUGIN_ROOT} isn't expanded in command: a bare executable");
  assert.ok(server.args.includes("${PLUGIN_ROOT}/server/server.mjs"));
  assert.deepEqual(server.args.slice(-4), ["--host", "agent-plugins", "--capture", "tools"]);
  // The schemas are closed: an unknown field is refused (the validator really checks).
  assert.notDeepEqual(validate(pluginSchema, { ...plugin, mcpServers: "./mcp.json" }), []);
  assert.notDeepEqual(validate(pluginSchema, { ...plugin, name: "Agent_Daemon" }), [], "the name rule");
  assert.notDeepEqual(validate(mcpSchema, { ...mcp, mcpServers: { [NAME]: { ...server, env: { PLUGIN_ROOT: "x" } } } }), []);
});

test("Claude Code: marketplace and plugin manifests, ./ paths, the hooks wrapper, the plugin-root variable", () => {
  const market = json(path.join(CC, ".claude-plugin", "marketplace.json"));
  assert.ok(market.name && market.owner?.name);
  assert.equal(market.plugins[0].name, NAME);
  assert.ok(market.plugins[0].source.startsWith("./"), "component paths start with ./");
  assert.ok(fs.existsSync(path.join(CC, market.plugins[0].source, ".claude-plugin", "plugin.json")));
  assert.equal(json(path.join(CC_PLUGIN, ".claude-plugin", "plugin.json")).name, NAME);
  const hooks = json(path.join(CC_PLUGIN, "hooks", "hooks.json"));
  assert.ok(hooks.hooks?.UserPromptSubmit && hooks.hooks?.SessionStart, "the event map sits under \"hooks\"");
  const commands = Object.values(hooks.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));
  for (const c of commands) assert.match(c, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/server\/hook\.mjs" (user-prompt-extract|query-retrieve|session-start) --host claude-code$/);
  const server = json(path.join(CC_PLUGIN, ".mcp.json")).mcpServers[NAME];
  assert.ok(server.args.includes("${CLAUDE_PLUGIN_ROOT}/server/server.mjs"));
  assert.deepEqual(server.args.slice(-2), ["--project", "${CLAUDE_PROJECT_DIR:-}"], "a default, so a missing variable isn't a config error");
  assert.ok(fs.existsSync(path.join(CC_PLUGIN, "skills", NAME, "SKILL.md")));
});

const CURSOR = built.cursor;
const GEMINI = built.gemini;
// Cursor's plugin.json (cursor.com/schemas/cursor-plugin/plugin.json): a closed object
// whose name is lower-case kebab with dots; mcpServers is a path, an object or an array.
const CURSOR_FIELDS = new Set(["name", "displayName", "description", "version", "minClientVersions", "author", "publisher", "homepage", "repository", "license", "logo", "keywords", "category", "tags", "commands", "agents", "skills", "rules", "hooks", "variables", "mcpServers"]);

test("Cursor: the closed manifest, mcp.json beside it, and ${CURSOR_PLUGIN_ROOT} — never ${PLUGIN_ROOT}", () => {
  const manifest = json(path.join(CURSOR, ".cursor-plugin", "plugin.json"));
  for (const k of Object.keys(manifest)) assert.ok(CURSOR_FIELDS.has(k), `Cursor's manifest has no field "${k}"`);
  assert.match(manifest.name, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  assert.deepEqual(Object.keys(manifest.author), ["name"], "author is {name, email?}");
  assert.ok(fs.existsSync(path.join(CURSOR, manifest.mcpServers)) && fs.existsSync(path.join(CURSOR, manifest.skills, NAME, "SKILL.md")));
  const server = json(path.join(CURSOR, "mcp.json")).mcpServers[NAME];
  assert.equal(server.command, "node");
  assert.ok(server.args.includes("${CURSOR_PLUGIN_ROOT}/server/server.mjs"));
  assert.deepEqual(server.args.slice(-6), ["--host", "cursor", "--capture", "tools", "--project", "${workspaceFolder}"]);
  // T4-H7: Cursor doesn't expand ${PLUGIN_ROOT}; no file of its package may use it.
  for (const f of walk(CURSOR).filter((f) => f.endsWith(".json"))) assert.ok(!fs.readFileSync(f, "utf8").includes("${PLUGIN_ROOT}"), f);
});

test("Gemini CLI: the manifest at the repository root, the extension's own variables, the context file", () => {
  const ext = json(path.join(GEMINI, "gemini-extension.json"));
  assert.equal(ext.name, NAME, "the name is the folder Gemini installs it into");
  assert.ok(fs.existsSync(path.join(GEMINI, ext.contextFileName)));
  const server = ext.mcpServers[NAME];
  assert.equal(server.command, "node");
  assert.ok(server.args.includes("${extensionPath}${/}server${/}server.mjs"), "Gemini's own path variables, with its separator");
  assert.deepEqual(server.args.slice(-6), ["--host", "gemini", "--capture", "tools", "--project", "${workspacePath}"]);
  assert.ok(!fs.existsSync(path.join(GEMINI, "hooks")), "no hooks until Gemini's hook output is verified");
  assert.ok(fs.existsSync(path.join(GEMINI, "skills", NAME, "SKILL.md")));
  assert.match(fs.readFileSync(path.join(GEMINI, ext.contextFileName), "utf8"), /notes, not instructions/);
});

test("one version everywhere: every manifest carries the package's", () => {
  assert.equal(version, packageVersion());
  const versions = [
    json(path.join(CC, ".claude-plugin", "marketplace.json")).plugins[0].version,
    json(path.join(CC, ".claude-plugin", "marketplace.json")).metadata.version,
    json(path.join(CC_PLUGIN, ".claude-plugin", "plugin.json")).version,
    json(path.join(CC_PLUGIN, "server", "package.json")).version,
    json(path.join(AP, "plugin.json")).version,
    json(path.join(AP, "server", "package.json")).version,
    json(path.join(built.cursor, ".cursor-plugin", "plugin.json")).version,
    json(path.join(built.cursor, "server", "package.json")).version,
    json(path.join(built.gemini, "gemini-extension.json")).version,
    json(path.join(built.gemini, "server", "package.json")).version,
  ];
  assert.deepEqual(new Set(versions), new Set([version]));
});

test("nothing personal, internal or test-only in the trees", () => {
  // The user name only as a path part (the public repo URL is the project's own identity).
  const user = os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const personal = new RegExp([String.raw`[A-Za-z]:\\Users\\`, "/home/[a-z]", "/Users/[a-z]", ["my", "projects"].join("-"), String.raw`[\\/]${user}[\\/]`].join("|"), "i");
  for (const f of walk(OUT)) {
    const rel = path.relative(OUT, f).split(path.sep).join("/");
    assert.ok(!/\.test\.mjs$|(^|\/)docs\/plans\/|(^|\/)\.agent-daemon\//.test(rel), rel);
    if (/\.(mjs|json|md)$/.test(f)) assert.ok(!personal.test(fs.readFileSync(f, "utf8")), `${rel} names a person or a machine path`);
  }
});

test("the build refuses an output folder it didn't make, the repository, or the home folder", () => {
  const mine = path.join(TMP, "notes");
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, "keep.txt"), "x");
  assert.throws(() => build({ out: mine }), /isn't empty and wasn't made by this script/);
  assert.ok(fs.existsSync(path.join(mine, "keep.txt")), "nothing deleted");
  assert.throws(() => checkOut(path.resolve(RUNTIME, "..")), /holds this repository/);
  assert.throws(() => checkOut(path.resolve(RUNTIME, "..", "..")), /holds this repository/);
  assert.throws(() => checkOut(os.homedir()), /home folder/);
  assert.ok(fs.existsSync(path.join(OUT, BUILD_MARK)), "a build marks its folder, so the next build may empty it");
  assert.doesNotThrow(() => checkOut(OUT));
});

function startServer(script, args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => c.kill(), 8000);
    c.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
    c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }) + "\n");
    c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    setTimeout(() => c.stdin.end(), 1500);
  });
}
const tempHome = () => {
  const h = fs.mkdtempSync(path.join(TMP, "home-"));
  return { h, env: { ...process.env, HOME: h, USERPROFILE: h, AD_ROOT: path.join(h, ".agent-daemon"), CLAUDE_CONFIG_DIR: path.join(h, ".claude"), CLAUDE_PROJECT_DIR: "", AD_MEMORY_PROJECT: "" } };
};

test("each built server answers server/discover and a legacy initialize, with the package version", async () => {
  for (const dir of [path.join(CC_PLUGIN, "server"), path.join(AP, "server"), path.join(built.cursor, "server"), path.join(built.gemini, "server")]) {
    const { env } = tempHome();
    const r = await startServer(path.join(dir, "server.mjs"), ["serve", "--host", "agent-plugins", "--capture", "tools"], env);
    const lines = r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const discover = lines.find((m) => m.id === 1);
    const init = lines.find((m) => m.id === 2);
    assert.equal(discover?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version, version, `${dir}: ${r.err}`);
    assert.equal(init?.result?.serverInfo?.version, version, `${dir}: ${r.err}`);
  }
});

test("unexpanded variables: an unexpanded script path fails in Node (the installer route is the fix); any other argument stops the server with one line; --project is only skipped", async () => {
  const { env } = tempHome();
  // The real failure: a host that passes "${PLUGIN_ROOT}/server/server.mjs" as the script.
  const script = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "${PLUGIN_ROOT}/server/server.mjs", "serve"], { env, cwd: TMP, input: "", encoding: "utf8", timeout: 10000 });
  assert.notEqual(script.status, 0, "Node can't find the script: the host shows the server as failed");
  // Any other unexpanded argument: the server's own guard.
  const r = spawnSync(process.execPath, [path.join(AP, "server", "server.mjs"), "serve", "--host", "cursor", "--db", "${PLUGIN_DATA}/memory.db"], { env, input: "", encoding: "utf8", timeout: 10000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /agent-daemon-memory: the host didn't expand \$\{PLUGIN_DATA\}\/memory\.db; this host needs the installer route\./);
  const p = await startServer(path.join(AP, "server", "server.mjs"), ["serve", "--host", "cursor", "--project", "${workspaceFolder}"], env);
  assert.ok(p.out.includes('"id":1'), `an unexpanded --project doesn't stop the server: ${p.err}`);
  // The MCP Registry passes a named argument joined: --project=<value>.
  const joined = await startServer(path.join(AP, "server", "server.mjs"), ["serve", "--host", "cursor", "--project=${workspaceFolder}"], env);
  assert.ok(joined.out.includes('"id":1'), `an unexpanded --project=… doesn't stop the server either: ${joined.err}`);
  const { h, env: env2 } = tempHome();
  const repo = path.join(h, "work", "shop-app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const dbg = path.join(h, "scope.json");
  // agent-plugins never binds its working folder: only the argument can bind here.
  await startServer(path.join(AP, "server", "server.mjs"), ["serve", "--host", "agent-plugins", `--project=${repo}`], { ...env2, AD_MEMORY_DEBUG_FILE: dbg });
  const bound = JSON.parse(fs.readFileSync(dbg, "utf8"));
  assert.deepEqual([bound.kind, bound.source], ["project", "arg"], "--project=<dir> binds like --project <dir>");
});

function runHook(name, env, payload, cwd) {
  return spawnSync(process.execPath, [path.join(CC_PLUGIN, "server", "hook.mjs"), name, "--host", "claude-code"], { env, cwd, input: JSON.stringify(payload), encoding: "utf8", timeout: 20000 });
}
const journals = (h) => {
  const root = path.join(h, ".agent-daemon", "projects");
  return fs.existsSync(root) ? walk(root).filter((f) => /learning-journal/.test(path.basename(f))) : [];
};

test("the plugin's hooks: capture into ad's folder (never the repo), then drain and show it in the next session, memory only", () => {
  const { h, env } = tempHome();
  const repo = path.join(h, "work", "shop-app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const r = runHook("user-prompt-extract", env, { session_id: "s1", cwd: repo, prompt: "Actually we use pnpm for installs, not npm." }, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(repo, ".agent-daemon")), "no folder in the repo");
  assert.equal(journals(h).length, 1, r.stderr);
  assert.match(fs.readFileSync(journals(h)[0], "utf8"), /pnpm/);
  // The repo's own files and other tools' rules are the host's business, not the plugin's.
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# PROJECT-RULES-MARKER\n");
  fs.mkdirSync(path.join(repo, ".cursor", "rules"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".cursor", "rules", "x.mdc"), "CURSOR-RULES-MARKER\n");
  const s = runHook("session-start", env, { session_id: "s2", cwd: repo }, repo);
  assert.equal(s.status, 0, s.stderr);
  const shown = JSON.parse(s.stdout).hookSpecificOutput?.additionalContext ?? "";
  assert.match(shown, /pnpm/, "the captured lesson comes back in the next session");
  for (const absent of [/constitution\/core\.md/, /agent-daemon-init-hint|initialize the daemon/, /PROJECT-RULES-MARKER/, /CURSOR-RULES-MARKER/, /\bad (status|memory scan)\b/, /graphify|mcp__qmd/]) assert.doesNotMatch(shown, absent);
  assert.ok(!fs.existsSync(path.join(repo, ".agent-daemon")));
});

test("duplicate guard: with ad init's hooks in Claude Code's settings, the plugin's hook for that step does nothing", () => {
  const { h, env } = tempHome();
  const repo = path.join(h, "work", "shop-app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "ad hook user-prompt-extract" }] }], SessionStart: [{ hooks: [{ type: "command", command: "ad session-start --output-json" }] }] } }));
  const r = runHook("user-prompt-extract", env, { session_id: "s1", cwd: repo, prompt: "Actually we use pnpm for installs, not npm." }, repo);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "{}");
  assert.equal(journals(h).length, 0, "ad's own hook captures; the plugin's doesn't");
  assert.equal(runHook("session-start", env, { cwd: repo }, repo).stdout, "{}");
  // query-retrieve isn't among these hooks: the plugin's own still runs.
  const q = runHook("query-retrieve", env, { cwd: repo, prompt: "how do we install packages here" }, repo);
  assert.equal(q.status, 0);
  assert.notEqual(q.stdout, "");
});

test("duplicate guard: only ad's own commands count; a conditional hook or another tool's never silences the plugin", () => {
  const { h } = tempHome();
  const repo = path.join(h, "work", "app");
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  const put = (file, cmd, extra = {}) => fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd, ...extra }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd, ...extra }] }] } }));
  const on = (name) => adHookInClaudeSettings(name, { env: {}, home: h, cwd: repo });
  const user = path.join(h, ".claude", "settings.json");
  const cases = [
    ["ad hook user-prompt-extract", [1, 0, 0]],
    ["agent-daemon session-start --output-json", [0, 0, 1]],
    ["ad query-retrieve --output-json", [0, 1, 0]],
    ['"C:/n/node.exe" "D:/x/runtime/src/cli.mjs" session-start', [0, 0, 1]],
    ["bash ~/.claude/hooks/session-start.sh", [0, 0, 0]],
    ["my-tool query-retrieve", [0, 0, 0]],
    ['node "${CLAUDE_PLUGIN_ROOT}/server/hook.mjs" session-start --host claude-code', [0, 0, 0]],
  ];
  for (const [cmd, steps] of cases) {
    put(user, cmd);
    assert.deepEqual(["user-prompt-extract", "query-retrieve", "session-start"].map((n) => (on(n) ? 1 : 0)), steps, cmd);
  }
  put(user, "agent-daemon session-start --output-json", { if: 'test -d "$CLAUDE_PROJECT_DIR/.agent-daemon"' });
  assert.equal(on("session-start"), false, "a conditional hook may not fire: the plugin keeps its step");
  fs.rmSync(user);
  put(path.join(repo, ".claude", "settings.local.json"), "ad hook user-prompt-extract");
  assert.equal(on("user-prompt-extract"), true, "a project's own settings count too");
});
