// L7 D13: the rule switch. While rules are in force ad's tool.before entry in Claude Code's
// user settings fails closed (onFailure "block", timeout ≥ 10) and, with an env-read policy
// rule, its matcher covers Read; with none it goes back to the values it had before the first
// raise (absence included) — and only with the review token (S1). Temp homes and roots only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeContext } = await import("../src/memory-install/install.mjs");
const S = await import("../src/memory-install/setup.mjs");
const W = await import("../src/memory-install/rule-switch.mjs");
const { readLedger2, openLedger2ForWrite, upsertItem, writeLedger2 } = await import("../src/memory-install/ledger2.mjs");
const D = await import("../src/memory/launch/dists.mjs");
const { writeGuards } = await import("../src/hooks/guards.mjs");
const { PRODUCT } = await import("../src/product.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");
const TOKEN = testReviewToken();

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const PLUGIN_KEY = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
const RULE = { id: 1, kind: "command", decision: "deny", reason: "x", scope: "project", project: "p1", rule: { type: "literal", text: "rm -rf build" } };
const ENV_READ = { id: 2, kind: "command", decision: "ask", reason: "starter safety policy", scope: "all", project: "policy", rule: { type: "policy", family: "env-read" } };
const H = 3_600_000;

/** A fake home with ad set up in Claude Code (the plugin on, so tool.before is written). */
async function home({ settings = {} } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-switch-home-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ ...settings, enabledPlugins: { [PLUGIN_KEY]: true } }, null, 2) + "\n");
  const env = { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: path.join(h, ".claude"), AD_ROOT: path.join(h, ".agent-daemon"), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const ctx = makeContext({ env, home: h, root: env.AD_ROOT, viaLauncher: false, resolve: () => null, out: (l) => lines.push(String(l)), isTTY: () => true, claudeVersion: async () => "2.1.319", lockWaitMs: 50 });
  assert.equal(await S.setup({ ctx, hosts: ["claude-code"] }), 0, lines.join("\n"));
  const file = path.join(h, ".claude", "settings.json");
  const settingsNow = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = () => {
    for (const g of settingsNow().hooks?.PreToolUse ?? []) for (const x of g.hooks ?? []) if (x.args?.includes("tool.before")) return { group: g, handler: x };
    return null;
  };
  return { h, ctx, root: env.AD_ROOT, file, text: () => fs.readFileSync(file, "utf8"), settings: settingsNow, entry, lines };
}
const count = (global, projects) => global.length + Object.values(projects).reduce((n, p) => n + p.rules.length, 0);
const snapshot = (root, { global = [], projects = {}, pausedAll } = {}) => writeGuards({ projects, global: { rules: global }, ruleCount: count(global, projects), ...(pausedAll ? { pausedAll } : {}) }, { root });
const p1 = (rules, paused = false) => ({ p1: { roots: ["/work/app"], paused, rules } });

test("wantedState: rules exist → active; an env-read policy rule exists → readMatcher; pauses don't count", () => {
  const now = Date.now();
  const snap = (o) => ({ version: 1, generation: 1, projects: {}, ...o, ruleCount: count(o.global?.rules ?? [], o.projects ?? {}) });
  assert.deepEqual(W.wantedState(null, now), { active: false, readMatcher: false });
  assert.deepEqual(W.wantedState(snap({}), now), { active: false, readMatcher: false });
  assert.deepEqual(W.wantedState(snap({ projects: p1([RULE]) }), now), { active: true, readMatcher: false });
  assert.deepEqual(W.wantedState(snap({ global: { rules: [ENV_READ] } }), now), { active: true, readMatcher: true });
  assert.deepEqual(W.wantedState(snap({ projects: p1([ENV_READ]) }), now), { active: true, readMatcher: true });
  const live = { at: new Date(now - H).toISOString(), until: new Date(now + H).toISOString() };
  // Pauses don't count: a paused rule still exists, and a pause ends by itself.
  assert.deepEqual(W.wantedState(snap({ global: { rules: [ENV_READ] }, pausedAll: live })), { active: true, readMatcher: true });
  assert.deepEqual(W.wantedState(snap({ projects: p1([ENV_READ], live) })), { active: true, readMatcher: true });
});

