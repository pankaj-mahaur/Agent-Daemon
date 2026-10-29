// P4.7: automatic fallback with nobody at the keyboard, on the fake engine, in a throwaway
// HOME / AD_ROOT: the per-run opt-in and its refusals, a switch that completes the task, a
// pause (exit 4), declined approvals, the run's own thread settings on the continuation, and
// the hint for a run that didn't opt in. Two accounts in the user's order:
//   A  OpenRouter · a · fake-model     B  OpenAI · b · fake-model   (both on the api home)

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-unattended-"));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_ROOT: process.env.AD_ROOT, AD_ACCOUNT: process.env.AD_ACCOUNT, AD_TOOL_SHELL: process.env.AD_TOOL_SHELL, AD_FALLBACK: process.env.AD_FALLBACK };
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
for (const k of ["AD_ACCOUNT", "AD_TOOL_SHELL", "AD_FALLBACK"]) delete process.env[k];

const { closeHarnessEngines, launchHarness } = await import("../src/harness/engines.mjs");
const { closeGateway } = await import("../src/harness/gateway-runtime.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { cmdRun } = await import("../src/harness/run.mjs");
const { createUnattendedRun, UNATTENDED_TEXTS } = await import("../src/harness/unattended-run.mjs");
const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
const { enablePolicy, updatePolicy, disablePolicy } = await import("../src/routing/store.mjs");
const { routingContext } = await import("../src/routing/context.mjs");
const { catalogFile } = await import("../src/providers/catalog.mjs");
after(async () => {
  await closeHarnessEngines();
  await closeGateway();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sink = () => {
  const chunks = [];
  return { write: (s) => (chunks.push(String(s)), true), text: () => chunks.join("") };
};
fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const A = reg.newAccount({ provider: "openrouter", label: "a", method: "api-key", defaultModel: "fake-model" });
const B = reg.newAccount({ provider: "openai", label: "b", method: "api-key", defaultModel: "fake-model" });
store.set(A.credential.ref, ["sk", "or", "v1", "aaaaaaaaaaaaaaaa1111"].join("-"));
store.set(B.credential.ref, ["sk", "test", "bbbbbbbbbbbbbbbb2222"].join("-"));
await reg.transact((doc) => {
  doc.accounts.push({ ...A, status: "ready", keyHint: "1111" }, { ...B, status: "ready", keyHint: "2222" });
  doc.engines.api.home = "api";
});
const at = new Date().toISOString();
for (const a of [A, B]) {
  fs.mkdirSync(path.dirname(catalogFile(a.id)), { recursive: true });
  fs.writeFileSync(catalogFile(a.id), JSON.stringify({ v: 1, accountId: a.id, observedAt: at, entries: [{ accountId: a.id, provider: a.provider, model: "fake-model", caps: { tools: true, contextWindow: 128000 }, price: { input: "0", output: "0", observedAt: at }, billing: "metered", data: {} }] }));
}
const project = path.join(TMP, "work", "shop-app");
fs.mkdirSync(path.join(project, ".agent-daemon"), { recursive: true });
const ORDER = [{ account: A.id, model: "fake-model" }, { account: B.id, model: "fake-model" }];

beforeEach(async () => {
  fs.rmSync(path.join(process.env.AD_ROOT, "quota"), { recursive: true, force: true });
  await disablePolicy(routingContext());
  await updatePolicy((p) => void (p.targets = ORDER), routingContext());
  await enablePolicy(routingContext());
});

const run = async (prompt, extra = {}) => {
  const out = sink();
  const err = sink();
  const code = await cmdRun(prompt, { cwd: project, account: "openrouter/a", command, store, stdout: out, stderr: err, json: true, ...extra });
  const last = out.text().trim().split("\n").at(-1);
  let json = null;
  try {
    json = JSON.parse(last);
  } catch {
    json = null;
  }
  return { code, out: out.text(), err: err.text(), json };
};

test("ad run --fallback with the policy off: exit 2 and how to turn it on; no engine starts", async () => {
  await disablePolicy(routingContext());
  const r = await run("quota-fail", { fallback: true });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), UNATTENDED_TEXTS.OFF("ad run"));
});

test("ad run --fallback with a stale consent (an account changed since): exit 2 naming it", async () => {
  await reg.transact((doc) => {
    doc.accounts.find((a) => a.id === B.id).keyHint = "9999";
  });
  try {
    const r = await run("quota-fail", { fallback: true });
    assert.equal(r.code, 2);
    assert.equal(r.err.trim(), UNATTENDED_TEXTS.CHANGED("ad run", "OpenAI · b"));
  } finally {
    await reg.transact((doc) => {
      doc.accounts.find((a) => a.id === B.id).keyHint = "2222";
    });
  }
});

test("ad run --fallback from the agent's own shell: refused with the guard text", async () => {
  const r = await run("quota-fail", { fallback: true, env: { ...process.env, AD_TOOL_SHELL: "1" } });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), UNATTENDED_TEXTS.TOOL_SHELL);
});

