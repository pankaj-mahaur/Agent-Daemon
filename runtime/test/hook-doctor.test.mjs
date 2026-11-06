// L2 part 3: `ad doctor`'s hook checks (hooks/hook-doctor.mjs): a step run
// twice across settings files, the memory plugin, fail-closed mode and the
// Claude Code version it needs, Codex hook trust (the S-HOOKS untrusted
// capture), the hook log's tail; and the rows in a spawned doctor run.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexTrust, duplicateRow, execFormRow, failClosedRows, logRow, memoryPluginState, pluginRow, ruleCount, rulesFileRow, scriptRow, transientInstall } from "../src/hooks/hook-doctor.mjs";
import { hookLog, hookLogTail } from "../src/hooks/hook-log.mjs";
import { HOOK_PATH } from "../src/hooks/routes.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/hosts/", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-hookdoc-"));
const route = (event, matcher, extra = {}) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: "node", args: [HOOK_PATH, event], timeout: 5, ...extra }] });

test("duplicates across settings files: a step from two entries is named with where it runs", () => {
  const user = { UserPromptSubmit: [route("prompt.submit")], PreToolUse: [route("tool.before", "Bash|PowerShell|Write|Edit")] };
  assert.equal(duplicateRow([{ name: "/h/.claude/settings.json", hooks: user }]).ok, true);
  const project = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "ad hook user-prompt-extract" }] }] };
  const row = duplicateRow([{ name: "/h/.claude/settings.json", hooks: user }, { name: "/w/app/.claude/settings.json", hooks: project }]);
  assert.equal(row.ok, false);
  assert.match(row.note, /user-prompt-extract \(\.claude\/settings\.json: prompt\.submit, \.claude\/settings\.json: an older ad hook entry\)/);
  // The same route twice in one file is a duplicate too.
  assert.equal(duplicateRow([{ name: "u", hooks: { PreToolUse: [route("tool.before", "Bash"), route("tool.before", "Bash")] } }]).ok, false);
});

