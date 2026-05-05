// GEPA Stage 2 — reflect on success/failure traces.
//
// Calls headless `claude` with the parent skill body + sampled traces and
// asks: which failure modes are recurring? what made successes succeed?
// Returns a structured reflection used to guide variant generation.

/**
 * @typedef {Object} FailureMode
 * @property {string} title         - short label
 * @property {string} description   - what went wrong
 * @property {string[]} evidence    - trace IDs supporting this mode
 * @property {string} fix_direction - the proposed direction (high level)
 *
 * @typedef {Object} SuccessPattern
 * @property {string} pattern
 * @property {string[]} evidence
 *
 * @typedef {Object} Reflections
 * @property {FailureMode[]} failureModes
 * @property {SuccessPattern[]} successPatterns
 * @property {string} summary       - one paragraph synthesis
 */

/**
 * The prompt template used for reflection. Inlined here so it ships with the
 * runtime; can be overridden via env var AGENT_DAEMON_REFLECT_PROMPT_PATH.
 */
const REFLECT_PROMPT = `You are reviewing how an AI coding agent used the skill "{{skillName}}" across a set of past sessions.

Your task is REFLECTIVE — identify why some uses succeeded and others failed, then produce structured feedback that will guide an evolutionary improvement of the skill.

Output strict JSON of shape:
{
  "failureModes": [
    {
      "title": "short label",
      "description": "what went wrong, in 1-2 sentences",
      "evidence": ["trace-id-1", "trace-id-2"],
      "fix_direction": "what the skill should do differently — high level, not exact wording"
    }
  ],
  "successPatterns": [
    { "pattern": "...", "evidence": ["trace-id-3"] }
  ],
  "summary": "one paragraph summarizing the chief drivers of variance in outcomes"
}

Be ruthless about category collapse: if two traces failed for the same reason, write ONE failure mode with both as evidence.

Be specific: avoid generic advice ("be more careful"). Name the missing instruction or the misleading phrasing.

Do NOT propose new skill text — that's the next stage's job. You produce the diagnosis only.`;

/**
 * @param {{
 *   skillName: string,
 *   parentBody: string,
 *   traces: import("./sample.mjs").SkillTrace[],
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<Reflections>}
 */
export async function reflectOnTraces(opts) {
  // v0.1 stub: returns an empty reflection. The prompt + invocation are wired
  // in v0.2 (shells out to `claude --print --output-format json`).
  //
  // v0.2 implementation:
  //
  //   const prompt = REFLECT_PROMPT.replace("{{skillName}}", opts.skillName);
  //   const userMessage = renderTracesForReflection(opts.parentBody, opts.traces);
  //   const json = await callClaudeHeadless({
  //     systemPromptAddition: prompt,
  //     userMessage,
  //     outputFormat: "json"
  //   });
  //   return JSON.parse(json.result);

  return {
    failureModes: [],
    successPatterns: [],
    summary: "v0.1 stub — reflection LLM call lands in v0.2"
  };
}

export { REFLECT_PROMPT };