test("coversRead: none, '', '*' and a regex that matches Read cover it; a list without it doesn't", () => {
  for (const m of [null, undefined, "", "*", ".*", "Bash|Read", "Re.*"]) assert.equal(W.coversRead(m), true, String(m));
  for (const m of ["Bash", "Bash|PowerShell|Write|Edit", "Reader", "Bash|Read2"]) assert.equal(W.coversRead(m), false, m);
});

test("the first rule raises tool.before to block/10 with no token; orig keeps the values before it", async () => {
  const t = await home();
  const before = t.entry().handler;
  assert.equal(before.onFailure, "continue");
  snapshot(t.root, { projects: p1([RULE]) });
  const r = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(r.changed, true, JSON.stringify(r));
  assert.equal(r.active, true);
  const after = t.entry().handler;
  assert.equal(after.onFailure, "block");
  assert.equal(after.timeout, W.BLOCK_TIMEOUT);
  const item = readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before");
  assert.deepEqual(item.orig, { onFailure: "continue", timeout: before.timeout, matcher: t.entry().group.matcher, had: { onFailure: true, timeout: true, matcher: true } });
  assert.deepEqual(W.readSwitchRecord(t.root), { at: W.readSwitchRecord(t.root).at, active: true, readMatcher: false, pendingLower: false });
  assert.equal(W.switchDue(t.root), false);
  // Again: nothing to change, and orig is never overwritten by the raised values.
  const text = t.text();
  assert.equal((await W.applyRuleSwitch({ ctx: t.ctx })).changed, false);
  assert.equal(t.text(), text);
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before").orig.onFailure, "continue");
});

test("a longer timeout than 10 stays; a shorter one is raised", async () => {
  const t = await home();
  snapshot(t.root, { projects: p1([RULE]) });
  const S2 = S.parseSettings(t.text());
  const [f] = S.locateHook(S2.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(t.root) });
  fs.writeFileSync(t.file, S.applyOps(S2.body, [{ path: ["hooks", "PreToolUse", f.gi, "hooks", f.hi, "timeout"], value: 30 }]).text);
  await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(t.entry().handler.timeout, 30);
  assert.equal(t.entry().handler.onFailure, "block");
});

test("the last rule: a tokenless run never lowers (pendingLower); the token puts orig back byte for byte", async () => {
  const t = await home();
  const pristine = t.text();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  snapshot(t.root, {});
  const raised = t.text();
  const r = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(r.changed, false);
  assert.equal(r.pendingLower, true);
  assert.equal(t.text(), raised, "no token: still block");
  assert.equal(W.readSwitchRecord(t.root).pendingLower, true);
  assert.equal(W.switchDue(t.root), false, "a tokenless run can't lower: not due again");
  const r2 = await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(r2.changed, true);
  assert.equal(r2.pendingLower, false);
  assert.equal(t.text(), pristine, "the resting values, as they were");
});

test("orig absence is restored: a handler with no onFailure or timeout gets none back", async () => {
  const t = await home();
  const S2 = S.parseSettings(t.text());
  const [f] = S.locateHook(S2.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(t.root) });
  const at = ["hooks", "PreToolUse", f.gi, "hooks", f.hi];
  fs.writeFileSync(t.file, S.applyOps(S2.body, [{ path: [...at, "onFailure"], value: undefined }, { path: [...at, "timeout"], value: undefined }]).text);
  const pristine = t.text();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(t.entry().handler.onFailure, "block");
  snapshot(t.root, {});
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(t.text(), pristine);
  assert.equal("onFailure" in t.entry().handler, false);
  assert.equal("timeout" in t.entry().handler, false);
});

