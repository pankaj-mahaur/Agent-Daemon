// L3 part 3d: the memory server's entry in Codex's config.toml as one inline table
// under [mcp_servers] (`codex mcp add` re-serialises table-form entries and drops
// 3.1.0's markers), and install moving a 3.1.0 entry — intact or damaged — to it.
// Temp homes only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const T = await import("../src/memory-install/edit-toml.mjs");
const { makeContext, install, uninstall } = await import("../src/memory-install/install.mjs");
const { readLedger } = await import("../src/memory-install/ledger.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const ENTRY = { command: "/usr/bin/node", args: ["--disable-warning=ExperimentalWarning", "/home/sam/.agent-daemon/memory/launch/run.mjs", "serve", "--host", "codex", "--capture", "tools"] };
const OLD = { command: "/usr/bin/node", args: ["--disable-warning=ExperimentalWarning", "/home/sam/.agent-daemon/memory/bin/launch.mjs", "serve", "--host", "codex", "--capture", "tools"] };
const doc = (text) => JSON.parse(JSON.stringify(parseToml(text)));
const without = (d) => {
  const c = structuredClone(d);
  if (c.mcp_servers) {
    delete c.mcp_servers[T.ENTRY_KEY];
    if (!Object.keys(c.mcp_servers).length) delete c.mcp_servers;
  }
  return c;
};
// 3.1.0's block, and the same after `codex mcp add other -- echo hi` (the pinned engine's real output).
const BLOCK = `${T.BEGIN}\n[mcp_servers.agent-daemon-memory]\ncommand = '/usr/bin/node'\nargs = ['--disable-warning=ExperimentalWarning', '/home/sam/.agent-daemon/memory/bin/launch.mjs', 'serve', '--host', 'codex', '--capture', 'tools']\n${T.END}\n`;
const DAMAGED = `model = "gpt-5"\n\n[mcp_servers.agent-daemon-memory]\ncommand = "/usr/bin/node"\nargs = ["--disable-warning=ExperimentalWarning", "/home/sam/.agent-daemon/memory/bin/launch.mjs", "serve", "--host", "codex", "--capture", "tools"]\n\n[mcp_servers.other]\ncommand = "echo"\nargs = ["hi"]\n${T.END}\n`;

test("the entry goes in as one inline table: under [mcp_servers], or in a table of its own; out again byte for byte", () => {
  const files = {
    empty: "",
    others: '# mine\nmodel = "o5"\n',
    header: '[mcp_servers]\n# servers\n\n[profiles.x]\nmodel = "a"\n',
    subtables: '[mcp_servers.github]\ncommand = "gh-mcp" # kept\n',
    crlf: 'model = "o5"\r\n\r\n[mcp_servers.github]\r\ncommand = "gh"\r\n',
  };
  for (const [name, text] of Object.entries(files)) {
    const r = T.planTomlAdd(text, ENTRY);
    assert.equal(r.action, "add", `${name}: ${r.reason}`);
    assert.deepEqual(doc(r.text).mcp_servers[T.ENTRY_KEY], ENTRY, name);
    assert.deepEqual(without(doc(r.text)), without(doc(text || "\n")), name);
    assert.equal([...r.text.matchAll(/^agent-daemon-memory = \{ command = /gm)].length, 1, `${name}: one inline line`);
    assert.equal(T.planTomlAdd(r.text, ENTRY).action, "same", name);
    const out = T.planTomlRemove(r.text, { entry: ENTRY, headerAdded: r.placement === "table" });
    assert.equal(out.action, "remove", name);
    assert.equal(out.text, text, `${name}: back as it was`);
  }
  assert.match(T.planTomlAdd(files.header, ENTRY).text, /^\[mcp_servers\]\nagent-daemon-memory = \{/m, "under the existing header");
});

test("3.1.0's block moves to the inline form, intact or as `codex mcp add` left it", () => {
  const intact = `model = "gpt-5"\n\n${BLOCK}`;
  for (const [name, text] of Object.entries({ intact, damaged: DAMAGED })) {
    const r = T.planTomlAdd(text, ENTRY, { owned: true });
    assert.equal(r.action, "update", `${name}: ${r.reason}`);
    assert.deepEqual(doc(r.text).mcp_servers[T.ENTRY_KEY], ENTRY);
    assert.deepEqual(without(doc(r.text)), without(doc(text)), `${name}: everything else as it was`);
    assert.ok(!r.text.includes(T.BEGIN) && !r.text.includes(T.END), `${name}: 3.1.0's markers are gone`);
    assert.ok(!/\[mcp_servers\.agent-daemon-memory\]/.test(r.text), name);
  }
  // Not ad's (no ledger record, a different entry): refused, file untouched.
  assert.equal(T.planTomlAdd(DAMAGED, ENTRY).action, "refuse");
  // Uninstall of a damaged 3.1.0 block (no move first) still removes it, the stray marker too.
  const out = T.planTomlRemove(DAMAGED, { entry: OLD });
  assert.equal(out.action, "remove");
  assert.ok(!out.text.includes(T.END));
  assert.deepEqual(doc(out.text), { model: "gpt-5", mcp_servers: { other: { command: "echo", args: ["hi"] } } });
});

test("the user's own entry, or one edited after ad wrote it, is left alone", () => {
  const mine = '[mcp_servers]\nagent-daemon-memory = { command = "my-node", args = [] }\n';
  assert.match(T.planTomlAdd(mine, ENTRY).reason, /which ad didn't write/);
  const r = T.planTomlAdd("", ENTRY);
  const edited = r.text.replace("'serve'", "'serve', '--verbose'");
  assert.equal(T.planTomlRemove(edited, { entry: ENTRY }).action, "edited");
  // Two definitions (an inline line and a table): refused rather than guessed.
  assert.equal(T.planTomlAdd(`${r.text}\n[mcp_servers.agent-daemon-memory]\ncommand = "x"\n`, ENTRY, { owned: true }).action, "refuse");
});

test("install moves a 3.1.0 Codex entry onto the stable launcher; uninstall then gives the file back", async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-codex-entry-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".codex"));
  const root = path.join(h, ".agent-daemon");
  const user = '# mine\nmodel = "gpt-5"\n';
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: path.join(h, ".codex"), CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: root, PATH: process.env.PATH };
  const lines = [];
  const ctx = makeContext({ env, home: h, root, resolve: () => null, out: (l) => lines.push(l), ask: async () => "", isTTY: () => false, noSetup: true });
  // 3.1.0's state: its block in config.toml and its v1 ledger record.
  const old = { command: ctx.node, args: ["--disable-warning=ExperimentalWarning", path.join(root, "memory", "bin", "launch.mjs"), "serve", "--host", "codex", "--capture", "tools", "env"].slice(0, 7) };
  old.env = { AD_ROOT: root };
  const file = path.join(h, ".codex", "config.toml");
  const block = `${T.BEGIN}\n[mcp_servers.agent-daemon-memory]\ncommand = ${T.tomlString(old.command)}\nargs = [${old.args.map(T.tomlString).join(", ")}]\nenv = { AD_ROOT = ${T.tomlString(root)} }\n${T.END}\n`;
  fs.writeFileSync(file, `${user}\n${block}`);
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "install-ledger.json"), JSON.stringify({ schemaVersion: 1, hosts: { codex: { driver: "file", file, realFile: file, entryKey: T.ENTRY_KEY, entry: old, version: "3.1.0", capture: "tools", installedBy: "npx", installedAt: new Date(0).toISOString(), restorable: false } } }));
  assert.equal(await install({ ctx, hosts: ["codex"], yes: true }), 0, lines.join("\n"));
  const now = fs.readFileSync(file, "utf8");
  assert.ok(!now.includes(T.BEGIN), now);
  assert.deepEqual(doc(now).mcp_servers[T.ENTRY_KEY].args.slice(1, 3), [path.join(root, "memory", "launch", "run.mjs"), "serve"]);
  assert.equal(readLedger(root).hosts.codex.entry.args[1], path.join(root, "memory", "launch", "run.mjs"));
  assert.equal(await uninstall({ ctx, hosts: ["codex"] }), 0, lines.join("\n"));
  assert.equal(fs.readFileSync(file, "utf8"), user);
});

