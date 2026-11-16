// L3 part 3b: `setup` writes the memory product's Claude Code hook and marker items
// through the stable launcher, ledgered one per item; uninstall removes exactly those,
// keeps what the user changed (made unable to block), turns the host off, and removes
// the launcher only when nothing starts it. Temp homes and roots only; no real host runs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { makeContext, install, uninstall } = await import("../src/memory-install/install.mjs");
const S = await import("../src/memory-install/setup.mjs");
const { readLedger2, adoptLauncherHooks } = await import("../src/memory-install/ledger2.mjs");
const D = await import("../src/memory/launch/dists.mjs");
const R = await import("../src/hooks/routes.mjs");
const { commandGate, main } = await import("../src/memory-install/cli.mjs");
const { PRODUCT } = await import("../src/product.mjs");
const { acquireLock } = await import("../src/lock.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const PLUGIN_KEY = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
const USER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };

/** A fake home; settings: the user's settings.json (object or raw text); plugin: enabled. */
function home({ settings, plugin = false, version = "2.1.319", rulesExist = false, token = false, tty = true } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-setup-home-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  let s = settings;
  if (plugin) s = { ...(s ?? {}), enabledPlugins: { [PLUGIN_KEY]: true } };
  if (s !== undefined) fs.writeFileSync(path.join(h, ".claude", "settings.json"), typeof s === "string" ? s : JSON.stringify(s, null, 2) + "\n");
  const env = { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: path.join(h, ".claude"), AD_ROOT: path.join(h, ".agent-daemon"), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const asked = { token: 0 };
  const ctx = makeContext({
    env, home: h, root: env.AD_ROOT, viaLauncher: false,
    resolve: () => null,
    out: (l) => lines.push(String(l)),
    ask: async () => "",
    isTTY: () => tty,
    claudeVersion: async () => version,
    rulesExist: () => rulesExist,
    confirmReview: async () => (asked.token++, token),
    lockWaitMs: 50,
  });
  const file = path.join(h, ".claude", "settings.json");
  return { h, env, ctx, lines, asked, file, text: () => lines.join("\n"), settings: () => JSON.parse(fs.readFileSync(file, "utf8")), launcher: D.launcherFile(env.AD_ROOT) };
}
const ours = (settings) => R.ourHandlers(settings.hooks).filter((o) => o.info.launcher);
const run = (args, { env, input = "{}" } = {}) => {
  const r = spawnSync(process.execPath, args, { input, encoding: "utf8", timeout: 60_000, env });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

test("routes: a launcher entry is a dispatcher entry of its host; anchored on its folder; off when its host is", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-setup-root-"));
  made.push(root);
  const launcher = D.launcherFile(root);
  const exec = R.classifyHandler({ type: "command", command: "node", args: [launcher, "hook", "tool.before", "--host", "claude-code"] }, { hostEvent: "PreToolUse" });
  assert.equal(exec.kind, "dispatcher");
  assert.equal(exec.launcher, true);
  assert.equal(exec.event, "tool.before");
  assert.equal(exec.host, "claude-code");
  assert.deepEqual(exec.steps, ["rules-check"]);
  const shell = R.classifyHandler({ type: "command", command: `node '${launcher.replace(/\\/g, "/")}' hook prompt.submit --host gemini` }, { hostEvent: "UserPromptSubmit" });
  assert.equal(shell.launcher, true);
  assert.equal(shell.host, "gemini");
  assert.deepEqual(shell.steps, ["user-prompt-extract", "capability-route-advice", "query-retrieve"]);
  // Another tool's run.mjs, or a word that isn't an event, is not ad's.
  assert.equal(R.classifyHandler({ command: "node", args: ["/x/my-launch/run.mjs", "hook", "tool.before"] }), null);
  assert.equal(R.classifyHandler({ command: "node", args: [launcher, "hook", "not-an-event"] }), null);
  assert.equal(R.classifyHandler({ command: "node", args: ["--inspect", launcher, "hook", "tool.before"] }), null, "exec form: the launcher is the first argument");
  // Alive while the file is there and its host isn't turned off.
  assert.equal(R.entryAlive(exec), false, "no launcher file yet");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "");
  assert.equal(R.entryAlive(exec), true);
  D.setHostDisabled(D.distsFile(root), "claude-code", true);
  assert.equal(R.entryAlive(exec), false, "uninstall turned Claude Code off");
  assert.equal(R.entryAlive(shell), true, "another host is still on");
});

