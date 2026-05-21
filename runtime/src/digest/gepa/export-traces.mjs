// Export skill execution traces to JSONL for inline GEPA mode.
//
// Inline GEPA (no-API path): the active Claude Code session does the
// reflection + variant generation itself. It needs the traces in a
// readable format — this module exports them as one JSON line per
// execution, written to <cwd>/.agent-daemon/skill-traces/<skill>.jsonl.
//
// One file per skill name; truncated and rewritten on each export.
//
// Pairs with the `gepa-evolve-inline` skill at skills/daemon/gepa-evolve-inline/.

import fs from "node:fs/promises";
import path from "node:path";
import { sampleSkillExecutions } from "../../memory/episodic.mjs";

/**
 * Export skill execution traces to a JSONL file the active Claude session
 * can read.
 *
 * @param {{ skillName: string, cwd: string, total?: number, verbose?: boolean }} opts
 * @returns {Promise<{ ok: boolean, path?: string, count?: number, error?: string }>}
 */
export async function exportSkillTraces(opts) {
  const { skillName, cwd, total = 50, verbose = false } = opts;

  if (!skillName) return { ok: false, error: "skillName required" };
  if (!cwd)       return { ok: false, error: "cwd required" };

  let traces;
  try {
    traces = await sampleSkillExecutions({ skillName, total });
  } catch (err) {
    return { ok: false, error: `episodic DB read failed: ${err.message}` };
  }

  if (!traces || traces.length === 0) {
    return { ok: false, error: `no execution traces for skill "${skillName}" in episodic DB` };
  }

  const outDir  = path.join(cwd, ".agent-daemon", "skill-traces");
  const outPath = path.join(outDir, `${skillName}.jsonl`);

  try {
    await fs.mkdir(outDir, { recursive: true });
    const lines = traces.map(t => JSON.stringify({
      id:             t.id,
      session_id:     t.session_id,
      skill_name:     t.skill_name,
      succeeded:      t.succeeded === 1 ? true : (t.succeeded === 0 ? false : null),
      failure_reason: t.failure_reason,
      trigger_text:   t.trigger_text,
      created_at:     t.created_at
    }));
    await fs.writeFile(outPath, lines.join("\n") + "\n", "utf8");
  } catch (err) {
    return { ok: false, error: `write failed: ${err.message}` };
  }

  if (verbose) {
    const passed  = traces.filter(t => t.succeeded === 1).length;
    const failed  = traces.filter(t => t.succeeded === 0).length;
    console.error(`agent-daemon: exported ${traces.length} traces for "${skillName}" (${passed} succeeded, ${failed} failed) → ${outPath}`);
  }

  return { ok: true, path: outPath, count: traces.length };
}
