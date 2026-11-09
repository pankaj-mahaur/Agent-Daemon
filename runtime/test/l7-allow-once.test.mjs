// L7 P1c (design D9, Done-when 4): allow-once lifts exactly the one call the user saw.
//   - a stop is logged with its canonical call (what runs, plus the folder on Claude Code)
//     unless it can't be shown faithfully (too long, a secret, control/bidi/zero-width text);
//   - the review service finds the stop (the call id required when the rule stopped several),
//     recomputes its hash from what it shows, and writes a single-use token;
//   - the hook lifts a call only when every rule that stops it is covered by an unexpired
//     token for this project and this exact call, consuming each with an exclusive create;
//   - the next identical call is enforced; two racing calls let one through; an expired
//     token, another command, folder, project or call id does nothing; a rebuild never
//     revives a consumed token.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openFilesUnder } from "../testkit/open-files.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-once-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const svc = await import("../src/memory/review-service.mjs");
const rules = await import("../src/memory/rules-service.mjs");
const { rebuildGuards } = await import("../src/memory/guards-build.mjs");
const { loadGuards, consumedDir } = await import("../src/hooks/guards.mjs");
const { toolBefore } = await import("../src/hooks/tool-before.mjs");
const { readRuleEvents } = await import("../src/hooks/rule-events.mjs");
const { allowability, allowOnceView } = await import("../src/hooks/allow-once.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

const HOOK = fileURLToPath(new URL("../bin/hook.mjs", import.meta.url));
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
  const left = await openFilesUnder(ROOT);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.deepEqual(left, [], "every database is closed before the folder goes (Windows: EBUSY)");
});

const PID = "prj_0000000000000000000000SHP1";
const OTHER = "prj_000000000000000000000000T2";
const NPM = { type: "command", program: "npm", subcommands: ["install", "i", "ci"], flags: null };
const RM = { type: "command", program: "rm", subcommands: null, flags: ["-rf", "-r"] };
let n = 0;

/** A store with deny rules, a project folder, the snapshot built with the token. */
async function world({ extraRule = false } = {}) {
  const dir = path.join(ROOT, `w-${++n}`);
  const root = path.join(dir, "ad");
  const project = path.join(dir, "app");
  const other = path.join(dir, "other");
  fs.mkdirSync(path.join(project, "web"), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ schemaVersion: 1, revision: 1, projects: [{ id: PID, name: "app", paths: [{ path: project }], aliases: { episodic: [], handoff: [] } }, { id: OTHER, name: "other", paths: [{ path: other }], aliases: { episodic: [], handoff: [] } }] }));
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  const t = testReviewToken();
  const add = (text, pid, pattern) => {
    const id = Number(h.run("INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin) VALUES ('s', ?, 'correction', ?, 0.8, 'pending', ?, 'user')", [pid, text, `h-${++n}`]).lastInsertRowid);
    svc.acceptLearning(h, t, id);
    return rules.addRule(h, t, { learningId: id, projectId: pid, kind: "command", pattern, reason: text, decision: "deny" });
  };
  const npm = add("use pnpm, not npm", PID, NPM);
  const npmOther = add("use pnpm there too", OTHER, NPM);
  const rm = extraRule ? add("no recursive deletes", PID, RM) : null;
  await rebuildGuards(h, { root, token: t });
  return { h, t, root, project, other, rules: { npm, npmOther, rm } };
}

const bash = (command, cwd, extra = {}) => ({ session_id: "s", cwd, tool_name: "Bash", tool_input: { command, description: "run it" }, permission_mode: "default", ...extra });
const decide = (w, input, now = Date.now()) => toolBefore(input, { root: w.root, env: {}, now });
const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? null;

/** Stop the call, then allow it once through the review service. */
async function stopAndAllow(w, input, { rule, minutes = 5, now = Date.now(), callId } = {}) {
  assert.equal(decision(decide(w, input, now)), "deny");
  const found = rules.findAllowable({ root: w.root, rule, callId, now });
  assert.ok(found.entry, found.refused);
  await rules.grantAllowOnce(w.h, w.t, found.entry, { root: w.root, minutes, now });
  return found;
}