test("setup with the plugin on: tool.before (exec form, onFailure continue) and the marker, ledgered; a re-run changes nothing", async () => {
  const t = home({ plugin: true, settings: { model: "opus", hooks: { PreToolUse: [USER_HOOK] }, env: { FOO: "bar" } } });
  const before = t.settings();
  D.setHostDisabled(D.distsFile(t.env.AD_ROOT), "claude-code", true);
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  const after1 = t.settings();
  assert.deepEqual(after1.hooks.PreToolUse[0], USER_HOOK, "the user's group stays first, untouched");
  assert.deepEqual(after1.hooks.PreToolUse[1], {
    matcher: "Bash|PowerShell|Write|Edit",
    hooks: [{ type: "command", command: "node", args: [t.launcher, "hook", "tool.before", "--host", "claude-code"], timeout: 5, onFailure: "continue" }],
  });
  assert.deepEqual(after1.env, { FOO: "bar", AD_TOOL_SHELL: "1" });
  assert.equal(after1.model, before.model);
  assert.deepEqual(after1.enabledPlugins, before.enabledPlugins);
  assert.ok(fs.existsSync(t.launcher), "the launcher is in place before any entry starts it");
  assert.deepEqual(D.readDists(D.distsFile(t.env.AD_ROOT)).disabledHosts, [], "setup turns the host back on");
  const items = readLedger2(t.env.AD_ROOT).items.filter((i) => i.host === "claude-code");
  assert.deepEqual(items.map((i) => i.kind).sort(), ["env", "hook"]);
  assert.ok(items.every((i) => !i.source && i.preExisted === false && i.file === t.file));
  const bytes = fs.readFileSync(t.file);
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.ok(fs.readFileSync(t.file).equals(bytes), "a second run leaves the file byte for byte");
  assert.match(t.text(), /tool\.before hook already there/);
  assert.deepEqual(readLedger2(t.env.AD_ROOT).items.map((i) => i.id).sort(), items.map((i) => i.id).sort());
  // The review service later makes it blocking (an ad-owned field): a re-run never lowers that.
  const blocking = t.settings();
  blocking.hooks.PreToolUse[1].hooks[0].onFailure = "block";
  fs.writeFileSync(t.file, JSON.stringify(blocking, null, 2));
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.equal(t.settings().hooks.PreToolUse[1].hooks[0].onFailure, "block");
  // The user's own edit of the entry stays too.
  const edited = t.settings();
  edited.hooks.PreToolUse[1].hooks[0].args.push("--mine");
  fs.writeFileSync(t.file, JSON.stringify(edited, null, 2));
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.deepEqual(t.settings(), edited);
  assert.match(t.text(), /tool\.before hook: you changed it, so it was left as it is/);
});

test("setup from a newer version updates ad's own entry and keeps a blocking onFailure", async () => {
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  // As an older version wrote it (an argument this one drops), recorded as ad's; the
  // review service later made it blocking.
  const s = t.settings();
  const old = { ...s.hooks.PreToolUse[0].hooks[0], args: [...s.hooks.PreToolUse[0].hooks[0].args, "--old"] };
  s.hooks.PreToolUse[0].hooks[0] = { ...old, onFailure: "block" };
  fs.writeFileSync(t.file, JSON.stringify(s, null, 2));
  const { openLedger2ForWrite, upsertItem, writeLedger2 } = await import("../src/memory-install/ledger2.mjs");
  const opened = openLedger2ForWrite(t.env.AD_ROOT);
  const hook = opened.ledger.items.find((i) => i.kind === "hook");
  upsertItem(opened.ledger, { host: hook.host, kind: "hook", file: hook.file, locator: hook.locator, value: old });
  await writeLedger2(t.env.AD_ROOT, opened.ledger);
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  const h = t.settings().hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(h.args, [t.launcher, "hook", "tool.before", "--host", "claude-code"], "updated to this version's entry");
  assert.equal(h.onFailure, "block", "never lowered");
  assert.match(t.text(), /tool\.before hook updated/);
});

test("setup --no-plugin routes every memory step through the launcher; neither plugin nor flag writes nothing", async () => {
  const t = home({ settings: { hooks: { PreToolUse: [USER_HOOK] } } });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.deepEqual(t.settings(), { hooks: { PreToolUse: [USER_HOOK] } }, "no plugin and no --no-plugin: untouched");
  assert.match(t.text(), new RegExp(`/plugin install ${PLUGIN_KEY}`));
  assert.match(t.text(), /setup --no-plugin/);
  assert.equal(await S.setup({ ctx: t.ctx, noPlugin: true }), 0, t.text());
  const routes = ours(t.settings()).map((o) => `${o.hostEvent}:${o.info.event}`).sort();
  assert.deepEqual(routes, ["PostToolUse:tool.after", "PreToolUse:tool.before", "SessionStart:session.start", "SubagentStop:subagent.stop", "UserPromptSubmit:prompt.submit"]);
  assert.equal(t.settings().hooks.PostToolUse[0].matcher, "CronCreate|ScheduleWakeup", "the plugin's own matcher");
  assert.equal(readLedger2(t.env.AD_ROOT).items.length, 6);
});

