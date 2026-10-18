// P0.4b: SessionStart's memory group puts the project's activeContext.md
// first and whole; the global user.md gets what remains. An activeContext.md
// over budget keeps its Now / Open issues / Rules sections and its newest
// lines, not its oldest head.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitActiveContext } from "../src/session-start.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function world() {
  const root = mkdtempSync(path.join(tmpdir(), "ad-ss-order-"));
  const home = path.join(root, "home");
  const project = path.join(home, "work", "app");
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(path.join(project, ".agent-daemon", "memory"), { recursive: true });
  mkdirSync(path.join(home, ".agent-daemon"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["AD_CODEX_HOME", "AD_ENGINE_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "AD_MEMORY_PROJECT", "AD_ROOT"]) delete env[k];
  return { root, home, project, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sessionStart = (w) => spawnSync(process.execPath, [CLI, "session-start", "--cwd", w.project], { env: w.env, encoding: "utf8", input: "{}" });

test("without QMD, a big global user.md no longer pushes activeContext.md out", () => {
  const w = world();
  try {
    writeFileSync(path.join(w.home, ".agent-daemon", "user.md"), "# User\n\n" + "- a long-standing global preference line\n".repeat(900));
    writeFileSync(path.join(w.project, ".agent-daemon", "memory", "activeContext.md"), "# Active context\n\n## Now\n- NEWEST-FACT-SENTINEL: v3.0.0 released\n");
    const out = sessionStart(w);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /NEWEST-FACT-SENTINEL/, "activeContext.md is injected whole");
    assert.ok(out.stdout.indexOf("NEWEST-FACT-SENTINEL") < (out.stdout.indexOf("long-standing global preference") >>> 0), "project memory comes before user.md");
  } finally {
    w.cleanup();
  }
});

test("fitActiveContext keeps the key sections and the newest lines of an over-budget file", () => {
  const old = Array.from({ length: 300 }, (_, i) => `- old line ${i} ${"x".repeat(40)}`).join("\n");
  const text = `# Active context\nCompacted note.\n\n## Now\n- the current part\n\n## Open issues\n- an open issue\n\n## Rules\n- a rule\n\n## Inbox\n${old}\n- NEWEST appended line\n`;
  const fit = fitActiveContext(text, 3200);
  assert.ok(Buffer.byteLength(fit) <= 3200, `${Buffer.byteLength(fit)} bytes`);
  for (const s of ["# Active context", "## Now", "the current part", "## Open issues", "## Rules", "a rule", "NEWEST appended line", "<!-- older lines: activeContext.md -->"]) assert.ok(fit.includes(s), s);
  assert.ok(!fit.includes("old line 0 "), "the oldest lines go");
  // Within budget: unchanged. Without the headings: unchanged (the group cap cuts its head).
  assert.equal(fitActiveContext("# small\n## Now\n- x\n", 3200), "# small\n## Now\n- x\n");
  const noHeads = "# Active\n" + "- line\n".repeat(1000);
  assert.equal(fitActiveContext(noHeads, 3200), noHeads);
});