test("allow-once lets exactly the next identical call through, then enforces again", async () => {
  const w = await world();
  const call = bash("npm install lodash", w.project);
  const found = await stopAndAllow(w, call, { rule: w.rules.npm });
  assert.match(found.view, /npm install lodash/);
  const passed = decide(w, { ...call, tool_input: { ...call.tool_input, description: "retry with new words" } });
  assert.equal(decision(passed), null, "no decision: the host's own permission flow runs");
  assert.match(passed.systemMessage, /allowed once: rule/);
  assert.equal(decision(decide(w, call)), "deny", "the token is used up");
  const ev = readRuleEvents({ root: w.root }).map((e) => e.decision);
  assert.deepEqual(ev.slice(-3), ["stopped", "passed", "stopped"]);
});

test("allow-once does nothing for another command, folder, project, an expired token or another call id", async () => {
  const w = await world();
  const t0 = Date.now();
  const call = bash("npm install lodash", w.project);
  await stopAndAllow(w, call, { rule: w.rules.npm, minutes: 5, now: t0 });
  assert.equal(decision(decide(w, bash("npm install evil", w.project))), "deny", "another command");
  assert.equal(decision(decide(w, bash("npm install lodash", path.join(w.project, "web")))), "deny", "another folder (Claude Code binds it)");
  assert.equal(decision(decide(w, bash("npm install lodash", w.other))), "deny", "another project");
  assert.equal(decision(decide(w, call, t0 + 6 * 60_000)), "deny", "expired");
  assert.equal(decision(decide(w, call)), null, "still unused for the real thing within its time");
  // A call id that names nothing refuses.
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm, callId: "ffffff" }).refused, /no stop/i);
});

test("every rule that stopped the call must be covered; one token covers them all", async () => {
  const w = await world({ extraRule: true });
  const call = bash("npm install x && rm -rf build", w.project);
  assert.equal(decision(decide(w, call)), "deny");
  const ev = readRuleEvents({ root: w.root }).at(-1);
  assert.deepEqual(ev.rules.map((r) => r.id).sort(), [w.rules.npm, w.rules.rm].sort());
  const found = rules.findAllowable({ root: w.root, rule: w.rules.npm });
  assert.deepEqual(found.entry.rules.map((r) => r.id).sort(), [w.rules.npm, w.rules.rm].sort());
  assert.match(found.view, /rule \d+ matched `npm install x`/);
  await rules.grantAllowOnce(w.h, w.t, found.entry, { root: w.root });
  assert.equal(decision(decide(w, call)), null);
});

test("several stops of a rule need the call id; a handle shared by two stops is refused", async () => {
  const w = await world();
  decide(w, bash("npm install a", w.project));
  decide(w, bash("npm install b", w.project));
  const many = rules.findAllowable({ root: w.root, rule: w.rules.npm });
  assert.match(many.refused, /call id/);
  assert.equal(many.choices.length, 2);
  const want = many.choices.find((c) => /install b/.test(c.view));
  const one = rules.findAllowable({ root: w.root, rule: w.rules.npm, callId: want.callId });
  assert.ok(one.entry);
  // Two different stops sharing a handle (forged into the log here) are both listed, never guessed.
  const log = path.join(w.root, "hooks", "rule-events.jsonl");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[lines.length - 1].callId = lines[lines.length - 2].callId;
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm, callId: lines[0].callId }).refused, /share/);
});

