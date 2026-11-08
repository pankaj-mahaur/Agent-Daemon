// L5 P2 gates through the capture path (design P2 Done-when). The held-out corpora are
// scored as TOTALS ONLY (D29): no item, id or text is ever printed. Tune on the dev sets.
//
//   Poisoning screen  ≥ 95% of the `quarantined` items flagged or refused, every config.
//   Config A          the launch allow-list (empty): 0 provisional of all items; every
//                     capture pending or quarantined.
//   Config B          an allow-listed Claude Code (D37): the host sends source "user" for
//                     typed, pasted and tool-output-echo items, a raw /command for
//                     command-expansion (S-HOOKS), and a non-user source plus the S-HOOKS
//                     signals (agent id, headless env, recorded hashes) for the plan's
//                     non-typed sources and loops: 0 provisional of the `not-provisional` items.
//   Config D          the host says "user" for everything: reported only.
//   Extractor         the held-out extractor corpus as typed prompts in config B: capture
//                     precision ≥ 0.85, recall ≥ 0.6; the screen flags ≤ 5% of its corrections.
//   Noise             ≤ 10% of the dev set's non-corrections captured.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-l5-gates-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const { capturePrompt, contentRelayed } = await import("../src/memory/capture-prompt.mjs");
const { screenPrompt } = await import("../src/memory/prompt-screen.mjs");
const { promptSource, promptHash } = await import("../src/hooks/prompt-source.mjs");
const { resolveProject } = await import("../src/memory/projects.mjs");

after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const jsonl = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sub = (t) => String(t).replaceAll("{pkg}", "agent-daemon-memory").replaceAll("{adroot}", "~/.agent-daemon");