// What the pinned engine's `codex mcp add other -- echo hi` left of 3.1.0's block with an env.
const DAMAGED_ENV = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.agent-daemon-memory]\ncommand = "/usr/bin/node"\nargs = ["--disable-warning=ExperimentalWarning", "/home/sam/.agent-daemon/memory/bin/launch.mjs", "serve", "--host", "codex", "--capture", "tools"]\n\n[mcp_servers.agent-daemon-memory.env]\nAD_ROOT = "/home/sam/.agent-daemon"\n\n[mcp_servers.other]\ncommand = "echo"\nargs = ["hi"]\n' + `${"# <<< agent-daemon-memory <<<"}\n\n# notes about profile x\n[profiles.x]\nmodel = "a"\n`;

test("review: a damaged 3.1.0 block with its env sub-table moves and goes; the user's comments and headers stay", () => {
  const OLD_ENV = { ...OLD, env: { AD_ROOT: "/home/sam/.agent-daemon" } };
  const r = T.planTomlAdd(DAMAGED_ENV, ENTRY, { owned: true });
  assert.equal(r.action, "update", r.reason);
  assert.deepEqual(without(doc(r.text)), without(doc(DAMAGED_ENV)));
  assert.match(r.text, /# notes about profile x\n\[profiles\.x\]/, "a comment above the next table stays with it");
  const out = T.planTomlRemove(DAMAGED_ENV, { entry: OLD_ENV });
  assert.equal(out.action, "remove", out.reason);
  assert.match(out.text, /# notes about profile x\n\[profiles\.x\]/);
  assert.ok(!/agent-daemon-memory/.test(out.text));
  // The user's own [mcp_servers] header (with a comment) is never taken, on install or uninstall.
  const mine = '[mcp_servers] # servers go here later\n';
  const a = T.planTomlAdd(mine, ENTRY);
  assert.equal(a.placement, "under");
  assert.equal(T.planTomlRemove(a.text, { entry: ENTRY, headerAdded: false }).text, mine);
  assert.equal(T.planTomlRemove(mine, { entry: ENTRY }).action, "absent", "nothing of ad's: nothing written");
  // A key of that name under another table isn't ad's entry.
  const other = '[profiles.x]\nagent-daemon-memory = { command = "x" }\n';
  const b = T.planTomlAdd(other, ENTRY);
  assert.equal(b.action, "add", b.reason);
  assert.equal(doc(b.text).profiles.x["agent-daemon-memory"].command, "x");
  assert.equal(T.planTomlRemove(b.text, { entry: ENTRY, headerAdded: b.placement === "table" }).text, other);
});

test("review: 3.1.0 entries not moved yet run this version, and doctor names them", async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-codex-legacy-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".cursor"));
  const root = path.join(h, ".agent-daemon");
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: path.join(h, ".codex-none"), CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: root, PATH: process.env.PATH };
  const lines = [];
  // An npx install of this version, with 3.1.0's current.json still there.
  const RT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fakepkg-"));
  made.push(pkg);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "agent-daemon-memory", version: "3.3.0" }));
  fs.writeFileSync(path.join(pkg, "cli.mjs"), "// fake\n");
  fs.mkdirSync(path.join(pkg, "bin"));
  fs.writeFileSync(path.join(pkg, "bin", "hook.mjs"), "// fake\n");
  fs.mkdirSync(path.join(pkg, "src", "memory", "launch"), { recursive: true });
  for (const f of ["run.mjs", "dists.mjs"]) fs.copyFileSync(path.join(RT, "src", "memory", "launch", f), path.join(pkg, "src", "memory", "launch", f));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "current.json"), JSON.stringify({ version: "3.1.0", path: path.join(root, "memory", "pkg", "3.1.0") }));
  const ctx = makeContext({ env, home: h, root, resolve: () => null, out: (l) => lines.push(l), ask: async () => "", isTTY: () => false, noSetup: true, packageRoot: pkg });
  assert.equal(await install({ ctx, hosts: ["cursor"], yes: true }), 0, lines.join("\n"));
  const cur = JSON.parse(fs.readFileSync(path.join(root, "memory", "current.json"), "utf8"));
  assert.equal(cur.version, "3.3.0");
  assert.ok(fs.existsSync(path.join(cur.path, "cli.mjs")), "3.1.0's launcher imports <path>/cli.mjs");
  // A v1 record still on 3.1.0's launcher: doctor says to move it.
  const led = readLedger(root);
  led.hosts.cursor.entry.args[1] = path.join(root, "memory", "bin", "launch.mjs");
  fs.writeFileSync(path.join(root, "memory", "install-ledger.json"), JSON.stringify(led));
  const { doctor } = await import("../src/memory-install/doctor.mjs");
  lines.length = 0;
  await doctor({ ctx, json: true });
  const checks = JSON.parse(lines.at(-1));
  assert.ok(checks.some((c) => c.code === "entry.legacy" && c.host === "cursor" && !c.ok));
});

