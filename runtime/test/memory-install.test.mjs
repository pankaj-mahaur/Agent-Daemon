// P5.3: the memory installer end to end, in fake homes only (HOME, USERPROFILE,
// APPDATA, XDG_CONFIG_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, AD_ROOT), with a
// fake `claude` (testkit/fake-claude.mjs). Real host configs are never read.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";

const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "testkit", "fake-claude.mjs");
const REAL_HOME = (() => {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
})();
const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { makeContext, install, uninstall, status } = await import("../src/memory-install/install.mjs");
const { doctor } = await import("../src/memory-install/doctor.mjs");
const { readLedger } = await import("../src/memory-install/ledger.mjs");
const { BEGIN } = await import("../src/memory-install/edit-toml.mjs");

/** A fake home with the hosts asked for; ctx with the fake claude when `claude` is on. */
function home({ claude = true, claudeDir = true, codex = true, cursor = true, files = {} } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-install-home-"));
  made.push(h);
  if (REAL_HOME) assert.notEqual(path.resolve(h).toLowerCase(), path.resolve(REAL_HOME).toLowerCase());
  if (claudeDir) fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  if (codex) fs.mkdirSync(path.join(h, ".codex"), { recursive: true });
  if (cursor) fs.mkdirSync(path.join(h, ".cursor"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(h, rel), text);
  const env = {
    HOME: h, USERPROFILE: h, APPDATA: path.join(h, "AppData"), XDG_CONFIG_HOME: path.join(h, ".config"),
    CODEX_HOME: path.join(h, ".codex"), CLAUDE_CONFIG_DIR: path.join(h, ".claude"), AD_ROOT: path.join(h, ".agent-daemon"),
    FAKE_CLAUDE_STATE: path.join(h, "fake-claude-state.json"), FAKE_CLAUDE_LOG: path.join(h, "fake-claude.log"),
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  };
  const lines = [];
  const answers = [];
  const ctx = makeContext({
    env, home: h, root: env.AD_ROOT,
    resolve: (name) => (name === "claude" && claude ? { cmd: process.execPath, prefix: [SHIM], via: "env", file: SHIM } : null),
    out: (l) => lines.push(String(l)),
    ask: async () => answers.shift() ?? "",
  });
  return { h, env, ctx, lines, answers, text: () => lines.join("\n"), claudeLog: () => (fs.existsSync(env.FAKE_CLAUDE_LOG) ? fs.readFileSync(env.FAKE_CLAUDE_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
const read = (p) => fs.readFileSync(p);
const codexFile = (h) => path.join(h, ".codex", "config.toml");
const cursorFile = (h) => path.join(h, ".cursor", "mcp.json");

test("install sets up all three hosts, through each host's own route, and is idempotent", async () => {
  const t = home();
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  assert.match(t.text(), /Found: Claude Code, Codex, Cursor\./);
  // Claude Code: only through its CLI, user scope, argv after "--".
  const adds = t.claudeLog().filter((a) => a[1] === "add");
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].slice(0, 7), ["mcp", "add", "--transport", "stdio", "--scope", "user", "agent-daemon-memory"]);
  assert.equal(adds[0][7], "--");
  assert.equal(adds[0][8], process.execPath, "the absolute node path");
  assert.ok(!fs.existsSync(path.join(t.h, ".claude.json")), "ad never writes Claude Code's own files");
  // Codex: a managed block. Cursor: the mcpServers entry with the project variable.
  const toml = parseToml(fs.readFileSync(codexFile(t.h), "utf8"));
  assert.equal(toml.mcp_servers["agent-daemon-memory"].command, process.execPath);
  assert.ok(toml.mcp_servers["agent-daemon-memory"].args.includes("codex"));
  assert.deepEqual({ ...toml.mcp_servers["agent-daemon-memory"].env }, { AD_ROOT: t.env.AD_ROOT }, "Codex passes servers a fixed environment");
  const cur = parseJsonc(fs.readFileSync(cursorFile(t.h), "utf8")).mcpServers["agent-daemon-memory"];
  assert.deepEqual(cur.args.slice(-2), ["--project", "${workspaceFolder}"]);
  assert.match(t.text(), /Restart Cursor to load it\./);
  const led = readLedger(t.env.AD_ROOT);
  assert.deepEqual(Object.keys(led.hosts).sort(), ["claude-code", "codex", "cursor"]);
  assert.equal(led.hosts.codex.preBytesSha256, null, "no config.toml before");
  // Again: already set up, no new backup, no second add.
  const backups = () => (fs.existsSync(path.join(t.env.AD_ROOT, "memory", "backups")) ? fs.readdirSync(path.join(t.env.AD_ROOT, "memory", "backups"), { recursive: true }).length : 0);
  const b0 = backups();
  t.lines.length = 0;
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  assert.equal((t.text().match(/already set up/g) ?? []).length >= 3, true, t.text());
  assert.equal(backups(), b0);
  assert.equal(t.claudeLog().filter((a) => a[1] === "add").length, 1);
  assert.equal(status({ ctx: t.ctx }), 0);
});

test("P5.4: VS Code (the portable Copilot file) and Gemini CLI (user settings): add, keep the rest, restore byte for byte", async () => {
  const vscodeText = '{\n  // personal servers\n  "mcpServers": {\n    "github": { "type": "stdio", "command": "gh-mcp" }\n  }\n}\n';
  const geminiText = '{\n  "theme": "Dracula",\n  "general": { "vimMode": true }\n}\n';
  const t = home({ claude: false, claudeDir: false, codex: false, cursor: false });
  fs.mkdirSync(path.join(t.h, ".copilot"));
  fs.mkdirSync(path.join(t.h, ".gemini"));
  fs.writeFileSync(path.join(t.h, ".copilot", "mcp-config.json"), vscodeText);
  fs.writeFileSync(path.join(t.h, ".gemini", "settings.json"), geminiText);
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  assert.match(t.text(), /Found: VS Code, Gemini CLI\./);
  const v = parseJsonc(fs.readFileSync(path.join(t.h, ".copilot", "mcp-config.json"), "utf8"));
  assert.equal(v.mcpServers["agent-daemon-memory"].type, "stdio");
  assert.equal(v.mcpServers["agent-daemon-memory"].command, process.execPath);
  assert.ok(v.mcpServers["agent-daemon-memory"].args.includes("vscode"));
  assert.ok(v.mcpServers.github, "the user's server stays");
  assert.ok(fs.readFileSync(path.join(t.h, ".copilot", "mcp-config.json"), "utf8").includes("// personal servers"));
  const g = JSON.parse(fs.readFileSync(path.join(t.h, ".gemini", "settings.json"), "utf8"));
  assert.equal(g.theme, "Dracula");
  assert.deepEqual(g.general, { vimMode: true });
  assert.ok(g.mcpServers["agent-daemon-memory"].args.includes("gemini"));
  assert.equal(g.mcpServers["agent-daemon-memory"].type, undefined, "Gemini's entry has no type field");
  assert.deepEqual(g.mcpServers["agent-daemon-memory"].env, { AD_ROOT: t.env.AD_ROOT }, "Gemini passes servers only safe variables");
  assert.deepEqual(Object.keys(readLedger(t.env.AD_ROOT).hosts).sort(), ["gemini", "vscode"]);
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.equal(fs.readFileSync(path.join(t.h, ".copilot", "mcp-config.json"), "utf8"), vscodeText);
  assert.equal(fs.readFileSync(path.join(t.h, ".gemini", "settings.json"), "utf8"), geminiText);
});

test("P5.4: one route per host — with the Claude Code plugin enabled, the installer leaves Claude Code alone and doctor flags both", async () => {
  const t = home({ codex: false, cursor: false });
  fs.writeFileSync(path.join(t.h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "agent-daemon-memory@agent-daemon": true, "other@x": true } }));
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  assert.match(t.text(), /Claude Code\s+leaves it: ad's memory is already enabled here as a plugin \(agent-daemon-memory@agent-daemon\)/);
  assert.equal(t.claudeLog().filter((a) => a[1] === "add").length, 0, "no second server");
  // A disabled plugin doesn't count.
  const u = home({ codex: false, cursor: false });
  fs.writeFileSync(path.join(u.h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "agent-daemon-memory@agent-daemon": false } }));
  assert.equal(await install({ ctx: u.ctx, yes: true }), 0, u.text());
  assert.equal(u.claudeLog().filter((a) => a[1] === "add").length, 1);
  // Installed first, plugin enabled later: doctor says both serve memory.
  fs.writeFileSync(path.join(u.h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "agent-daemon-memory@agent-daemon": true } }));
  u.lines.length = 0;
  await doctor({ ctx: u.ctx, json: true });
  assert.match(u.text(), /route\.double/);
  assert.match(u.text(), /the agent-daemon-memory@agent-daemon plugin also serves memory here/);
});

