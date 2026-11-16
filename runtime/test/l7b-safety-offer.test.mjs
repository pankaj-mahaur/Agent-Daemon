// L7b part 5 (design §8): the starter safety policy, offered once.
//   - asked once; a no (or enter) is kept and never asked again; a yes turns it on with the token;
//   - never asked from the agent's shell or without a terminal (and nothing is recorded then);
//   - a yes whose token is refused changes nothing and is asked again;
//   - review asks after the rule step with the run's token, never in --accept-all;
//   - setup and both review entry points pass the offer;
//   - status says whether Claude Code's Read tool is covered (the rule switch's record).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7b-offer-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.AD_ROOT = path.join(ROOT, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const svc = await import("../src/memory/review-service.mjs");
const policy = await import("../src/memory/starter-policy.mjs");
const offer = await import("../src/memory/safety-offer.mjs");
const { safetyMain } = await import("../src/memory/safety-cli.mjs");
const preview = await import("../src/memory/rule-preview.mjs");
const { reviewChecklist } = await import("../src/memory/review-checklist.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

const RUNTIME = fileURLToPath(new URL("..", import.meta.url));
const opened = [];
after(async () => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // closed already
    }
  }
  (await import("../src/memory/episodic.mjs")).closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const SLUG = "-work-shop-app";
const PID = "prj_0000000000000000000000SHP1";
const KEYS = [SLUG, PID];
let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return { h, root: path.join(dir, "ad") };
}
function note(h, text) {
  const id = Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin, provenance) VALUES (?, ?, 'correction', ?, 0.8, 'pending', ?, 'user', 'prompt')",
    [SLUG, PID, text, `h-${++n}-${text}`]
  ).lastInsertRowid);
  svc.acceptLearning(h, testReviewToken(), id);
  return id;
}

/** offerPolicyOnce in the user's own terminal, answering with `answers`. */
async function ask(h, root, answers, extra = {}) {
  const q = [...answers];
  const questions = [];
  const lines = [];
  const r = await offer.offerPolicyOnce({
    handle: h,
    root,
    out: (l) => lines.push(l),
    ask: async (text) => (questions.push(text), q.shift() ?? ""),
    env: {},
    isTTY: () => true,
    version: null,
    command: (v) => `ad ${v}`,
    getToken: async () => ({ token: testReviewToken() }),
    ...extra,
  });
  return { r, questions, text: lines.join("\n") };
}

test("the hook's notice names the policy's commands as the install route types them", async () => {
  const { makeContext, verbBase } = await import("../src/memory-install/install.mjs");
  const { PRODUCT } = await import("../src/product.mjs");
  const { loadGuards } = await import("../src/hooks/guards.mjs");
  const { toolBefore } = await import("../src/hooks/tool-before.mjs");
  // A clone (`ad memory setup`): `ad safety off` (there is no `ad memory safety`); the launcher: the npx package.
  for (const [viaLauncher, base] of [[false, "ad"], [true, `npx -y ${PRODUCT.package}`]]) {
    const { h, root } = await store();
    const ctx = makeContext({ viaLauncher, env: {}, home: ROOT, root });
    assert.equal(verbBase(ctx), base);
    const a = await ask(h, root, ["y"], { cmdName: verbBase(ctx) });
    assert.equal(a.r.answer, "yes", a.text);
    assert.equal(loadGuards({ root }).snapshot.cmd, base);
    const home = path.join(ROOT, `home-${++n}`);
    fs.mkdirSync(home, { recursive: true });
    const out = toolBefore({ session_id: "s", cwd: home, tool_name: "Bash", tool_input: { command: "rm -rf ~" }, permission_mode: "default" }, { root, homes: [home], log: () => {} });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "ask", JSON.stringify(out));
    assert.ok(out.systemMessage.includes(`turn it off: \`${base} safety off\` · pause every rule: \`${base} rules pause --all\``), out.systemMessage);
  }
});