test("review: an entry equal to ad's but in table form still moves to the inline line; no launcher, no entry", async () => {
  const table = `[mcp_servers.agent-daemon-memory]\ncommand = ${T.tomlString(ENTRY.command)}\nargs = [${ENTRY.args.map(T.tomlString).join(", ")}]\n`;
  const r = T.planTomlAdd(table, ENTRY, { owned: true });
  assert.equal(r.action, "update", "table form isn't the inline form: moved");
  assert.ok(!/\[mcp_servers\.agent-daemon-memory\]/.test(r.text));
  // A package without the launcher's files: install stops before writing any entry.
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-nolauncher-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".cursor"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fakepkg-"));
  made.push(pkg);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "agent-daemon-memory", version: "3.3.0" }));
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: path.join(h, ".codex-none"), CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: path.join(h, ".agent-daemon"), PATH: process.env.PATH };
  const lines = [];
  const ctx = makeContext({ env, home: h, root: env.AD_ROOT, resolve: () => null, out: (l) => lines.push(l), ask: async () => "", isTTY: () => false, noSetup: true, packageRoot: pkg });
  assert.equal(await install({ ctx, hosts: ["cursor"], yes: true }), 1, lines.join("\n"));
  assert.match(lines.join("\n"), /couldn't set up the launcher/);
  assert.ok(!fs.existsSync(path.join(h, ".cursor", "mcp.json")), "no entry that starts a launcher that isn't there");
});

