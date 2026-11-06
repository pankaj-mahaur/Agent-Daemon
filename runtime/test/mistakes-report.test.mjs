// L4a: fixture history → exact counts and clusters; redaction; the rule
// coverage line; the three renderings.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSources, readPrompts } from "../src/mistakes/history.mjs";
import { buildReport, renderText, renderShare, renderJson, weekStart, coverageLine, splitLine, BETA_SIGNUP_URL } from "../src/mistakes/report.mjs";
import { clusterCorrections, clusterLabel, tokens } from "../src/mistakes/cluster.mjs";
import { redactSentence, MAX_SENTENCE } from "../src/mistakes/redact.mjs";
import { ruleCoverage, ruleLines } from "../src/mistakes/coverage.mjs";
import { buildScenario } from "../testkit/agent-history.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-mistakes-"));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function scenarioReport({ allProjects = false } = {}) {
  const base = tmp();
  const s = buildScenario(base);
  const sources = listSources({ env: {}, home: s.home, cwd: s.project, allProjects });
  const { prompts, stats, calls } = readPrompts(sources, { calls: true });
  const report = buildReport({ prompts, calls, sources, stats, coverage: ruleCoverage({ root: sources.root, env: {}, home: s.home }), now: s.now, redact: { home: s.home, names: [] } });
  return { base, s, report };
}

