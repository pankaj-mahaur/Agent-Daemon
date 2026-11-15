// L7 D16: the typed confirmation code. A verb that lowers enforcement asks for a random
// 4-letter code on the controlling terminal (never stdin's answer), unless the run already
// typed L1's dialog code. Wired here: safety off (l7b-safety-cli), config review auto, and
// ad init rewriting its own rules-check entry while rules exist. Temp roots only; no real
// terminal is opened (every call passes the tty seam).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = await import("../src/memory/typed-code.mjs");
const svc = await import("../src/memory/review-service.mjs");
const IG = await import("../src/init-gate.mjs");
const { cliToken, memoryVerbMain } = await import("../src/memory/memory-cli.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");
const { writeGuards, activePath } = await import("../src/hooks/guards.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ad-typed-"));
  made.push(d);
  return d;
};
const said = (answer) => {
  const asked = [];
  return { asked, tty: { ask: async (q) => (asked.push(q), typeof answer === "function" ? answer(q) : answer) } };
};

test("the code: 4 letters from an alphabet without look-alikes", () => {
  assert.equal(T.CODE_LETTERS, "acdefhjkmnprtvwxy");
  for (const ch of "bgiloqsuz0123456789") assert.equal(T.CODE_LETTERS.includes(ch), false, ch);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = T.makeCode();
    assert.match(c, /^[acdefhjkmnprtvwxy]{4}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 150, "random");
});