test("ad run --fallback: quota on A → switch → completes on B; the JSON has target B and one switch", async () => {
  const r = await run("quota-fail", { fallback: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.status, "completed");
  assert.equal(r.json.target.account, "OpenAI · b");
  assert.equal(r.json.fallback.filter((e) => e.type === "switched").length, 1);
  assert.match(r.json.fallback[0].text, /^\u{21aa} Switched to OpenAI · b · fake-model: /u);
  assert.match(r.err, /\[ad\] \u{21aa} Switched to OpenAI · b/u);
  assert.match(r.json.sessionId, /^ses_/);
});

test("ad run --fallback: a pause (a command's end unknown) exits 4 with the reason and the session", async () => {
  const r = await run("quota-command-running", { fallback: true });
  assert.equal(r.code, 4, r.err);
  assert.equal(r.json.status, "paused");
  assert.match(r.json.reason, /may still be running/);
  assert.match(r.json.sessionId, /^ses_/);
  assert.match(r.err, /\[ad\] \u{23f8} Paused: .* Work so far is saved \(session ses_/u);
});

test("ad run --fallback: approvals are still declined, with the same stderr line", async () => {
  const r = await run("hello", { fallback: true });
  assert.match(r.err, /\[declined [^\]]+ — ad run is non-interactive; use ad chat to approve\]/);
  assert.equal(r.json.status, "completed");
});

test("without --fallback, a limit while the policy is on prints the hint once (and 'hint' in --json); nothing switches", async () => {
  const r = await run("quota-fail");
  assert.equal(r.code, 1);
  assert.equal(r.json.hint, UNATTENDED_TEXTS.HINT("add --fallback"));
  assert.equal(r.json.fallback, undefined, "the old path");
  assert.equal(r.err.split(UNATTENDED_TEXTS.HINT("add --fallback")).length - 1, 1);
  const s = await run("quota-fail", { env: { ...process.env, AD_SCHEDULE_JOB: "job_7" } });
  assert.equal(s.json.hint, UNATTENDED_TEXTS.HINT("ad schedule edit job_7 --fallback"));
  await disablePolicy(routingContext());
  assert.equal((await run("quota-fail")).json.hint, undefined, "policy off: no hint");
});

test("the continuation thread keeps the run's own settings: approval never, the sandbox, developer instructions and the unattended config", async () => {
  const err = sink();
  const started = await launchHarness({ cwd: project, account: "openrouter/a", command, store, err });
  assert.ok(started.engine, err.text());
  const r = createUnattendedRun({
    started,
    cwd: project,
    origin: "loop",
    err,
    threadOpts: { sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: "LOOP PROTOCOL", config: { web_search: "cached" } },
    turnOpts: { sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false } },
    accounts: (session) => createTuiAccounts({ session, store, launch: (a) => launchHarness({ cwd: project, account: a.id, command, store, err }) }),
  });
  try {
    const res = await r.turn("quota-fail");
    assert.equal(res.status, "completed", err.text());
    const starts = (await started.engine.testRequest("debug/state", {})).calls.filter((c) => c === "thread/start").length;
    assert.ok(starts >= 2, "a new thread for the continuation");
    const p = (await started.engine.testRequest("debug/state", {})).lastParams["thread/start"];
    assert.equal(p.approvalPolicy, "never");
    assert.equal(p.sandbox, "workspace-write");
    assert.equal(p.developerInstructions, "LOOP PROTOCOL");
    assert.equal(p.config.web_search, "cached", "the unattended config (the engine adds its own keys beside it)");
    assert.equal(p.modelProvider, B.providerEntry, "on B");
    const turn = (await started.engine.testRequest("debug/state", {})).lastParams["turn/start"];
    assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [], networkAccess: false }, "every turn, on the new thread too");
  } finally {
    await r.close();
    await started.release();
  }
});

