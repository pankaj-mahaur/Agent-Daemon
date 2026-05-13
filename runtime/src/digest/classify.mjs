// Digest pipeline — Stage 3: classify each learning into a target store.
//
// Pure rules-based routing — no LLM call. Cheap and predictable.
//
// Targets:
//   - "memory:project"     → append to project's activeContext.md (low risk, auto-apply)
//   - "memory:global"      → append to ~/.agent-daemon/user.md (low risk, auto-apply)
//   - "skill-edit"         → propose a SKILL.md edit (high risk, queue for review)
//   - "constitution-add"   → propose a constitution rule addition (high risk, queue)
//   - "episodic-only"      → just store as an episodic SQLite row (default — always)

/**
 * @typedef {import("./extract.mjs").Learning} Learning
 *
 * @typedef {Object} ClassifiedLearning
 * @property {Learning} learning
 * @property {string[]} targets         - one or more of the target names above
 * @property {string} routeReason       - human-readable rationale
 */

/**
 * Apply rules to decide where each learning lands.
 *
 * Rule order (a learning may match multiple → all targets fire):
 *
 *   1. ALWAYS write to episodic-only (every learning becomes a SQLite row).
 *
 *   2. type='correction' AND scope='global' AND confidence ≥ 0.85
 *      → constitution-add (queue) IF it sounds like a universal rule
 *      → otherwise memory:global
 *
 *   3. type='correction' AND scope='project'
 *      → memory:project
 *
 *   4. type='confirmation' / 'pattern' AND scope='project'
 *      → memory:project
 *
 *   5. type='pattern' AND tags reference a known skill name
 *      → skill-edit (queue)
 *
 *   6. type='tool' AND scope='global'
 *      → memory:global
 *
 *   7. type='tool' AND scope='project'
 *      → memory:project
 *
 * Confidence below 0.5 → episodic-only (don't pollute durable memory).
 *
 * @param {Learning[]} learnings
 * @param {{availableSkills?: string[]}} [opts]
 * @returns {ClassifiedLearning[]}
 */
export function classify(learnings, opts = {}) {
  const skills = new Set(opts.availableSkills || []);
  return learnings.map(learning => classifyOne(learning, skills));
}

function classifyOne(learning, skills) {
  const targets = ["episodic-only"];  // always
  const reasons = [];

  if (learning.confidence < 0.5) {
    reasons.push(`low confidence (${learning.confidence.toFixed(2)}) — episodic only`);
    return { learning, targets, routeReason: reasons.join("; ") };
  }

  // Pattern referencing a skill name → skill-edit proposal
  if (learning.type === "pattern" && learning.tags) {
    const matchingSkill = learning.tags.find(t => skills.has(t.replace(/^skill:/, "")));
    if (matchingSkill) {
      targets.push("skill-edit");
      reasons.push(`pattern tagged with skill "${matchingSkill}" → propose SKILL.md edit`);
    }
  }

  // Universal-sounding correction → maybe constitution
  if (learning.type === "correction" && learning.scope === "global" && learning.confidence >= 0.85) {
    if (looksLikeConstitutionRule(learning.text)) {
      targets.push("constitution-add");
      reasons.push(`global high-confidence correction with rule-shaped text → queue constitution addition`);
    } else {
      targets.push("memory:global");
      reasons.push(`global correction → user.md`);
    }
  }

  // Project-scoped corrections / confirmations / patterns → project memory
  if (learning.scope === "project" && (learning.type === "correction" || learning.type === "confirmation" || learning.type === "pattern")) {
    targets.push("memory:project");
    reasons.push(`${learning.type} (project scope) → activeContext.md`);
  }

  // Gotchas behave like corrections — durable lesson about what went wrong.
  // Decisions behave like patterns — durable choice the team made.
  if (learning.scope === "project" && (learning.type === "gotcha" || learning.type === "decision")) {
    targets.push("memory:project");
    reasons.push(`${learning.type} (project scope) → activeContext.md`);
  }

  // Tools
  if (learning.type === "tool") {
    if (learning.scope === "global") {
      targets.push("memory:global");
      reasons.push(`global tool tip → user.md`);
    } else {
      targets.push("memory:project");
      reasons.push(`project tool tip → techContext.md / activeContext.md`);
    }
  }

  return { learning, targets, routeReason: reasons.join("; ") };
}

/**
 * Heuristic: does the text read like a universal "always X" / "never Y" rule?
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeConstitutionRule(text) {
  const lower = text.toLowerCase();
  return (
    /\b(always|never|don'?t|do not|must|must not|shall not|should always|should never)\b/.test(lower) &&
    text.length < 300  // short, rule-shaped
  );
}
