// L6 (design decision 13): `config recall on|off` per project, the review token both
// ways (02 §7: no model-callable path stops recall of an accepted note; the agent can't
// undo the user's off either), and the hooks honour it.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-mode-"));
const AD = path.join(ROOT, "ad-root");
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.AD_ROOT = AD;
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];
after(async () => {
  // A context job the hooks started may still run git in a project folder, and a store
  // may be open: both block the delete on Windows (EBUSY). Wait for them, then delete.
  (await import("../src/memory/episodic.mjs")).closeDb();
  assert.ok(await waitForRecallJobs(AD), "the context jobs ended");
  assert.deepEqual(cwdsUnder(ROOT), [], "no process works inside the temp folder");
  assert.deepEqual(await openFilesUnder(ROOT), [], "no file under the temp folder is still open");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const H = await import("../testkit/recall-hook.mjs");
const { waitForRecallJobs, cwdsUnder } = await import("../testkit/recall-jobs.mjs");
const { openFilesUnder } = await import("../testkit/open-files.mjs");

const { memoryVerbMain } = await import("../src/memory/memory-cli.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");
const { recallMode } = await import("../src/memory/recall-mode.mjs");
const ep = await import("../src/memory/episodic.mjs");

let P;
before(async () => {
  if (!H.hasGit) return;
  P = fs.realpathSync.native(H.gitProject(path.join(ROOT, "work", "app"), "feat/refunds"));
  // A fresh repo context: these tests need no context job.
  (await import("../src/memory/recall-context.mjs")).writeContext(P, { branch: "feat/refunds", paths: ["app/refunds/bulk_issuer.rb"], commits: ["bulk refunds"] }, { root: AD });
  const S = await H.projectStore(P);
  S.add({ text: "refunds go through the BulkIssuer job", created_at: new Date().toISOString(), accepted_at: new Date().toISOString() });
  S.close();
});

async function config(args, token) {
  const lines = [];
  const handle = await ep.db();
  const code = await memoryVerbMain("config", args, { out: (l) => lines.push(l), cwd: P, handle, token: async () => (token ? { token } : { refused: "not your own terminal" }) });
  return { code, text: lines.join("\n"), handle };
}

test("without the token recall can't be turned off, nor back on", { skip: !H.hasGit }, async () => {
  const off = await config(["recall", "off"], null);
  assert.equal(off.code, 2);
  assert.match(off.text, /recall stays as it is/);
  const { projectIdOf } = await import("../src/memory/projects.mjs");
  assert.equal(recallMode(off.handle, projectIdOf(P)), "on");
  const turnedOff = await config(["recall", "off"], testReviewToken());
  assert.equal(turnedOff.code, 0);
  assert.match(turnedOff.text, /Recall is off in this project/);
  const on = await config(["recall", "on"], null);
  assert.equal(on.code, 2, "the agent can't undo the user's off");
  assert.equal(recallMode(on.handle, projectIdOf(P)), "off");
  ep.closeDb();
});

test("off: the hooks send nothing; on again: the brief is back", { skip: !H.hasGit }, async () => {
  const offStart = H.runHook("session.start", H.sessionStart(P, "m-1"), { host: "claude", project: P });
  assert.ok(!offStart.context.includes("<!-- memory brief -->"));
  const offPrompt = H.runHook("prompt.submit", { session_id: "m-1", cwd: P, hook_event_name: "UserPromptSubmit", prompt: "how do refunds go through the BulkIssuer job" }, { host: "claude", project: P });
  assert.ok(!offPrompt.context.includes("learnings that may help"));
  const on = await config(["recall", "on"], testReviewToken());
  assert.equal(on.code, 0);
  ep.closeDb();
  const onStart = H.runHook("session.start", H.sessionStart(P, "m-2"), { host: "claude", project: P });
  assert.ok(onStart.context.includes("<!-- memory brief -->"));
});

test("ad's own CLI routes config recall", { skip: !H.hasGit }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "config", "recall"], { cwd: P, env: { ...process.env }, encoding: "utf8", input: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Recall is (on|off) in this project/);
});
