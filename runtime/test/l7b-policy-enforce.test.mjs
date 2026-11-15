// L7b part 2: the starter safety policy in L7's store and on L7's enforcement path.
//   - off by default: a fresh store has no policy row and its snapshot no policy rule;
//   - on/off only with the review token; one ask rule per family, every project, no learning;
//     a learning's rule can never carry a policy pattern;
//   - guards.json: the policy merges in as global rules (counted for the fail-closed switch);
//     off leaves exactly its own rules out (L7 D3's expected list);
//   - decisions per host and permission_mode (spawned bin/hook.mjs): Claude Code asks (deny in
//     bypassPermissions, dontAsk); Codex denies; the message names the starter safety policy
//     and never tells the model a command (S4);
//   - D18: a project rule can only add (deny wins; a project hit never hides the policy); a
//     project's pause doesn't lift the policy, a pause of every rule does;
//   - an unknown pattern type is asked, never passed (a guard copy older than its rules).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7b-enf-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const rules = await import("../src/memory/rules-service.mjs");
const policy = await import("../src/memory/starter-policy.mjs");
const { buildSnapshot } = await import("../src/memory/guards-build.mjs");
const { loadGuards, writeGuards, activePath } = await import("../src/hooks/guards.mjs");
const { toolBefore } = await import("../src/hooks/tool-before.mjs");
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
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
async function store() {
  const dir = path.join(ROOT, `s-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return { h, root: path.join(dir, "ad") };
}

const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? null;
const POL = (id, family) => ({ id, kind: "command", decision: "ask", reason: `starter safety policy: ${family}`, scope: "all", project: "_policy", rule: { type: "policy", family } });
const ALL_POL = [POL(1, "recursive-delete"), POL(2, "force-push-default"), POL(3, "env-read"), POL(4, "no-verify")];

/** A snapshot with the policy (global) and optional project rules, like L7's tests write. */
function setup({ projectRules = [], global = ALL_POL, paused = false, pausedAll = null } = {}) {
  const base = path.join(ROOT, `w-${++n}`);
  const root = path.join(base, "ad");
  const project = path.join(base, "work", "app");
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const ruleCount = projectRules.length + global.length;
  writeGuards({ projects: { p1: { roots: [project], paused, rules: projectRules } }, global: { rules: global }, pausedAll, allowOnce: [], ruleCount, rules_rev: 1, store_id: "a".repeat(32), cmd: "ad" }, { root });
  if (ruleCount) fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount, store_id: "a".repeat(32) }));
  return { base, root, project, home };
}
const bash = (command, cwd, extra = {}) => ({ session_id: "s", cwd, tool_name: "Bash", tool_input: { command }, permission_mode: "default", ...extra });
const opts = (g, extra = {}) => ({ root: g.root, homes: [g.home], gitRead: { currentBranch: () => "feat/x", defaultBranches: () => ["main"] }, log: () => {}, ...extra });

test("off by default: a fresh store has no policy row, and its snapshot no policy rule", async () => {
  const { h, root } = await store();
  assert.equal(policy.policyState(h).state, "off");
  assert.deepEqual(policy.policyRules(h), []);
  const snap = buildSnapshot(h, { root });
  assert.equal(snap.ruleCount, 0);
  assert.deepEqual(snap.global.rules, []);
});

test("on and off need the review token; on adds one ask rule per family, idempotent", async () => {
  const { h, root } = await store();
  assert.throws(() => policy.policyOn(h, null), /token/);
  assert.throws(() => policy.policyOn(h, {}), /token/);
  await assert.rejects(policy.setPolicy(h, null, true, { root }), /token/);
  assert.equal(policy.policyState(h).state, "off");
  const t = testReviewToken();
  const on = await policy.setPolicy(h, t, true, { root });
  assert.equal(on.added.length, 4);
  assert.equal(on.ruleCount, 4);
  const rows = h.all("SELECT * FROM rules ORDER BY id");
  for (const r of rows) {
    assert.equal(r.source, "policy");
    assert.equal(r.scope, "all");
    assert.equal(r.decision, "ask");
    assert.equal(r.learning_id, null);
    assert.equal(r.kind, "command");
  }
  assert.deepEqual(policy.policyOn(h, t).added, [], "idempotent");
  assert.equal(policy.policyState(h).state, "on");
  // guards.json holds them as global rules; the sentinel counts them (the fail-closed switch).
  const g = loadGuards({ root }).snapshot;
  assert.deepEqual(g.global.rules.map((r) => r.rule.family).sort(), [...policy.POLICY_FAMILIES].sort());
  assert.equal(g.ruleCount, 4);
  assert.equal(JSON.parse(fs.readFileSync(activePath(root), "utf8")).ruleCount, 4);
  assert.equal(g.projects._policy, undefined, "no project named _policy");
  // Off: exactly its own rules leave (no UNEXPECTED_DROP), with the token only.
  await assert.rejects(policy.setPolicy(h, null, false, { root }), /token/);
  const off = await policy.setPolicy(h, t, false, { root });
  assert.equal(off.removed.length, 4);
  assert.equal(policy.policyState(h).state, "off");
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 0);
});

test("a policy pattern only through the policy route: never a learning's rule, never deny or one project", async () => {
  const { h } = await store();
  const t = testReviewToken();
  assert.throws(() => rules.validPattern("command", { type: "policy", family: "env-read" }), /not a usable pattern/);
  assert.throws(() => rules.addRule(h, t, { learningId: 1, projectId: "p", kind: "command", pattern: { type: "policy", family: "env-read" }, reason: "x" }), /not a usable pattern|accepted/);
  const base = { learningId: null, projectId: "_policy", scope: "all", kind: "command", decision: "ask", pattern: { type: "policy", family: "env-read" }, reason: "x", source: "policy" };
  for (const bad of [{ decision: "deny" }, { scope: "project" }, { learningId: 3 }, { kind: "write" }, { pattern: { type: "policy", family: "rm-everything" } }, { pattern: { type: "command", program: "rm" } }]) {
    assert.throws(() => rules.addRule(h, t, { ...base, ...bad }), /starter safety policy|policy family/, JSON.stringify(bad));
  }
  assert.ok(rules.addRule(h, t, base) > 0);
});

test("decisions: Claude Code asks, Codex denies; the message names the policy and gives the model no command", () => {
  const g = setup();
  const ask = toolBefore(bash("rm -rf ~", g.project), opts(g));
  assert.equal(decision(ask), "ask");
  const reason = ask.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /starter safety policy asks before this command/);
  assert.doesNotMatch(reason, /`|safety off|rules (?:rm|pause|allow-once)/, "S4: no command in model text");
  assert.match(ask.systemMessage, /starter safety policy \(rule 1\): asks before .* turn it off: `ad safety off`/);
  assert.doesNotMatch(ask.systemMessage + reason, /protects? you/i, "copy: asks before, never protects");
  const deny = toolBefore(bash("git push --force origin main", g.project, { permission_mode: "bypassPermissions" }), opts(g));
  assert.equal(decision(deny), "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /stops this command here.*Tell the user/);
  assert.match(deny.systemMessage, /allow this once: `ad rules allow-once 2 [0-9a-f]{6}`/);
  const codex = toolBefore({ ...bash("cat .env", g.project), turn_id: "t" }, opts(g, { host: "codex" }));
  assert.equal(decision(codex), "deny");
  // The Read tool and its exemption; look-alikes pass.
  assert.equal(decision(toolBefore({ session_id: "s", cwd: g.project, tool_name: "Read", tool_input: { file_path: path.join(g.project, ".env") }, permission_mode: "default" }, opts(g))), "ask");
  assert.match(toolBefore({ session_id: "s", cwd: g.project, tool_name: "Read", tool_input: { file_path: ".env.local" }, permission_mode: "default" }, opts(g)).hookSpecificOutput.permissionDecisionReason, /this file read/);
  assert.equal(toolBefore({ session_id: "s", cwd: g.project, tool_name: "Read", tool_input: { file_path: ".env.example" }, permission_mode: "default" }, opts(g)), null);
  for (const c of ["rm -rf ./build", "git push --force origin feat/x", "git commit -m '--no-verify'", "cp .env.example .env"]) assert.equal(toolBefore(bash(c, g.project), opts(g)), null, c);
  // The project folder itself, its home and the branch come from the hook's own context.
  assert.equal(decision(toolBefore(bash("rm -rf .", g.project), opts(g))), "ask");
  assert.equal(decision(toolBefore(bash("git push -f", g.project), opts(g, { gitRead: { currentBranch: () => "main", defaultBranches: () => ["main"] } }))), "ask");
  assert.equal(toolBefore(bash("git push -f", g.project), opts(g)), null, "on a feature branch");
});