test("a pause never lowers: the check stays fail-closed while paused rules exist", async () => {
  const t = await home();
  const now = Date.now();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx, now });
  snapshot(t.root, { projects: p1([RULE]), pausedAll: { at: new Date(now).toISOString(), until: new Date(now + H).toISOString() } });
  assert.equal(W.switchDue(t.root, now), false);
  const r = await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN, now });
  assert.equal(r.changed, false);
  assert.equal(t.entry().handler.onFailure, "block");
});

test("an env-read policy rule adds Read to the matcher with no token; removal needs the token", async () => {
  const t = await home();
  const m0 = t.entry().group.matcher;
  assert.equal(W.coversRead(m0), false, m0);
  snapshot(t.root, { global: [ENV_READ] });
  const r = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(r.readMatcher, true);
  assert.equal(t.entry().group.matcher, `${m0}|Read`);
  assert.equal(t.entry().handler.onFailure, "block");
  // The env-read rule goes, another stays: Read stays until a tokened run.
  snapshot(t.root, { projects: p1([RULE]) });
  const r2 = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(r2.pendingLower, true);
  assert.equal(t.entry().group.matcher, `${m0}|Read`);
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(t.entry().group.matcher, m0);
  assert.equal(t.entry().handler.onFailure, "block", "a rule is still in force");
});

test("a matcher the user had with Read keeps it after the last rule", async () => {
  const t = await home();
  const S2 = S.parseSettings(t.text());
  const [f] = S.locateHook(S2.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(t.root) });
  const m0 = `${f.matcher}|Read`;
  fs.writeFileSync(t.file, S.applyOps(S2.body, [{ path: ["hooks", "PreToolUse", f.gi, "matcher"], value: m0 }]).text);
  const pristine = t.text();
  snapshot(t.root, { global: [ENV_READ] });
  await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(t.entry().group.matcher, m0);
  snapshot(t.root, {});
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(t.text(), pristine);
});

test("a shared group keeps its matcher (other hooks would run for Read) and says so", async () => {
  const t = await home();
  const S2 = S.parseSettings(t.text());
  const [f] = S.locateHook(S2.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(t.root) });
  fs.writeFileSync(t.file, S.applyOps(S2.body, [{ path: ["hooks", "PreToolUse", f.gi, "hooks", -1], value: { type: "command", command: "echo mine" }, insert: true }]).text);
  const m0 = t.entry().group.matcher;
  snapshot(t.root, { global: [ENV_READ] });
  const r = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(t.entry().group.matcher, m0);
  assert.match(r.why ?? "", /shares its group/);
  assert.equal(t.entry().handler.onFailure, "block", "the raise itself still happens");
});

test("setup's re-run keeps the raise and orig; an unreadable rules file never lowers", async () => {
  const t = await home();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.lines.join("\n"));
  assert.equal(t.entry().handler.onFailure, "block");
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before").orig?.onFailure, "continue", "upsertItem carries orig");
  const text = t.text();
  // Both snapshot files unreadable, guards.active gone too: nothing is known, nothing changes.
  for (const f of ["guards.json", "guards.last-good.json"]) fs.writeFileSync(path.join(t.root, f), "{not json");
  fs.rmSync(path.join(t.root, "guards.active"), { force: true });
  const r = await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.match(r.why ?? "", /unreadable/);
  assert.equal(t.text(), text);
  // guards.active says rules exist: still raised, and the token can't lower it.
  fs.writeFileSync(path.join(t.root, "guards.active"), "1");
  const r2 = await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(r2.active, true);
  assert.equal(t.text(), text);
  assert.equal(W.switchDue(t.root), false);
});