test("P5.4: COPILOT_HOME and GEMINI_CLI_HOME move the files; VS Code is found by its user data folder too", async () => {
  const t = home({ claude: false, claudeDir: false, codex: false, cursor: false });
  t.env.COPILOT_HOME = path.join(t.h, "copilot-elsewhere");
  t.env.GEMINI_CLI_HOME = path.join(t.h, "gemini-home");
  fs.mkdirSync(path.join(t.env.GEMINI_CLI_HOME, ".gemini"), { recursive: true });
  // No ~/.copilot yet: VS Code is found by its user data folder.
  fs.mkdirSync(path.join(t.env.XDG_CONFIG_HOME, "Code - Insiders", "User"), { recursive: true });
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  assert.ok(fs.existsSync(path.join(t.env.COPILOT_HOME, "mcp-config.json")));
  assert.ok(fs.existsSync(path.join(t.env.GEMINI_CLI_HOME, ".gemini", "settings.json")));
  assert.ok(!fs.existsSync(path.join(t.h, ".copilot")) && !fs.existsSync(path.join(t.h, ".gemini")));
});

test("uninstall restores untouched configs byte for byte, and keeps hand edits", async () => {
  const codexText = '# my config\nmodel = "o5"\n\n[mcp_servers.github]\ncommand = "gh-mcp" # keep me\n';
  const cursorText = '{\n  // mine\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n';
  // Unchanged since install → exact original bytes.
  const a = home({ files: { ".codex/config.toml": codexText, ".cursor/mcp.json": cursorText } });
  assert.equal(await install({ ctx: a.ctx, yes: true }), 0, a.text());
  assert.equal(await uninstall({ ctx: a.ctx }), 0, a.text());
  assert.equal(fs.readFileSync(codexFile(a.h), "utf8"), codexText);
  assert.equal(fs.readFileSync(cursorFile(a.h), "utf8"), cursorText);
  assert.equal(a.claudeLog().filter((x) => x[1] === "remove").length, 1);
  assert.deepEqual(readLedger(a.env.AD_ROOT).hosts, {});
  // Hand edits after install → only ad's entry goes.
  const b = home({ files: { ".codex/config.toml": codexText, ".cursor/mcp.json": cursorText } });
  await install({ ctx: b.ctx, yes: true });
  fs.appendFileSync(codexFile(b.h), '\n# added later\n[mcp_servers.mine]\ncommand = "mine"\n');
  const cj = fs.readFileSync(cursorFile(b.h), "utf8").replace('"github": { "command": "gh-mcp" }', '"github": { "command": "gh-mcp" }, // edited\n    "mine": { "command": "mine" }');
  fs.writeFileSync(cursorFile(b.h), cj);
  assert.equal(await uninstall({ ctx: b.ctx }), 0, b.text());
  const ct = fs.readFileSync(codexFile(b.h), "utf8");
  assert.ok(!ct.includes(BEGIN) && !ct.includes("agent-daemon-memory"));
  assert.ok(ct.includes("# keep me") && ct.includes("# added later\n[mcp_servers.mine]\ncommand = \"mine\"\n"));
  const cu = fs.readFileSync(cursorFile(b.h), "utf8");
  assert.ok(!cu.includes("agent-daemon-memory"));
  assert.ok(cu.includes("// mine") && cu.includes("// edited") && cu.includes('"mine": { "command": "mine" }'));
  // A file that didn't exist before is removed again.
  const c = home({ claude: false, claudeDir: false });
  await install({ ctx: c.ctx, yes: true });
  await uninstall({ ctx: c.ctx });
  assert.ok(!fs.existsSync(codexFile(c.h)) && !fs.existsSync(cursorFile(c.h)));
});

