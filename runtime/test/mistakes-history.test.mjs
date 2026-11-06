// L4a: the mistakes report's history reader keeps only what the user typed,
// once, for the right project (S-HISTORY filters, uuid / item-id dedupe).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { claudePrompts, codexPrompts, codexToolCalls, osOfPath, listSources, readPrompts, typedText, claudeProjectSlug, inProject, claudeRetentionDays } from "../src/mistakes/history.mjs";
import { buildScenario } from "../testkit/agent-history.mjs";

const hosts = fileURLToPath(new URL("./fixtures/hosts/", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(hosts, rel), "utf8");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-mistakes-"));
}

test("real Claude Code 2.1.314 transcripts: only the typed prompts survive", () => {
  // sources-main: two typed prompts, a tool_result entry and a background
  // task's completion (promptSource system, origin task-notification).
  const main = claudePrompts(read("claude-code/transcripts/sources-main.jsonl"));
  assert.equal(main.length, 2);
  assert.ok(main[0].text.startsWith("SPIKE_AGENT"));
  assert.ok(main[1].text.startsWith("SPIKE_WAKE"));
  assert.ok(!main.some((p) => p.text.includes("task-notification")));
  // The spike ran headless (`claude -p`, entrypoint sdk-cli): tagged as scripted.
  assert.ok(main.every((p) => p.automated));
  // A ScheduleWakeup prompt fires as isMeta + promptSource system: not typed.
  // A prompt sent while the agent was working survives only as a
  // queued_command attachment (the queue logs it "absorbed_mid_turn").
  const scheduled = claudePrompts(read("claude-code/transcripts/scheduled-main.jsonl")).map((p) => p.text.split(" ")[0]);
  assert.deepEqual(scheduled.sort(), ["SPIKE_CRON", "SPIKE_WAKE"]);
  // A subagent's transcript is all sidechain.
  assert.deepEqual(claudePrompts(read("claude-code/transcripts/sources-subagent.jsonl")), []);
});

test("real Codex 0.164 rollout: the typed prompt, not the injected environment context", () => {
  const got = codexPrompts(read("codex/rollouts/exec-basic.jsonl"));
  assert.deepEqual(got.map((p) => p.text), ["SPIKE_SHELL no, use pnpm here"]);
  assert.equal(got[0].automated, true, "codex exec is a scripted run");
});

test("tool calls for replay: the agent's own, once each, this project's, no scripted runs", () => {
  const base = tmp();
  const s = buildScenario(base);
  const { calls } = readPrompts(listSources({ env: {}, home: s.home, cwd: s.project }), { calls: true });
  // Claude Code: 4 in s1 (the sidechain's left out), 1 new in s2 (its copy of t-npm-1 dropped).
  // Codex: npm ci in c1 (c3 repeats it), npm test in c3; c2 is a subagent's.
  assert.deepEqual(calls.map((c) => c.id).sort(), ["cc:t-npm-1", "cc:t-npm-2", "cc:t-pnpm", "cc:t-run", "cc:t-write", "cx:call_npm_ci", "cx:call_test"]);
  const ci = calls.find((c) => c.id === "cx:call_npm_ci");
  assert.deepEqual(ci.input.command, ["bash", "-lc", "npm ci"]);
  assert.equal(ci.tool, "shell");
  assert.equal(calls.find((c) => c.id === "cx:call_test").input.command, "npm test");
  assert.equal(calls.find((c) => c.id === "cc:t-write").tool, "Write");
  fs.rmSync(base, { recursive: true, force: true });
});

test("the OS of a call comes from its folder's spelling", () => {
  assert.equal(osOfPath("C:\\work\\app"), "windows");
  assert.equal(osOfPath("\\\\server\\share\\app"), "windows");
  assert.equal(osOfPath("/Users/sam/app"), "macos");
  assert.equal(osOfPath("/home/sam/app"), "linux");
  assert.equal(osOfPath(null), "linux");
});