test("setup adopts ad init's own rules-check (L7: it runs in the launcher's entry); refuses hooks on an old Claude Code; leaves a marker the user set", async () => {
  const adEntry = { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "tool.before"], timeout: 5 }] };
  const t = home({ plugin: true, settings: { hooks: { PreToolUse: [adEntry] } } });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  const pre = R.ourHandlers(t.settings().hooks).filter((o) => o.info.event === "tool.before");
  assert.deepEqual(pre.map((o) => Boolean(o.info.launcher)), [true], "only the launcher's tool.before is left");
  assert.match(t.text(), /now runs ad's own rules check/);
  assert.equal(t.settings().env.AD_TOOL_SHELL, "1");

  const old = home({ plugin: true, version: "2.1.300" });
  assert.equal(await S.setup({ ctx: old.ctx }), 0);
  assert.equal(old.settings().hooks, undefined, "below the exec-form version no hook is written");
  assert.match(old.text(), new RegExp(`2\\.1\\.300 predates the hook form ad writes \\(${R.EXEC_FORM_MIN_VERSION.replace(/\./g, "\\.")} or later\\)`));
  assert.equal(old.settings().env.AD_TOOL_SHELL, "1");

  const zero = home({ plugin: true, settings: { env: { AD_TOOL_SHELL: "0" } } });
  assert.equal(await S.setup({ ctx: zero.ctx }), 2);
  assert.equal(zero.settings().env.AD_TOOL_SHELL, "0", "the user's own value is never overwritten");
  assert.match(zero.text(), /env\.AD_TOOL_SHELL is set to "0"/);

  const had = home({ plugin: true, settings: { env: { AD_TOOL_SHELL: "1" } } });
  assert.equal(await S.setup({ ctx: had.ctx }), 0);
  assert.equal(readLedger2(had.env.AD_ROOT).items.find((i) => i.kind === "env").preExisted, true);
  assert.equal(await uninstall({ ctx: had.ctx }), 0, had.text());
  assert.equal(had.settings().env.AD_TOOL_SHELL, "1", "a marker the user had stays");
  assert.match(had.text(), /Kept:\n {2}- .*settings\.json · env\.AD_TOOL_SHELL: you had it before/);
});