test("refusals leave the file untouched and print the snippet: malformed JSON, read-only, a hidden TOML entry", async () => {
  const bad = '{ "mcpServers": { ';
  const dotted = 'mcp_servers.agent-daemon-memory.command = "node"\n';
  const t = home({ claude: false, claudeDir: false, files: { ".cursor/mcp.json": bad, ".codex/config.toml": dotted } });
  assert.equal(await install({ ctx: t.ctx, yes: true }), 1, t.text());
  assert.equal(fs.readFileSync(cursorFile(t.h), "utf8"), bad);
  assert.equal(fs.readFileSync(codexFile(t.h), "utf8"), dotted);
  assert.match(t.text(), /✗ Codex: it already defines agent-daemon-memory outside ad's markers; add this yourself:\n# >>> agent-daemon-memory/);
  assert.match(t.text(), /✗ Cursor: it isn't valid JSON/);
  // Read-only.
  const r = home({ claude: false, claudeDir: false, codex: false, files: { ".cursor/mcp.json": "{}\n" } });
  fs.chmodSync(cursorFile(r.h), 0o444);
  assert.equal(await install({ ctx: r.ctx, yes: true }), 1, r.text());
  assert.match(r.text(), /read-only/);
  fs.chmodSync(cursorFile(r.h), 0o644);
  assert.equal(fs.readFileSync(cursorFile(r.h), "utf8"), "{}\n");
  // One host refused, another set up: partial (2).
  const p = home({ claude: false, claudeDir: false, files: { ".codex/config.toml": dotted } });
  assert.equal(await install({ ctx: p.ctx, yes: true }), 2, p.text());
});

test("~/.claude without the claude command: the command is printed, nothing runs", async () => {
  const t = home({ claude: false, codex: false, cursor: false });
  assert.equal(await install({ ctx: t.ctx, yes: true }), 1, t.text());
  assert.match(t.text(), /the claude command isn't on PATH; add this yourself:\nclaude mcp add --transport stdio --scope user agent-daemon-memory --/);
  assert.deepEqual(t.claudeLog(), []);
});

test("--dry-run and a declined plan write nothing", async () => {
  const t = home();
  assert.equal(await install({ ctx: t.ctx, dryRun: true }), 0);
  assert.ok(!fs.existsSync(codexFile(t.h)) && !fs.existsSync(cursorFile(t.h)));
  assert.equal(t.claudeLog().filter((a) => a[1] === "add").length, 0);
  t.answers.push("n");
  assert.equal(await install({ ctx: t.ctx }), 1);
  assert.match(t.text(), /Nothing changed\./);
  assert.ok(!fs.existsSync(codexFile(t.h)));
});

test("a linked config needs an explicit yes even with --yes", { skip: process.platform === "win32" && "file symlinks need admin rights on Windows" }, async () => {
  const t = home({ claude: false, claudeDir: false, codex: false });
  const real = path.join(t.h, "dotfiles", "mcp.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "{}\n");
  fs.symlinkSync(real, cursorFile(t.h));
  t.answers.push("");
  assert.equal(await install({ ctx: t.ctx, yes: true }), 1, t.text());
  assert.match(t.text(), /It is a link to /);
  assert.equal(fs.readFileSync(real, "utf8"), "{}\n");
  t.answers.push("y");
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  assert.ok(fs.lstatSync(cursorFile(t.h)).isSymbolicLink(), "the link stays a link");
  assert.match(fs.readFileSync(real, "utf8"), /agent-daemon-memory/);
});

test("upgrade then uninstall puts back the bytes from before the first install", async () => {
  const original = '# mine\nmodel = "o5"\n';
  const t = home({ claude: false, claudeDir: false, cursor: false, files: { ".codex/config.toml": original } });
  await install({ ctx: t.ctx, yes: true, capture: "tools" });
  // A newer package (another target path) updates the entry.
  const ctx2 = { ...t.ctx, version: "9.9.9", target: path.join(t.h, "elsewhere", "memory-server.mjs") };
  assert.equal(await install({ ctx: ctx2, yes: true }), 0, t.text());
  const led = readLedger(t.env.AD_ROOT);
  assert.equal(led.hosts.codex.version, "9.9.9");
  assert.ok(led.hosts.codex.originalBackup, "the first install's backup is kept");
  assert.equal(await uninstall({ ctx: ctx2 }), 0, t.text());
  assert.equal(fs.readFileSync(codexFile(t.h), "utf8"), original);
});

test("--purge-data: refused while ad uses the same memory; --force asks for the typed words", async () => {
  const t = home({ claude: false, claudeDir: false, cursor: false });
  await install({ ctx: t.ctx, yes: true });
  fs.writeFileSync(path.join(t.env.AD_ROOT, "episodic.db"), "x");
  // This test runs from the clone, so the entries are installedBy "ad".
  assert.equal(readLedger(t.env.AD_ROOT).hosts.codex.installedBy, "ad");
  assert.equal(await uninstall({ ctx: t.ctx, purgeData: true }), 2, "the host was removed, the purge refused");
  assert.ok(fs.existsSync(path.join(t.env.AD_ROOT, "episodic.db")));
  assert.match(t.text(), /Memory data kept/);
  t.answers.push("yes");
  assert.equal(await uninstall({ ctx: t.ctx, purgeData: true, force: true }), 1);
  assert.ok(fs.existsSync(path.join(t.env.AD_ROOT, "episodic.db")));
  t.answers.push("delete my memory");
  assert.equal(await uninstall({ ctx: t.ctx, purgeData: true, force: true }), 0);
  assert.ok(!fs.existsSync(path.join(t.env.AD_ROOT, "episodic.db")));
});

test("a Codex home inside ad's own folder (ad's engine) is refused", async () => {
  const t = home({ claude: false, claudeDir: false, cursor: false });
  const engine = path.join(t.env.AD_ROOT, "engine");
  fs.mkdirSync(engine, { recursive: true });
  const ctx = makeContext({ env: { ...t.env, CODEX_HOME: engine }, home: t.h, root: t.env.AD_ROOT, resolve: () => null, out: (l) => t.lines.push(l), ask: async () => "" });
  assert.equal(await install({ ctx, yes: true }), 1);
  assert.match(t.text(), /ad's own engine home/);
  assert.ok(!fs.existsSync(path.join(engine, "config.toml")));
  // Through a link (a junction on Windows) too.
  const link = path.join(t.h, "codex-link");
  fs.symlinkSync(engine, link, process.platform === "win32" ? "junction" : "dir");
  const viaLink = makeContext({ env: { ...t.env, CODEX_HOME: link }, home: t.h, root: t.env.AD_ROOT, resolve: () => null, out: (l) => t.lines.push(l), ask: async () => "" });
  assert.equal(await install({ ctx: viaLink, yes: true }), 1);
  assert.ok(!fs.existsSync(path.join(engine, "config.toml")));
});

test("review C1: edits made between the first install and an upgrade survive uninstall", async () => {
  // No mcp.json before the first install, then the user adds a server, then an upgrade.
  const t = home({ claude: false, claudeDir: false, codex: false });
  await install({ ctx: t.ctx, yes: true });
  const j = JSON.parse(fs.readFileSync(cursorFile(t.h), "utf8"));
  j.mcpServers.mine = { command: "mine" };
  fs.writeFileSync(cursorFile(t.h), JSON.stringify(j, null, 2));
  const upgraded = { ...t.ctx, version: "9.9.9", target: path.join(t.h, "newer", "memory-server.mjs") };
  assert.equal(await install({ ctx: upgraded, yes: true }), 0, t.text());
  assert.equal(readLedger(t.env.AD_ROOT).hosts.cursor.restorable, false);
  assert.equal(await uninstall({ ctx: upgraded }), 0, t.text());
  assert.ok(fs.existsSync(cursorFile(t.h)), "the file holding the user's server is not deleted");
  const after = JSON.parse(fs.readFileSync(cursorFile(t.h), "utf8"));
  assert.deepEqual(after.mcpServers.mine, { command: "mine" });
  assert.equal(after.mcpServers["agent-daemon-memory"], undefined);
});

test("review H1: a hand edit to ad's entry is kept by install and repair", async () => {
  const t = home({ claude: false, claudeDir: false, codex: false });
  await install({ ctx: t.ctx, yes: true });
  const j = JSON.parse(fs.readFileSync(cursorFile(t.h), "utf8"));
  j.mcpServers["agent-daemon-memory"].env = { MY_VAR: "1" };
  fs.writeFileSync(cursorFile(t.h), JSON.stringify(j, null, 2));
  const before = fs.readFileSync(cursorFile(t.h));
  const other = { ...t.ctx, target: path.join(t.h, "newer", "memory-server.mjs") };
  assert.equal(await install({ ctx: other, yes: true }), 1, t.text());
  assert.ok(fs.readFileSync(cursorFile(t.h)).equals(before), "the user's edit stays");
  assert.match(t.text(), /already defines agent-daemon-memory/);
});

test("review H2: an npx upgrade copies the new package even when every entry is unchanged", async () => {
  const t = home({ claude: false, claudeDir: false, codex: false });
  const pkg = (v) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fakepkg-"));
    made.push(d);
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "agent-daemon-memory", version: v }));
    fs.writeFileSync(path.join(d, "cli.mjs"), "// fake\n");
    return d;
  };
  const npx = (v) => makeContext({ env: t.env, home: t.h, root: t.env.AD_ROOT, resolve: () => null, out: (l) => t.lines.push(l), ask: async () => "", packageRoot: pkg(v) });
  assert.equal(await install({ ctx: npx("3.2.0"), yes: true }), 0, t.text());
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.env.AD_ROOT, "memory", "current.json"), "utf8")).version, "3.2.0");
  t.lines.length = 0;
  assert.equal(await install({ ctx: npx("3.2.1"), yes: true }), 0, t.text());
  assert.match(t.text(), /already set up/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.env.AD_ROOT, "memory", "current.json"), "utf8")).version, "3.2.1");
  assert.ok(fs.existsSync(path.join(t.env.AD_ROOT, "memory", "pkg", "3.2.1", "cli.mjs")));
  // Uninstalling the last host removes the launcher and the copies.
  assert.equal(await uninstall({ ctx: npx("3.2.1") }), 0);
  assert.ok(!fs.existsSync(path.join(t.env.AD_ROOT, "memory", "pkg")) && !fs.existsSync(path.join(t.env.AD_ROOT, "memory", "bin")));
});