test("the memory plugin: its hooks pass through where ad init's run; one from before the dispatcher is flagged", () => {
  const key = "agent-daemon-memory@agent-daemon";
  const routes = [{ name: "u", hooks: { UserPromptSubmit: [route("prompt.submit")] } }];
  assert.equal(pluginRow({ plugin: null, sources: [] }), null);
  assert.match(pluginRow({ plugin: { key, version: "3.2.0", outdated: false }, sources: routes }).note, /pass through/);
  assert.match(pluginRow({ plugin: { key, version: null, outdated: null }, sources: [] }).note, /runs the memory hooks/);
  const old = pluginRow({ plugin: { key, version: "3.1.0", outdated: true }, sources: routes });
  assert.equal(old.ok, false, "its guard only knows ad's older entries: every memory step runs twice");
  assert.match(old.note, /3\.1\.0 predates/);
  // Next to ad's older entries, an older plugin still passes through: nothing to flag.
  assert.equal(pluginRow({ plugin: { key, version: "3.1.0", outdated: true }, sources: [{ name: "u", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "ad hook user-prompt-extract" }] }] } }] }).ok, true);
  // Routes written in the older plugin's form (ad init saw it): it stands aside.
  const tagged = [{ name: "u", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node '${HOOK_PATH}' prompt.submit # ad hook user-prompt-extract ad query-retrieve` }] }] } }];
  const ok = pluginRow({ plugin: { key, version: "3.1.0", outdated: true }, sources: tagged });
  assert.equal(ok.ok, true);
  assert.match(ok.note, /stands aside/);
  // Its version couldn't be read: not claimed to pass through.
  assert.match(pluginRow({ plugin: { key, version: null, outdated: null }, sources: routes }).note, /couldn't read which version/);

  // Read from Claude Code's own files: enabled in settings, installed at a path, its hooks.json.
  const home = tmp();
  try {
    const dir = path.join(home, ".claude");
    const install = path.join(dir, "plugins", "cache", "agent-daemon", "agent-daemon-memory", "3.1.0");
    fs.mkdirSync(path.join(install, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { [key]: true } }));
    fs.writeFileSync(path.join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [key]: [{ scope: "user", installPath: install, version: "3.1.0" }] } }));
    fs.writeFileSync(path.join(install, "hooks", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/server/hook.mjs" user-prompt-extract --host claude-code' }] }] } }));
    assert.deepEqual(memoryPluginState({ env: {}, home }), { key, version: "3.1.0", outdated: true });
    fs.writeFileSync(path.join(install, "hooks", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/server/hook.mjs" prompt.submit --host claude-code --plugin' }] }] } }));
    assert.equal(memoryPluginState({ env: {}, home }).outdated, false);
    fs.rmSync(path.join(dir, "plugins", "installed_plugins.json"));
    assert.equal(memoryPluginState({ env: {}, home }).outdated, null, "unknown, not assumed");
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { [key]: false } }));
    assert.equal(memoryPluginState({ env: {}, home, cwd: null }), null);
    // On for one project only (its .claude/settings.local.json).
    const project = path.join(home, "work", "app");
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { [key]: true } }));
    assert.equal(memoryPluginState({ env: {}, home, cwd: project }).key, key);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the hook script: a dead path, a copy that may go, and the exec form on an older Claude Code", () => {
  const home = tmp();
  try {
    const dead = path.join(home, "gone", "runtime", "bin", "hook.mjs");
    const deadRow = scriptRow([{ name: "u", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: [dead, "session.start"] }] }] } }], HOOK_PATH);
    assert.equal(deadRow.ok, false);
    assert.ok(deadRow.note.includes(dead));
    assert.equal(transientInstall(path.join(os.tmpdir(), "x", "runtime", "bin", "hook.mjs")), "a temporary folder");
    assert.equal(transientInstall(path.join(home, "npm-cache", "_npx", "abc", "node_modules", "agent-daemon", "runtime", "bin", "hook.mjs")), "an npx cache");
    const repo = path.join(home, "wt");
    fs.mkdirSync(path.join(repo, "runtime", "bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    assert.equal(transientInstall(path.join(repo, "runtime", "bin", "hook.mjs"), { tmp: path.join(home, "no-tmp") }), "a git worktree");
    assert.equal(transientInstall(path.join(home, "npm", "_npx", "a", "runtime", "bin", "hook.mjs"), { tmp: path.join(home, "no-tmp") }), "an npx cache");
    // The scripts the settings run are checked, not only the ad running doctor.
    const at = (p) => [{ name: "u", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: [p, "session.start"] }] }] } }];
    const shakyIf = (bad) => (p) => (p === bad ? "a git worktree" : null);
    const wt = path.join(home, "wt", "runtime", "bin", "hook.mjs");
    const main = path.join(home, "main", "runtime", "bin", "hook.mjs");
    for (const p of [wt, main]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "");
    }
    assert.equal(scriptRow(at(wt), main, { transient: shakyIf(wt) }).ok, false, "settings point at a worktree, doctor runs from the main install");
    assert.equal(scriptRow(at(main), wt, { transient: shakyIf(wt) }).ok, true, "settings point at the main install, doctor runs from a worktree");
    assert.equal(scriptRow([], wt, { transient: shakyIf(wt) }).ok, false, "no routes yet: the path ad init would write");
    const exec = [{ name: "u", hooks: { SessionStart: [route("session.start")] } }];
    assert.equal(execFormRow(exec, "2.1.314"), null);
    assert.equal(execFormRow(exec, null), null, "unknown version: nothing to say");
    assert.equal(execFormRow(exec, "2.1.100").ok, false);
    assert.equal(execFormRow([{ name: "u", hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${HOOK_PATH}' session.start` }] }] } }], "2.1.100"), null, "the shell form needs no version");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fail-closed mode: advisory with no rules, flagged with rules, and the Claude Code version onFailure needs", () => {
  const advisory = [{ name: "u", hooks: { PreToolUse: [route("tool.before", "Bash")] } }];
  const [cc, cx] = failClosedRows({ sources: advisory, rules: 0 });
  assert.equal(cc.ok, true);
  assert.match(cc.note, /advisory: no rules yet/);
  assert.match(cx.note, /Codex runs the tool when a hook fails/);
  assert.equal(failClosedRows({ sources: advisory, rules: 2 })[0].ok, false, "rules exist but a crash lets the tool run");
  const closed = [{ name: "u", hooks: { PreToolUse: [route("tool.before", "Bash", { onFailure: "block" })] } }];
  assert.equal(failClosedRows({ sources: closed, rules: 2, claudeVersion: "2.1.314" }).at(-1).ok, true);
  assert.equal(failClosedRows({ sources: closed, rules: 2, claudeVersion: "2.1.295" }).at(-1).ok, true);
  const old = failClosedRows({ sources: closed, rules: 2, claudeVersion: "2.1.200" }).at(-1);
  assert.equal(old.ok, false);
  assert.match(old.note, /needs 2\.1\.295/);
  assert.equal(failClosedRows({ sources: closed, rules: 2, claudeVersion: null }).at(-1).ok, false, "an unknown version isn't assumed new enough");
  assert.deepEqual(failClosedRows({ sources: [], rules: 0 }), [], "no rules check route: nothing to say (the presence row covers it)");
  assert.equal(ruleCount({ projects: { a: { rules: [1, 2] }, b: { rules: [3], paused: true }, c: {} } }), 2);
});

test("Codex trust: the S-HOOKS untrusted capture is detected, other sources aren't counted", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, "codex", "untrusted.json"), "utf8"));
  const hooks = fx.trust.hooks;
  const file = hooks[0].key.replace(/:[a-z_]+:\d+:\d+$/i, "");
  const t = codexTrust(hooks, file, { platform: "win32" });
  assert.equal(t.total, hooks.length);
  assert.equal(t.trusted, 0);
  assert.ok(t.untrusted.some((u) => /preToolUse \(untrusted\)/.test(u)));
  const trusted = hooks.map((h) => ({ ...h, trustStatus: "trusted" }));
  assert.deepEqual(codexTrust(trusted, file, { platform: "win32" }), { trusted: hooks.length, total: hooks.length, untrusted: [] });
  const modified = [{ ...trusted[0], trustStatus: "modified" }, ...trusted.slice(1), { key: "C:\\repo\\.codex\\hooks.json:pre_tool_use:0:0", trustStatus: "untrusted" }];
  const m = codexTrust(modified, file, { platform: "win32" });
  assert.deepEqual([m.trusted, m.total], [hooks.length - 1, hooks.length], "a repo's hooks aren't ad's");
  assert.match(m.untrusted[0], /modified/);
  assert.equal(codexTrust([{ sourcePath: file.toUpperCase(), trustStatus: "trusted" }], file, { platform: "win32" }).total, 1, "Windows paths compare case-blind");
});

