// L7 P3-3: uninstall after the rule switch (D13), its gate (rulesExist from the snapshot or
// guards.active; the review token plus the typed code of D16), Done-when 6 and 7, and Codex
// on Windows (its tool.before arrives with the first rule and stays). Temp homes only; no
// real terminal is opened (the tty seam), no real host runs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeContext, uninstall } = await import("../src/memory-install/install.mjs");
const S = await import("../src/memory-install/setup.mjs");
const W = await import("../src/memory-install/rule-switch.mjs");
const { readLedger2, ledger2Path } = await import("../src/memory-install/ledger2.mjs");
const D = await import("../src/memory/launch/dists.mjs");
const { writeGuards, activePath } = await import("../src/hooks/guards.mjs");
const { PRODUCT } = await import("../src/product.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");
const { toolBefore } = await import("../src/hooks/tool-before.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const PLUGIN_KEY = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
const USER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
const RULE = { id: 1, kind: "command", decision: "deny", reason: "x", scope: "project", project: "p1", rule: { type: "literal", text: "rm -rf build" } };
const rules = (root, list) => writeGuards({ projects: { p1: { roots: ["/work/app"], paused: false, rules: list } }, global: { rules: [] }, ruleCount: list.length }, { root });

/**
 * A home with Claude Code settings (the plugin on: tool.before is written). gate: what the
 * user's own terminal says ({ ok, dialogProven }); typed: what they type for the code.
 */
function home({ settings = {}, gate = { ok: false, why: "not your own terminal" }, typed = "", platform } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-unswitch-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ ...settings, enabledPlugins: { [PLUGIN_KEY]: true } }, null, 2) + "\n");
  const env = { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: path.join(h, ".claude"), CODEX_HOME: path.join(h, ".codex"), AD_ROOT: path.join(h, ".agent-daemon"), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const asked = [];
  const mk = (out = (l) => lines.push(String(l))) =>
    makeContext({
      env, home: h, root: env.AD_ROOT, viaLauncher: false, resolve: () => null, out, isTTY: () => true, claudeVersion: async () => "2.1.319", lockWaitMs: 50,
      ...(platform ? { platform } : {}),
      // The default rulesExist and confirmReview, with the terminal's answers as seams.
      ownTerminal: async () => gate,
      tty: { ask: async (q) => (asked.push(q), typed) },
      code: () => "kqtw",
    });
  const file = path.join(h, ".claude", "settings.json");
  const entry = () => {
    for (const g of JSON.parse(fs.readFileSync(file, "utf8")).hooks?.PreToolUse ?? []) for (const x of g.hooks ?? []) if (x.args?.includes("tool.before")) return { group: g, handler: x };
    return null;
  };
  return { h, env, root: env.AD_ROOT, ctx: mk(), mk, lines, asked, file, entry, text: () => fs.readFileSync(file, "utf8"), log: () => lines.join("\n") };
}