test("setup refuses a file it can't edit safely, and writes only over the bytes it planned from", async () => {
  const bad = home({ settings: "{ not json" });
  assert.equal(await S.setup({ ctx: bad.ctx, noPlugin: true }), 1, bad.text());
  assert.equal(fs.readFileSync(bad.file, "utf8"), "{ not json");
  assert.match(bad.text(), /isn't valid JSON.*nothing changed/);
  const odd = home({ plugin: true, settings: { hooks: [] } });
  assert.equal(await S.setup({ ctx: odd.ctx }), 1);
  assert.match(odd.text(), /its hooks isn't an object/);

  // Claude Code writes the file once while setup plans: setup plans again, keeping that write.
  const once = home({ plugin: true, settings: { a: 1 } });
  let writes = 0;
  once.ctx.beforeWrite = () => {
    if (writes++ === 0) fs.writeFileSync(once.file, JSON.stringify({ ...once.settings(), b: 2 }, null, 2));
  };
  assert.equal(await S.setup({ ctx: once.ctx }), 0, once.text());
  assert.equal(once.settings().b, 2);
  assert.equal(ours(once.settings()).length, 1);
  // It keeps writing: setup gives up and the host's bytes stay.
  const busy = home({ plugin: true, settings: { a: 1 } });
  let k = 0;
  busy.ctx.beforeWrite = () => fs.writeFileSync(busy.file, JSON.stringify({ a: 1, n: ++k }));
  assert.equal(await S.setup({ ctx: busy.ctx }), 1);
  assert.deepEqual(busy.settings(), { a: 1, n: 2 });
  assert.match(busy.text(), /keeps changing/);
  assert.equal(readLedger2(busy.env.AD_ROOT).items.length, 0, "nothing ledgered that wasn't written");
});

test("uninstall after setup puts the settings back, turns the host off and removes the launcher nothing starts", async () => {
  const t = home({ settings: { hooks: { PreToolUse: [USER_HOOK] } } });
  const before = t.settings();
  assert.equal(await S.setup({ ctx: t.ctx, noPlugin: true }), 0);
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.deepEqual(t.settings(), before, "exactly the user's settings again");
  assert.match(t.text(), /Removed:(?:\n {2}- .*settings\.json · .+){6}/);
  assert.equal(readLedger2(t.env.AD_ROOT).items.length, 0);
  assert.ok(!fs.existsSync(D.launchDir(t.env.AD_ROOT)), "nothing starts the launcher any more");
  // Set up again: capture works again (setup → uninstall → setup → capture).
  assert.equal(await S.setup({ ctx: t.ctx, noPlugin: true }), 0, t.text());
  const proj = path.join(t.h, "proj");
  // A plain git checkout (no ad project folder): its journal lives under the root.
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const prompt = ours(t.settings()).find((o) => o.info.event === "prompt.submit").handler;
  const r = run(prompt.args, { env: { ...t.env, AGENT_DAEMON_DISABLE_SWEEP: "1" }, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-cap", cwd: proj, prompt: "actually we use pnpm in this repo" }) });
  assert.equal(r.code, 0, r.err);
  const projects = path.join(t.env.AD_ROOT, "projects");
  const journals = fs.existsSync(projects) ? fs.readdirSync(projects).map((d) => path.join(projects, d, "learning-journal.jsonl")).filter((f) => fs.existsSync(f)) : [];
  assert.equal(journals.length, 1, `the correction was journaled: ${r.out} ${r.err}`);
  assert.match(fs.readFileSync(journals[0], "utf8"), /pnpm/);
});

test("a kept tool.before can't block a tool call: onFailure continue, a no-op while the host is off, harmless once ad is gone", async () => {
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  // The user edits ad's entry (an extra argument) and makes it blocking.
  const s = t.settings();
  const h = s.hooks.PreToolUse[0].hooks[0];
  h.args.push("--verbose");
  h.onFailure = "block";
  fs.writeFileSync(t.file, JSON.stringify(s, null, 2));
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  const kept = t.settings().hooks.PreToolUse[0].hooks[0];
  assert.equal(kept.onFailure, "continue");
  assert.deepEqual(kept.args.slice(-1), ["--verbose"], "the user's edit stays");
  assert.match(t.text(), /Kept:\n {2}- .*settings\.json · tool\.before: you changed it; it now has onFailure "continue".* To remove it: delete the PreToolUse entry/);
  assert.equal(t.settings().env, undefined, "the marker went (empty env with it)");
  assert.match(t.text(), /Left on disk:[\s\S]*launch: the launcher, still started by .*settings\.json/);
  assert.ok(D.readDists(D.distsFile(t.env.AD_ROOT)).disabledHosts.includes("claude-code"));
  const r = run(kept.args, { env: t.env, input: JSON.stringify({ session_id: "k1", tool_name: "Bash" }) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), {}, "the host is off: the kept entry does nothing");
  fs.rmSync(t.env.AD_ROOT, { recursive: true, force: true });
  const gone = run(kept.args, { env: t.env });
  assert.notEqual(gone.code, 2, "exit 2 would block the tool call; node's missing-file error is 1");
});

test("while rules exist, tool.before and the marker go only with the review token; the rest goes either way", async () => {
  const t = home({ rulesExist: true, token: false });
  assert.equal(await S.setup({ ctx: t.ctx, noPlugin: true }), 0);
  assert.equal(await uninstall({ ctx: t.ctx }), 2, t.text());
  assert.deepEqual(ours(t.settings()).map((o) => o.info.event), ["tool.before"]);
  assert.equal(t.settings().env.AD_TOOL_SHELL, "1");
  assert.equal(t.asked.token, 1, "asked once");
  assert.match(t.text(), /tool\.before: rules exist, and removing it needs your review in your own terminal\. To remove it: delete the PreToolUse entry that runs memory\/launch\/run\.mjs hook tool\.before/);
  assert.match(t.text(), /env\.AD_TOOL_SHELL: rules exist.*To remove it: delete "AD_TOOL_SHELL" from "env"/);
  assert.deepEqual(readLedger2(t.env.AD_ROOT).items.map((i) => i.kind).sort(), ["env", "hook"], "held items stay ad's");
  t.ctx.confirmReview = async () => true;
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.ok(!fs.existsSync(t.file), "the settings file setup created goes once ad's items are out");
});

test("ad init adopts the launcher's entries; memory uninstall then leaves ad's routes", async () => {
  // --no-plugin: the launcher runs the memory routes too, so ad init has entries to adopt.
  const t = home({ plugin: false });
  assert.equal(await S.setup({ ctx: t.ctx, noPlugin: true }), 0, t.text());
  const s = t.settings();
  // L7 (D10): a live launcher tool.before is the rules check's entry: ad init keeps it and
  // writes no rules-check of its own beside it.
  const plan = R.planClaudeHooks(s.hooks, { steps: ["rules-check", "query-retrieve"] });
  assert.ok(!plan.removed.some((o) => o.info.launcher && o.info.event === "tool.before"), "ad init keeps the launcher's tool.before");
  assert.ok(!plan.routes.some((r) => r.steps.includes("rules-check")), "and adds no rules-check of its own");
  assert.equal(R.ourHandlers(plan.hooks).filter((o) => o.info.event === "tool.before").length, 1);
  fs.writeFileSync(t.file, JSON.stringify({ ...s, hooks: plan.hooks }, null, 2));
  const n = await adoptLauncherHooks(t.env.AD_ROOT, { file: t.file, handlers: plan.removed.filter((o) => o.info.launcher).map((o) => ({ hostEvent: o.hostEvent, event: o.info.event, script: o.info.script })) });
  assert.ok(n >= 1, "the launcher's memory routes are ad's now");
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  const left = R.ourHandlers(t.settings().hooks);
  assert.ok(left.some((o) => o.info.event === "prompt.submit" && !o.info.launcher), "ad's own routes stay");
  assert.equal(t.settings().env, undefined, "the marker setup wrote goes");
});

test("uninstalling another host keeps the launcher Claude Code's entries start, and Claude Code on", async () => {
  const t = home({ plugin: true });
  fs.mkdirSync(path.join(t.h, ".cursor"));
  t.ctx.resolve = () => null;
  assert.equal(await install({ ctx: t.ctx, hosts: ["cursor"], yes: true }), 0, t.text());
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["cursor"] }), 0, t.text());
  assert.ok(fs.existsSync(t.launcher));
  assert.ok(!D.readDists(D.distsFile(t.env.AD_ROOT)).disabledHosts.includes("claude-code"));
  assert.equal(ours(t.settings()).length, 1);
});

test("Left on disk names the per-project journals with their size", async () => {
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  fs.mkdirSync(path.join(t.env.AD_ROOT, "projects", "p1"), { recursive: true });
  fs.writeFileSync(path.join(t.env.AD_ROOT, "projects", "p1", "learning-journal.jsonl"), "x".repeat(3000));
  assert.equal(await uninstall({ ctx: t.ctx }), 0);
  assert.match(t.text(), /Left on disk:[\s\S]*projects \(3 KB\): per-project journals and buffers/);
});

test("one install, setup or uninstall at a time", async () => {
  const t = home({ plugin: true, settings: { a: 1 } });
  const release = acquireLock("memory-ledger", { dir: path.join(t.env.AD_ROOT, "locks") });
  try {
    assert.equal(await S.setup({ ctx: t.ctx }), 1);
    assert.match(t.text(), /another install, setup or uninstall of ad's memory is running/);
    assert.deepEqual(t.settings(), { a: 1, enabledPlugins: { [PLUGIN_KEY]: true } });
    assert.equal(await uninstall({ ctx: t.ctx }), 1);
  } finally {
    release();
  }
});

test("the agent's shell can't install, set up, repair or uninstall; setup needs a terminal; install says how to finish", async () => {
  for (const cmd of ["install", "setup", "repair", "uninstall"]) assert.match(commandGate(cmd, { env: { AD_TOOL_SHELL: "1" }, isTTY: () => true }), /agent's own shell/);
  // Uninstall's review gate (while rules exist) is ad review's: never from the agent's shell or without a terminal.
  const { confirmInOwnTerminal } = await import("../src/review.mjs");
  assert.equal((await confirmInOwnTerminal({ env: { AD_TOOL_SHELL: "1" }, isTTY: () => true })).ok, false);
  assert.equal((await confirmInOwnTerminal({ env: {}, isTTY: () => false })).ok, false);
  assert.equal((await confirmInOwnTerminal({ env: {}, isTTY: () => true, ancestry: () => ({ verdict: "agent", agent: "claude" }) })).ok, false);
  assert.equal((await confirmInOwnTerminal({ env: {}, isTTY: () => true, ancestry: () => ({ verdict: "terminal" }) })).ok, true);
  assert.match(commandGate("setup", { env: {}, isTTY: () => false }), /winpty/);
  for (const cmd of ["install", "repair", "uninstall", "doctor", "status", "report"]) assert.equal(commandGate(cmd, { env: {}, isTTY: () => false }), null, cmd);
  const lines = [];
  assert.equal(await main(["setup"], { env: { AD_TOOL_SHELL: "1" }, log: (l) => lines.push(l) }), 2);

  // No terminal: the MCP part only, then the pinned command to finish with.
  const t = home({ plugin: true, tty: false, settings: { a: 1 } });
  assert.equal(await install({ ctx: t.ctx, hosts: ["claude-code"], yes: true }), 2, t.text());
  // From this clone it is ad's own command; from the npm package the pinned npx line.
  assert.match(t.text(), /Finish in a terminal \(the hooks need one\): ad memory setup/);
  assert.equal(makeContext({ viaLauncher: true, home: t.h, env: t.env }).command("setup"), `npx -y ${PRODUCT.package}@${t.ctx.version} setup`);
  assert.equal(ours(t.settings()).length, 0);
  // In a terminal the same install sets the hooks up.
  t.ctx.isTTY = () => true;
  assert.equal(await install({ ctx: t.ctx, hosts: ["claude-code"], yes: true }), 0, t.text());
  assert.equal(ours(t.settings()).length, 1);
  // Nothing for setup to do (Cursor only): no terminal needed, exit 0.
  const c = home({ tty: false });
  fs.mkdirSync(path.join(c.h, ".cursor"));
  assert.equal(await install({ ctx: c.ctx, hosts: ["cursor"], yes: true }), 0, c.text());
});

test("setup then uninstall gives the settings file back byte for byte, whatever its layout", async () => {
  const pretty = JSON.stringify({ model: "opus", hooks: { PreToolUse: [USER_HOOK] }, env: { FOO: "bar" } }, null, 2) + "\n";
  const variants = {
    pretty,
    "CRLF and a BOM": "\u{FEFF}" + pretty.replace(/\n/g, "\r\n"),
    tabs: JSON.stringify({ model: "opus", env: { FOO: "bar" } }, null, "\t") + "\n",
    comments: '{\n  // my model\n  "model": "opus", // keep me\n  "env": { "FOO": "bar" } // and me\n}\n',
    "one-line containers": '{\n  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo mine" }] }] },\n  "env": {"FOO": "1"}\n}\n',
    "empty containers the user had": '{\n  "hooks": {\n    "PreToolUse": []\n  },\n  "env": {}\n}\n',
    minified: '{"model":"opus","env":{"FOO":"bar"}}',
    "trailing comma": '{\n  "model": "opus",\n}\n',
    "trailing commas and a line comment": '{\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [] }, // mine\n    ],\n  },\n  "model": "opus", // keep\n}\n',
    "containers holding only a comment": '{\n  "hooks": {\n    "PreToolUse": [ // none yet\n    ]\n  },\n  "env": { /* later */ }\n}\n',
  };
  for (const [name, text] of Object.entries(variants)) {
    const t = home({ settings: text });
    assert.equal(await S.setup({ ctx: t.ctx, noPlugin: true }), 0, `${name}: ${t.text()}`);
    assert.equal(ours(S.parseSettings(fs.readFileSync(t.file, "utf8")).root).length, 5, name);
    assert.equal(await uninstall({ ctx: t.ctx }), 0, `${name}: ${t.text()}`);
    assert.equal(fs.readFileSync(t.file, "utf8"), text, name);
  }
});

test("an uninstall that can't change the file keeps the items ad's, fails, and finishes once the file is fixed", async () => {
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  const good = fs.readFileSync(t.file, "utf8");
  fs.writeFileSync(t.file, good + "garbage");
  assert.equal(await uninstall({ ctx: t.ctx }), 1, t.text());
  assert.match(t.text(), /isn't valid JSON \([^)]*\); run uninstall again once that is fixed/);
  assert.equal(readLedger2(t.env.AD_ROOT).items.length, 2, "still ad's, to remove next time");
  fs.writeFileSync(t.file, good);
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.equal(ours(t.settings()).length, 0);
  assert.equal(readLedger2(t.env.AD_ROOT).items.length, 0);
});

test("while rules exist and the review is refused, the host stays on, so the kept tool.before still checks", async () => {
  const t = home({ plugin: true, rulesExist: true, token: false });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.equal(await uninstall({ ctx: t.ctx }), 1, t.text());
  assert.ok(!D.readDists(D.distsFile(t.env.AD_ROOT)).disabledHosts.includes("claude-code"));
  assert.match(t.text(), /Claude Code stays on: rules exist, and turning off its tool\.before check needs your review/);
  // A kept entry the user changed is turned off only with the review, too.
  const u = home({ plugin: true, rulesExist: true, token: false });
  assert.equal(await S.setup({ ctx: u.ctx }), 0);
  const s = u.settings();
  s.hooks.PreToolUse[0].hooks[0].args.push("--mine");
  fs.writeFileSync(u.file, JSON.stringify(s, null, 2));
  await uninstall({ ctx: u.ctx });
  assert.ok(!D.readDists(D.distsFile(u.env.AD_ROOT)).disabledHosts.includes("claude-code"));
  // A tool.before the ledger doesn't know of (its record lost) keeps the host on too.
  const v = home({ plugin: true, rulesExist: true, token: false });
  assert.equal(await S.setup({ ctx: v.ctx }), 0);
  const ledgerFile = path.join(v.env.AD_ROOT, "memory", "ledger.json");
  const led = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  led.items = led.items.filter((i) => i.kind !== "hook");
  fs.writeFileSync(ledgerFile, JSON.stringify(led));
  await uninstall({ ctx: v.ctx });
  assert.equal(ours(v.settings()).length, 1);
  assert.ok(!D.readDists(D.distsFile(v.env.AD_ROOT)).disabledHosts.includes("claude-code"));
});

test("a settings file with comments still shows the plugin to setup", async () => {
  const t = home({ settings: `{\n  // my plugins\n  "enabledPlugins": { "${PLUGIN_KEY}": true },\n}\n` });
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  assert.doesNotMatch(t.text(), /\/plugin install/);
  assert.equal(ours(S.parseSettings(fs.readFileSync(t.file, "utf8")).root).length, 1);
});

test("with ad init's hooks capturing and no plugin, setup writes the marker, skips every memory hook and adopts ad's rules-check", async () => {
  const adPrompt = { hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "prompt.submit"], timeout: 10 }] };
  const adTool = { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "tool.before"], timeout: 5 }] };
  const adStart = { hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "session.start"], timeout: 10 }] };
  const t = home({ settings: { hooks: { UserPromptSubmit: [adPrompt], PreToolUse: [adTool], SessionStart: [adStart] } } });
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  assert.doesNotMatch(t.text(), /\/plugin install/);
  assert.equal(t.settings().env.AD_TOOL_SHELL, "1");
  assert.deepEqual(t.settings().hooks.UserPromptSubmit, [adPrompt]);
  // L7 (D10): the rules check moves into the launcher's entry; ad's own goes.
  const pre = R.ourHandlers(t.settings().hooks).filter((o) => o.info.event === "tool.before");
  assert.deepEqual(pre.map((o) => Boolean(o.info.launcher)), [true]);
});

