// Replay (plan L4c): what a rule would have done on the user's own history.
// "4 of your top 10 repeats could become rules; replayed on your history,
// they would have asked before 37 commands." Pure: the calls come from the
// history reader, the project root of each call from the caller.

import { deriveRule } from "./derive.mjs";
import { matchRule } from "./match.mjs";

/**
 * The rule a group of corrections asks for: the first wording, most frequent
 * first, that derives to a rule.
 * @param {string[]} sentences  the cluster's sentences (unredacted)
 */
export function ruleForSentences(sentences) {
  const counts = new Map();
  for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([s]) => s);
  for (const s of ordered) {
    const r = deriveRule(s);
    if (r.type === "command" || r.type === "write") return r;
  }
  return null;
}

/**
 * How many of these calls the rule would have asked before.
 * @param {object} rule
 * @param {{tool:string, input:object, os:string, cwd:string|null}[]} calls
 * @param {{rootOf?:(cwd:string|null)=>string|null}} [opts]
 */
export function replayRule(rule, calls, opts = {}) {
  return replayMatches(rule, calls, opts).size;
}

/** The indexes of the calls the rule would have asked before (for totals without double counting). */
export function replayMatches(rule, calls, { rootOf = (cwd) => cwd } = {}) {
  const hits = new Set();
  calls.forEach((c, i) => {
    const root = rootOf(c.cwd);
    if (matchRule(rule, { tool: c.tool, input: c.input, os: c.os, cwd: c.cwd ?? root, project_root: root ?? c.cwd }).match) hits.add(i);
  });
  return hits;
}