test("review H3: a config that changes while ad asks isn't written over", async () => {
  const t = home({ claude: false, claudeDir: false, codex: false, files: { ".cursor/mcp.json": "{}\n" } });
  const ctx = { ...t.ctx, ask: async () => (fs.writeFileSync(cursorFile(t.h), '{ "theirs": 1 }\n'), "y") };
  assert.equal(await install({ ctx }), 1, t.text());
  assert.match(t.text(), /changed while ad was asking/);
  assert.equal(fs.readFileSync(cursorFile(t.h), "utf8"), '{ "theirs": 1 }\n');
});

test("review M1: a Codex config with dates and times: uninstall of an edited file removes ad's block", async () => {
  const text = 'start = 1979-05-27\nat = 07:32:00\nwhen = 1979-05-27T07:32:00\n';
  const t = home({ claude: false, claudeDir: false, cursor: false, files: { ".codex/config.toml": text } });
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0, t.text());
  fs.appendFileSync(codexFile(t.h), "\n# mine\n");
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  const back = fs.readFileSync(codexFile(t.h), "utf8");
  assert.ok(back.startsWith(text) && back.includes("# mine") && !back.includes("agent-daemon-memory"));
});

test("review M2: Claude Code — an unreadable list refuses, and only a user-scope entry is ad's", async () => {
  const t = home({ codex: false, cursor: false });
  const failing = { ...t.ctx, claudeOpts: { env: { ...t.env, FAKE_CLAUDE_GET_FAIL: "1" } } };
  assert.equal(await install({ ctx: failing, yes: true }), 1, t.text());
  assert.match(t.text(), /couldn't read Claude Code's MCP servers/);
  assert.equal(t.claudeLog().filter((a) => a[1] === "add").length, 0);
  // A project-scope entry of the same name (the user's) doesn't count as ad's.
  const proj = { ...t.ctx, claudeOpts: { env: { ...t.env, FAKE_CLAUDE_OTHER_SCOPE: "project" } } };
  t.lines.length = 0;
  assert.equal(await install({ ctx: proj, yes: true }), 0, t.text());
  assert.equal(t.claudeLog().filter((a) => a[1] === "add").length, 1);
  assert.match(t.text(), /also has an agent-daemon-memory in its project scope/);
});