test("review N1: after an update (Node moved), uninstall still takes back the [mcp_servers] header ad appended", async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-codex-update-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".codex"));
  const user = 'model = "a"\n';
  const file = path.join(h, ".codex", "config.toml");
  fs.writeFileSync(file, user);
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: path.join(h, ".codex"), CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: path.join(h, ".agent-daemon"), PATH: process.env.PATH };
  const lines = [];
  const mk = (node) => makeContext({ env, home: h, root: env.AD_ROOT, node, resolve: () => null, out: (l) => lines.push(l), ask: async () => "", isTTY: () => false, noSetup: true });
  assert.equal(await install({ ctx: mk("/usr/bin/node"), hosts: ["codex"], yes: true }), 0, lines.join("\n"));
  // Someone else writes the file too (so uninstall can't just restore the bytes), then Node moves.
  fs.appendFileSync(file, '\n[profiles.x]\nmodel = "b"\n');
  assert.equal(await install({ ctx: mk("/opt/node/bin/node"), hosts: ["codex"], yes: true }), 0, lines.join("\n"));
  assert.equal(readLedger(env.AD_ROOT).hosts.codex.tomlPlacement, "table");
  assert.equal(await uninstall({ ctx: mk("/opt/node/bin/node"), hosts: ["codex"] }), 0, lines.join("\n"));
  assert.ok(!/\[mcp_servers\]/.test(fs.readFileSync(file, "utf8")), fs.readFileSync(file, "utf8"));
});

test("review: a comment right above the next table, and a bare [mcp_servers] header of the user's, stay", () => {
  const table = `[mcp_servers.agent-daemon-memory]\ncommand = ${T.tomlString(OLD.command)}\nargs = [${OLD.args.map(T.tomlString).join(", ")}]\n\n# my profile note\n[profiles.x]\nmodel = "a"\n`;
  const out = T.planTomlRemove(table, { entry: OLD });
  assert.equal(out.action, "remove", out.reason);
  assert.match(out.text, /# my profile note\n\[profiles\.x\]/);
  const bare = '[mcp_servers]\n\n[profiles.x]\nmodel = "a"\n';
  const a = T.planTomlAdd(bare, ENTRY);
  assert.equal(T.planTomlRemove(a.text, { entry: ENTRY, headerAdded: false }).text, bare, "the user's header stays");
});