test("D18: a project rule only adds — deny wins, a project hit never hides the policy, a project pause doesn't lift it", () => {
  const PUSH = { id: 9, kind: "command", decision: "deny", reason: "never push from here", scope: "project", rule: { type: "command", program: "git", subcommands: ["push"], flags: null } };
  const g = setup({ projectRules: [PUSH] });
  const both = toolBefore(bash("git push --force origin main", g.project), opts(g));
  assert.equal(decision(both), "deny", "a stricter project rule tightens");
  assert.match(both.systemMessage, /also the starter safety policy/);
  const ASKNPM = { id: 10, kind: "command", decision: "ask", reason: "use pnpm", scope: "project", rule: { type: "command", program: "rm", subcommands: null, flags: null } };
  const g2 = setup({ projectRules: [ASKNPM] });
  const out = toolBefore(bash("rm -rf ~", g2.project), opts(g2));
  assert.equal(decision(out), "ask");
  assert.match(out.systemMessage, /starter safety policy|also the starter safety policy/);
  // Order doesn't decide: a project ask hit comes first, the user's deny later — deny wins.
  const ASKPUSH = { id: 12, kind: "command", decision: "ask", reason: "ask before pushing", scope: "project", rule: { type: "command", program: "git", subcommands: ["push"], flags: null } };
  const DENYFORCE = { id: 13, kind: "command", decision: "deny", reason: "never force push", scope: "all", rule: { type: "command", program: "git", subcommands: ["push"], flags: ["--force", "-f"] } };
  const g5 = setup({ projectRules: [ASKPUSH], global: [...ALL_POL, DENYFORCE] });
  assert.equal(decision(toolBefore(bash("git push --force origin main", g5.project), opts(g5))), "deny");
  // A paused project: its own rules stop; the user-level policy still asks.
  const g3 = setup({ projectRules: [ASKNPM], paused: { at: "2026-11-15T00:00:00Z", until: null } });
  const p3 = toolBefore(bash("rm -rf ~", g3.project), opts(g3));
  assert.equal(decision(p3), "ask");
  assert.match(p3.systemMessage, /starter safety policy \(rule 1\)/);
  assert.equal(toolBefore(bash("rm -rf ./x", g3.project), opts(g3)), null, "the paused project's own rule is off");
  // A pause of every rule (the user's, token + code) lifts the policy too.
  const g4 = setup({ pausedAll: { at: "2026-11-15T00:00:00Z", until: null } });
  assert.equal(toolBefore(bash("rm -rf ~", g4.project), opts(g4)), null);
});