test("Codex patch and exec calls in their different shapes", () => {
  const ts = "2026-11-03T08:00:00.000Z";
  const meta = JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "x", cwd: "/w/app", originator: "codex_cli_rs" } });
  const line = (payload) => JSON.stringify({ timestamp: ts, type: "response_item", payload });
  const raw = [
    meta,
    line({ type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch" }),
    line({ type: "function_call", name: "apply_patch", call_id: "p2", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Delete File: b.ts\n*** End Patch" }) }),
    line({ type: "local_shell_call", call_id: "l1", action: { command: ["npm", "i"], working_directory: "/w/app/web" } }),
    line({ type: "function_call", name: "shell_command", call_id: "s1", arguments: JSON.stringify({ command: "npm ci", workdir: "/w/app" }) }),
    line({ type: "function_call", name: "web_search", call_id: "w1", arguments: "{}" }),
  ].join("\n");
  const calls = codexToolCalls(raw);
  assert.deepEqual(calls.map((c) => [c.id, c.tool]), [["cx:p1", "apply_patch"], ["cx:p2", "apply_patch"], ["cx:l1", "shell"], ["cx:s1", "shell"]]);
  assert.equal(calls[2].cwd, "/w/app/web");
  // Another project's rollout gives nothing in project scope.
  assert.deepEqual(codexToolCalls(raw, { root: "/w/other" }), []);
});

test("a prompt typed mid-turn counts once, whether queued or also logged as a user entry", () => {
  const ts = "2026-11-03T10:00:00.000Z";
  const queued = (id, mode = "prompt") => JSON.stringify({ type: "attachment", uuid: `a-${id}`, timestamp: ts, cwd: "/w/app", sessionId: "s", attachment: { type: "queued_command", prompt: [{ type: "text", text: "never commit .env files" }], source_uuid: id, commandMode: mode } });
  const user = (id) => JSON.stringify({ type: "user", uuid: id, timestamp: ts, cwd: "/w/app", sessionId: "s", message: { role: "user", content: "never commit .env files" } });
  const got = claudePrompts([queued("q1"), user("q1"), queued("q2", "bash")].join("\n"));
  assert.deepEqual(got.map((p) => p.id), ["cc:q1", "cc:q1"], "same id, so readPrompts keeps one; a bash-mode command isn't a prompt");
});

test("scripted runs are counted apart and left out", () => {
  const base = tmp();
  const s = buildScenario(base);
  const ts = "2026-11-03T08:00:00.000Z";
  fs.writeFileSync(
    path.join(s.claudeDir, "projects", claudeProjectSlug(s.project), "ci.jsonl"),
    JSON.stringify({ type: "user", uuid: "ci-1", timestamp: ts, cwd: s.project, sessionId: "ci", entrypoint: "sdk-cli", promptSource: "sdk", message: { role: "user", content: "never push to main" } }) + "\n",
  );
  const src = listSources({ env: {}, home: s.home, cwd: s.project });
  const { prompts, stats } = readPrompts(src);
  assert.equal(stats.automated, 1);
  assert.ok(!prompts.some((p) => p.session === "ci"));
  assert.equal(readPrompts(src, { automated: true }).prompts.length, prompts.length + 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test("outside a git repository only sessions started in exactly that folder count", () => {
  const base = tmp();
  const s = buildScenario(base);
  const work = path.join(base, "work");
  // Started in work/ itself (no .git there or above), plus the scenario's sessions in work/app.
  const ts = "2026-11-03T08:00:00.000Z";
  const dir = path.join(s.claudeDir, "projects", claudeProjectSlug(work));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "w.jsonl"), JSON.stringify({ type: "user", uuid: "w-1", timestamp: ts, cwd: work, sessionId: "w", message: { role: "user", content: "use pnpm" } }) + "\n");
  const src = listSources({ env: {}, home: s.home, cwd: work });
  assert.equal(src.root, work);
  assert.equal(src.exactFolder, true);
  const { prompts } = readPrompts(src);
  assert.deepEqual(prompts.map((p) => p.text), ["use pnpm"]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("Windows and macOS: a session recorded with another drive or path case is found", { skip: process.platform === "linux" }, () => {
  const base = tmp();
  const home = path.join(base, "home");
  const project = path.join(base, "work", "app");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  // A terminal that reported c:\ instead of C:\ (or another case on macOS):
  // the only folder for this project has the other spelling.
  const oddCase = project.replace(/^[A-Za-z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).replace(/[a-z](?=[^\\/]*$)/, (c) => c.toUpperCase());
  assert.notEqual(oddCase, project);
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(oddCase));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "odd.jsonl"), JSON.stringify({ type: "user", uuid: "odd-1", timestamp: "2026-11-03T08:00:00.000Z", cwd: oddCase, sessionId: "odd", message: { role: "user", content: "hello from the other case" } }) + "\n");
  const { prompts } = readPrompts(listSources({ env: {}, home, cwd: project }));
  assert.deepEqual(prompts.map((p) => p.session), ["odd"]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("typedText drops wrappers, reminders and generated prompts", () => {
  assert.equal(typedText("<command-name>/x</command-name>"), null);
  assert.equal(typedText("<task-notification>done</task-notification>"), null);
  assert.equal(typedText("<some-new-wrapper>anything</some-new-wrapper>"), null);
  assert.equal(typedText("Caveat: The messages below were generated by the user while running local commands."), null);
  assert.equal(typedText("[Request interrupted by user]"), null);
  assert.equal(typedText("use pnpm<system-reminder>ignore me</system-reminder>"), "use pnpm");
  assert.equal(typedText("<environment_context>\n<cwd>x</cwd>\n</environment_context>"), null);
  assert.equal(typedText("  keep <b>this</b> one  "), "keep <b>this</b> one");
});

test("project scope: subfolders count, a sibling whose slug starts the same doesn't", () => {
  const base = tmp();
  const s = buildScenario(base);
  const env = {};
  const src = listSources({ env, home: s.home, cwd: path.join(s.project, "packages", "web"), allProjects: false });
  assert.equal(src.root, s.project);
  // Listed: app, app/packages/web and app-old (same slug start); read: only this project's entries.
  assert.equal(src.claude.projects, 3);
  const { prompts, stats } = readPrompts(src);
  const by = (h) => prompts.filter((p) => p.host === h);
  assert.equal(by("claude").length, s.expected.prompts.claude);
  assert.equal(by("codex").length, s.expected.prompts.codex);
  assert.ok(prompts.every((p) => inProject(p.cwd, s.project)));
  assert.ok(!prompts.some((p) => p.text === "never push to main"));
  // The resumed session's two copies and the fork's two copies.
  assert.equal(stats.duplicates, 4);
  // Time order.
  assert.deepEqual([...prompts].sort((a, b) => a.ts - b.ts), prompts);

  const all = readPrompts(listSources({ env, home: s.home, cwd: s.project, allProjects: true }));
  assert.equal(all.prompts.length, s.expected.allProjects.prompts);
  fs.rmSync(base, { recursive: true, force: true });
});

test("CLAUDE_CONFIG_DIR and CODEX_HOME are honoured; .zst rollouts are read or counted", () => {
  const base = tmp();
  const s = buildScenario(base);
  const cfg = path.join(base, "elsewhere-claude");
  const cx = path.join(base, "elsewhere-codex");
  fs.renameSync(s.claudeDir, cfg);
  fs.renameSync(s.codexHome, cx);
  const src = listSources({ env: { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: cx }, home: s.home, cwd: s.project });
  assert.equal(src.claude.dir, path.join(cfg, "projects"));
  assert.equal(src.codex.dir, cx);
  const { prompts } = readPrompts(src);
  assert.equal(prompts.length, s.expected.prompts.claude + s.expected.prompts.codex);

  // Codex compresses old rollouts (.jsonl.zst).
  const one = src.codex.files.find((f) => f.path.includes("c5"));
  const raw = fs.readFileSync(one.path);
  if (typeof zlib.zstdCompressSync === "function") {
    fs.writeFileSync(one.path + ".zst", zlib.zstdCompressSync(raw));
    fs.rmSync(one.path);
    const again = readPrompts(listSources({ env: { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: cx }, home: s.home, cwd: s.project }));
    assert.ok(again.prompts.some((p) => p.text === "always run lint before committing"));
  } else {
    fs.writeFileSync(one.path + ".zst", raw);
    fs.rmSync(one.path);
    assert.equal(listSources({ env: { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: cx }, home: s.home, cwd: s.project }).codex.compressed, 1);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test("no history: empty lists, no error", () => {
  const base = tmp();
  const src = listSources({ env: {}, home: path.join(base, "nobody"), cwd: base });
  assert.equal(src.claude.exists, false);
  assert.equal(src.codex.exists, false);
  assert.deepEqual(readPrompts(src).prompts, []);
  fs.rmSync(base, { recursive: true, force: true });
});

test("Claude Code's slug and retention setting", () => {
  assert.equal(claudeProjectSlug("D:\\Program Files\\work\\app"), "D--Program-Files-work-app");
  assert.equal(claudeProjectSlug("/home/sam/work/my_app"), "-home-sam-work-my-app");
  const base = tmp();
  const cfg = path.join(base, ".claude");
  fs.mkdirSync(cfg);
  assert.equal(claudeRetentionDays({ env: {}, home: base }), 30);
  fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
  assert.equal(claudeRetentionDays({ env: {}, home: base }), 90);
  fs.writeFileSync(path.join(cfg, "settings.json"), "{ not json");
  assert.equal(claudeRetentionDays({ env: {}, home: base }), 30);
  fs.rmSync(base, { recursive: true, force: true });
});

test("a corrupt line or an unknown entry shape is skipped, not fatal", () => {
  const raw = ['{"type":"user", broken', JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "use pnpm" }, timestamp: "2026-11-01T00:00:00Z" }), JSON.stringify({ type: "user", future: true })].join("\n");
  assert.deepEqual(claudePrompts(raw).map((p) => p.text), ["use pnpm"]);
  const rollout = ['{"type":"response_item", nope', JSON.stringify({ timestamp: "2026-11-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "use pnpm" }] } })].join("\n");
  assert.deepEqual(codexPrompts(rollout).map((p) => p.text), ["use pnpm"]);
});