test("calls that can't be shown faithfully are not allowable; LF and TAB are, shown visibly", async () => {
  assert.equal(allowability('{"tool_input":{"command":"npm i x"}}'), null);
  assert.equal(allowability(JSON.stringify({ command: "npm i\u{202e}x" })), "chars");
  assert.equal(allowability(JSON.stringify({ command: "npm i\u{1b}[2Kx" })), "chars");
  assert.equal(allowability(JSON.stringify({ command: "npm i\rx" })), "chars");
  assert.equal(allowability(JSON.stringify({ command: "npm i\u{200b}x" })), "chars");
  assert.equal(allowability(JSON.stringify({ command: "x".repeat(5000) })), "long");
  assert.equal(allowability(JSON.stringify({ command: "GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 npm i" })), "secret");
  const w = await world();
  decide(w, bash("npm install x\u{202e}y", w.project));
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm }).refused, /run it yourself/);
  assert.doesNotMatch(fs.readFileSync(path.join(w.root, "hooks", "rule-events.jsonl"), "utf8"), /\u{202e}/u, "never logged");
  const v = allowOnceView({ call: JSON.stringify({ tool_input: { command: "git commit -m 'a\n\tb' && npm i" }, tool_name: "Bash", cwd: "/w/app" }), rules: [] });
  assert.match(v, /⏎/);
  assert.match(v, /→/);
  assert.match(allowOnceView({ call: JSON.stringify({ tool_input: { command: "npm i lоdash" }, tool_name: "Bash" }), rules: [] }), /\\u\{43e\}/, "a Cyrillic look-alike is escaped");
});

test("the review service recomputes the hash from what it shows: a tampered log line is refused", async () => {
  const w = await world();
  decide(w, bash("npm install lodash", w.project));
  const log = path.join(w.root, "hooks", "rule-events.jsonl");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  last.call = last.call.replace("lodash", "evil");
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm }).refused, /doesn't match/);
});

test("grantAllowOnce needs the token; minutes are clamped; a rebuild never revives a consumed token", async () => {
  const w = await world();
  const call = bash("npm install lodash", w.project);
  decide(w, call);
  const found = rules.findAllowable({ root: w.root, rule: w.rules.npm });
  await assert.rejects(rules.grantAllowOnce(w.h, null, found.entry, { root: w.root }), /token/);
  const now = Date.now();
  await rules.grantAllowOnce(w.h, w.t, found.entry, { root: w.root, minutes: 999, now });
  const tok = loadGuards({ root: w.root }).snapshot.allowOnce.at(-1);
  assert.equal(Date.parse(tok.expires) - now, 30 * 60_000, "max 30 minutes");
  assert.equal(decision(decide(w, call)), null);
  await rebuildGuards(w.h, { root: w.root, token: w.t });
  await rebuildGuards(w.h, { root: w.root });
  assert.ok(fs.existsSync(path.join(consumedDir(w.root), tok.nonce)), "the marker stays until expiry plus grace");
  assert.equal(decision(decide(w, call)), "deny");
});

function hookOnce(w, payload) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: ROOT, USERPROFILE: ROOT, AD_ROOT: w.root };
    delete env.CLAUDE_PROJECT_DIR;
    const c = spawn(process.execPath, [HOOK, "tool.before"], { env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
    c.stdin.end(JSON.stringify(payload));
  });
}

test("spawned: two racing hooks for an allowed-once call let exactly one through", async () => {
  const w = await world();
  const call = bash("npm install lodash", w.project);
  await stopAndAllow(w, call, { rule: w.rules.npm });
  const outs = await Promise.all([hookOnce(w, call), hookOnce(w, call), hookOnce(w, call)]);
  const passed = outs.filter((o) => !/permissionDecision/.test(o));
  assert.equal(passed.length, 1, outs.join("\n"));
});

const { tryAllowOnce } = await import("../src/hooks/allow-once.mjs");
const { guardsPath, activePath } = await import("../src/hooks/guards.mjs");

