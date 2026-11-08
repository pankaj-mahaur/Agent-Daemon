// L3 part 3c: setup's Codex items — the memory hooks through the stable launcher
// (hooks.json, or config.toml when it already holds hook arrays), appended so the
// user's groups keep their trust positions, and the agent-shell marker; uninstall
// removes them as written, never rewrites them, and gives the files back. Temp homes
// and roots only; no real Codex runs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { makeContext, install, uninstall } = await import("../src/memory-install/install.mjs");
const S = await import("../src/memory-install/setup.mjs");
const C = await import("../src/memory-install/setup-codex.mjs");
const { readLedger2 } = await import("../src/memory-install/ledger2.mjs");
const D = await import("../src/memory/launch/dists.mjs");
const R = await import("../src/hooks/routes.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const USER_TOML = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';

function home({ config, hooks, platform = "linux", root, rulesExist = false } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-setup-codex-"));
  made.push(h);
  const codex = path.join(h, ".codex");
  fs.mkdirSync(codex, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(codex, "config.toml"), config);
  if (hooks !== undefined) fs.writeFileSync(path.join(codex, "hooks.json"), typeof hooks === "string" ? hooks : JSON.stringify(hooks, null, 2) + "\n");
  const adRoot = root ? path.join(h, root, ".agent-daemon") : path.join(h, ".agent-daemon");
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: adRoot, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const ctx = makeContext({
    env, home: h, root: adRoot, viaLauncher: false, platform,
    resolve: () => null, out: (l) => lines.push(String(l)), ask: async () => "",
    isTTY: () => true, claudeVersion: async () => "2.1.319", rulesExist: () => rulesExist, confirmReview: async () => false, lockWaitMs: 50,
  });
  const config_ = path.join(codex, "config.toml");
  const hooks_ = path.join(codex, "hooks.json");
  return {
    h, env, ctx, lines, text: () => lines.join("\n"), config: config_, hooksFile: hooks_, launcher: D.launcherFile(adRoot),
    toml: () => JSON.parse(JSON.stringify(parseToml(fs.readFileSync(config_, "utf8")))),
    json: () => JSON.parse(fs.readFileSync(hooks_, "utf8")),
  };
}
// The exact line for the platform the test's context says (win32 turns \ into /).
const line = (t, event) => C.codexCommand(t.launcher, event, t.ctx.platform);
const launcherGroups = (hooks) => R.ourHandlers(hooks).filter((o) => o.info.launcher);

test("Codex: hooks in hooks.json with the exact line, the marker in config.toml; a re-run changes nothing; uninstall gives both back", async () => {
  const t = home({ config: USER_TOML });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  const hooks = t.json().hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "SessionStart", "UserPromptSubmit"]);
  assert.deepEqual(hooks.SessionStart, [{ hooks: [{ type: "command", command: line(t, "session.start"), timeout: 10 }] }]);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: "Bash|Write|Edit", hooks: [{ type: "command", command: line(t, "tool.before"), timeout: 10 }] }]);
  for (const o of launcherGroups(hooks)) assert.equal(o.info.host, "codex");
  assert.equal(fs.readFileSync(t.config, "utf8"), `${USER_TOML}\n[shell_environment_policy.set]\nAD_TOOL_SHELL = "1"\n`);
  assert.match(t.text(), /run \/hooks to trust ad's hooks/);
  const items = readLedger2(t.env.AD_ROOT).items.filter((i) => i.host === "codex");
  assert.deepEqual(items.map((i) => i.kind).sort(), ["env", "hook", "hook", "hook"]);
  const bytes = [fs.readFileSync(t.config), fs.readFileSync(t.hooksFile)];
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  assert.ok(fs.readFileSync(t.config).equals(bytes[0]) && fs.readFileSync(t.hooksFile).equals(bytes[1]), "the same bytes: Codex's trust in them holds");
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.equal(fs.readFileSync(t.config, "utf8"), USER_TOML);
  assert.ok(!fs.existsSync(t.hooksFile), "the hooks.json setup created goes");
  assert.equal(readLedger2(t.env.AD_ROOT).items.length, 0);
});