test("the rules file row: current, none, last good copy, both unreadable", () => {
  assert.equal(rulesFileRow({ source: "current", warning: null }, "g.json").ok, true);
  assert.equal(rulesFileRow({ source: "none", warning: null }, "g.json").note, "no rules yet");
  assert.match(rulesFileRow({ source: "last-good", warning: "x" }, "g.json").note, /last good copy/);
  assert.equal(rulesFileRow({ source: "last-good", warning: "x" }, "g.json").ok, false);
  assert.equal(rulesFileRow({ source: "last-good", warning: null }, "g.json").ok, true, "moved aside: the last good copy, silently and fine");
  assert.match(rulesFileRow({ source: "none", warning: "x" }, "g.json").note, /no rules apply/);
});

test("the hook log: appended, capped, tailed", () => {
  const root = tmp();
  try {
    assert.deepEqual(hookLogTail(5, { root }), []);
    assert.equal(logRow([]).note, "nothing logged");
    hookLog("tool.before", "line\nwith  breaks", { root, now: new Date("2026-11-05T00:00:00Z") });
    assert.deepEqual(hookLogTail(5, { root }), ["2026-11-05T00:00:00.000Z tool.before line with breaks"]);
    for (let i = 0; i < 1200; i++) hookLog("prompt.submit", `entry ${i} ${"x".repeat(250)}`, { root });
    assert.ok(fs.statSync(path.join(root, "hooks", "hook.log")).size <= 300 * 1024, "kept under the cap");
    assert.match(hookLogTail(1, { root })[0], /entry 1199/);
    assert.match(logRow(hookLogTail(5, { root })).note, /entry 1199/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("spawned ad doctor: hook rows for duplicates, mode and the log", () => {
  const home = tmp();
  try {
    const root = path.join(home, "ad-root");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const settings = { hooks: { UserPromptSubmit: [route("prompt.submit"), { hooks: [{ type: "command", command: "ad hook user-prompt-extract" }] }], PreToolUse: [route("tool.before", "Bash|PowerShell|Write|Edit")] } };
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings));
    hookLog("tool.before", "couldn't check a call", { root });
    const env = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root };
    for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "AD_HOOK_HOST"]) delete env[k];
    const r = spawnSync(process.execPath, [CLI, "doctor", "--cwd", home], { env, encoding: "utf8", timeout: 120_000 });
    const out = r.stdout + r.stderr;
    assert.match(out, /Hook routes.*run twice: user-prompt-extract/);
    assert.match(out, /Rules check mode \(Claude Code\).*advisory: no rules yet/);
    assert.match(out, /Hook log.*couldn't check a call/);
    assert.match(out, /Hook dispatcher.*1 hook entry loads the whole CLI/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
