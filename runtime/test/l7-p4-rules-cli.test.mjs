// L7 P4 (design D16, D19): the `rules` CLI.
//   - list needs no token (text and --json): decision, scope, pattern, reason, paused, a rule
//     whose learning is gone, last asked/stopped from the hook's log;
//   - add needs the token; ask and this project unless --block / --all-projects;
//   - rm, pause and allow-once need the token and the typed code; resume the token;
//   - pause lasts 1 hour by default (--for, --until-resume, --all);
//   - from the agent's shell every change refuses and names no command; help and usage there
//     name only `rules list` (S4); each write rebuilds guards.json.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFilesUnder } from "../testkit/open-files.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7p4-cli-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const svc = await import("../src/memory/review-service.mjs");
const rules = await import("../src/memory/rules-service.mjs");
const { rulesMain, parseFor } = await import("../src/memory/rules-cli.mjs");
const { proposalFor } = await import("../src/memory/rule-proposals.mjs");
const { loadGuards } = await import("../src/hooks/guards.mjs");
const { appendRuleEvent } = await import("../src/hooks/rule-events.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

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
  assert.deepEqual(left, []);
});

const SLUG = "-work-shop-app";
const PID = "prj_0000000000000000000000SHP1";
let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return { h, root: path.join(dir, "ad") };
}
function note(h, text, { accepted = true } = {}) {
  const id = Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin, provenance) VALUES (?, ?, 'correction', ?, 0.8, 'pending', ?, 'user', 'prompt')",
    [SLUG, PID, text, `h-${++n}-${text}`]
  ).lastInsertRowid);
  if (accepted) svc.acceptLearning(h, testReviewToken(), id);
  return id;
}
const rulesOf = (h) => h.all("SELECT * FROM rules ORDER BY id");
const NOW = new Date("2026-11-15T10:00:00Z");

function cli(s, argv, o = {}) {
  const lines = [];
  const codes = [];
  return rulesMain(argv, {
    handle: s.h,
    root: s.root,
    projectId: PID,
    out: (l) => lines.push(l),
    env: o.env ?? {},
    isTTY: () => o.tty ?? true,
    now: o.now ?? NOW,
    command: (v) => `ad ${v}`,
    token: o.token ?? (async () => ({ token: testReviewToken() })),
    confirm: o.confirm ?? (async ({ what }) => (codes.push(what), { ok: true })),
    ask: async () => "",
  }).then((code) => ({ code, out: lines.join("\n"), codes }));
}
const refused = async () => ({ refused: "not your own terminal" });
const noCode = async () => ({ ok: false, text: "the code didn't match" });