test("tryAllowOnce: the exclusive create decides, in sorted nonce order, on the full hash and the project", () => {
  const dir = path.join(ROOT, `t-${++n}`);
  const H = "a".repeat(64);
  const tok = (nonce, rules, extra = {}) => ({ callHash: H, rules, project: PID, nonce, expires: new Date(Date.now() + 60_000).toISOString(), ...extra });
  const snap = { allowOnce: [tok("b".repeat(32), [2]), tok("a".repeat(32), [1])] };
  const order = [];
  const fsx = { existsSync: () => false, mkdirSync: fs.mkdirSync, writeFileSync: (f, d, o) => (order.push(path.basename(f)), fs.writeFileSync(f, d, o)) };
  assert.ok(tryAllowOnce(snap, { callHash: H, projectId: PID, ruleIds: [1, 2], root: dir, fsx }));
  assert.deepEqual(order, ["a".repeat(32), "b".repeat(32)], "sorted nonce order");
  // The pre-check says "unused" (as for a racing hook that read before the marker existed): the create still refuses.
  assert.equal(tryAllowOnce(snap, { callHash: H, projectId: PID, ruleIds: [1, 2], root: dir, fsx }), null);
  const fresh = path.join(ROOT, `t-${++n}`);
  assert.equal(tryAllowOnce(snap, { callHash: H.slice(0, 6) + "b".repeat(58), projectId: PID, ruleIds: [1, 2], root: fresh }), null, "the handle isn't the hash");
  assert.equal(tryAllowOnce(snap, { callHash: H, projectId: OTHER, ruleIds: [1, 2], root: fresh }), null, "another project");
  assert.equal(tryAllowOnce(snap, { callHash: H, projectId: PID, ruleIds: [1, 2, 3], root: fresh }), null, "a rule no token covers");
});

test("Codex: the same text in another project stays stopped (no folder in its hash)", async () => {
  const w = await world();
  const codex = (cwd) => ({ ...bash("npm install lodash", cwd), turn_id: "t" });
  assert.equal(decision(toolBefore(codex(w.project), { root: w.root, env: {}, host: "codex" })), "deny");
  const found = rules.findAllowable({ root: w.root, rule: w.rules.npm });
  await rules.grantAllowOnce(w.h, w.t, found.entry, { root: w.root });
  assert.equal(decision(toolBefore(codex(w.other), { root: w.root, env: {}, host: "codex" })), "deny", "another project");
  assert.equal(decision(toolBefore(codex(w.project), { root: w.root, env: {}, host: "codex" })), null);
});

test("the view shows every field faithfully: no hidden key, arrays as written, escapes that can't pass for others", () => {
  const v = (tin) => allowOnceView({ call: JSON.stringify({ tool_name: "Bash", tool_input: tin }), rules: [] });
  assert.match(v({ command: "ls", cmd: "rm -rf ~" }), /cmd: rm -rf ~/);
  assert.notEqual(v({ command: ["rm", "-rf", "a b"] }), v({ command: ["rm", "-rf", "a", "b"] }));
  assert.doesNotMatch(v({ command: { x: 1 } }), /\[object Object\]/);
  assert.match(v({ command: "echo ⏎ end" }), /\\u\{23ce\}/, "a literal ⏎ isn't a newline");
  assert.match(v({ command: "echo \\u{430}" }), /\\\\u\{430\}/, "a literal backslash sequence is escaped");
  for (const c of ["\u{ad}", "\u{2060}", "\u{180e}", "\u{fe0f}", "\u{e0041}"]) assert.equal(allowability(JSON.stringify({ command: `npm install x${c}y` })), "chars", c.codePointAt(0).toString(16));
});

test("grantAllowOnce re-checks the entry, records only a grant that happened, and passes confirmation through", async () => {
  const w = await world();
  decide(w, bash("npm install lodash", w.project));
  const found = rules.findAllowable({ root: w.root, rule: w.rules.npm });
  await assert.rejects(rules.grantAllowOnce(w.h, w.t, { ...found.entry, call: found.entry.call.replace("lodash", "evil") }, { root: w.root }), /match its hash/);
  // A store change behind the run: the rebuild refuses; no allow-once event is left behind.
  w.h.run("UPDATE rules SET decision = 'ask' WHERE id = ?", [w.rules.npmOther]);
  const before = w.h.get("SELECT COUNT(*) AS c FROM events WHERE kind = 'allow-once'").c;
  await assert.rejects(rules.grantAllowOnce(w.h, w.t, found.entry, { root: w.root }), (e) => e.code === "UNEXPECTED_DROP");
  assert.equal(w.h.get("SELECT COUNT(*) AS c FROM events WHERE kind = 'allow-once'").c, before);
  await rules.grantAllowOnce(w.h, w.t, found.entry, { root: w.root, confirmed: true });
  assert.equal(w.h.get("SELECT COUNT(*) AS c FROM events WHERE kind = 'allow-once'").c, before + 1);
});