test("asked once: no (and enter) is kept and never asked again; the policy stays off", async () => {
  for (const answer of ["n", ""]) {
    const { h, root } = await store();
    const a = await ask(h, root, [answer]);
    assert.deepEqual(a.questions, [`${policy.POLICY_COPY.offer} `]);
    assert.equal(a.r.answer, "no");
    assert.equal(policy.policyState(h).state, "off", `"${answer}" turns nothing on`);
    assert.equal(offer.offerRecord(h).answer, "no");
    assert.match(a.text, /you won't be asked again.*`ad safety on`/);
    const b = await ask(h, root, ["y"]);
    assert.deepEqual(b.questions, [], "never asked again");
    assert.equal(policy.policyState(h).state, "off");
  }
});

test("yes turns it on with the token; the rules file asks before all four", async () => {
  const { h, root } = await store();
  let tokens = 0;
  const a = await ask(h, root, ["y"], { getToken: async () => (tokens++, { token: testReviewToken() }) });
  assert.equal(a.r.answer, "yes");
  assert.equal(a.r.code, 0, a.text);
  assert.equal(tokens, 1, "the token is asked for only after the yes");
  assert.equal(policy.policyState(h).state, "on");
  const snap = JSON.parse(fs.readFileSync(path.join(root, "guards.json"), "utf8"));
  assert.equal(snap.global.rules.filter((r) => r.rule.type === "policy").length, 4);
  assert.match(a.text, /starter safety policy: on \(4 rules added\)/);
  assert.equal((await ask(h, root, ["y"])).questions.length, 0);

  // A no never asks for the token.
  const { h: h2, root: root2 } = await store();
  let t2 = 0;
  await ask(h2, root2, ["n"], { getToken: async () => (t2++, { token: testReviewToken() }) });
  assert.equal(t2, 0);
});

test("never asked from the agent's shell or without a terminal, and nothing is recorded", async () => {
  for (const extra of [{ env: { AD_TOOL_SHELL: "1" } }, { isTTY: () => false }]) {
    const { h, root } = await store();
    const a = await ask(h, root, ["y"], extra);
    assert.deepEqual(a.questions, []);
    assert.equal(a.r.asked, false);
    assert.equal(offer.offerRecord(h), null, "still offered in the user's own terminal");
    assert.equal(policy.policyState(h).state, "off");
  }
});

test("a yes whose token is refused changes nothing and is asked again; a bad token turns nothing on", async () => {
  const { h, root } = await store();
  const a = await ask(h, root, ["y"], { getToken: async () => ({ refused: "not your own terminal" }) });
  assert.equal(policy.policyState(h).state, "off");
  assert.equal(offer.offerRecord(h), null);
  assert.match(a.text, /Nothing changed: this needs your own terminal/);
  assert.equal((await ask(h, root, ["n"])).questions.length, 1, "asked again");

  const { h: h2, root: root2 } = await store();
  const b = await ask(h2, root2, ["y"], { getToken: async () => ({ token: "forged" }) });
  assert.equal(policy.policyState(h2).state, "off", b.text);
  assert.equal(b.r.code, 1);
  assert.equal(offer.offerRecord(h2), null);
});

test("already on: not asked, recorded; the guard copy not ready: nothing turns on", async () => {
  const { h, root } = await store();
  await policy.setPolicy(h, testReviewToken(), true, { root });
  const a = await ask(h, root, ["n"]);
  assert.deepEqual(a.questions, []);
  assert.equal(offer.offerRecord(h).answer, "on-already");
  assert.equal(policy.policyState(h).state, "on", "an offer never turns it off");

  // A launcher whose guard copy is missing: the hook that would run can't know the policy.
  const { h: h2, root: root2 } = await store();
  const { launcherFile } = await import("../src/memory/launch/dists.mjs");
  fs.mkdirSync(path.dirname(launcherFile(root2)), { recursive: true });
  fs.writeFileSync(launcherFile(root2), "// launcher\n");
  const b = await ask(h2, root2, ["y"]);
  assert.equal(b.r.code, 1);
  assert.equal(policy.policyState(h2).state, "off");
  assert.match(b.text, /nothing changed: there is no guard copy yet.*`ad repair`.*`ad safety on`/);
  assert.equal(offer.offerRecord(h2), null, "a yes that changed nothing is asked again");
});

// ---- review wiring -------------------------------------------------------------------

function review(h, root, answers, flags = {}) {
  const lines = [];
  const q = [...answers];
  const questions = [];
  return reviewChecklist({
    handle: h,
    keys: KEYS,
    cwd: ROOT,
    root,
    out: (l) => lines.push(l),
    ask: async (text) => (questions.push(String(text)), q.shift() ?? ""),
    isTTY: () => true,
    env: {},
    gate: async () => ({ token: testReviewToken() }),
    stdin: { isTTY: false },
    stdout: { rows: 30, columns: 100, write() {} },
    home: ROOT,
    afterRuleStep: offer.reviewOffer({ env: {}, isTTY: () => true, root, command: (v) => `ad ${v}` }),
    ...flags,
  }).then((code) => ({ code, out: lines.join("\n"), questions }));
}

test("review: the offer comes after the rule step, with the run's token; once", async () => {
  const { h, root } = await store();
  preview.setPreviewConsent(h, "off");
  note(h, "use pnpm, not npm");
  const r = await review(h, root, ["", "y"]);
  const at = r.questions.findIndex((q) => q.includes(policy.POLICY_COPY.offer));
  assert.ok(at > 0, "after the rule step's question: " + JSON.stringify(r.questions));
  assert.equal(policy.policyState(h).state, "on", r.out);
  const snap = JSON.parse(fs.readFileSync(path.join(root, "guards.json"), "utf8"));
  assert.equal(snap.global.rules.filter((x) => x.rule.type === "policy").length, 4, "afterReview kept the policy in the rules file");
  note(h, "never use yarn add");
  const r2 = await review(h, root, ["", "y"]);
  assert.ok(!r2.questions.some((q) => q.includes(policy.POLICY_COPY.offer)), "once");
});

test("review --accept-all never offers", async () => {
  const { h, root } = await store();
  preview.setPreviewConsent(h, "off");
  h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin, provenance) VALUES (?, ?, 'correction', 'use pnpm, not npm', 0.8, 'pending', 'h-aa', 'user', 'prompt')",
    [SLUG, PID]
  );
  const r = await review(h, root, ["y", "y"], { acceptAll: true });
  assert.ok(!r.questions.some((q) => q.includes(policy.POLICY_COPY.offer)), r.out);
  assert.equal(policy.policyState(h).state, "off");
  assert.equal(offer.offerRecord(h), null);
});