test("no settings file or no ledger item: nothing written, the record still made", async () => {
  const t = await home();
  const opened = openLedger2ForWrite(t.root);
  opened.ledger.items = opened.ledger.items.filter((i) => i.locator?.event !== "tool.before");
  await writeLedger2(t.root, opened.ledger);
  const text = t.text();
  snapshot(t.root, { projects: p1([RULE]) });
  const r = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(r.changed, false);
  assert.equal(t.text(), text, "an entry ad has no record of is the user's");
  assert.equal(W.readSwitchRecord(t.root).active, true);
  fs.rmSync(t.file);
  assert.equal((await W.applyRuleSwitch({ ctx: t.ctx })).changed, false);
  assert.equal(fs.existsSync(t.file), false);
});

test("upsertItem carries orig; a fresh item has none", () => {
  const ledger = { items: [] };
  const spec = { host: "claude-code", kind: "hook", file: "/x/settings.json", locator: { hostEvent: "PreToolUse", event: "tool.before", script: "/r/run.mjs" }, value: { command: "node" } };
  const a = upsertItem(ledger, spec);
  assert.equal("orig" in a, false);
  a.orig = { onFailure: "continue", timeout: 5, matcher: "Bash", had: { onFailure: true, timeout: true, matcher: true } };
  const b = upsertItem(ledger, { ...spec, value: { command: "node", args: ["x"] } });
  assert.deepEqual(b.orig, a.orig);
});

test("end to end: safety on raises the entry and adds Read; safety off (token) puts both back; a setup meanwhile fails closed", async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const policy = await import("../src/memory/starter-policy.mjs");
  const t = await home();
  const pristine = t.text();
  const h = await open({ dbPath: path.join(t.root, "episodic.db") });
  try {
    const on = await policy.setPolicy(h, testReviewToken(), true, { root: t.root });
    assert.equal(on.switch?.changed, true, JSON.stringify(on.switch));
    assert.equal(t.entry().handler.onFailure, "block");
    assert.equal(W.coversRead(t.entry().group.matcher), true);
    // A setup re-run while the policy is on keeps it raised.
    assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.lines.join("\n"));
    assert.equal(t.entry().handler.onFailure, "block");
    const off = await policy.setPolicy(h, testReviewToken(), false, { root: t.root });
    assert.equal(off.switch?.changed, true, JSON.stringify(off.switch));
    assert.equal(t.text(), pristine);
  } finally {
    h.close();
  }
});

test("setup run while rules are in force writes the entry raised (no token needed)", async () => {
  const t = await home();
  const opened = openLedger2ForWrite(t.root);
  // As if set up before: remove the entry and its record, add a rule, set up again.
  opened.ledger.items = opened.ledger.items.filter((i) => i.locator?.event !== "tool.before");
  await writeLedger2(t.root, opened.ledger);
  const s0 = t.settings();
  s0.hooks.PreToolUse = s0.hooks.PreToolUse.filter((g) => !g.hooks.some((x) => x.args?.includes("tool.before")));
  if (!s0.hooks.PreToolUse.length) delete s0.hooks.PreToolUse;
  fs.writeFileSync(t.file, JSON.stringify(s0, null, 2) + "\n");
  snapshot(t.root, { projects: p1([RULE]) });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.lines.join("\n"));
  assert.equal(t.entry().handler.onFailure, "block");
  assert.equal(t.entry().handler.timeout, W.BLOCK_TIMEOUT);
  assert.match(t.lines.join("\n"), /fails closed/);
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before").orig.onFailure, "continue");
});

// Review round 1 (P3-1).
const editEntry = (t, edit) => {
  const P = S.parseSettings(t.text());
  const [f] = S.locateHook(P.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(t.root) });
  const at = ["hooks", "PreToolUse", f.gi];
  fs.writeFileSync(t.file, S.applyOps(P.body, edit(at, f)).text);
};