// ---- ad loop --fallback ----------------------------------------------------------------------
const { cmdLoop, loopDecision, LOOP_DEFAULTS, nextPrompt } = await import("../src/harness/loop.mjs");
const loopRun = async (objective, extra = {}) => {
  const out = sink();
  const err = sink();
  const code = await cmdLoop(objective, { cwd: project, account: "openrouter/a", command, store, stdout: out, stderr: err, userHome: path.join(TMP, "userhome"), ...extra });
  const m = /log: (.+\.jsonl)/.exec(out.text());
  const log = m && fs.existsSync(m[1]) ? fs.readFileSync(m[1], "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { code, out: out.text(), err: err.text(), log };
};

test("loop brakes: a switched turn never counts toward the failure limits; three real failures still stop it", () => {
  const fail = { turnStatus: "failed", error: "boom", status: null, fileChanges: 1, commands: 0 };
  const sw = { turnStatus: "switched", error: null, status: null, fileChanges: 1, commands: 0 };
  assert.equal(loopDecision([fail, sw, fail, sw], { limits: LOOP_DEFAULTS }).stop, false, "two failures and two switches");
  assert.match(loopDecision([fail, sw, fail, sw, fail], { limits: LOOP_DEFAULTS }).reason, /3 failed turns in a row/);
  assert.match(nextPrompt("ship it", { ...sw, switchedTo: "OpenAI · b · fake-model", switchReason: "OpenRouter's credits are used up" }), /You're now on OpenAI · b · fake-model after OpenRouter's credits are used up\./);
});

test("ad loop --fallback: a quota error moves the loop to B, the log has a fallback line, the loop finishes there", async () => {
  const r = await loopRun("LOOPTEST-QUOTA-FIRST fix the tests", { fallback: true });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /\[1\] switched/);
  assert.match(r.out, /stopped: objective done/);
  assert.ok(r.log.some((l) => l.type === "fallback" && l.event === "switched" && /Switched to OpenAI · b/.test(l.text)), JSON.stringify(r.log));
  assert.equal(r.log.filter((l) => l.iteration).length, 2);
});

test("ad loop --fallback: a pause stops the loop with exit 4 and the reason in the log", async () => {
  const r = await loopRun("LOOPTEST-PAUSE deploy", { fallback: true });
  assert.equal(r.code, 4, r.err + r.out);
  assert.match(r.out, /ad loop stopped: paused: `npm run deploy` may still be running/);
  assert.ok(r.log.some((l) => l.type === "fallback" && l.event === "paused"));
  assert.match(r.err, /\[ad\] \u{23f8} Paused:/u);
});

test("ad loop --fallback with the policy off: exit 2", async () => {
  await disablePolicy(routingContext());
  const r = await loopRun("LOOPTEST-STUCK", { fallback: true });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), UNATTENDED_TEXTS.OFF("ad loop"));
});

// ---- teams --------------------------------------------------------------------------------------
const { cmdTeamSet } = await import("../src/orchestration/team-settings.mjs");
const { createTeam, loadTeam } = await import("../src/orchestration/team.mjs");
const { runEngineWorker } = await import("../src/orchestration/engine-worker.mjs");

test("AD_TOOL_SHELL=1: ad team set <team> fallback on exits 2 with the guard text; from a terminal it sets and clears it", async () => {
  const team = await createTeam({ description: "fallback test" });
  const err = sink();
  assert.equal(await cmdTeamSet([team.id, "fallback", "on"], { env: { AD_TOOL_SHELL: "1" }, out: sink(), err }), 2);
  assert.equal(err.text().trim(), UNATTENDED_TEXTS.TOOL_SHELL);
  assert.equal((await loadTeam(team.id)).fallback, undefined);
  assert.equal(await cmdTeamSet([team.id, "fallback", "on"], { env: {}, out: sink(), err: sink() }), 0);
  assert.equal((await loadTeam(team.id)).fallback, true);
  assert.equal(await cmdTeamSet([team.id, "fallback", "off"], { env: {}, out: sink(), err: sink() }), 0);
  assert.equal((await loadTeam(team.id)).fallback, undefined);
  assert.equal(await cmdTeamSet([team.id, "fallback", "maybe"], { env: {}, out: sink(), err: sink() }), 1);
});

test("a worker spawned with AD_TOOL_SHELL=1 still uses its team's fallback: quota on A, it finishes on B; a pause comes back as paused", async () => {
  const worktreePath = path.join(TMP, "work", "wt-1");
  fs.mkdirSync(worktreePath, { recursive: true });
  const env = { AD_TOOL_SHELL: "1" };
  const r = await runEngineWorker({ worktreePath, systemPrompt: "role", userMessage: "quota-fail", account: "openrouter/a", fallback: true, team: "t1", engineOpts: { command, store, env }, err: sink() });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.fallback.some((e) => e.type === "switched"));
  const p = await runEngineWorker({ worktreePath, systemPrompt: "role", userMessage: "quota-command-running", account: "openrouter/a", fallback: true, team: "t1", engineOpts: { command, store, env }, err: sink() });
  assert.equal(p.status, "paused");
  assert.match(p.error, /^paused: `npm run deploy` may still be running/);
  const off = await runEngineWorker({ worktreePath, systemPrompt: "role", userMessage: "quota-fail", account: "openrouter/a", team: "t1", engineOpts: { command, store }, err: sink() });
  assert.equal(off.ok, false);
  assert.match(off.error, /Fallback is on in your settings but not for this run: ad team set t1 fallback on\./);
});