test("doctor, dry runs, backups, install and the gate's command after P3b's review", async () => {
  // Doctor: a turned-off launcher entry is there and quiet, not gone.
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0);
  assert.ok(fs.readdirSync(path.join(t.env.AD_ROOT, "memory", "backups", "claude-code")).length === 1, "the settings file as it was before setup");
  D.setHostDisabled(D.distsFile(t.env.AD_ROOT), "claude-code", true);
  const { scriptRow, memoryPluginState } = await import("../src/hooks/hook-doctor.mjs");
  const row = scriptRow([{ name: t.file, hooks: t.settings().hooks }], R.HOOK_PATH, { transient: () => null });
  assert.equal(row.ok, true, row.note);
  assert.match(row.note, /1 memory hook entry turned off by its uninstall/);
  // Install turns a host it sets up again back on.
  fs.mkdirSync(path.join(t.h, ".cursor"));
  D.setHostDisabled(D.distsFile(t.env.AD_ROOT), "cursor", true);
  assert.equal(await install({ ctx: t.ctx, hosts: ["cursor"], yes: true }), 0, t.text());
  assert.ok(!D.readDists(D.distsFile(t.env.AD_ROOT)).disabledHosts.includes("cursor"));
  // A dry run leaves a garbled ledger where it is.
  const g = home({ plugin: true });
  fs.mkdirSync(path.join(g.env.AD_ROOT, "memory"), { recursive: true });
  fs.writeFileSync(path.join(g.env.AD_ROOT, "memory", "ledger.json"), "{ garbled");
  assert.equal(await S.setup({ ctx: g.ctx, dryRun: true }), 0);
  assert.equal(fs.readFileSync(path.join(g.env.AD_ROOT, "memory", "ledger.json"), "utf8"), "{ garbled");
  assert.match(g.text(), /would add the tool\.before hook/);
  // An exec-form plugin (--plugin as an argument) is not "from before the dispatcher".
  const cfg = path.join(t.h, ".claude");
  const inst = path.join(cfg, "plugins", "cache", "p");
  fs.mkdirSync(path.join(inst, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(inst, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/hook.mjs", "session.start", "--host", "claude-code", "--plugin"] }] }] } }));
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [PLUGIN_KEY]: [{ scope: "user", installPath: inst, version: "3.2.0" }] } }));
  assert.equal(memoryPluginState({ env: { CLAUDE_CONFIG_DIR: cfg }, home: t.h, cwd: null }).outdated, false);
  // The gate's refusal names the command to type here (ad's own from a clone).
  const lines = [];
  await main(["uninstall"], { env: { AD_TOOL_SHELL: "1" }, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /Run it yourself in a terminal: (ad memory uninstall|npx -y agent-daemon-memory@\S+ uninstall)/);
});

