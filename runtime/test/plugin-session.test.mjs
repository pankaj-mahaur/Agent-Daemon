// L3 Decision 19: the plugin's session.start, before any skip — the agent-shell marker
// line in CLAUDE_ENV_FILE (once, whatever fires SessionStart again), the plugin
// registered by id in the launcher's dists list (only the installed copy), and the
// weekly "one terminal step finishes setup" line. Temp homes only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV_LINE, NUDGE_EVERY_MS, pluginRecord, registerPlugin, setupNudge, writeEnvMarker } from "../src/hooks/plugin-session.mjs";
import { distsFile, launcherFile, readDists, setHostDisabled } from "../src/memory/launch/dists.mjs";
import { PRODUCT } from "../src/product.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-plugin-session-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }));
let n = 0;
const home = () => {
  const h = path.join(TMP, `h${++n}`);
  fs.mkdirSync(path.join(h, ".claude", "plugins"), { recursive: true });
  return { h, root: path.join(h, ".agent-daemon"), env: { HOME: h } };
};
const ID = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
const install = (h, installPath, extra = {}) =>
  fs.writeFileSync(path.join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [ID]: [{ scope: "user", installPath, version: "3.1.0", ...extra }] } }));
const putLauncher = (root) => {
  fs.mkdirSync(path.dirname(launcherFile(root)), { recursive: true });
  fs.writeFileSync(launcherFile(root), "// launcher\n");
};

test("the marker line: appended once, whatever fires SessionStart again; a missing variable writes nothing", () => {
  const { h } = home();
  const file = path.join(h, "env-file");
  assert.equal(writeEnvMarker(file), "added", "the file needn't exist yet");
  assert.equal(writeEnvMarker(file), "there", "resume, clear, compact: no second line");
  assert.equal(fs.readFileSync(file, "utf8"), `${ENV_LINE}\n`);
  // Another hook's lines stay; a file without a final newline gets one before ours.
  const other = path.join(h, "env-other");
  fs.writeFileSync(other, "export FOO=1");
  assert.equal(writeEnvMarker(other), "added");
  assert.equal(fs.readFileSync(other, "utf8"), `export FOO=1\n${ENV_LINE}\n`);
  // Our line written with CRLF (or spaces around it) by an earlier run is the same line.
  const crlf = path.join(h, "env-crlf");
  fs.writeFileSync(crlf, `export FOO=1\r\n  ${ENV_LINE}  \r\n`);
  assert.equal(writeEnvMarker(crlf), "there");
  assert.equal(ENV_LINE, "export AD_TOOL_SHELL=1", "the plain form PowerShell's reader also takes");
  assert.equal(writeEnvMarker(undefined), "none");
  assert.equal(writeEnvMarker(""), "none");
});

test("registration: the installed copy, by id, written once; an inline --plugin-dir copy or no launcher: nothing", () => {
  const { h, root, env } = home();
  const plugin = path.join(h, ".claude", "plugins", "cache", PRODUCT.marketplace, PRODUCT.plugin, "3.1.0");
  install(h, plugin);
  const rec = pluginRecord({ env, home: h, pluginRoot: plugin });
  assert.deepEqual(rec, { pluginId: ID, pluginsFile: path.join(h, ".claude", "plugins", "installed_plugins.json") });
  assert.equal(registerPlugin(root, rec), "no launcher", "nothing starts the launcher yet: no list written");
  assert.ok(!fs.existsSync(distsFile(root)));
  putLauncher(root);
  assert.equal(registerPlugin(root, rec), "added");
  const d = readDists(distsFile(root));
  assert.deepEqual(d.dists.map(({ at, ...x }) => x), [{ route: "plugin", pluginId: ID, pluginsFile: rec.pluginsFile }]);
  const before = fs.readFileSync(distsFile(root), "utf8");
  assert.equal(registerPlugin(root, rec), "same", "each session start: no write when nothing changed");
  assert.equal(fs.readFileSync(distsFile(root), "utf8"), before);
  // Loaded inline (--plugin-dir): not the installed copy, so it isn't what the id resolves to.
  assert.equal(pluginRecord({ env, home: h, pluginRoot: path.join(h, "dev", PRODUCT.plugin) }), null);
  // CLAUDE_CONFIG_DIR moves the records; a project-scoped install counts when it is this copy.
  const cfg = path.join(h, "cfg");
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [ID]: [{ scope: "project", installPath: plugin }] } }));
  assert.deepEqual(pluginRecord({ env: { ...env, CLAUDE_CONFIG_DIR: cfg }, home: h, pluginRoot: plugin }), { pluginId: ID, pluginsFile: path.join(cfg, "plugins", "installed_plugins.json") });
  // Another marketplace's plugin of the same name is matched by its own id.
  install(h, plugin, {});
  fs.writeFileSync(path.join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [`${PRODUCT.plugin}@mirror`]: [{ scope: "user", installPath: plugin }] } }));
  assert.equal(pluginRecord({ env, home: h, pluginRoot: plugin }).pluginId, `${PRODUCT.plugin}@mirror`);
  assert.equal(pluginRecord({ env, home: h, pluginRoot: undefined }), null, "no root known: nothing to match");
});