test("a restore puts back only what ad raised: the user's later block, timeout and Read stay; orig is cleared after it", async () => {
  const t = await home();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  snapshot(t.root, {});
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before").orig, undefined, "cleared once put back");
  // The user's own choice now: block, 30, Read.
  editEntry(t, (at, f) => [{ path: [...at, "hooks", f.hi, "onFailure"], value: "block" }, { path: [...at, "hooks", f.hi, "timeout"], value: 30 }, { path: [...at, "matcher"], value: `${f.matcher}|Read` }]);
  const mine = t.text();
  snapshot(t.root, { global: [ENV_READ] });
  assert.equal((await W.applyRuleSwitch({ ctx: t.ctx })).changed, false);
  snapshot(t.root, {});
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(t.text(), mine);
});

test("a field the user changed while raised keeps their value at the restore", async () => {
  const t = await home();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  editEntry(t, (at, f) => [{ path: [...at, "hooks", f.hi, "timeout"], value: 45 }]);
  snapshot(t.root, {});
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(t.entry().handler.timeout, 45);
  assert.equal(t.entry().handler.onFailure, "continue");
});

test("a file that can't be read leaves the others switched, their orig recorded, and the switch due again", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const t = await home();
  const other = path.join(t.h, "old-config", "settings.json");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "{}");
  const opened = openLedger2ForWrite(t.root);
  const mine = opened.ledger.items.find((i) => i.locator?.event === "tool.before");
  upsertItem(opened.ledger, { host: "claude-code", kind: "hook", file: other, locator: mine.locator, value: mine.value });
  await writeLedger2(t.root, opened.ledger);
  fs.chmodSync(other, 0o000);
  try {
    snapshot(t.root, { projects: p1([RULE]) });
    const r = await W.applyRuleSwitch({ ctx: t.ctx });
    assert.equal(t.entry().handler.onFailure, "block");
    assert.match(r.why ?? "", /couldn't switch/);
    assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before" && i.file === t.file).orig?.onFailure, "continue");
    assert.equal(W.readSwitchRecord(t.root).failed, true);
    assert.equal(W.switchDue(t.root), true);
  } finally {
    fs.chmodSync(other, 0o644);
  }
  snapshot(t.root, {});
  await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(t.entry().handler.onFailure, "continue");
});

test("a read-only or non-UTF-8 file is never rewritten, and says why", async () => {
  const t = await home();
  editEntry(t, () => []);
  const bytes = Buffer.concat([Buffer.from(t.text().replace(/\n}\n?$/, ',\n  "x": "caf')), Buffer.from([0xe9]), Buffer.from('"\n}\n')]);
  fs.writeFileSync(t.file, bytes);
  snapshot(t.root, { projects: p1([RULE]) });
  const r = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.match(r.why ?? "", /UTF-8/);
  assert.ok(fs.readFileSync(t.file).equals(bytes));
  assert.equal(W.switchDue(t.root), true);
});

test("a last-good snapshot behind the sentinel raises and never lowers; a token that isn't a review token can't lower", async () => {
  const t = await home();
  snapshot(t.root, {});
  snapshot(t.root, { projects: p1([RULE]) });
  fs.writeFileSync(path.join(t.root, "guards.active"), JSON.stringify({ ruleCount: 1 }) + "\n");
  fs.writeFileSync(path.join(t.root, "guards.json"), "{trunc");
  const w = W.wantedNow(t.root);
  assert.equal(w.active, true);
  assert.equal(w.sure, false);
  await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(t.entry().handler.onFailure, "block");
  snapshot(t.root, {});
  for (const fake of [true, { id: "t" }, "token"]) {
    const r = await W.applyRuleSwitch({ ctx: t.ctx, token: fake });
    assert.equal(r.pendingLower, true);
    assert.equal(t.entry().handler.onFailure, "block");
  }
});