test("L7: setup takes over ad init's rules check without lowering it, and uninstall puts it back", async () => {
  const adTool = { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "tool.before"], timeout: 10, onFailure: "block" }] };
  const t = home({ plugin: true, settings: { hooks: { PreToolUse: [adTool] } } });
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  const pre = R.ourHandlers(t.settings().hooks).filter((o) => o.info.event === "tool.before");
  assert.equal(pre.length, 1);
  assert.ok(pre[0].info.launcher);
  assert.equal(pre[0].handler.onFailure, "block", "a blocking check stays blocking");
  assert.equal(pre[0].handler.timeout, 10, "and keeps the longer timeout");
  assert.ok(readLedger2(t.env.AD_ROOT).items.some((i) => i.adopted?.length === 1), "the ledger remembers what it took over");
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  const back = R.ourHandlers(t.settings().hooks).filter((o) => o.info.event === "tool.before");
  assert.deepEqual(back.map((o) => Boolean(o.info.launcher)), [false], "ad's own rules check is back");
  assert.match(t.text(), /ad's own rules check is back/);
  // The launcher's entry already in place, ad init's blocking one added later: raised, not lowered.
  const t2 = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t2.ctx }), 0, t2.text());
  const s2 = t2.settings();
  fs.writeFileSync(t2.file, JSON.stringify({ ...s2, hooks: { ...s2.hooks, PreToolUse: [...s2.hooks.PreToolUse, adTool] } }, null, 2));
  assert.equal(await S.setup({ ctx: t2.ctx }), 0, t2.text());
  const pre2 = R.ourHandlers(t2.settings().hooks).filter((o) => o.info.event === "tool.before");
  assert.deepEqual(pre2.map((o) => [Boolean(o.info.launcher), o.handler.onFailure, o.handler.timeout]), [[true, "block", 10]]);
});