test("Codex on Windows: no tool.before until the first rule", async () => {
  const t = home({ config: "", platform: "win32" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.deepEqual(Object.keys(t.json().hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
});

test("Codex with hook arrays in config.toml: ours appended there, the user's groups and trust keys untouched, and taken out again", async () => {
  const config = [
    'model = "gpt-5"',
    "",
    "[[hooks.SessionStart]]",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    'command = "echo mine"',
    "",
    '[hooks.state."config.toml:session_start:0:0"]',
    'trusted_hash = "abc"',
    "",
  ].join("\n");
  const t = home({ config });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(!fs.existsSync(t.hooksFile));
  const doc = t.toml();
  assert.deepEqual(doc.hooks.SessionStart[0], { hooks: [{ type: "command", command: "echo mine" }] }, "the user's group keeps index 0");
  assert.equal(doc.hooks.SessionStart[1].hooks[0].command, line(t, "session.start"));
  assert.deepEqual(doc.hooks.state, { "config.toml:session_start:0:0": { trusted_hash: "abc" } });
  assert.equal(doc.shell_environment_policy.set.AD_TOOL_SHELL, "1");
  const once = fs.readFileSync(t.config);
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  assert.ok(fs.readFileSync(t.config).equals(once));
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.equal(fs.readFileSync(t.config, "utf8"), config);
});

test("Codex: a static hook array is refused with the block to add; a root a shell would read gets no hooks", async () => {
  const t = home({ config: '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo x" }] }]\n' });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 2, t.text());
  assert.match(t.text(), /session\.start hook: its hooks\.SessionStart isn't a list of tables ad can add to[\s\S]*\[\[hooks\.SessionStart\]\]/);
  assert.equal(t.toml().hooks.UserPromptSubmit[0].hooks[0].command, line(t, "prompt.submit"));
  assert.equal(t.toml().hooks.SessionStart.length, 1);
  for (const ch of ["$", "%"]) {
    const u = home({ config: "", root: `odd${ch}root` });
    assert.equal(await S.setup({ ctx: u.ctx, hosts: ["codex"] }), 2, u.text());
    assert.match(u.text(), /no hooks: ad's folder .* holds \$, `, % or "/);
    assert.ok(!fs.existsSync(u.hooksFile));
    assert.equal(u.toml().shell_environment_policy.set.AD_TOOL_SHELL, "1", "the marker doesn't depend on the path");
  }
});

test("Codex marker: the user's own value stays; one they had stays on uninstall; include_only that drops it is named", async () => {
  const zero = home({ config: '[shell_environment_policy.set]\nAD_TOOL_SHELL = "0"\n' });
  assert.equal(await S.setup({ ctx: zero.ctx, hosts: ["codex"] }), 2);
  assert.equal(zero.toml().shell_environment_policy.set.AD_TOOL_SHELL, "0");
  const had = '[shell_environment_policy.set]\nAD_TOOL_SHELL = "1"\nOTHER = "x"\n';
  const t = home({ config: had });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  assert.equal(fs.readFileSync(t.config, "utf8"), had);
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.equal(fs.readFileSync(t.config, "utf8"), had);
  assert.match(t.text(), /AD_TOOL_SHELL: you had it before/);
  // An existing [shell_environment_policy.set] table gets the line; it goes again on uninstall.
  const table = '[shell_environment_policy]\ninherit = "core"\n\n[shell_environment_policy.set]\nFOO = "1"\n';
  const u = home({ config: table });
  assert.equal(await S.setup({ ctx: u.ctx, hosts: ["codex"] }), 0, u.text());
  assert.deepEqual(u.toml().shell_environment_policy.set, { AD_TOOL_SHELL: "1", FOO: "1" });
  assert.equal(await uninstall({ ctx: u.ctx, hosts: ["codex"] }), 0);
  assert.equal(fs.readFileSync(u.config, "utf8"), table);
  const f = home({ config: '[shell_environment_policy]\ninclude_only = ["PATH", "HOME"]\n' });
  assert.equal(await S.setup({ ctx: f.ctx, hosts: ["codex"] }), 0);
  assert.match(f.text(), /include_only drops AD_TOOL_SHELL/);
});

test("a newer setup never rewrites a Codex hook an older version wrote (its trust would go)", async () => {
  const t = home({ config: "" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  const j = t.json();
  const old = { ...j.hooks.SessionStart[0].hooks[0], command: `${j.hooks.SessionStart[0].hooks[0].command} --old` };
  j.hooks.SessionStart[0].hooks[0] = old;
  fs.writeFileSync(t.hooksFile, JSON.stringify(j, null, 2));
  const { openLedger2ForWrite, upsertItem, writeLedger2 } = await import("../src/memory-install/ledger2.mjs");
  const opened = openLedger2ForWrite(t.env.AD_ROOT);
  const hook = opened.ledger.items.find((i) => i.kind === "hook" && i.locator.event === "session.start");
  upsertItem(opened.ledger, { host: "codex", kind: "hook", file: hook.file, locator: hook.locator, value: old });
  await writeLedger2(t.env.AD_ROOT, opened.ledger);
  const before = fs.readFileSync(t.hooksFile);
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(fs.readFileSync(t.hooksFile).equals(before), "left exactly as it is");
});

test("Codex uninstall never rewrites a hook: a changed one stays and is turned off; groups added after ours need trusting again", async () => {
  const t = home({ config: "" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  const j = t.json();
  j.hooks.SessionStart[0].hooks[0].timeout = 30;
  j.hooks.UserPromptSubmit[0].hooks[0].command += " --mine";
  j.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo later" }] });
  fs.writeFileSync(t.hooksFile, JSON.stringify(j, null, 2));
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  const left = t.json().hooks;
  assert.deepEqual(left.UserPromptSubmit[0].hooks[0], j.hooks.UserPromptSubmit[0].hooks[0], "kept exactly as the user left it (no onFailure added)");
  assert.equal(left.SessionStart, undefined, "a timeout change is ad's own field: still ad's entry, removed");
  assert.deepEqual(left.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "echo later" }] }]);
  assert.match(t.text(), /the PreToolUse hook you added after ad's moved up one place; trust it again in \/hooks/);
  assert.match(t.text(), /prompt\.submit: you changed it/);
  assert.ok(D.readDists(D.distsFile(t.env.AD_ROOT)).disabledHosts.includes("codex"));
});

test("session.start --host codex says how to put back a marker that's gone from config.toml", async () => {
  const t = home({ config: USER_TOML });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  const proj = path.join(t.h, "proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const env = { ...t.env, AGENT_DAEMON_DISABLE_SWEEP: "1" };
  const start = () => {
    const r = spawnSync(process.execPath, [path.join(RUNTIME, "bin", "hook.mjs"), "session.start", "--host", "codex", "--memory-only"], { input: JSON.stringify({ session_id: "s1", cwd: proj, hook_event_name: "SessionStart" }), env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(start().systemMessage, undefined, "the marker is there");
  fs.writeFileSync(t.config, USER_TOML);
  assert.match(start().systemMessage ?? "", /AD_TOOL_SHELL is gone from .*config\.toml.*Run (npx -y \S+ setup --host codex|.*setup --host codex) in your own terminal/);
});

// The exact line under every shell Codex may use (pwsh -Command on Windows, cmd /C as
// its fallback, $SHELL -lc elsewhere), with a root holding a space, ' & and ( ).
test("the Codex hook line runs under every shell here", () => {
  const t = home({ root: "ad sh&ell's (root)" });
  const dir = D.launchDir(t.env.AD_ROOT);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["run.mjs", "dists.mjs"]) fs.copyFileSync(path.join(RUNTIME, "src", "memory", "launch", f), path.join(dir, f));
  const cmd = C.codexCommand(D.launcherFile(t.env.AD_ROOT), "session.start");
  const env = { ...process.env, HOME: t.h, USERPROFILE: t.h, AD_ROOT: t.env.AD_ROOT, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const shells = [];
  if (process.platform === "win32") {
    shells.push(["pwsh", ["-NoProfile", "-NonInteractive", "-Command", cmd]], ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]], ["cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { windowsVerbatimArguments: true }]);
    const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim();
    const bash = exec ? path.resolve(exec, "..", "..", "..", "bin", "bash.exe") : null;
    if (bash && fs.existsSync(bash)) shells.push([bash, ["-c", cmd]]);
  } else {
    for (const sh of ["sh", "bash", "zsh"]) shells.push([sh, ["-lc", cmd]]);
    shells.push(["fish", ["-c", cmd]]);
  }
  let ran = 0;
  for (const [sh, args, opts = {}] of shells) {
    const r = spawnSync(sh, args, { env, encoding: "utf8", timeout: 60_000, input: "{}", ...opts });
    if (r.error?.code === "ENOENT") continue;
    ran++;
    assert.equal(r.status, 0, `${sh}: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout.trim().split("\n").at(-1)), `${sh} printed: ${r.stdout} ${r.stderr}`);
  }
  assert.ok(ran >= 2, `at least two shells ran (${ran})`);
});

test("Codex round trips keep the exact bytes: no final newline, CRLF without one, mixed line endings, inline hooks", async () => {
  const inline = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"';
  for (const config of ['model = "x"', 'model = "x"\r\n', 'a = 1\r\nb = 2', 'a = 1\r\nb = 2\n', inline, inline.replace(/\n/g, "\r\n") + "\r\n"]) {
    const t = home({ config });
    assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
    assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
    assert.equal(fs.readFileSync(t.config, "utf8"), config, JSON.stringify(config));
  }
});

test("Codex: after the placement flips, setup finds its hooks in the other file and adds nothing twice", async () => {
  const t = home({ config: "" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  const json = fs.readFileSync(t.hooksFile);
  // The user starts keeping hooks in config.toml.
  fs.appendFileSync(t.config, '\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n');
  const config = fs.readFileSync(t.config);
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(fs.readFileSync(t.hooksFile).equals(json) && fs.readFileSync(t.config).equals(config), "nothing added to either file");
  assert.deepEqual(await S.setupPending(t.ctx, "codex", await S.setupWork(t.ctx, "codex")), [], "nothing pending either");
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(!fs.existsSync(t.hooksFile));
});

test("Codex uninstall says which of your hooks need trusting again, in config.toml and inside ad's group", async () => {
  const t = home({ config: '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n' });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  fs.appendFileSync(t.config, '\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo later"\n');
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.match(t.text(), /the SessionStart hook you added after ad's moved up one place; trust it again in \/hooks/);
  assert.equal(t.toml().hooks.SessionStart[0].hooks[0].command, "echo later");
  // A handler the user put inside ad's hooks.json group.
  const u = home({ config: "" });
  assert.equal(await S.setup({ ctx: u.ctx, hosts: ["codex"] }), 0);
  const j = u.json();
  j.hooks.SessionStart[0].hooks.push({ type: "command", command: "echo mine" });
  fs.writeFileSync(u.hooksFile, JSON.stringify(j, null, 2));
  assert.equal(await uninstall({ ctx: u.ctx, hosts: ["codex"] }), 0, u.text());
  assert.match(u.text(), /the hook you added in ad's SessionStart group moved up one place/);
  assert.deepEqual(u.json().hooks.SessionStart, [{ hooks: [{ type: "command", command: "echo mine" }] }]);
});

test("Codex: a refused route isn't pending forever; a file setup made keeps the user's comment; an entry like ad's with no record is the user's", async () => {
  const s = home({ config: '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo x" }] }]\n' });
  assert.equal(await S.setup({ ctx: s.ctx, hosts: ["codex"] }), 2);
  assert.deepEqual(await S.setupPending(s.ctx, "codex", await S.setupWork(s.ctx, "codex")), []);
  const c = home({ config: "" });
  assert.equal(await S.setup({ ctx: c.ctx, hosts: ["codex"] }), 0);
  fs.writeFileSync(c.hooksFile, fs.readFileSync(c.hooksFile, "utf8").replace("{", "{\n  // my note"));
  assert.equal(await uninstall({ ctx: c.ctx, hosts: ["codex"] }), 0, c.text());
  assert.match(fs.readFileSync(c.hooksFile, "utf8"), /my note/, "a file holding the user's comment stays");
  // The user pasted ad's own group before any setup: kept as theirs.
  const p = home({ config: "" });
  const group = { hooks: [{ type: "command", command: line(p, "session.start"), timeout: 10 }] };
  fs.writeFileSync(p.hooksFile, JSON.stringify({ hooks: { SessionStart: [group] } }, null, 2) + "\n");
  assert.equal(await S.setup({ ctx: p.ctx, hosts: ["codex"] }), 0);
  assert.equal(await uninstall({ ctx: p.ctx, hosts: ["codex"] }), 0);
  assert.deepEqual(p.json().hooks.SessionStart, [group]);
  assert.match(p.text(), /session\.start: you had it before/);
});

test("Codex: roots PowerShell or cmd would misread get no hooks; POSIX paths are kept as they are", () => {
  for (const ch of ["\u{201C}", "\u{201D}", "\u{201E}", "!", "\n", "$", "`", "%", '"']) assert.ok(C.UNSAFE_ROOT.test(`/x/a${ch}b`), JSON.stringify(ch));
  for (const ch of [" ", "'", "&", "(", "^", ";", "#", "\u{2019}"]) assert.ok(!C.UNSAFE_ROOT.test(`/x/a${ch}b`), JSON.stringify(ch));
  assert.equal(C.codexCommand("C:\\a b\\run.mjs", "x", "win32"), 'node "C:/a b/run.mjs" hook x --host codex');
  assert.equal(C.codexCommand("/home/a\\b/run.mjs", "x", "linux"), 'node "/home/a\\b/run.mjs" hook x --host codex');
});

test("Codex marker check: quiet when the user set another value or wrote it another way", async () => {
  const { codexMarkerMissing } = await import("../src/memory/codex-marker.mjs");
  const t = home({ config: USER_TOML });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  for (const text of ['[shell_environment_policy.set]\nAD_TOOL_SHELL = "0"\n', "[shell_environment_policy]\nset = { AD_TOOL_SHELL = \"1\" }\n", '[shell_environment_policy.set]\n"AD_TOOL_SHELL" = "1"\n']) {
    fs.writeFileSync(t.config, text);
    assert.equal(codexMarkerMissing(t.env.AD_ROOT), null, text);
  }
  fs.writeFileSync(t.config, USER_TOML);
  assert.ok(codexMarkerMissing(t.env.AD_ROOT));
  fs.rmSync(t.config);
  assert.ok(codexMarkerMissing(t.env.AD_ROOT), "the whole file gone");
});

test("uninstall keeps the user's comments: inside a container ad created, and around ad's group", async () => {
  const t = home({ config: "" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  // A comment inside the SessionStart list setup created, and one inside the hooks object.
  let j = fs.readFileSync(t.hooksFile, "utf8");
  j = j.replace('"SessionStart": [', '"SessionStart": [\n      // my hooks go here').replace('"hooks": {', '"hooks": {\n    // mine too');
  fs.writeFileSync(t.hooksFile, j);
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  const left = fs.readFileSync(t.hooksFile, "utf8");
  assert.match(left, /my hooks go here/);
  assert.match(left, /mine too/);
  assert.equal(launcherGroups(S.parseSettings(left).root.hooks).length, 0);
  // A block comment before ad's group and a line comment after it, with the user's group after.
  const u = home({ config: "" });
  assert.equal(await S.setup({ ctx: u.ctx, hosts: ["codex"] }), 0);
  const k = u.json();
  k.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo later" }] });
  let text = JSON.stringify(k, null, 2);
  text = text.replace('"PreToolUse": [\n      {', '"PreToolUse": [\n      /* ad */ {').replace(/(\n {6}\}),(\n {6}\{\n {8}"matcher": "Bash")/, "$1, // ad memory$2");
  fs.writeFileSync(u.hooksFile, text);
  assert.equal(await uninstall({ ctx: u.ctx, hosts: ["codex"] }), 0, u.text());
  const rest = fs.readFileSync(u.hooksFile, "utf8");
  assert.match(rest, /\/\* ad \*\//);
  assert.match(rest, /\/\/ ad memory/);
  assert.deepEqual(S.parseSettings(rest).root.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "echo later" }] }]);
});

test("Codex uninstall after the user tidied config.toml: blank lines gone, the file turned CRLF", async () => {
  const inline = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n';
  for (const edit of [(s) => s.replace(/\n\n/g, "\n"), (s) => s.replace(/\r?\n/g, "\r\n")]) {
    const t = home({ config: inline });
    assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
    fs.writeFileSync(t.config, edit(fs.readFileSync(t.config, "utf8")));
    assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
    const doc = t.toml();
    assert.deepEqual(doc.hooks, { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] }, "only the user's hook is left");
    assert.equal(doc.shell_environment_policy, undefined);
    assert.match(fs.readFileSync(t.config, "utf8"), /command = "echo stop"\r?\n/, "the user's last line keeps its line break");
  }
});

test("install --no-setup: the MCP entry only, without setup's preview or files", async () => {
  const t = home({ config: "" });
  assert.equal(await install({ ctx: t.ctx, hosts: ["codex"], yes: true, noSetup: true }), 0, t.text());
  assert.doesNotMatch(t.text(), /setup: add/);
  assert.doesNotMatch(t.text(), /Finish in a terminal/);
  assert.ok(!fs.existsSync(t.hooksFile));
  assert.equal(t.toml().shell_environment_policy, undefined);
  // Without the flag, in a terminal, the same install previews and runs setup.
  const u = home({ config: "" });
  assert.equal(await install({ ctx: u.ctx, hosts: ["codex"], yes: true }), 0, u.text());
  assert.match(u.text(), /setup: add the session\.start hook/);
  assert.ok(fs.existsSync(u.hooksFile));
});

test("trust doctor: each of ad's Codex hooks is pending, trusted, modified, disabled, changed — or can't be confirmed on a newer Codex", async () => {
  const t = home({ config: "" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  const states = () => Object.fromEntries(S.codexTrust(t.ctx).map((x) => [x.item.locator.event, x.state]));
  assert.deepEqual(states(), { "session.start": "pending", "prompt.submit": "pending", "tool.before": "pending" });
  const rows = S.codexTrust(t.ctx);
  const key = (ev) => rows.find((x) => x.item.locator.event === ev).key;
  assert.equal(key("session.start"), `${t.hooksFile}:session_start:0:0`, "Codex's positional key");
  // Trust as Codex records it (trusted_hash under hooks.state), a stale hash, and a hook turned off.
  const ss = t.json().hooks.SessionStart[0].hooks[0];
  const tb = t.json().hooks.PreToolUse[0];
  const state = [
    `[hooks.state.${JSON.stringify(key("session.start"))}]`, `trusted_hash = "${S.codexTrustHash("SessionStart", null, ss)}"`,
    `[hooks.state.${JSON.stringify(key("tool.before"))}]`, `trusted_hash = "${S.codexTrustHash("PreToolUse", "Bash", tb.hooks[0])}"`,
    `[hooks.state.${JSON.stringify(key("prompt.submit"))}]`, "enabled = false", "",
  ].join("\n");
  fs.appendFileSync(t.config, state);
  assert.deepEqual(states(), { "session.start": "trusted", "prompt.submit": "disabled", "tool.before": "modified" });
  assert.equal(S.codexTrust(t.ctx, { codexVersion: "99.0.0" }).find((x) => x.item.locator.event === "tool.before").state, "unknown");
  assert.equal(S.codexTrust(t.ctx, { codexVersion: "99.0.0" }).find((x) => x.item.locator.event === "session.start").state, "trusted", "an equal hash is trusted on any version");
  // Doctor says it in words.
  const { doctor } = await import("../src/memory-install/doctor.mjs");
  t.lines.length = 0;
  await doctor({ ctx: t.ctx });
  assert.match(t.text(), /✗ Codex hooks\.trust: trusted: session\.start; Codex won't run tool\.before until you review it again in \/hooks; turned off in \/hooks: prompt\.submit/);
  // The user edits ad's entry: theirs now, not a trust question.
  const j = t.json();
  j.hooks.SessionStart[0].hooks[0].command += " --mine";
  fs.writeFileSync(t.hooksFile, JSON.stringify(j, null, 2));
  assert.equal(states()["session.start"], "changed");
});

test("the trust hash is checked on the engine ad pins", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME, "package.json"), "utf8"));
  assert.equal(S.TRUST_HASH_CHECKED_ON, pkg.dependencies["@openai/codex"], "a new engine pin re-runs the golden test (memory-host-codex.test.mjs) and moves this");
  // The formula on a known value (the pinned engine's hooks/list gave this for this group).
  const cmd = 'node "/tmp/ad-trust-spike-LtCMHc/ad/memory/launch/run.mjs" hook session.start --host codex';
  assert.equal(S.codexTrustHash("SessionStart", null, { type: "command", command: cmd, timeout: 10 }), "sha256:5284a0d9169dcc09a91fe93e7b20a2141ecc47cc20e8b5b55bcb51835f0fd508");
});

test("uninstall from an editor's terminal: no terminal, no dialog, no rules — it never asks and removes everything", async () => {
  const t = home({ config: USER_TOML });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0);
  t.ctx.isTTY = () => false;
  t.ctx.confirmReview = async () => {
    throw new Error("asked for the review gate with no rules");
  };
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.equal(fs.readFileSync(t.config, "utf8"), USER_TOML);
});

test("review: with a linked CODEX_HOME the trust key uses the real folder, as Codex does", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, async () => {
  const t = home({ config: "" });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "ad-real-codex-"));
  made.push(real);
  fs.cpSync(path.join(t.h, ".codex"), real, { recursive: true });
  fs.rmSync(path.join(t.h, ".codex"), { recursive: true });
  fs.symlinkSync(real, path.join(t.h, ".codex"));
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  const rows = S.codexTrust(t.ctx);
  assert.ok(rows.every((r) => r.key.startsWith(`${fs.realpathSync.native(real)}${path.sep}hooks.json:`)), rows.map((r) => r.key).join("\n"));
});