test("Done-when 6: zero rules → the entry carries its resting onFailure and the hook prints nothing; the first rule flips it, the last flips it back", async () => {
  const t = home({ settings: { hooks: { PreToolUse: [USER_HOOK] } } });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  assert.doesNotMatch(t.text(), /"block"/);
  assert.equal(t.entry().handler.onFailure, "continue");
  const out = toolBefore({ session_id: "s", cwd: "/work/app", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls -la" } }, { root: t.root, env: {}, host: "claude", platform: "linux", log: () => {} });
  assert.equal(out ?? null, null, "nothing printed for an ordinary call");
  rules(t.root, [RULE]);
  await W.switchAfterRules({ root: t.root, platform: "linux" });
  assert.equal(t.entry().handler.onFailure, "block");
  rules(t.root, []);
  await W.switchAfterRules({ root: t.root, token: testReviewToken(), platform: "linux" });
  assert.equal(t.entry().handler.onFailure, "continue");
  assert.doesNotMatch(t.text(), /"block"/);
});

test("Done-when 7: setup → first rule → last rule → uninstall leaves the user's file byte for byte", async () => {
  const t = home({ settings: { model: "opus", hooks: { PreToolUse: [USER_HOOK] } } });
  const pristine = fs.readFileSync(t.file);
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  rules(t.root, [RULE]);
  await W.switchAfterRules({ root: t.root, platform: "linux" });
  rules(t.root, []);
  fs.rmSync(activePath(t.root), { force: true });
  await W.switchAfterRules({ root: t.root, token: testReviewToken(), platform: "linux" });
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.log());
  assert.ok(fs.readFileSync(t.file).equals(pristine), t.text());
});

test("Done-when 7: an identical entry the user had before ad stays byte for byte — raised and put back, and never given an onFailure it didn't have (a ledger from before L7 too)", async () => {
  // The user's own copy of the entry: what setup writes, then ad's record of it gone.
  const t = home({ settings: { hooks: { PreToolUse: [USER_HOOK] } }, gate: { ok: true }, typed: "kqtw" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  fs.rmSync(ledger2Path(t.root));
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before").preExisted, true);
  const pristine = fs.readFileSync(t.file);
  rules(t.root, [RULE]);
  await W.switchAfterRules({ root: t.root, platform: "linux" });
  assert.equal(t.entry().handler.onFailure, "block");
  // Uninstall while the rule exists: the gate passes (token and code), the entry stays and gets its values back.
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.log());
  assert.match(t.asked.join("\n"), /— type kqtw: $/);
  assert.ok(fs.readFileSync(t.file).equals(pristine), t.text());

  // A ledger from before L7: the user's entry has no onFailure, and no orig was ever recorded.
  const u = home({ settings: { hooks: { PreToolUse: [USER_HOOK] } } });
  assert.equal(await S.setup({ ctx: u.ctx, hosts: ["claude-code"] }), 0, u.log());
  const P = S.parseSettings(u.text());
  const [f] = S.locateHook(P.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(u.root) });
  fs.writeFileSync(u.file, S.applyOps(P.body, [{ path: ["hooks", "PreToolUse", f.gi, "hooks", f.hi, "onFailure"], value: undefined }]).text);
  fs.rmSync(ledger2Path(u.root));
  assert.equal(await S.setup({ ctx: u.ctx, hosts: ["claude-code"] }), 0, u.log());
  const before = fs.readFileSync(u.file);
  assert.equal(await uninstall({ ctx: u.ctx }), 0, u.log());
  assert.ok(fs.readFileSync(u.file).equals(before), "no onFailure the user never had");
});

test("the uninstall gate: rules (the snapshot or guards.active alone) hold the entry raised unless the token and the typed code pass", async () => {
  // No terminal of the user's: held, still fail-closed.
  const a = home();
  assert.equal(await S.setup({ ctx: a.ctx, hosts: ["claude-code"] }), 0, a.log());
  rules(a.root, [RULE]);
  await W.switchAfterRules({ root: a.root, platform: "linux" });
  const raised = a.text();
  await uninstall({ ctx: a.ctx });
  assert.equal(a.text(), raised);
  assert.match(a.log(), /rules exist, and removing it needs your review/);
  // The user's terminal, but the wrong code: held too, and it says why.
  const b = home({ gate: { ok: true }, typed: "zzzz" });
  assert.equal(await S.setup({ ctx: b.ctx, hosts: ["claude-code"] }), 0, b.log());
  rules(b.root, [RULE]);
  await W.switchAfterRules({ root: b.root, platform: "linux" });
  // Both snapshot files unreadable: guards.active alone says rules exist.
  fs.writeFileSync(activePath(b.root), "1\n");
  for (const f of ["guards.json", "guards.last-good.json"]) fs.writeFileSync(path.join(b.root, f), "{x");
  const held = b.text();
  await uninstall({ ctx: b.ctx });
  assert.equal(b.text(), held);
  assert.match(b.log(), /code didn't match/);
  // Proven by the dialog code: no typed code, and the entry goes.
  const c = home({ gate: { ok: true, dialogProven: true }, typed: "zzzz" });
  assert.equal(await S.setup({ ctx: c.ctx, hosts: ["claude-code"] }), 0, c.log());
  rules(c.root, [RULE]);
  await W.switchAfterRules({ root: c.root, platform: "linux" });
  assert.equal(await uninstall({ ctx: c.ctx }), 0, c.log());
  assert.equal(c.entry(), null);
  assert.equal(c.asked.length, 0);
});

test("a kept entry the user changed while it was raised keeps their change; one ad raised goes back (orig), with the gate", async () => {
  const t = home({ gate: { ok: true }, typed: "kqtw" });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  rules(t.root, [RULE]);
  await W.switchAfterRules({ root: t.root, platform: "linux" });
  // The user changes the command's arguments (so uninstall keeps it) and its timeout.
  const P = S.parseSettings(t.text());
  const [f] = S.locateHook(P.root, { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(t.root) });
  const at = ["hooks", "PreToolUse", f.gi, "hooks", f.hi];
  fs.writeFileSync(t.file, S.applyOps(P.body, [{ path: [...at, "timeout"], value: 30 }, { path: [...at, "if"], value: "Bash(git *)" }]).text);
  assert.equal(await uninstall({ ctx: t.ctx }), 0, t.log());
  assert.equal(t.entry().handler.onFailure, "continue", "ad's raise put back");
  assert.equal(t.entry().handler.timeout, 30, "the user's own value stays");
});

test("restoreOps: only fields still at the raised value, absence restored, Read only when ad added it", () => {
  const item = { locator: { hostEvent: "PreToolUse" }, orig: { onFailure: null, timeout: 5, matcher: "Bash", had: { onFailure: false, timeout: true, matcher: true }, readAdded: true } };
  const loc = (handler, matcher = "Bash|Read") => ({ gi: 2, hi: 0, handler, matcher });
  assert.deepEqual(S.restoreOps(item, loc({ onFailure: "block", timeout: 10 })), [
    { path: ["hooks", "PreToolUse", 2, "hooks", 0, "onFailure"], value: undefined },
    { path: ["hooks", "PreToolUse", 2, "hooks", 0, "timeout"], value: 5 },
    { path: ["hooks", "PreToolUse", 2, "matcher"], value: "Bash" },
  ]);
  assert.deepEqual(S.restoreOps(item, loc({ onFailure: "continue", timeout: 30 }, "Bash")), []);
  assert.deepEqual(S.restoreOps({ ...item, orig: { ...item.orig, onFailure: "block", had: { onFailure: true, timeout: true } } }, loc({ onFailure: "block", timeout: 5 }, "Bash")), [], "block was the user's own");
});

test("Codex on Windows: no tool.before until the first rule, then added once (the cost said) and kept after the last", async () => {
  const t = home({ platform: "win32" });
  fs.mkdirSync(path.join(t.h, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(t.h, ".codex", "config.toml"), "");
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.log());
  const hooks = () => JSON.parse(fs.readFileSync(path.join(t.h, ".codex", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks().PreToolUse, undefined);
  // No rule yet: nothing added.
  assert.equal((await W.switchAfterRules({ root: t.root, platform: "win32", ctxFor: (out) => t.mk(out) })).codex, undefined);
  rules(t.root, [RULE]);
  const r = await W.switchAfterRules({ root: t.root, platform: "win32", ctxFor: (out) => t.mk(out) });
  assert.ok(hooks().PreToolUse?.length, JSON.stringify(r));
  assert.match((r.codex ?? []).join("\n"), /waits 1–4 s/);
  assert.ok(readLedger2(t.root).items.some((i) => i.host === "codex" && i.locator?.event === "tool.before"));
  // Once there: not again, and it stays after the last rule (and through setup).
  assert.equal((await W.switchAfterRules({ root: t.root, platform: "win32", ctxFor: (out) => t.mk(out) })).codex, undefined);
  rules(t.root, []);
  fs.rmSync(activePath(t.root), { force: true });
  await W.switchAfterRules({ root: t.root, token: testReviewToken(), platform: "win32", ctxFor: (out) => t.mk(out) });
  t.lines.length = 0;
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.log());
  assert.ok(hooks().PreToolUse?.length, "stays");
  assert.match(t.log(), /stays once added/, "setup keeps it in its plan with no rules left");
  // Elsewhere nothing is added by the switch (Codex's own setup writes it there).
  const l = home();
  assert.equal((await W.switchAfterRules({ root: l.root, platform: "linux" })).codex, undefined);
});

test("a restore the gate refuses keeps the item and its orig: the last rule's switch still puts the entry back byte for byte", async () => {
  const t = home({ settings: { hooks: { PreToolUse: [USER_HOOK] } } });
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  fs.rmSync(ledger2Path(t.root));
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["claude-code"] }), 0, t.log());
  const pristine = fs.readFileSync(t.file);
  rules(t.root, [RULE]);
  await W.switchAfterRules({ root: t.root, platform: "linux" });
  assert.notEqual(await uninstall({ ctx: t.ctx }), 0, "held: run it again");
  assert.match(t.log(), /changing it needs your review/);
  assert.equal(readLedger2(t.root).items.find((i) => i.locator?.event === "tool.before")?.orig?.onFailure, "continue");
  rules(t.root, []);
  fs.rmSync(activePath(t.root), { force: true });
  await W.switchAfterRules({ root: t.root, token: testReviewToken(), platform: "linux" });
  assert.ok(fs.readFileSync(t.file).equals(pristine), t.text());
});

test("confirmInOwnTerminal passes on the dialog's proof (so uninstall doesn't ask for the typed code again)", async () => {
  const { confirmInOwnTerminal } = await import("../src/review.mjs");
  const base = { env: {}, isTTY: () => true, ask: async () => "", out: () => {} };
  assert.deepEqual(await confirmInOwnTerminal({ ...base, ancestry: () => ({ verdict: "terminal" }) }), { ok: true, dialogProven: false });
  assert.deepEqual(await confirmInOwnTerminal({ ...base, ancestry: () => ({ verdict: "unknown" }), dialog: async () => ({ ok: true }) }), { ok: true, dialogProven: true });
  assert.equal((await confirmInOwnTerminal({ ...base, ancestry: () => ({ verdict: "agent", agent: "claude" }) })).ok, false);
});