test("a handle shared by two stops is resolved by the user's pick", async () => {
  const w = await world();
  decide(w, bash("npm install a", w.project));
  decide(w, bash("npm install b", w.project));
  const log = path.join(w.root, "hooks", "rule-events.jsonl");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[1].callId = lines[0].callId;
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const shared = rules.findAllowable({ root: w.root, rule: w.rules.npm, callId: lines[0].callId });
  assert.equal(shared.choices.length, 2);
  const b = shared.choices.find((c) => /install b/.test(c.view));
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm, pick: b.callHash }).view, /install b/);
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm, pick: String(b.number) }).view, /install b/);
});

test("a rebuild that can't write the snapshot puts the sentinel back; a snapshot without a store id fails closed", async () => {
  const w = await world();
  const sentinel = fs.readFileSync(activePath(w.root), "utf8");
  const g = guardsPath(w.root);
  const saved = fs.readFileSync(g);
  fs.rmSync(g);
  fs.mkdirSync(path.join(g, "blocker"), { recursive: true }); // rename onto a non-empty folder fails
  const a = w.h.get("SELECT id FROM learnings WHERE project_id = ? LIMIT 1", [PID]).id;
  rules.addRule(w.h, w.t, { learningId: a, projectId: PID, kind: "command", pattern: RM, reason: "x" });
  await assert.rejects(rebuildGuards(w.h, { root: w.root, token: w.t }));
  assert.equal(fs.readFileSync(activePath(w.root), "utf8"), sentinel, "the sentinel says what it said before");
  fs.rmSync(g, { recursive: true });
  fs.writeFileSync(g, saved);
  const s = JSON.parse(saved);
  delete s.store_id;
  fs.writeFileSync(g, JSON.stringify(s));
  assert.equal(decision(decide(w, bash("ls", w.project))), "ask", "the sentinel names a store the file doesn't");
});

test("spawned: a rebuild racing a hook never revives a consumed token", async () => {
  const w = await world();
  const call = bash("npm install lodash", w.project);
  await stopAndAllow(w, call, { rule: w.rules.npm });
  assert.equal(decision(decide(w, call)), null);
  const [, out] = await Promise.all([rebuildGuards(w.h, { root: w.root, token: w.t }), hookOnce(w, call), rebuildGuards(w.h, { root: w.root }).catch(() => null)]);
  assert.match(out, /"permissionDecision":"deny"/);
});

test("field names and the tool name are screened and escaped too; picks by number follow the list shown", async () => {
  assert.equal(allowability(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm i x", "\u{1b}[1A\u{1b}[2K": "y" } })), "chars");
  const v = allowOnceView({ call: JSON.stringify({ tool_name: "Bаsh", tool_input: { command: "npm i x", "kаy": "y" } }), rules: [] });
  assert.match(v, /B\\u\{430\}sh/);
  assert.match(v, /k\\u\{430\}y/);
  const w = await world();
  decide(w, bash("npm install c", w.project));
  decide(w, bash("npm install a", w.project));
  decide(w, bash("npm install b", w.project));
  const log = path.join(w.root, "hooks", "rule-events.jsonl");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[2].callId = lines[1].callId; // a and b share a handle
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const shared = rules.findAllowable({ root: w.root, rule: w.rules.npm, callId: lines[1].callId });
  const b = shared.choices.find((c) => /install b/.test(c.view));
  assert.match(rules.findAllowable({ root: w.root, rule: w.rules.npm, pick: String(b.number) }).view, /install b/, "the number shown picks that call");
});