test("safety on prints the switch's why (a shared group: Read isn't checked there)", async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const { safetyMain } = await import("../src/memory/safety-cli.mjs");
  const t = await home();
  editEntry(t, (at) => [{ path: [...at, "hooks", -1], value: { type: "command", command: "echo mine" }, insert: true }]);
  const h = await open({ dbPath: path.join(t.root, "episodic.db") });
  try {
    const lines = [];
    const code = await safetyMain(["on"], { out: (l) => lines.push(l), env: {}, isTTY: () => true, handle: h, root: t.root, token: async () => ({ token: testReviewToken() }), command: (v) => `ad ${v}`, version: null, others: async () => [] });
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /shares its group/);
    assert.equal(t.entry().handler.onFailure, "block");
  } finally {
    h.close();
  }
});

test("from the last-good copy even a review token takes nothing away (Read stays)", async () => {
  const t = await home();
  snapshot(t.root, { projects: p1([RULE]) });
  snapshot(t.root, { global: [ENV_READ], projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(W.coversRead(t.entry().group.matcher), true);
  fs.writeFileSync(path.join(t.root, "guards.json"), "{trunc");
  const r = await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  assert.equal(r.readMatcher, false, "the last-good copy has no env-read rule");
  assert.equal(W.coversRead(t.entry().group.matcher), true);
  assert.equal(t.entry().handler.onFailure, "block");
});

// Review round 2 (P3-1).
test("a raise whose orig can't be recorded leaves the file as it is (never raised with nothing to put back)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const { ledger2Path } = await import("../src/memory-install/ledger2.mjs");
  const t = await home();
  const text = t.text();
  snapshot(t.root, { projects: p1([RULE]) });
  const dir = path.dirname(ledger2Path(t.root));
  fs.chmodSync(dir, 0o555);
  let r;
  try {
    r = await W.applyRuleSwitch({ ctx: t.ctx });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.match(r.why ?? "", /resting values/);
  assert.equal(t.text(), text);
  const r2 = await W.applyRuleSwitch({ ctx: t.ctx });
  assert.equal(r2.changed, true);
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before").orig?.onFailure, "continue");
});

test("a tokened lowering that failed is retried by the next review (afterReview with no rules left)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const { afterReview } = await import("../src/memory/rules-finish.mjs");
  const t = await home();
  const pristine = t.text();
  snapshot(t.root, { projects: p1([RULE]) });
  await W.applyRuleSwitch({ ctx: t.ctx });
  snapshot(t.root, {});
  fs.chmodSync(t.file, 0o444);
  let r;
  try {
    r = await W.applyRuleSwitch({ ctx: t.ctx, token: TOKEN });
  } finally {
    fs.chmodSync(t.file, 0o644);
  }
  assert.match(r.why ?? "", /read-only.*retries it/);
  assert.equal(W.switchDue(t.root), true);
  const h = await open({ dbPath: path.join(t.root, "episodic.db") });
  try {
    const done = await afterReview(h, testReviewToken(), { root: t.root });
    assert.equal(done?.switch?.changed, true, JSON.stringify(done));
    assert.equal(t.text(), pristine);
    assert.equal(await afterReview(h, testReviewToken(), { root: t.root }), null, "nothing owed now");
  } finally {
    h.close();
  }
});

test("afterReview with rules in the store switches too (an entry left un-raised is raised by the next review)", async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const policy = await import("../src/memory/starter-policy.mjs");
  const { afterReview } = await import("../src/memory/rules-finish.mjs");
  const t = await home();
  const h = await open({ dbPath: path.join(t.root, "episodic.db") });
  try {
    await policy.setPolicy(h, testReviewToken(), true, { root: t.root });
    editEntry(t, (at, f) => [{ path: [...at, "hooks", f.hi, "onFailure"], value: "continue" }]);
    const done = await afterReview(h, testReviewToken(), { root: t.root });
    assert.equal(done?.switch?.changed, true, JSON.stringify(done?.switch));
    assert.equal(t.entry().handler.onFailure, "block");
  } finally {
    h.close();
  }
});
