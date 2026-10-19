// The driver smoke: ad's real engine with the scripted model (runner/mock-model.mjs),
// one family, off vs on-hooks, two sessions. It proves the plumbing a real run
// depends on: the follow-up correction turn, the prompt hook, SessionEnd, capture,
// and the lesson reaching session 2. Needs the pinned engine: AD_REAL_ENGINE=1.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runner", "run.mjs");
const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bench-smoke-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

test("one family through the real engine: off repeats the mistake, on-hooks captures the correction and doesn't", { skip, timeout: 900_000 }, () => {
  const phr = path.join(TMP, "phrasings");
  fs.mkdirSync(phr);
  // A phrasing the hook's rules capture whole (PROTOCOL.md: capture is measured, not assumed).
  fs.writeFileSync(path.join(phr, "logger.json"), JSON.stringify({ family: "logger", phrasings: [{ id: "smoke", text: "Actually we use logInfo for logging, not console output.", writer: "author" }] }));
  const out = path.join(TMP, "out");
  const r = spawnSync(process.execPath, [RUN, "--mock", "--families", "logger", "--conditions", "off,on-hooks", "--seeds", "1", "--sessions", "2", "--phrasings", phr, "--out", out, "--episode-timeout-ms", "420000"], { encoding: "utf8", timeout: 880_000 });
  assert.equal(r.status, 0, r.stderr);
  const rs = fs.readFileSync(path.join(out, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const at = (c, s) => rs.find((x) => x.condition === c && x.session === s);
  const show = JSON.stringify(rs, null, 1);
  for (const x of rs) assert.equal(x.status, "ok", show);
  // off: corrected in session 1, repeated in session 2.
  assert.deepEqual([at("off", 1).violated, at("off", 1).corrected, at("off", 2).violated], [true, true, true], show);
  // on-hooks: the follow-up turn ran, the prompt hook and SessionEnd fired, the correction was stored…
  const s1 = at("on-hooks", 1);
  assert.equal(s1.corrected, true, show);
  assert.equal(s1.hooks.promptHook, true, show);
  // End-of-session capture ran at least once (the engine caps it at 3 s; a cold start can miss it).
  assert.ok(rs.some((x) => x.condition === "on-hooks" && x.hooks?.sessionEnd), show);
  assert.equal(s1.captured, true, show);
  // …and session 2 was shown it before the task.
  assert.deepEqual([at("on-hooks", 2).opportunity, at("on-hooks", 2).violated], [true, false], show);
  const run = JSON.parse(fs.readFileSync(path.join(out, "run.json"), "utf8"));
  assert.equal(run.mock, true);
  assert.equal(run.conditions["on-hooks"].settings.engineMemories.value, false);
});
