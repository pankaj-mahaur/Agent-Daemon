// L4a: the correction classifier on its development set and on the shapes
// the definition names. The held-out gate is mistakes-corpus.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPrompt, ownWords } from "../src/mistakes/classify.mjs";

const dev = readFileSync(fileURLToPath(new URL("./fixtures/mistakes/dev-prompts.jsonl", import.meta.url)), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

test("development set: precision >= 0.95, recall >= 0.9 (regression guard; it was tuned on)", () => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const misses = [];
  for (const it of dev) {
    const got = classifyPrompt(it.prompt).correction;
    if (got && it.is_correction) tp++;
    else if (got) (fp++, misses.push(`FP ${it.id}`));
    else if (it.is_correction) (fn++, misses.push(`FN ${it.id}`));
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  assert.ok(precision >= 0.95 && recall >= 0.9, `precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}: ${misses.join(", ")}`);
});

const POSITIVE = [
  ["prohibition", "stop adding comments to every function"],
  ["we", "we use tabs in this repo, not spaces"],
  ["never", "never push straight to main"],
  ["fact", "the db is on 5433 not 5432"],
  ["frustrated", "how many times do I have to say it, use yarn"],
  ["polite request", "can you please stop using console.log, use the logger"],
  ["embedded in a task", "add the route and remember we validate with zod here"],
  ["conditional", "if you touch the schema, always add a migration"],
  ["do not", "do not use default exports"],
  ["hinglish always", "humesha tests chalao commit se pehle"],
  ["hinglish frustrated", "yaar kitni baar bola hai, axios mat use karo"],
  ["preference", "I prefer early returns over nested ifs"],
  ["rhetorical", "why do you keep adding semicolons? we don't use them"],
  ["after a paste", "```\nnpm ERR! code ERESOLVE\n```\nwe use pnpm here, not npm"],
  ["widened scope", "use the Result type, please stick to that everywhere, not just in this module"],
  ["keep under", "keep functions under 50 lines"],
  ["thanks, then a rule", "thanks, but never push to main"],
  // The team's convention names code too (the bench's smoke phrasing; L5 P2 fix).
  ["we use, a code name", "Actually we use logInfo for logging, not console output."],
  ["in this repo, a code name", "in this repo we use logInfo, not console.log"],
];
const NEGATIVE = [
  ["stop alone", "stop"],
  ["one-off choice", "use the second approach"],
  ["undo", "revert that"],
  ["scoped", "for now, skip the flaky test"],
  ["question", "should we switch to pnpm?"],
  ["status", "we never got the confirmation email"],
  ["status, always", "the build always fails on CI, can you check"],
  ["approval", "looks good, ship it"],
  ["current output", "the function should return 42 for that input"],
  ["pasted lint", "error: Do not use 'any'  @typescript-eslint/no-explicit-any"],
  ["quoted review", "Reviewer said: never mutate props. can you fix that one?"],
  ["no rush", "no rush"],
  ["yet", "don't commit yet"],
  ["task", "run the tests"],
  ["hinglish one-off", "ye mat karo"],
  ["about the user", "I always forget the flag for this"],
  ["idiom", "never mind, leave it as it is"],
  ["task with instead of", "Refactor src/api/users.ts to use async/await instead of promise chains"],
  ["code names", "no, the other function. parseHeaders, not parseBody"],
  ["explains this bug", "the file has 2 BOM bytes, not 0. that's why parsing breaks"],
  ["past event", "the cron job never ran last night"],
  ["session scope", "from now on in this session just show me diffs"],
  ["pasted CLI help", "Usage: deploy [options]\n\nOptions:\n  --dry-run     Never apply changes\n  --force       Always overwrite"],
  // This turn's work, worded like a rule (review round 1).
  ["idiom: worry", "don't worry about the flaky one"],
  ["idiom: forget", "don't forget to bump the version"],
  ["this task's scope", "don't change anything else"],
  ["this task's scope", "please don't touch the other modules"],
  ["this task's scope", "don't refactor anything, just fix the crash"],
  ["bare verb", "Don't merge"],
  ["stop and", "stop and look at the logs first"],
  ["a value", "use 8, not 4"],
  ["naming this code", "call it loadOrders, not getOrders"],
  ["naming this code, we", "we need to use loadOrders here, not getOrders"],
  // "we" elsewhere in the clause, or tied to this turn, isn't the team's convention (fix review).
  ["naming this code, we elsewhere", "we log a lot here, so use fetchUsers instead of getUsers"],
  ["naming this code, we don't", "we don't need fooBar, use bazQux instead of fooBar"],
  ["naming this code, now", "ok so now we use loadOrders instead of getOrders, update the tests"],
  ["naming this code, that call", "wait, we use getUserById in that call, not getUser"],
  ["naming this code, after", "after your refactor we use newHelper instead of oldHelper"],
  ["naming this code, here", "so we use useMemo here instead of useCallback"],
  ["one design choice", "instead of a dropdown, use a radio group"],
  ["outage", "the staging API is down"],
  ["same error", "always the same error: module not found"],
  ["names the bug", "you keep stale props in the closure, that's the bug"],
  ["minified blob", "a".repeat(120) + ".never.use.npm." + "b".repeat(120)],
  // Review round 2.
  ["this choice", "use the blue variant, not the green one"],
  ["status, never", "never seen this error before"],
  ["praise", "you always do great work, thanks"],
];

test("adversarial input stays fast (no catastrophic backtracking)", () => {
  const b64 = "QUJD".repeat(12_500);
  for (const text of [b64, `${b64}, not npm`, "ok so ".repeat(40) + "x", "no, ".repeat(2000) + "use pnpm", "never use npm and ".repeat(3000), "C:\\" + "a b ".repeat(10_000)]) {
    const t = performance.now();
    classifyPrompt(text);
    assert.ok(performance.now() - t < 1500, `${text.slice(0, 30)}… took ${Math.round(performance.now() - t)} ms`);
  }
});

test("the shapes the definition names", () => {
  for (const [why, p] of POSITIVE) assert.equal(classifyPrompt(p).correction, true, `${why}: ${p}`);
  for (const [why, p] of NEGATIVE) assert.equal(classifyPrompt(p).correction, false, `${why}: ${p}`);
});

test("the sentence is the rule clause, tidied, never the frustration alone", () => {
  assert.equal(classifyPrompt("no, use pnpm here, not npm").sentence, "use pnpm here, not npm");
  assert.equal(classifyPrompt("ugh every single time. the env file is .env.local not .env").sentence, "the env file is .env.local not .env");
  assert.equal(classifyPrompt("Can you please always run lint first?").sentence, "always run lint first");
  assert.equal(classifyPrompt("> prefer composition over inheritance\n\nthat comment is right, follow that from now on").sentence, "prefer composition over inheritance");
});

test("own words: private spans, fences, quotes and machine lines go", () => {
  assert.equal(ownWords("use pnpm <private>secret</private>"), "use pnpm");
  assert.equal(ownWords("```\nnever use any\n```\nok"), "ok");
  assert.equal(ownWords("> never use any\nok"), "ok");
  assert.equal(ownWords("    at foo (src/a.js:1:2)\nok"), "ok");
  assert.equal(ownWords("src/a.ts:12:4 - error TS2322: never\nok"), "ok");
});
