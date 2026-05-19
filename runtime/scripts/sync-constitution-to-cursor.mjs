#!/usr/bin/env node
// Mirror constitution/*.md → adapters/cursor/.cursor/rules/*.mdc
//
// Cursor reads `.mdc` files from `.cursor/rules/` and injects their content
// into the agent's context based on the frontmatter (`alwaysApply`, `globs`,
// `description`). We mirror our constitution so Cursor users get the same
// behavioral floor as Claude Code users — without hand-maintaining a parallel
// copy.
//
// Idempotent — regenerates every file on each run. Run via:
//   node runtime/scripts/sync-constitution-to-cursor.mjs
//   npm run sync:constitution
//
// If you edit constitution/*.md, re-run this script before committing so the
// mirror doesn't drift.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "constitution");
const DST_DIR = path.join(REPO_ROOT, "adapters", "cursor", ".cursor", "rules");

// Per-file mirror config. The `name` matches the source filename minus `.md`.
// `alwaysApply: true` = Cursor loads this into every chat in the project.
// `globs` = scope the rule to matching files only. Omit for repo-wide rules.
// Skip `README.md` — it's project documentation, not a behavioral rule.
const MIRRORS = [
  {
    name: "core",
    out: "agent-daemon-core.mdc",
    description: "Cardinal rules every agent loads at session start (the daemon's constitution/core.md).",
    alwaysApply: true,
  },
  {
    name: "karpathy-guidelines",
    out: "karpathy-guidelines.mdc",
    description: "Karpathy's observations on common LLM coding pitfalls. Loaded every session.",
    alwaysApply: true,
  },
  {
    name: "safety",
    out: "agent-daemon-safety.mdc",
    description: "Hard limits on destructive actions, secret handling, and shipping confidence (constitution/safety.md).",
    alwaysApply: true,
  },
  {
    name: "verification",
    out: "agent-daemon-verification.mdc",
    description: "What 'done' means — re-run the failing flow, run CI gates locally, watch the access log (constitution/verification.md).",
    alwaysApply: true,
  },
  {
    name: "communication",
    out: "agent-daemon-communication.mdc",
    description: "How to write user-facing text and handoff messages (constitution/communication.md).",
    alwaysApply: true,
  },
  {
    name: "ending-protocol",
    out: "agent-daemon-ending-protocol.mdc",
    description: "Three-action session-close protocol — session-log + digest block + handoff (constitution/ending-protocol.md).",
    alwaysApply: true,
  },
];

const HEADER_BANNER = "<!-- AUTO-GENERATED — DO NOT EDIT. Source: constitution/<name>.md. Regenerate: npm run sync:constitution -->";

function buildMdc({ description, alwaysApply, globs }, sourceName, body) {
  // Build YAML-ish frontmatter. Cursor accepts `description`, `globs`,
  // `alwaysApply`. Quote description if it contains a colon.
  const lines = ["---"];
  if (description) {
    const needsQuote = /:/.test(description);
    lines.push(`description: ${needsQuote ? JSON.stringify(description) : description}`);
  }
  if (globs) lines.push(`globs: ${JSON.stringify(globs)}`);
  if (alwaysApply !== undefined) lines.push(`alwaysApply: ${alwaysApply}`);
  lines.push(`source: constitution/${sourceName}.md`);
  lines.push("---");
  lines.push("");
  lines.push(HEADER_BANNER);
  lines.push("");
  lines.push(body.trim());
  lines.push("");
  return lines.join("\n");
}

async function main() {
  await fs.mkdir(DST_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;

  for (const cfg of MIRRORS) {
    const srcPath = path.join(SRC_DIR, `${cfg.name}.md`);
    let srcBody;
    try {
      srcBody = await fs.readFile(srcPath, "utf8");
    } catch {
      console.log(`  -  ${cfg.name}.md (source missing, skipped)`);
      skipped++;
      continue;
    }
    const mdc = buildMdc(cfg, cfg.name, srcBody);
    const dstPath = path.join(DST_DIR, cfg.out);
    await fs.writeFile(dstPath, mdc, "utf8");
    console.log(`  ✓  ${cfg.out}`);
    written++;
  }

  console.log(`\nWrote ${written} .mdc file(s) to ${path.relative(REPO_ROOT, DST_DIR)}/ (${skipped} skipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
