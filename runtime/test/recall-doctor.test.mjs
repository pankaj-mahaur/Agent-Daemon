// L6 P5 (design decision 15): doctor's recall rows.
//   - the token row counts the same brief the hook sends from this folder;
//   - what the host loads itself and other memory are explained, never failures;
//   - doctor writes nothing (the store opened read-only; no job, no marker, no counter).

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-doctor-"));
const AD = path.join(ROOT, "ad-root");
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.AD_ROOT = AD;
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const H = await import("../testkit/recall-hook.mjs");
const { recallChecks } = await import("../src/memory/recall-doctor.mjs");
const { estimateTokens } = await import("../src/memory/recall-render.mjs");
const { writeContext } = await import("../src/memory/recall-context.mjs");

let P;
let keys;
before(async () => {
  if (!H.hasGit) return;
  P = fs.realpathSync.native(H.gitProject(path.join(ROOT, "work", "shop"), "feat/checkout-refunds"));
  writeContext(P, { branch: "feat/checkout-refunds", paths: ["app/services/refunds/bulk_issuer.rb"], commits: ["queue bulk refunds"] }, { root: AD });
  const S = await H.projectStore(P);
  keys = S.keys;
  const at = new Date(Date.now() - 20 * 86_400_000).toISOString();
  S.add({ text: "Bulk refunds go through Refunds::BulkIssuer in BulkRefundJob", created_at: at, accepted_at: at });
  S.add({ text: "Admin dashboards use Chartkick", created_at: at, accepted_at: at });
  S.close();
  fs.writeFileSync(path.join(P, "CLAUDE.md"), "# Shop\n\n<!-- agent-daemon:learnings:start -->\n- use pnpm\n<!-- agent-daemon:learnings:end -->\n");
  fs.mkdirSync(path.join(ROOT, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "claude-mem@thedotmack": true } }));
});

const snap = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      // A WAL store's -shm index is touched by any reader, read-only ones included: not a write.
      else if (!p.endsWith("-shm")) out.push(`${p}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};

test("the token row counts the brief the hook sends; host files and other memory are explained", { skip: !H.hasGit }, async () => {
  const rows = await recallChecks({ cwd: P, home: ROOT, env: process.env, keys });
  const tokensRow = rows.find((r) => r.code === "recall.tokens");
  const m = /≈ ([\d,]+) tokens of your learnings/.exec(tokensRow.note);
  assert.ok(m, tokensRow.note);
  const hook = H.runHook("session.start", H.sessionStart(P, "doc-1"), { host: "claude", project: P });
  const brief = hook.context.split("\n\n---\n\n")[0];
  assert.ok(brief.startsWith("<!-- memory brief -->"));
  assert.equal(Number(m[1].replace(/,/g, "")), estimateTokens(brief));
  assert.match(tokensRow.note, /sent to its model like the rest of the chat/);
  assert.ok(rows.every((r) => r.ok), "information, never a failure");
  assert.ok(rows.some((r) => r.code === "coexist.auto-memory" && /auto memory is on \(default\)/.test(r.note)));
  assert.ok(rows.some((r) => r.code === "coexist.claude-mem" && /claude-mem is on in Claude Code/.test(r.note)));
  assert.ok(rows.some((r) => r.code === "coexist.mirror" && /CLAUDE\.md still holds an agent-daemon:learnings block \(1 line\)/.test(r.note)));
  assert.ok(rows.some((r) => r.code === "recall.host" && /CLAUDE\.md \(\d+ tokens\)/.test(r.note)));
});

test("doctor writes nothing", { skip: !H.hasGit }, async () => {
  const before = snap(ROOT);
  await recallChecks({ cwd: P, home: ROOT, env: process.env, keys });
  assert.equal(snap(ROOT), before);
});

test("a folder that isn't a project: nothing is sent, said plainly", async () => {
  const rows = await recallChecks({ cwd: ROOT, home: ROOT, env: process.env, keys: [] });
  assert.match(rows.find((r) => r.code === "recall.tokens").note, /isn't a project/);
});