test("add: the token; ask and this project by default; --block and --all-projects explicit; a pending learning can't", async () => {
  const s = await store();
  const a = note(s.h, "use pnpm, not npm");
  assert.equal((await cli(s, ["add", String(a)], { token: refused })).code, 1);
  assert.equal(rulesOf(s.h).length, 0, "no token: nothing");
  const r = await cli(s, ["add", String(a)]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /rule 1 asks before `npm install\|/);
  assert.deepEqual([rulesOf(s.h)[0].decision, rulesOf(s.h)[0].scope], ["ask", "project"]);
  assert.equal(loadGuards({ root: s.root }).snapshot.ruleCount, 1, "guards.json rebuilt");
  const b = note(s.h, "never use yarn add");
  await cli(s, ["add", String(b), "--block", "--all-projects"]);
  assert.deepEqual([rulesOf(s.h)[1].decision, rulesOf(s.h)[1].scope], ["deny", "all"]);
  const c = note(s.h, "keep it tidy");
  const r2 = await cli(s, ["add", String(c), "--pattern", "git push on main"]);
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(JSON.parse(rulesOf(s.h)[2].pattern).branches, ["main"]);
  const p = note(s.h, "use pnpm, not npm again", { accepted: false });
  assert.match((await cli(s, ["add", String(p)])).out, /isn't an accepted learning/);
  assert.match((await cli(s, ["add", String(c), "--pattern", "ad rules pause"])).out, /can't name ad's own/);
});

test("rm: the token and the typed code; a wrong code or none changes nothing", async () => {
  const s = await store();
  const a = note(s.h, "use pnpm, not npm");
  await cli(s, ["add", String(a)]);
  const noTok = await cli(s, ["rm", "1"], { token: refused });
  assert.equal(noTok.code, 1);
  assert.match(noTok.out, /nothing changed: this needs your own terminal \(not your own terminal\)/);
  assert.deepEqual(noTok.codes, [], "no token: not even the code is asked");
  const wrong = await cli(s, ["rm", "1"], { confirm: noCode });
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /nothing changed \(the code didn't match\)/);
  assert.equal(rulesOf(s.h).length, 1);
  const ok = await cli(s, ["rm", "1"]);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(ok.codes, ["Remove rule 1 (asks before `npm install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|clean-install|ic|install-clean|isntall-clean`)"]);
  assert.equal(rulesOf(s.h).length, 0);
  assert.equal(loadGuards({ root: s.root }).snapshot.ruleCount, 0, "guards.json follows");
  assert.match((await cli(s, ["rm", "9"])).out, /there is no rule 9/);
});

test("pause: 1 hour by default, --for, --until-resume, --all; the typed code; resume with the token", async () => {
  const s = await store();
  await cli(s, ["add", String(note(s.h, "use pnpm, not npm"))]);
  assert.equal((await cli(s, ["pause"], { confirm: noCode })).code, 1);
  assert.equal(rules.pausedState(s.h).projects[PID], undefined);
  const r = await cli(s, ["pause"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(rules.pausedState(s.h).projects[PID].until, "2026-11-15T11:00:00.000Z", "1 hour");
  assert.match(r.codes[0], /^Pause 1 rule in this project until 2026-11-15 11:00 UTC$/);
  await cli(s, ["pause", "--all", "--for", "30m"]);
  assert.equal(rules.pausedState(s.h).all.until, "2026-11-15T10:30:00.000Z");
  await cli(s, ["pause", "--until-resume"]);
  assert.equal(rules.pausedState(s.h).projects[PID].until, null);
  assert.match((await cli(s, ["pause", "--for", "forever"])).out, /--for takes/);
  assert.equal((await cli(s, ["resume"], { token: refused })).code, 1);
  assert.notEqual(rules.pausedState(s.h).projects[PID], undefined);
  const res = await cli(s, ["resume"]);
  assert.equal(res.code, 0);
  assert.deepEqual(res.codes, [], "resume raises: no typed code");
  assert.equal(rules.pausedState(s.h).projects[PID], undefined);
  await cli(s, ["resume", "--all"]);
  assert.equal(rules.pausedState(s.h).all, null);
  assert.equal(parseFor("2d"), 2 * 86_400_000);
  assert.equal(parseFor("0h"), null);
});

test("allow-once: nothing stopped → refused; with a stop: the token and the code over the full call", async () => {
  const s = await store();
  await cli(s, ["add", String(note(s.h, "use pnpm, not npm"))]);
  assert.match((await cli(s, ["allow-once", "1"])).out, /hasn't stopped anything/);
  const { createHash } = await import("node:crypto");
  const call = JSON.stringify({ cwd: "/w", tool_input: { command: "npm install lodash" }, tool_name: "Bash" });
  const callHash = createHash("sha256").update(call).digest("hex");
  appendRuleEvent({ project: PID, rules: [{ id: 1, matched: ["npm install lodash"] }], decision: "stopped", host: "claude", mode: "default", callId: callHash.slice(0, 6), callHash, call }, { root: s.root, now: NOW.getTime() - 60_000 });
  assert.equal((await cli(s, ["allow-once", "1"], { confirm: noCode })).code, 1);
  assert.equal(loadGuards({ root: s.root }).snapshot.allowOnce.length, 0);
  const ok = await cli(s, ["allow-once", "1", "--minutes", "10"]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.codes[0], /^Allow once: .*npm install lodash/);
  assert.equal(loadGuards({ root: s.root }).snapshot.allowOnce.length, 1);
  assert.match((await cli(s, ["allow-once", "1", "--minutes", "90"])).out, /1 to 30/);
});

test("list: no token; text and --json; paused, a gone learning, last asked/stopped", async () => {
  const s = await store();
  const a = note(s.h, "use pnpm, not npm");
  await cli(s, ["add", String(a)]);
  appendRuleEvent({ project: PID, rules: [{ id: 1 }], decision: "asked", host: "claude", mode: "default", callId: "abcdef", callHash: "a".repeat(64) }, { root: s.root, now: NOW.getTime() - 3 * 3_600_000 });
  await cli(s, ["pause", "--for", "2h"]);
  svc.forgetAccepted(s.h, testReviewToken(), a, { memoryFile: [] });
  const t = await cli(s, ["list"], { token: async () => assert.fail("list asks for no token") });
  assert.equal(t.code, 0);
  assert.match(t.out, /1 {2}asks · this project · npm install\|.* — a rule whose learning you removed \(paused until 2026-11-15 12:00 UTC, last asked 3h ago\)/);
  assert.match(t.out, /rule 1's learning is gone: keep it or `ad rules rm 1`/);
  const j = JSON.parse((await cli(s, ["list", "--json"])).out);
  assert.equal(j.rules[0].orphaned, "orphaned");
  assert.equal(j.rules[0].paused.until, "2026-11-15T12:00:00.000Z");
  assert.equal(j.rules[0].lastAsked, new Date(NOW.getTime() - 3 * 3_600_000).toISOString());
});

test("from the agent's shell: changes refuse and name no command; usage names only list (S4)", async () => {
  const s = await store();
  const a = note(s.h, "use pnpm, not npm");
  await cli(s, ["add", String(a)]);
  svc.forgetAccepted(s.h, testReviewToken(), a, { memoryFile: [] });
  const outs = [];
  for (const env of [{ AD_TOOL_SHELL: "1" }, {}]) {
    const tty = env.AD_TOOL_SHELL ? true : false;
    for (const argv of [["rm", "1"], ["pause", "--all"], ["allow-once", "1"], ["resume"], ["add", "1"], ["--help"], ["bogus"], ["list"], ["list", "--json"]]) {
      const r = await cli(s, argv, { env, tty, token: async () => assert.fail("no token from the agent's shell") });
      outs.push(r.out);
      if (["rm", "pause", "allow-once", "resume", "add"].includes(argv[0])) {
        assert.equal(r.code, 1);
        assert.match(r.out, /changed by the user, in their own terminal\. Nothing changed\./);
      }
    }
  }
  const all = outs.join("\n");
  assert.doesNotMatch(all, /rules (?:rm|pause|resume|allow-once|add)\b/, "no lowering or change command in any agent-facing output");
  assert.match(all, /the user can settle this in their own terminal/);
  assert.equal(rulesOf(s.h).length, 1);
});

test("a rule step's proposal never names ad (proposalFor)", () => {
  assert.equal(proposalFor("don't touch .agent-daemon/memory files"), null);
});