test("outside any project the policy still applies (user level), the git top standing in for the project", () => {
  const g = setup();
  const loose = path.join(g.base, "elsewhere", "repo");
  fs.mkdirSync(path.join(loose, ".git"), { recursive: true });
  assert.equal(decision(toolBefore(bash("rm -rf ~", loose), opts(g))), "ask");
  assert.equal(decision(toolBefore(bash("rm -rf .", loose), opts(g))), "ask", "the git top is the project folder");
  assert.equal(toolBefore(bash("rm -rf ./dist", loose), opts(g)), null);
});

test("the policy's own lines: pause means every rule; a context that can't be read asks", () => {
  const g = setup();
  const out = toolBefore(bash("rm -rf ~", g.project), opts(g));
  assert.match(out.systemMessage, /pause every rule: `ad rules pause --all`/);
  assert.doesNotMatch(out.systemMessage, /rules pause`/, "a project pause doesn't lift the policy: not offered");
  const broken = toolBefore(bash("git push -f", g.project), opts(g, { gitRead: { currentBranch: () => { throw new Error("EIO"); }, defaultBranches: () => ["main"] } }));
  assert.equal(decision(broken), "ask");
  // A Write never reads the folders (latency): homes are read only when a family needs them.
  let reads = 0;
  const counting = opts(g, { realpath: (p) => (reads++, p) });
  toolBefore({ session_id: "s", cwd: g.project, tool_name: "Write", tool_input: { file_path: path.join(g.project, "a.txt"), content: "x" }, permission_mode: "default" }, counting);
  const afterWrite = reads;
  toolBefore(bash("ls -la", g.project), counting);
  assert.equal(reads - afterWrite, afterWrite, "a command no family reads costs what a Write costs");
});

test("an unknown pattern type is asked, never passed silently", () => {
  const g = setup({ global: [{ id: 5, kind: "command", decision: "ask", reason: "from a newer writer", scope: "all", rule: { type: "policy-v9", family: "x" } }] });
  assert.equal(decision(toolBefore(bash("ls", g.project), opts(g))), "ask");
});

function runHook(raw, { root, home }) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root };
  for (const k of ["CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER", "AD_MEMORY_DB"]) delete e[k];
  return spawnSync(process.execPath, [HOOK, "tool.before"], { input: raw, env: e, encoding: "utf8", timeout: 60_000 });
}

test("spawned: decisions per host and permission_mode through bin/hook.mjs (L7 Done-when 3)", () => {
  const g = setup();
  const dir = fileURLToPath(new URL("./fixtures/hosts/claude-code/", import.meta.url));
  const want = { default: "ask", acceptEdits: "ask", plan: "ask", auto: "ask", bypassPermissions: "deny", dontAsk: "deny" };
  for (const [mode, expect] of Object.entries(want)) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, `mode-${mode}-none.json`), "utf8"));
    const p = fx.hooks.find((x) => x.payload?.hook_event_name === "PreToolUse").payload;
    const r = runHook(JSON.stringify({ ...p, cwd: g.project, tool_input: { ...p.tool_input, command: `rm -rf ${g.project}` } }), { root: g.root, home: g.home }); // (rm -rf $HOME is self-protection's: a deny)
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, expect, mode);
    assert.match(out.systemMessage, /starter safety policy/);
  }
  const unread = runHook(JSON.stringify({ ...bash("rm -rf ~", g.project), permission_mode: "someNewMode" }), { root: g.root, home: g.home });
  assert.equal(JSON.parse(unread.stdout).hookSpecificOutput.permissionDecision, "deny", "a mode it can't read denies");
  const codex = runHook(JSON.stringify({ ...bash("git commit --no-verify -m x", g.project), turn_id: "t" }), { root: g.root, home: g.home });
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, "deny", "Codex");
  const none = runHook(JSON.stringify(bash("rm -rf ./build", g.project)), { root: g.root, home: g.home });
  assert.equal(none.stdout.trim() === "" || none.stdout.trim() === "{}", true, "a look-alike prints no decision");
});

test("git-branch: current and default branches from files, worktrees included; unknown → main and master", async () => {
  const { currentBranch, defaultBranches } = await import("../src/hooks/git-branch.mjs");
  const repo = path.join(ROOT, `repo-${++n}`);
  fs.mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feat/a\n");
  assert.equal(currentBranch(path.join(repo)), "feat/a");
  assert.deepEqual(defaultBranches(repo), ["main", "master"], "no origin/HEAD");
  fs.writeFileSync(path.join(repo, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/trunk\n");
  assert.deepEqual(defaultBranches(repo), ["trunk"]);
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(currentBranch(repo), null, "detached");
  // A linked worktree: its own HEAD, the main repository's remote refs.
  const wt = path.join(ROOT, `wt-${n}`);
  const gd = path.join(repo, ".git", "worktrees", "w");
  fs.mkdirSync(gd, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gd}\n`);
  fs.writeFileSync(path.join(gd, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gd, "HEAD"), "ref: refs/heads/wt-branch\n");
  assert.equal(currentBranch(path.join(wt)), "wt-branch");
  assert.deepEqual(defaultBranches(wt), ["trunk"]);
  assert.equal(currentBranch(path.join(ROOT, "nowhere")), null);
});

test("allow-once sees what the policy matched (matchedParts)", async () => {
  const { matchedParts } = await import("../src/hooks/allow-once.mjs");
  const call = { tool: "Bash", input: { command: "ls && rm -rf ~" }, os: "linux", cwd: "/w", policy: { homes: ["/home/u"], project_root: [], default_branches: ["main"], current_branch: "x" } };
  assert.deepEqual(matchedParts({ type: "policy", family: "recursive-delete" }, call), ["rm -rf ~"]);
  assert.deepEqual(matchedParts({ type: "policy", family: "env-read" }, { ...call, tool: "Read", input: { file_path: "/w/.env" } }), ["/w/.env"]);
});
