// L4c: correction → rule. The held-out gate is rules-corpus.test.mjs; this
// file holds the development set (a regression guard), the shapes the
// derivation must read, and replay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveRule } from "../src/rules/derive.mjs";
import { matchRule } from "../src/rules/match.mjs";
import { ruleForSentences, replayRule } from "../src/rules/replay.mjs";
import { derivationCorrect } from "../testkit/rule-examples.mjs";

const dev = readFileSync(fileURLToPath(new URL("./fixtures/rules/dev-corrections.jsonl", import.meta.url)), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

test("development set: accuracy >= 0.95 (regression guard; it was tuned on)", () => {
  const wrong = dev.filter((it) => !derivationCorrect(it, deriveRule(it.correction), matchRule)).map((it) => it.id);
  assert.ok((dev.length - wrong.length) / dev.length >= 0.95, `wrong: ${wrong.join(", ")}`);
});

const call = (command, os = "linux") => ({ tool: os === "windows" ? "PowerShell" : "Bash", input: { command }, os, cwd: os === "windows" ? "C:\\w\\app" : "/w/app", project_root: os === "windows" ? "C:\\w\\app" : "/w/app" });
const write = (file_path) => ({ tool: "Write", input: { file_path }, os: "linux", cwd: "/w/app", project_root: "/w/app" });

// [correction, calls it must ask before, calls it must leave alone]
const RULES = [
  ["use pnpm, not npm", [call("npm install"), call("npm i -D x"), call("npm ci")], [call("npx jest"), call("pnpm install"), call("npm view x")]],
  ["never force push", [call("git push --force"), call("git push -f origin x")], [call("git push"), call("git push --force-with-lease")]],
  ["Don't run terraform apply yourself, I'll do it", [call("terraform apply -auto-approve")], [call("terraform plan")]],
  ["Never run rails db:drop or db:reset.", [call("rails db:drop"), call("bin/rails db:reset")], [call("rails db:migrate")]],
  ["helm install ya upgrade mat chalao", [call("helm install x ./chart"), call("helm upgrade x ./chart")], [call("helm list")]],
  ["Don't pass -auto-approve to terraform.", [call("terraform apply -auto-approve")], [call("terraform apply")]],
  ["No git branch -D, not even -d.", [call("git branch -D x"), call("git branch -d x"), call("git branch --delete x")], [call("git branch -a")]],
  ["ruff check --fix ate my imports. Don't use --fix.", [call("ruff check --fix .")], [call("ruff check .")]],
  ["never rm -rf", [call("rm -rf x"), call("rm -r -f x")], [call("rm x")]],
  ["Never use Remove-Item -Recurse here", [call("Remove-Item -Recurse x", "windows")], [call("Remove-Item x", "windows")]],
  ["don't install packages globally", [call("npm install -g x"), call("npm i --global x")], [call("npm install x")]],
  ["Don't touch src/gen/, it's generated", [write("/w/app/src/gen/a.ts")], [write("/w/app/src/generated/a.ts")]],
  ["The lockfile is managed by CI, leave it alone", [write("/w/app/package-lock.json"), write("/w/app/pnpm-lock.yaml")], [write("/w/app/package.json")]],
  ["The fixtures in tests/fixtures/ are recorded. Don't edit them.", [write("/w/app/tests/fixtures/a.json")], [write("/w/app/tests/unit/a.json")]],
  ["Stop editing files inside .terraform/", [write("/w/app/infra/dev/.terraform/x.json")], [write("/w/app/infra/dev/main.tf")]],
  ["don't write any .pem files", [write("/w/app/certs/local.pem")], [write("/w/app/certs/README.md")]],
  ["use vitest instead of jest", [call("jest --watch"), call("npx jest")], [call("vitest run")]],
  ["No, use pnpm here", [call("npm install x")], [call("pnpm install x")]],
  ["use pnpm in this repo", [call("npm ci")], [call("pnpm i")]],
  ["Never edit anything in vendor/", [write("/w/app/vendor/x.go")], [write("/w/app/docs/vendor/x.md")]],
  // Review round 1.
  ["Don't run jest, we use vitest", [call("jest"), call("jest --watch")], [call("vitest")]],
  ["Don't run npm install, use npm ci instead", [call("npm install x")], [call("npm ci")]],
  ["never use sudo", [call("sudo apt update")], [call("apt list")]],
  ["don't run python -m pip install", [call("python -m pip install x"), call("pip install x")], [call("python -m pytest")]],
  ["main pe push mat karo", [call("git push origin main")], [call("git pull")]],
  ["Don't edit the root package.json", [write("/w/app/package.json")], [write("/w/app/web/package.json")]],
  // Review round 2: not too broad.
  ["Do not run make deploy", [call("make deploy")], [call("make test")]],
  ["don't run php artisan migrate:fresh", [call("php artisan migrate:fresh")], [call("php artisan migrate")]],
  ["don't run npx prisma migrate reset", [call("npx prisma migrate reset"), call("prisma migrate dev")], [call("npx prettier --check .")]],
  ["main branch pe push mat karna", [call("git push")], [call("git pull")]],
  ["don't run git, ask me first", [call("git push"), call("git status")], [call("hg status")]],
  ["never run eslint because it is slow", [call("eslint ."), call("eslint --fix src")], [call("prettier .")]],
  ["Don't ask, just use pnpm", [call("npm install x")], [call("pnpm install x")]],
];
const REMINDERS = [
  "always run the tests after you change something",
  "write commit messages in English",
  "no console.log in production code",
  "don't push yet",
  "use the logger",
  "keep your answers short",
  "be careful with git",
  "for now, don't touch the lockfile",
  "after you add a dependency, always run pnpm install",
  "don't run the migration yet",
  // Review round 1: negations that ask for the command.
  "Don't forget to run npm install",
  "never skip npm install after pulling",
  "It failed because you did not run npm install",
  "npm install nahi kiya tumne",
  "No need to run npm install again",
  "No, run git pull first",
];

test("corrections that become rules ask before exactly the right calls", () => {
  for (const [text, blocks, allows] of RULES) {
    const rule = deriveRule(text);
    assert.ok(rule.type === "command" || rule.type === "write", `${text} → ${JSON.stringify(rule)}`);
    for (const c of blocks) assert.equal(matchRule(rule, c).match, true, `${text}: ${JSON.stringify(c.input)}`);
    for (const c of allows) assert.equal(matchRule(rule, c).match, false, `${text}: ${JSON.stringify(c.input)}`);
  }
});

test("reminders stay reminders", () => {
  for (const text of REMINDERS) assert.equal(deriveRule(text).type, "not-a-rule", text);
});

test("replay: the first wording that derives a rule, counted over calls", () => {
  assert.equal(ruleForSentences(["stop with that", "use pnpm, not npm", "stop with that"])?.program, "npm");
  assert.equal(ruleForSentences(["keep it short", "keep it short"]), null);
  const rule = deriveRule("use pnpm, not npm");
  const calls = [
    { tool: "Bash", input: { command: "npm install" }, os: "linux", cwd: "/w/app" },
    { tool: "shell", input: { command: ["bash", "-lc", "npm ci"] }, os: "linux", cwd: "/w/app" },
    { tool: "Bash", input: { command: "pnpm i" }, os: "linux", cwd: "/w/app" },
    { tool: "Write", input: { file_path: "/w/app/x.sh", content: "npm install" }, os: "linux", cwd: "/w/app" },
  ];
  assert.equal(replayRule(rule, calls), 2);
  const writeRule = deriveRule("don't touch src/gen/");
  assert.equal(replayRule(writeRule, [{ tool: "Edit", input: { file_path: "/w/app/src/gen/a.ts" }, os: "linux", cwd: "/w/app/src" }], { rootOf: () => "/w/app" }), 1);
});

test("derivation stays fast on long input", () => {
  for (const text of ["don't " + "npm install ".repeat(5000), "x".repeat(100_000), "never edit " + "a/".repeat(20_000)]) {
    const t = performance.now();
    deriveRule(text);
    assert.ok(performance.now() - t < 1500, `${text.slice(0, 20)}… took ${Math.round(performance.now() - t)} ms`);
  }
});