test("the setup line: once a week, only while no tool.before entry is live, never after an uninstall or when no one watches", () => {
  const { h, root, env } = home();
  const cwd = path.join(h, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const t0 = new Date("2026-11-08T10:00:00Z");
  const ask = (at, e = env) => setupNudge({ root, env: e, home: h, cwd, version: "3.1.0", now: at });
  const first = ask(t0);
  assert.match(first, /^One terminal step finishes setup: /);
  assert.ok(first.includes(`npx -y ${PRODUCT.package}@3.1.0 setup`), first);
  assert.equal(ask(new Date(t0.getTime() + 3 * 86_400_000)), null, "not again within the week");
  assert.match(ask(new Date(t0.getTime() + NUDGE_EVERY_MS + 1000)) ?? "", /finishes setup/, "a week later, once more");
  const t1 = new Date(t0.getTime() + 3 * NUDGE_EVERY_MS);
  for (const quiet of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-py" }, { CLAUDE_CODE_SESSION_ATTENDED: "0" }, { AD_WORKER: "1" }]) assert.equal(ask(t1, { ...env, ...quiet }), null, `no one watches: ${JSON.stringify(quiet)}`);
  // Claude Code sets CLAUDE_CODE_CHILD_SESSION=1 for every hook, a top-level interactive
  // session's too (2.1.319, probed): it can't mean "child" here.
  const t2 = new Date(t1.getTime() - NUDGE_EVERY_MS / 2);
  assert.match(ask(t2, { ...env, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" }) ?? "", /finishes setup/, "an interactive top-level session is told");
  // A live tool.before entry (setup's launcher entry in the user's settings): set up already.
  // Asked more than a week after the last showing, so only the entry can silence it.
  const t3 = new Date(t2.getTime() + NUDGE_EVERY_MS + 1000);
  putLauncher(root);
  const settings = path.join(h, ".claude", "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [launcherFile(root), "hook", "tool.before", "--host", "claude-code"], onFailure: "continue" }] }] } }));
  assert.equal(ask(t3), null, "the live entry silences it");
  // Uninstalled on purpose (the host turned off): no nudge either — and the entry is dead then.
  setHostDisabled(distsFile(root), "claude-code", true);
  assert.equal(ask(new Date(t1.getTime() + 2 * NUDGE_EVERY_MS)), null);
  setHostDisabled(distsFile(root), "claude-code", false);
  // The entry's launcher is gone: not live, so the line comes back.
  fs.rmSync(launcherFile(root));
  assert.match(ask(new Date(t1.getTime() + 4 * NUDGE_EVERY_MS)) ?? "", /finishes setup/);
  // An unknown version: the unpinned command.
  assert.ok(setupNudge({ root, env, home: h, cwd, version: null, now: new Date(t1.getTime() + 6 * NUDGE_EVERY_MS) }).includes(`npx -y ${PRODUCT.package} setup`));
});