test("confirmTypedCode: the question names the change and the code; typed back (any case, spaces) passes", async () => {
  const s = said("  KQTW \n");
  assert.deepEqual(await T.confirmTypedCode({ what: "Pause all 4 rules in app for 1 hour", tty: s.tty, code: "kqtw" }), { ok: true });
  assert.equal(s.asked[0], "Pause all 4 rules in app for 1 hour — type kqtw: ");
  const wrong = await T.confirmTypedCode({ what: "x", tty: said("kqtx").tty, code: "kqtw" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.text, /didn't match; nothing changed/);
  assert.equal((await T.confirmTypedCode({ what: "x", tty: said("").tty, code: "kqtw" })).ok, false, "an empty answer");
  // The code is the one shown: the answer can't be computed without reading the question.
  const echo = said((q) => /type (\w+)/.exec(q)[1]);
  assert.equal((await T.confirmTypedCode({ what: "x", tty: echo.tty })).ok, true);
});

test("confirmTypedCode: no terminal → refused; a read error → refused; proven by the dialog → no ask", async () => {
  const none = await T.confirmTypedCode({ what: "x", tty: null, code: "kqtw" });
  assert.equal(none.ok, false);
  assert.match(none.text, /code typed in your terminal/);
  const broken = await T.confirmTypedCode({ what: "x", tty: { ask: async () => { throw new Error("EIO"); } }, code: "kqtw" });
  assert.equal(broken.ok, false);
  assert.match(broken.text, /EIO/);
  const s = said("nope");
  assert.deepEqual(await T.confirmTypedCode({ what: "x", proven: true, tty: s.tty }), { ok: true });
  assert.equal(s.asked.length, 0);
  assert.equal((await T.confirmTypedCode({ what: "x", proven: "yes", tty: said("nope").tty, code: "kqtw" })).ok, true, "proven is the caller's boolean");
});

test("openTty: /dev/tty (CONIN$/CONOUT$ on Windows), one line read byte by byte, CR stripped; none → null", async () => {
  const opened = [];
  const written = [];
  let input = Buffer.from("kqtw\r\nrest");
  const fake = {
    open: (f, mode) => (opened.push([f, mode]), opened.length + 10),
    write: (fd, s) => written.push([fd, s]),
    read: (fd, buf) => {
      if (!input.length) return 0;
      buf[0] = input[0];
      input = input.subarray(1);
      return 1;
    },
    close: () => {},
  };
  const t = T.openTty({ platform: "linux", ...fake });
  assert.equal(await t.ask("q? "), "kqtw");
  assert.deepEqual(opened, [["/dev/tty", "r+"]]);
  assert.deepEqual(written, [[11, "q? "]]);
  assert.equal(input.toString(), "rest", "nothing past the line is taken");
  opened.length = 0;
  T.openTty({ platform: "win32", ...fake });
  assert.deepEqual(opened, [["\\\\.\\CONIN$", "r+"], ["\\\\.\\CONOUT$", "r+"]], "the device namespace, opened only if it exists");
  // Node namespaces a bare name against the cwd (a file); the \\.\ form it leaves alone.
  assert.equal(path.win32.toNamespacedPath("\\\\.\\CONIN$"), "\\\\.\\CONIN$");
  assert.equal(T.openTty({ platform: "linux", ...fake, open: () => { throw Object.assign(new Error("no tty"), { code: "ENXIO" }); } }), null);
});

test("reviewToken says when the run proved itself with the dialog code; cliToken passes it on", async () => {
  const base = { env: {}, isTTY: () => true };
  const term = await svc.reviewToken({ ...base, ancestry: () => ({ verdict: "terminal" }) });
  assert.ok(svc.isReviewToken(term.token));
  assert.equal(term.dialogProven, undefined);
  const dlg = await svc.reviewToken({ ...base, ancestry: () => ({ verdict: "unknown" }), dialog: async () => ({ ok: true }) });
  assert.ok(svc.isReviewToken(dlg.token));
  assert.equal(dlg.dialogProven, true);
  const failed = await svc.reviewToken({ ...base, ancestry: () => ({ verdict: "unknown" }), dialog: async () => ({ ok: false, text: "no" }) });
  assert.equal(failed.token, undefined);
  assert.deepEqual(await cliToken({ token: async () => dlg }), { token: dlg.token, dialogProven: true });
  assert.deepEqual(await cliToken({ token: async () => ({ token: testReviewToken() }) }).then((r) => r.dialogProven), false);
});

test("config review auto: from strict it takes the typed code (not when the dialog proved the run); already auto asks nothing", async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const { setReviewStrict, reviewMode } = await import("../src/memory/review-mode.mjs");
  const dir = tmp();
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  try {
    const lines = [];
    const run = (o) => memoryVerbMain("config", ["review", "auto"], { out: (l) => lines.push(l), cwd: dir, handle: h, code: () => "kqtw", ...o });
    setReviewStrict(h, {});
    const wrong = said("kqtx");
    assert.equal(await run({ token: async () => ({ token: testReviewToken() }), tty: wrong.tty }), 1);
    assert.match(wrong.asked[0], /Turn review-first off .* — type kqtw: $/);
    assert.match(lines.at(-1), /review stays as it is: the code didn't match/);
    assert.equal(reviewMode(h), "strict");
    assert.equal(await run({ token: async () => ({ token: testReviewToken() }), tty: null }), 1, "no terminal to type it in");
    assert.equal(reviewMode(h), "strict");
    const proven = said("nope");
    assert.equal(await run({ token: async () => ({ token: testReviewToken(), dialogProven: true }), tty: proven.tty }), 0);
    assert.equal(proven.asked.length, 0);
    assert.equal(reviewMode(h), "auto");
    const again = said("nope");
    assert.equal(await run({ token: async () => ({ token: testReviewToken() }), tty: again.tty }), 0);
    assert.equal(again.asked.length, 0, "already auto: nothing lowers");
    setReviewStrict(h, {});
    assert.equal(await run({ token: async () => ({ token: testReviewToken() }), tty: said("KQTW").tty }), 0);
    assert.equal(reviewMode(h), "auto");
  } finally {
    h.close();
  }
});

test("ad init: rulesCheckChanged sees only its own tool.before entry changing or going", async () => {
  const R = await import("../src/hooks/routes.mjs");
  const before = R.planClaudeHooks({}, { steps: ["rules-check", "session-start"] }).hooks;
  const clone = () => JSON.parse(JSON.stringify(before));
  const tb = (h) => h.PreToolUse.find((g) => g.hooks.some((x) => R.classifyHandler(x, { hostEvent: "PreToolUse", matcher: g.matcher })?.event === "tool.before"));
  assert.ok(tb(before), JSON.stringify(before));
  assert.equal(IG.rulesCheckChanged(before, clone()), false);
  const other = clone();
  other.SessionStart[0].hooks[0].timeout = 99;
  assert.equal(IG.rulesCheckChanged(before, other), false, "another route changed");
  const gone = clone();
  gone.PreToolUse = gone.PreToolUse.filter((g) => g !== tb(gone));
  assert.equal(IG.rulesCheckChanged(before, gone), true, "removed");
  const lowered = clone();
  tb(lowered).hooks[0].onFailure = "continue";
  assert.equal(IG.rulesCheckChanged(before, lowered), true, "changed");
  const narrowed = clone();
  tb(narrowed).matcher = "Bash";
  assert.equal(IG.rulesCheckChanged(before, narrowed), true, "matcher narrowed");
  assert.equal(IG.rulesCheckChanged({ SessionStart: before.SessionStart }, before), false, "added: a raise");
});

test("ad init's gate: no rules → passes; rules → the token and the typed code (or the dialog's proof)", async () => {
  const root = tmp();
  const tok = async () => ({ token: testReviewToken() });
  assert.deepEqual(await IG.initRulesCheckGate({ root, token: async () => ({ refused: "agent" }), tty: null }), { ok: true });
  writeGuards({ projects: { p: { roots: ["/w"], paused: false, rules: [{ id: 1, kind: "command", decision: "deny", reason: "x", scope: "project", project: "p", rule: { type: "literal", text: "x" } }] } }, global: { rules: [] }, ruleCount: 1 }, { root });
  const refused = await IG.initRulesCheckGate({ root, token: async () => ({ refused: "an agent runs it" }), tty: null });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /needs your own terminal \(an agent runs it\)/);
  const wrong = await IG.initRulesCheckGate({ root, token: tok, tty: said("zzzz").tty });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /didn't match/);
  const right = await IG.initRulesCheckGate({ root, token: tok, tty: said((q) => /type (\w+)/.exec(q)[1]).tty });
  assert.equal(right.ok, true);
  const proven = said("nope");
  assert.equal((await IG.initRulesCheckGate({ root, token: async () => ({ token: testReviewToken(), dialogProven: true }), tty: proven.tty })).ok, true);
  assert.equal(proven.asked.length, 0);
  // The sentinel alone (both snapshot files unreadable) counts as rules.
  const root2 = tmp();
  fs.writeFileSync(activePath(root2), "1\n");
  assert.equal((await IG.initRulesCheckGate({ root: root2, token: tok, tty: null })).ok, false);
});

test("ad init calls the gate before writing a changed rules-check entry (a spawned init has no terminal, so this is checked in its source)", () => {
  const src = fs.readFileSync(new URL("../src/cli-full.mjs", import.meta.url), "utf8");
  const at = src.indexOf("IG.rulesCheckChanged(existingSettings.hooks, hookPlan.hooks)");
  assert.ok(at > 0);
  assert.ok(src.indexOf("await IG.initRulesCheckGate()", at) > at);
  assert.ok(src.indexOf("hookPlan.changed = false;", at) > at);
  assert.ok(at < src.indexOf("if (hookPlan.changed) {", at), "before the plan is acted on");
});
