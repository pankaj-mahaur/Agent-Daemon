// Session-start command.
// Reads constitution + project memory and emits a JSON object Claude Code's
// SessionStart hook injects as additional context.
//
// Output schema (when --output-json):
//   { "additionalContext": "<markdown string>" }
//
// Total length is capped at 9KB to stay under Claude Code's 10K hook output cap.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT_BYTES = 9000;

/**
 * @param {{
 *   cwd: string,
 *   outputJson?: boolean,
 *   verbose?: boolean,
 *   projectRoot: string,
 * }} opts
 */
export async function runSessionStart(opts) {
  const sections = [];

  // 1. Constitution (always loaded)
  const constitutionDir = path.join(opts.projectRoot, "constitution");
  const constitutionFiles = ["core.md", "safety.md", "verification.md", "communication.md"];
  for (const f of constitutionFiles) {
    const text = await tryRead(path.join(constitutionDir, f));
    if (text) {
      sections.push(`<!-- constitution/${f} -->\n${text}`);
    }
  }

  // 2. Cross-project user profile (Honcho-style — applies everywhere)
  const userMd = await tryRead(path.join(homeDir(), ".agent-daemon", "user.md"));
  if (userMd) {
    sections.push(`<!-- ~/.agent-daemon/user.md (cross-project user profile) -->\n${userMd}`);
  }

  // 3. Project memory — try several conventional locations
  const memoryLocations = [
    path.join(opts.cwd, ".agent-daemon", "memory"),
    path.join(opts.cwd, ".claude", "memory"),
    path.join(homeDir(), ".claude", "projects", encodeProjectPath(opts.cwd), "memory"),
    path.join(homeDir(), ".agent-daemon", "memory")
  ];

  for (const memDir of memoryLocations) {
    const block = await readMemoryDir(memDir);
    if (block) {
      sections.push(`<!-- memory: ${memDir} -->\n${block}`);
      break;  // first one wins; later locations are fallbacks
    }
  }

  // 4. Project CLAUDE.md / AGENTS.md (per-project rules supersede constitution)
  for (const fname of ["CLAUDE.md", "AGENTS.md"]) {
    const text = await tryRead(path.join(opts.cwd, fname));
    if (text) {
      sections.push(`<!-- ${fname} -->\n${text}`);
    }
  }

  // Concatenate, truncate if needed
  let combined = sections.join("\n\n---\n\n");
  if (Buffer.byteLength(combined, "utf8") > MAX_OUTPUT_BYTES) {
    combined = truncateToBytes(combined, MAX_OUTPUT_BYTES);
    combined += "\n\n<!-- (agent-daemon: context truncated to fit 9KB hook cap) -->";
  }

  if (opts.outputJson) {
    process.stdout.write(JSON.stringify({ additionalContext: combined }));
  } else {
    process.stdout.write(combined);
    process.stdout.write("\n");
  }

  if (opts.verbose) {
    process.stderr.write(`agent-daemon: loaded ${sections.length} context sections (${Buffer.byteLength(combined, "utf8")} bytes)\n`);
  }

  return 0;
}

async function tryRead(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readMemoryDir(memDir) {
  try {
    const entries = await fs.readdir(memDir);
    const mdFiles = entries.filter(e => e.endsWith(".md") && !e.endsWith(".template"));
    if (mdFiles.length === 0) return null;

    // Prefer index file first if it exists, then the rest
    const ordered = [
      ...mdFiles.filter(f => /^MEMORY\.md$/i.test(f)),
      ...mdFiles.filter(f => !/^MEMORY\.md$/i.test(f))
    ];
    const blocks = [];
    for (const f of ordered) {
      const text = await tryRead(path.join(memDir, f));
      if (text) blocks.push(`### ${f}\n\n${text}`);
    }
    return blocks.join("\n\n");
  } catch {
    return null;
  }
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function encodeProjectPath(p) {
  // Claude Code's encoding: replace `/` and `\` and `:` with `-`.
  // Approximate; real algorithm may differ slightly.
  return p.replace(/[\\/:]/g, "-");
}

function truncateToBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Find a UTF-8-safe break at maxBytes.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}