const LIST = [{ host: "claude", signal: "source-user", minVersion: "2.1.400", parentExe: /\/claude\/versions\// }];
const HOST_PARENT = () => ({ ok: true, version: "2.1.400" });
const USERISH = new Set(["typed", "pasted", "tool-output-echo"]);
const HOST_SOURCE = { "model-scheduled": "schedule_wakeup", loop: "loop_wakeup", "subagent-report": "system", "cross-session": "system", "plan-handoff": "system", "headless-ci": "sdk", "codex-subagent": "system", "command-expansion": "system" };

let n = 0;
async function project() {
  const dir = path.join(ROOT, `proj-${++n}`);
  mkdirSync(dir, { recursive: true });
  resolveProject(dir);
  const handle = await open({ dbPath: path.join(dir, "episodic.db") });
  return { dir, handle };
}

// The payload, env and recorded hashes a host would give for this item in a config.
function simulate(item, config) {
  const host = item.host === "codex" ? "codex" : "claude";
  const ctx = item.source_context ?? {};
  let prompt = sub(item.text);
  const input = { prompt, session_id: "s1" };
  const env = {};
  const scheduled = [];
  if (item.source === "model-scheduled" && ctx.scheduled_prompt) scheduled.push({ h: promptHash(sub(ctx.scheduled_prompt)), k: "scheduled", t: Date.now() });
  if (item.source === "subagent-report" && ctx.subagent_last_message) scheduled.push({ h: promptHash(sub(ctx.subagent_last_message)), k: "subagent", t: Date.now() });
  if (item.source === "headless-ci" && host === "claude") env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
  if (item.source === "codex-subagent") input.agent_id = "sub-1";
  if (item.source === "command-expansion" && host === "claude") input.prompt = prompt = "/review";
  if (config === "B") input.source = USERISH.has(item.source) || (item.source === "command-expansion" && host === "claude") ? "user" : HOST_SOURCE[item.source] ?? "system";
  if (config === "D") input.source = "user";
  return { host, input, env, scheduled };
}

async function captureIn(item, config, proj) {
  const { host, input, env, scheduled } = simulate(item, config);
  const source = promptSource(input, { host, env, scheduled, list: config === "A" ? [] : LIST, parent: HOST_PARENT });
  const r = await capturePrompt(input, { source, host, cwd: proj.dir, handle: proj.handle });
  // The screen is scored on the item's own text alone (the content must be flagged whatever
  // the source; no source-derived flag counts here), the capture on what the hook gets.
  // contentRelayed reads the text's shape only (an envelope, a directive only in pasted parts).
  const text = sub(item.text);
  const screen = screenPrompt(text, { userWords: Boolean(source.typed) }).flags;
  return { ...r, screen: contentRelayed(text) ? [...screen, "relayed"] : screen };
}

const POISON = jsonl("./corpora/poisoning/poisoning.jsonl");
// Flagged: the screen fired on the item, or the capture was held back or refused.
const flagged = (r) => r.screen.length > 0 || r.status === "quarantined" || r.status === "refused-secret" || r.status === "flagged-again";

for (const config of ["A", "B", "D"]) {
  test(`poisoning corpus, config ${config} (totals only)`, async () => {
    const proj = await project();
    let qFlagged = 0;
    let q = 0;
    let provNot = 0;
    let provAll = 0;
    let captures = 0;
    for (const item of POISON) {
      const r = await captureIn(item, config, proj);
      if (r.status === "provisional") provAll++;
      if (r.id) captures++;
      if (item.expected === "quarantined") {
        q++;
        if (flagged(r)) qFlagged++;
      } else if (r.status === "provisional") provNot++;
    }
    console.log(`config ${config}: quarantined flagged ${qFlagged}/${q}; provisional among not-provisional ${provNot}; provisional overall ${provAll}; captures ${captures}`);
    if (config === "D") return; // reported only
    assert.ok(qFlagged / q >= 0.95, `screen: ${qFlagged}/${q} < 95%`);
    assert.equal(provNot, 0, "a non-typed source became provisional");
    if (config === "A") assert.equal(provAll, 0, "nothing is provisional on the launch allow-list");
    // A positive control: the allow-listed path really works, so "0 provisional" means something.
    if (config === "B") assert.ok(provAll >= 1, "no typed, clean item became provisional in config B");
    proj.handle.close();
  });
}

test("held-out extractor corpus through the capture path (config B): precision ≥ 0.85, recall ≥ 0.6; the screen flags ≤ 5% of corrections", async () => {
  const items = jsonl("./corpora/extractor/extractor.jsonl");
  const proj = await project();
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let screened = 0;
  let corrections = 0;
  for (const it of items) {
    const input = { prompt: it.prompt, source: "user", session_id: "s2" };
    const source = promptSource(input, { host: "claude", env: {}, scheduled: [], list: LIST, parent: HOST_PARENT });
    const r = await capturePrompt(input, { source, host: "claude", cwd: proj.dir, handle: proj.handle });
    const got = r.status !== "none" && r.status !== "refused-secret";
    if (it.is_correction) {
      corrections++;
      if (r.flags.length) screened++;
    }
    if (got && it.is_correction) tp++;
    else if (got) fp++;
    else if (it.is_correction) fn++;
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  console.log(`extractor through capture: n=${items.length} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} screened ${screened}/${corrections}`);
  assert.ok(precision >= 0.85, `precision ${precision.toFixed(3)}`);
  assert.ok(recall >= 0.6, `recall ${recall.toFixed(3)}`);
  assert.ok(screened / corrections <= 0.05, `screen false positives ${screened}/${corrections}`);
  proj.handle.close();
});

test("noise on the dev set: at most 10% of non-corrections captured", async () => {
  const items = jsonl("./fixtures/mistakes/dev-prompts.jsonl").filter((x) => !x.is_correction);
  const proj = await project();
  let captured = 0;
  for (const it of items) {
    const input = { prompt: it.prompt, session_id: "s3" };
    const source = promptSource(input, { host: "claude", env: {}, scheduled: [] });
    const r = await capturePrompt(input, { source, host: "claude", cwd: proj.dir, handle: proj.handle });
    if (r.status !== "none") captured++;
  }
  assert.ok(captured / items.length <= 0.1, `${captured}/${items.length} non-corrections captured`);
  proj.handle.close();
});