test("setup and both review entry points pass the offer", () => {
  const cli = fs.readFileSync(path.join(RUNTIME, "src", "memory-install", "cli.mjs"), "utf8");
  assert.match(cli, /case "setup": \{[\s\S]*?setupOffer\([\s\S]*?return code;/);
  assert.match(cli, /runInteractiveReview\(\{[^\n]*afterRuleStep: reviewOffer\(/);
  const full = fs.readFileSync(path.join(RUNTIME, "src", "cli-full.mjs"), "utf8");
  assert.match(full, /async function cmdReview\(opts\) \{[\s\S]{0,300}afterRuleStep: reviewOffer\(/);
});

test("setupOffer: not from the agent's shell; a no is kept", async () => {
  const { h, root } = await store();
  let asked = 0;
  const lines = [];
  assert.equal((await offer.setupOffer({ handle: h, root, out: (l) => lines.push(l), env: { AD_TOOL_SHELL: "1" }, isTTY: () => true, ask: async () => (asked++, "y") })).asked, false);
  assert.equal(asked, 0);
  const r = await offer.setupOffer({ handle: h, root, out: (l) => lines.push(l), env: {}, isTTY: () => true, ask: async () => (asked++, "n") });
  assert.equal(r.answer, "no");
  assert.equal(asked, 1);
});

test("status: Claude Code's Read tool is covered only once the rule switch says so; no line while env-read is off", async () => {
  const { h, root } = await store();
  const status = async () => {
    const lines = [];
    await safetyMain(["status"], { out: (l) => lines.push(l), env: {}, isTTY: () => true, handle: h, root, command: (v) => `ad ${v}`, others: async () => [] });
    return lines.join("\n");
  };
  assert.doesNotMatch(await status(), /Read tool/);
  await policy.setPolicy(h, testReviewToken(), true, { root });
  fs.rmSync(path.join(root, "memory", "switch.json"), { force: true });
  assert.match(await status(), /Read tool isn't asked about/, "no record: not covered");
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "switch.json"), JSON.stringify({ readMatcher: false }));
  assert.match(await status(), /Read tool isn't asked about until ad's hook entry covers Read/);
  fs.writeFileSync(path.join(root, "memory", "switch.json"), JSON.stringify({ readMatcher: true, failed: true }));
  assert.match(await status(), /Read tool isn't asked about/, "a failed switch covers nothing");
  fs.writeFileSync(path.join(root, "memory", "switch.json"), JSON.stringify({ readMatcher: true }));
  assert.match(await status(), /Read tool is asked about too/);
});