test("review M4: a config that isn't UTF-8 is refused; a byte restore is exact", async () => {
  const latin1 = Buffer.from('{\n  "name": "caf\xe9"\n}\n', "latin1");
  const t = home({ claude: false, claudeDir: false, codex: false });
  fs.writeFileSync(cursorFile(t.h), latin1);
  assert.equal(await install({ ctx: t.ctx, yes: true }), 1);
  assert.match(t.text(), /isn't UTF-8/);
  assert.ok(fs.readFileSync(cursorFile(t.h)).equals(latin1));
  // Installed into UTF-8, then the user saves a Latin-1 comment: uninstall refuses, bytes kept.
  const u = home({ claude: false, claudeDir: false, codex: false, files: { ".cursor/mcp.json": "{}\n" } });
  await install({ ctx: u.ctx, yes: true });
  const edited = Buffer.concat([fs.readFileSync(cursorFile(u.h)), Buffer.from("// caf\xe9\n", "latin1")]);
  fs.writeFileSync(cursorFile(u.h), edited);
  assert.equal(await uninstall({ ctx: u.ctx }), 1, u.text());
  assert.match(u.text(), /isn't UTF-8 text any more/);
  assert.ok(fs.readFileSync(cursorFile(u.h)).equals(edited));
});

test("review L1: ad's entry already in place without a ledger record is recorded, without a byte restore", async () => {
  const t = home({ claude: false, claudeDir: false, cursor: false });
  await install({ ctx: t.ctx, yes: true });
  fs.rmSync(path.join(t.env.AD_ROOT, "memory", "install-ledger.json"));
  assert.equal(await install({ ctx: t.ctx, yes: true }), 0);
  const rec = readLedger(t.env.AD_ROOT).hosts.codex;
  assert.equal(rec.restorable, false);
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.ok(!fs.readFileSync(codexFile(t.h), "utf8").includes("agent-daemon-memory"));
});

test("doctor: both handshakes against the installed entry, and the per-host checks", async () => {
  const t = home({ claude: false, claudeDir: false });
  await install({ ctx: t.ctx, yes: true });
  t.lines.length = 0;
  const code = await doctor({ ctx: t.ctx, json: true, cwd: t.h });
  const checks = JSON.parse(t.lines.at(-1));
  const by = (c, h) => checks.find((x) => x.code === c && x.host === h);
  for (const h of ["codex", "cursor"]) {
    for (const c of ["config.parse", "entry", "node.path", "command.exists", "smoke.legacy", "smoke.modern"]) assert.equal(by(c, h)?.ok, true, `${h} ${c}: ${JSON.stringify(by(c, h))}`);
  }
  assert.equal(checks.find((c) => c.code === "db.schema").ok, true);
  assert.equal(code, 0, JSON.stringify(checks.filter((c) => !c.ok)));
  // An entry whose script doesn't speak MCP fails both smokes.
  const dead = path.join(t.h, "dead.mjs");
  fs.writeFileSync(dead, "process.exit(0);\n");
  const cj = JSON.parse(fs.readFileSync(cursorFile(t.h), "utf8"));
  cj.mcpServers["agent-daemon-memory"].args[1] = dead;
  fs.writeFileSync(cursorFile(t.h), JSON.stringify(cj));
  const led = readLedger(t.env.AD_ROOT);
  led.hosts.cursor.entry = cj.mcpServers["agent-daemon-memory"];
  fs.writeFileSync(path.join(t.env.AD_ROOT, "memory", "install-ledger.json"), JSON.stringify(led));
  t.lines.length = 0;
  assert.equal(await doctor({ ctx: t.ctx, json: true, cwd: t.h }), 1);
  const smoked = JSON.parse(t.lines.at(-1));
  assert.equal(smoked.find((c) => c.code === "smoke.legacy" && c.host === "cursor").ok, false);
  assert.equal(smoked.find((c) => c.code === "smoke.modern" && c.host === "cursor").ok, false);
  // A broken config is reported, not repaired by doctor.
  fs.writeFileSync(cursorFile(t.h), "{ broken");
  t.lines.length = 0;
  assert.equal(await doctor({ ctx: t.ctx, json: true, cwd: t.h }), 1);
  assert.equal(JSON.parse(t.lines.at(-1)).find((c) => c.code === "config.parse" && c.host === "cursor").ok, false);
});