test("the rule split: replayed on the fixture history, exact numbers", () => {
  const { base, s, report } = scenarioReport();
  assert.deepEqual(report.split, s.expected.split);
  assert.deepEqual(report.top.map((t) => t.rule), [{ kind: "command", asked: 3 }, null]);
  assert.equal(splitLine(report), "1 of your top 2 repeats could become a rule; replayed on your history, it would have asked before 3 commands. The other one is a reminder, recalled and counted.");
  const text = renderText(report, { projectName: "app" });
  assert.ok(text.split("\n")[2].startsWith("1 of your top 2 repeats could become a rule"), "the split leads the report");
  assert.ok(text.includes("×3 use pnpm, not npm  (Claude Code 2 · Codex 1)  → rule: would have asked before 3 commands"));
  assert.ok(renderShare(report).includes("| 3 | stop adding comments to every function | Claude Code 2 · Codex 1 | reminder |"));
  // Without calls (an older caller), no split at all.
  assert.equal(buildReport({ prompts: [], sources: { root: null, codex: {} } }).split, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("two repeats with the same rule count each call once in the totals", () => {
  const ts = Date.parse("2026-11-03T00:00:00Z");
  const prompts = ["use pnpm, not npm", "use pnpm, not npm", "stop running npm install", "stop running npm install"].map((text, i) => ({ host: "claude", id: `p${i}`, ts: ts + i, text, session: "s" }));
  const calls = ["npm install a", "npm i b", "npm ci"].map((command, i) => ({ id: `c${i}`, tool: "Bash", input: { command }, os: "linux", cwd: "/w/app" }));
  const report = buildReport({ prompts, calls, sources: { root: "/w/app", codex: {} }, now: ts + 86_400_000 });
  assert.equal(report.top.length, 2);
  assert.deepEqual(report.top.map((t) => t.rule?.asked), [3, 3]);
  assert.equal(report.split.commands, 3, "not 6");
});

test("the split line's wording", () => {
  const r = (split, n) => splitLine({ split, top: Array.from({ length: n }) });
  assert.equal(r({ rules: 4, reminders: 6, commands: 37, writes: 0 }, 10), "4 of your top 10 repeats could become rules; replayed on your history, they would have asked before 37 commands. The other 6 are reminders, recalled and counted.");
  assert.equal(r({ rules: 2, reminders: 0, commands: 5, writes: 2 }, 2), "2 of your top 2 repeats could become rules; replayed on your history, they would have asked before 5 commands and 2 file writes.");
  assert.equal(r({ rules: 1, reminders: 0, commands: 0, writes: 3 }, 1), "1 of your top 1 repeat could become a rule; replayed on your history, it would have asked before 3 file writes.");
  assert.equal(r({ rules: 0, reminders: 3, commands: 0, writes: 0 }, 3), "None of your top 3 repeats are command or file rules: they are reminders, recalled and counted.");
});

test("fixture history: exact counts, clusters and weekly trend", () => {
  const { base, s, report } = scenarioReport();
  const e = s.expected;
  assert.equal(report.hosts.claude.prompts, e.prompts.claude);
  assert.equal(report.hosts.codex.prompts, e.prompts.codex);
  assert.equal(report.prompts, e.prompts.claude + e.prompts.codex);
  assert.equal(report.corrections, e.corrections);
  assert.equal(report.repeats, e.clusters.length);
  assert.equal(report.repeated3, 2);
  assert.equal(report.bothAgents, 2);
  assert.equal(report.singles, e.singles);
  assert.deepEqual(
    report.top.map((t) => ({ count: t.count, hosts: t.hosts, sentence: t.sentence })),
    e.clusters,
  );
  const weekly = Object.fromEntries(report.weekly.filter((w) => w.total).map((w) => [day(w.weekStart), w.total]));
  assert.deepEqual(weekly, e.weekly);
  // From the first prompt's week to now.
  assert.deepEqual(report.weekly.map((w) => day(w.weekStart)), ["2026-10-26", "2026-11-02"]);
  // Sessions: s1, s2, s3 (Claude Code); c1, c3, c5 (Codex).
  assert.equal(report.hosts.claude.sessions, 3);
  assert.equal(report.hosts.codex.sessions, 3);
  assert.equal(report.hosts.claude.days, 10);
  assert.equal(report.scope.project, "app", "the folder's name, never its path");
  fs.rmSync(base, { recursive: true, force: true });
});

test("--all-projects adds the sibling project's repeat", () => {
  const { base, s, report } = scenarioReport({ allProjects: true });
  assert.equal(report.prompts, s.expected.allProjects.prompts);
  assert.equal(report.corrections, s.expected.allProjects.corrections);
  assert.equal(report.repeats, s.expected.allProjects.repeats);
  assert.ok(report.top.some((t) => t.sentence === "never push to main" && t.count === 2));
  assert.equal(report.scope.allProjects, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test("clusters: same rule in other words merges; different or opposite rules never do", () => {
  const items = [
    "use pnpm, not npm",
    "stop using npm, we use pnpm",
    "don't add comments to every function",
    "stop adding comments to every function",
    "use npm",
    "never use npm",
  ].map((sentence, i) => ({ sentence, host: "claude", ts: i }));
  const c = clusterCorrections(items);
  // "use npm" says the opposite and stays alone; "never use npm" shares only "npm" with the pnpm rule, too little to merge.
  assert.deepEqual(c.map((x) => x.count), [2, 2, 1, 1]);
  assert.ok(c.some((x) => x.sentences.length === 1 && x.sentences[0] === "use npm"));
  assert.deepEqual([...tokens("use pnpm, not npm")].sort(), ["+pnpm", "-npm"]);
  assert.deepEqual([...tokens("stop using npm, we use pnpm")].sort(), ["+pnpm", "-npm"]);
  assert.deepEqual([...tokens("prefer early returns over nested ifs")].sort(), ["+early", "+return", "-ifs", "-nest"]);
  assert.deepEqual([...tokens("npm mat use karo, pnpm use karo")].sort(), ["+pnpm", "-npm"]);
  assert.deepEqual([...tokens("keep .env.local out of git")].sort(), ["+env.local", "+git", "+out"]);
  const sizes = (list) => clusterCorrections(list.map((sentence, i) => ({ sentence, host: "claude", ts: i }))).map((x) => x.count);
  // Different things to avoid: three rules, not one.
  assert.deepEqual(sizes(["never use lodash", "don't use moment", "never use var"]), [1, 1, 1]);
  // Opposite directions.
  assert.deepEqual(sizes(["use tabs, not spaces", "use spaces, not tabs"]), [1, 1]);
  assert.deepEqual(sizes(["use pnpm, not npm", "use npm, not pnpm"]), [1, 1]);
  // Mostly the same words, but one wants what the other rules out.
  assert.deepEqual(sizes(["format with prettier before commit, not eslint", "format with prettier and eslint before commit"]), [1, 1]);
  // Same verb, different thing: the verb doesn't make them one rule.
  assert.deepEqual(sizes(["always run lint first", "always run tests first"]), [1, 1]);
  // One shared word isn't enough when the verb is what differs, or when the other words differ.
  assert.deepEqual(sizes(["always write tests", "always run tests"]), [1, 1]);
  assert.deepEqual(sizes(["never commit to main", "never commit secrets", "never commit .env files"]), [1, 1, 1]);
  // Short rules still group with their own rewordings ("any" is filler elsewhere, so "any types" stays apart).
  assert.deepEqual(sizes(["don't use any", "never use any types", "dont use any!"]), [2, 1]);
  // Deterministic.
  assert.deepEqual(clusterCorrections(items).map((x) => x.id), c.map((x) => x.id));
  assert.equal(clusterLabel(["b long one", "a", "b long one"]), "b long one");
  assert.equal(clusterLabel(["longer wording", "short"]), "short");
});

test("redaction: secrets, paths, the account name, e-mails, handles, IPs, URLs; at most 200 characters", () => {
  const home = "C:\\Users\\sam";
  const token = "gh" + "p_" + "a1B2c3D4".repeat(5);
  const r = (t) => redactSentence(t, { home, names: ["sam"] });
  assert.equal(r(`never commit ${token} again`), "never commit [redacted:github-token] again");
  assert.equal(r("logs go to C:\\Users\\sam\\clients\\acme\\logs\\app.log"), "logs go to <path>\\app.log");
  assert.equal(r("config is in D:\\Program Files\\Acme Corp\\cfg.toml now"), "config is in <path>\\cfg.toml now");
  assert.equal(r("run it from /home/sam/clients/acme/app"), "run it from <path>/app");
  assert.equal(r("keep it in ~/clients/acme/notes.md"), "keep it in ~/…/notes.md");
  assert.equal(r("ask sam or mail sam@corp.test"), "ask <user> or mail <email>");
  assert.equal(r("ping @priya before merging, not @types/node"), "ping @<name> before merging, not @types/node");
  assert.equal(r("the db is at 10.1.2.3, use 127.0.0.1 locally"), "the db is at <ip>, use 127.0.0.1 locally");
  assert.equal(r("see https://git.corp.test/team/repo/pull/12?token=x"), "see https://git.corp.test/…");
  assert.equal(r("src/api/users.ts stays as it is"), "src/api/users.ts stays as it is");
  assert.equal(r("use <private>the secret plan</private>pnpm"), "use pnpm");
  const long = r("never ".repeat(80));
  assert.ok(long.length <= MAX_SENTENCE && long.endsWith("…"));
  // Folder names with spaces, home by another name, credentials in a URL, glued secret names.
  assert.equal(r("see /Users/sam/Client Work/Acme Corp/billing.ts"), "see <path>/billing.ts");
  assert.equal(r("see ~\\Desktop\\Acme Corp\\a.txt"), "see ~/…/a.txt");
  assert.equal(r("logs in $HOME/clients/acme-bank/out.log"), "logs in ~/…/out.log");
  assert.equal(r("logs in %USERPROFILE%\\clients\\acme\\out.log"), "logs in ~/…/out.log");
  assert.equal(r("db is postgres://app:hunter2pw@db.internal:5432/app"), "db is postgres://db.internal:5432/…");
  assert.equal(r("set PGPASSWORD=Tr0ub4dor3xyz first"), "set PGPASSWORD=[redacted:env-assignment] first");
  assert.equal(r("push to git@github.test:acme-bank/payments.git only"), "push to <email>:… only");
});

test("the redacted sentence is what the report shows and shares", () => {
  const prompts = [1, 2].map((i) => ({ host: "claude", id: `x${i}`, ts: Date.parse("2026-11-03T00:00:00Z") + i, text: "never write logs to C:\\Users\\sam\\clients\\acme\\out.log", session: "s" }));
  const report = buildReport({ prompts, sources: { root: null, codex: {} }, now: Date.parse("2026-11-05T00:00:00Z"), redact: { home: "C:\\Users\\sam", names: ["sam"] } });
  assert.equal(report.top[0].sentence, "never write logs to <path>\\out.log");
  for (const out of [renderText(report), renderShare(report), renderJson(report)]) {
    assert.ok(!out.includes("acme"), out);
    assert.ok(!out.includes("sam"), out);
  }
});

test("rule coverage: CLAUDE.md rules Codex can't see, and the other way", () => {
  const base = tmp();
  const home = path.join(base, "home");
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "CLAUDE.md"),
    ["# Rules", "- use pnpm, not npm", "- never push to main", "1. tests live next to the code", "- tbd", "- [the style guide](docs/style.md)", "- `npm run lint:fix`", "- Commands:", "```", "- not a rule (in a fence)", "```", "<!-- agent-daemon:start -->", "- ad's managed text", "<!-- agent-daemon:end -->"].join("\n"),
  );
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "- reply in short bullets please\n");
  assert.deepEqual(ruleLines(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")), ["use pnpm, not npm", "never push to main", "tests live next to the code"]);

  let cov = ruleCoverage({ root, env: {}, home });
  assert.equal(cov.claudeRules, 4);
  assert.equal(cov.codexMissing, 4);
  const fake = { hosts: { claude: { prompts: 1 }, codex: { prompts: 1 } } };
  assert.equal(coverageLine(cov, fake), "Codex sees none of your 4 CLAUDE.md rules.");

  fs.writeFileSync(path.join(root, "AGENTS.md"), "- Use pnpm, NOT npm!\n- keep functions under 40 lines\n");
  cov = ruleCoverage({ root, env: {}, home });
  assert.equal(cov.codexMissing, 3);
  assert.equal(cov.claudeMissing, 1);
  assert.equal(coverageLine(cov, fake), "Codex doesn't see 3 of your 4 CLAUDE.md rules. Claude Code doesn't see 1 of your 2 AGENTS.md rules.");

  // CLAUDE.md importing AGENTS.md: Claude Code sees them all.
  fs.appendFileSync(path.join(root, "CLAUDE.md"), "\n@AGENTS.md\n");
  assert.equal(ruleCoverage({ root, env: {}, home }).claudeMissing, 0);

  // Codex told to fall back to CLAUDE.md where there's no AGENTS.md.
  fs.rmSync(path.join(root, "AGENTS.md"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'project_doc_fallback_filenames = ["CLAUDE.md"]\n');
  cov = ruleCoverage({ root, env: {}, home });
  assert.equal(cov.codexMissing, 1); // only the user-level rule
  // No Codex at all: no Codex line.
  assert.equal(coverageLine({ ...cov, agentsFiles: [] }, { hosts: { claude: { prompts: 3 }, codex: { prompts: 0 } } }), null);
  fs.rmSync(base, { recursive: true, force: true });
});

test("text report: both agents, coverage, weekly bars, top repeats, history, sign-up", () => {
  const { base, report } = scenarioReport();
  const text = renderText(report, { projectName: "app", claudeSettings: "~/.claude/settings.json" });
  const lines = text.split("\n");
  assert.equal(lines[0], "Mistakes report: this project (app). Offline: no model call, nothing stored.");
  assert.ok(text.includes("Claude Code and Codex together: 2 of your repeated corrections came up in both."));
  assert.ok(text.includes("Codex sees none of your 2 CLAUDE.md rules."));
  assert.ok(text.indexOf("together") < text.indexOf("Corrections per week"));
  assert.ok(text.indexOf("Corrections per week") < text.indexOf("You corrected your agents 8 times in 10 typed prompts; 2 corrections repeated 3+ times."));
  assert.ok(text.includes("×3 use pnpm, not npm  (Claude Code 2 · Codex 1)"));
  assert.ok(text.includes("Claude Code: 10 days of history, 3 sessions, 6 typed prompts."));
  assert.ok(text.trimEnd().endsWith(BETA_SIGNUP_URL));
  assert.ok(!text.includes("cleanupPeriodDays"), "10 days of history is far from the 30-day limit");
  fs.rmSync(base, { recursive: true, force: true });
});

test("the retention tip appears when history reaches Claude Code's limit", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const prompts = [{ host: "claude", id: "a", ts: now - 29.5 * 86_400_000, text: "hello", session: "s" }];
  const report = buildReport({ prompts, sources: { root: "/w/app", codex: {} }, now, retentionDays: 30 });
  assert.ok(renderText(report, { claudeSettings: "~/.claude/settings.json" }).includes('Claude Code deletes transcripts after 30 days by default; raise "cleanupPeriodDays" in ~/.claude/settings.json to keep more.'));
});

test("share: no project name, no paths, a table; JSON: the numbers", () => {
  const { base, s, report } = scenarioReport();
  const md = renderShare(report);
  assert.ok(md.startsWith("## My coding agents' repeated mistakes (10 days of history)"));
  assert.ok(md.includes("| 3 | use pnpm, not npm | Claude Code 2 · Codex 1 |"));
  assert.ok(!md.includes(s.project) && !md.includes("app-old") && !md.includes(base));
  const raw = renderJson(report);
  const json = JSON.parse(raw);
  assert.equal(json.corrections, 8);
  assert.equal(json.top.length, 2);
  assert.ok(!raw.includes("how many times"), "raw prompts never reach the output");
  // No absolute path at all: not the project, not the rule files, not the home folder.
  for (const p of [s.project, s.home, base, path.join(s.project, "CLAUDE.md")]) assert.ok(!raw.includes(JSON.stringify(p).slice(1, -1)), p);
  assert.equal(json.scope.project, "app");
  fs.rmSync(base, { recursive: true, force: true });
});

test("weekStart is Monday 00:00 UTC", () => {
  assert.equal(new Date(weekStart(Date.parse("2026-11-05T12:00:00Z"))).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(weekStart(Date.parse("2026-11-02T00:00:00Z"))).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(weekStart(Date.parse("2026-11-08T23:59:00Z"))).toISOString(), "2026-11-02T00:00:00.000Z");
});