test("L7: uninstall says so when ad init's hooks are left with no rules check", async () => {
  const adPrompt = { hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "prompt.submit"], timeout: 10 }] };
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  // ad init ran after setup: it kept the launcher's tool.before and wrote its other routes.
  const s = t.settings();
  fs.writeFileSync(t.file, JSON.stringify({ ...s, hooks: { ...s.hooks, UserPromptSubmit: [adPrompt] } }, null, 2));
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.match(t.text(), /no longer run a rules check: run `ad init`/);
});

test("L7: memory uninstall keeps the launcher while ad's engine hooks.json runs tool.before through it", async () => {
  const t = home({ plugin: true });
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  const engineHooks = path.join(t.env.AD_ROOT, "engine", "hooks.json");
  fs.mkdirSync(path.dirname(engineHooks), { recursive: true });
  fs.writeFileSync(engineHooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `'node' '${t.launcher}' hook tool.before --host ad` }] }] } }));
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.text());
  assert.ok(fs.existsSync(t.launcher), "the launcher stays for ad's own workers");
});

test("L7: a launcher entry ad has no record of leaves ad's own check beside it; a hand-deleted one still gets ad's back on uninstall; ad init keeps both", async () => {
  const adTool = { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [R.HOOK_PATH, "tool.before"], timeout: 10, onFailure: "block" }] };
  // A launcher tool.before ad has no record of ("keep"): ad's own blocking entry stays.
  const t = home({ plugin: true });
  const launcherEntry = { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [t.launcher, "hook", "tool.before", "--host", "claude-code", "--verbose"], timeout: 7, onFailure: "continue" }] };
  fs.writeFileSync(t.file, JSON.stringify({ enabledPlugins: t.settings().enabledPlugins, hooks: { PreToolUse: [launcherEntry, adTool] } }, null, 2));
  assert.equal(await S.setup({ ctx: t.ctx }), 0, t.text());
  const kinds = R.ourHandlers(t.settings().hooks).filter((o) => o.info.event === "tool.before").map((o) => Boolean(o.info.launcher)).sort();
  assert.deepEqual(kinds, [false, true], "ad's own check isn't taken over by an entry ad didn't write");
  // ad init with both live: ad's own stays (nothing lowered).
  const plan = R.planClaudeHooks(t.settings().hooks, { steps: ["rules-check"] });
  const own = R.ourHandlers(plan.hooks).filter((o) => !o.info.launcher && o.info.event === "tool.before");
  assert.equal(own.length, 1, "ad init keeps ad's own check beside the launcher's");
  assert.equal(own[0].handler.onFailure, "block", "as it was");
  // Adopted, then the launcher's entry deleted by hand: uninstall still puts ad's back.
  const t2 = home({ plugin: true, settings: { hooks: { PreToolUse: [adTool] } } });
  assert.equal(await S.setup({ ctx: t2.ctx }), 0, t2.text());
  const s2 = t2.settings();
  fs.writeFileSync(t2.file, JSON.stringify({ ...s2, hooks: { ...s2.hooks, PreToolUse: [] } }, null, 2));
  assert.equal(await uninstall({ ctx: t2.ctx }), 0, t2.text());
  assert.ok(R.ourHandlers(t2.settings().hooks).some((o) => !o.info.launcher && o.info.event === "tool.before"), t2.text());
});
