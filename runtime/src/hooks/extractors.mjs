// Rules-based learning extractors.
//
// Pure functions only — no fs, no stdin, no side effects. Easy to test.
// Each rule scans a chunk of text and returns zero or more {type, text,
// evidence_quote, confidence} learnings. The UserPromptSubmit hook composes
// these to capture lessons from the previous assistant turn (and the current
// user prompt — corrections live there).
//
// Design notes:
//   - Patterns are intentionally conservative: high precision over recall.
//     One stray "actually we use" match is fine; ten false positives every
//     turn poisons the memory file.
//   - All captures cap text at 300 chars and trim trailing punctuation.
//   - Each match carries an evidence_quote (≤200 chars) so the SessionStart
//     drain can show context when classifying.
//   - Confidence is fixed per rule. The drain step boosts confidence on
//     duplicates (≥2 matches across sessions → 0.7+).

/**
 * @typedef {Object} ExtractedLearning
 * @property {"correction"|"pattern"|"gotcha"|"decision"|"tool"|"confirmation"} type
 * @property {string} text
 * @property {string} evidence_quote
 * @property {"user"|"agent"} evidence_speaker
 * @property {number} confidence       0..1
 * @property {string[]} tags
 * @property {string} rule_id          which rule fired (for debugging/replay)
 */

/**
 * Single rule definition.
 * @typedef {Object} Rule
 * @property {string} id
 * @property {RegExp} pattern          must define one capturing group for `text` (or use composer)
 * @property {"correction"|"pattern"|"gotcha"|"decision"|"tool"|"confirmation"} type
 * @property {number} confidence       0..1
 * @property {"user"|"agent"} [speakerHint]  default speaker if caller doesn't provide one
 * @property {(match: RegExpExecArray) => string} [composer]  custom text builder
 * @property {(text: string) => string[]} [tagger]
 */

/** @type {Rule[]} */
export const RULES = [
  // --- Corrections (highest signal — almost always the user telling the agent it was wrong)
  {
    id: "correction-actually-we-use",
    pattern: /\bactually,?\s+(?:we|i|it'?s?|the\s+(?:right|correct))\s+(?:use|using|run|prefer|do|don'?t\s+use)\s+([^.\n!?]{4,200})/i,
    type: "correction",
    confidence: 0.75,
    speakerHint: "user"
  },
  {
    id: "correction-no-its",
    pattern: /\bno,?\s+it'?s\s+(?:actually\s+)?([^.\n!?]{4,200})/i,
    type: "correction",
    confidence: 0.6,
    speakerHint: "user"
  },
  {
    id: "correction-not-x-but-y",
    pattern: /\bnot\s+([a-z][a-z0-9._\-]{1,40}),?\s+(?:but|use)\s+([a-z][a-z0-9._\-]{1,40})\b/i,
    type: "correction",
    confidence: 0.65,
    speakerHint: "user",
    // Custom: text is "not X, use Y"
    composer: (match) => `not ${match[1].trim()}, use ${match[2].trim()}`
  },

  // --- Explicit notes / IMPORTANT markers
  {
    id: "note-remember",
    pattern: /\b(?:remember|note|important|fyi):\s*([^.\n!?]{6,300})/i,
    type: "pattern",
    confidence: 0.7
  },
  {
    id: "note-always-never",
    // v0.3.1 — clause-anchored. Require "we" subject (was firing on mid-sentence
    // "...never on typing", "...always at the start" garbage). Bare "always" /
    // "never" no longer match — too noisy. See skills/regex-clause-anchored-extractors/.
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(we\s+(?:always|never))\s+([a-z][^.\n!?]{4,200}?)(?=[.!?]|\n|$)/i,
    type: "pattern",
    confidence: 0.65,
    composer: (m) => `${m[1].toLowerCase()} ${m[2].trim()}`
  },

  // --- Conventions
  {
    id: "convention-the-convention-is",
    // v0.4.1 — clause-anchored. Bare `\b(the convention is|...)` was firing on
    // mid-sentence "...so the convention is..." sub-clauses and capturing
    // garbage tails. Require a clause boundary on the left so the rule only
    // matches statement-shaped sentences.
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:the convention is|by convention|we (?:standardize|standardise) on)\s+([a-z][^.\n!?]{4,250}?)(?=[.!?]|\n|$)/i,
    type: "pattern",
    confidence: 0.7
  },

  // --- Decisions
  {
    id: "decision-decided",
    // v0.4.1 — clause-anchored. "decided" / "going with" / "we chose" mid-
    // narrative ("...having decided X earlier, we then...") produced fragment
    // captures of trailing prose. Require clause boundary.
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:decided|we'?ll go with|we chose|chose to|going with)\s+([a-z][^.\n!?]{4,250}?)(?=[.!?]|\n|$)/i,
    type: "decision",
    confidence: 0.65
  },
  {
    id: "decision-lets-use",
    // v0.3.1 — clause-anchored. "Let's use X" mid-narrative ("...maybe let's use a trie")
    // produced fragment captures. Require clause boundary.
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)let'?s\s+(?:use|go with|stick with|adopt)\s+([a-z][^.\n!?]{2,200}?)(?=[.!?]|\n|$)/i,
    type: "decision",
    confidence: 0.55,
    speakerHint: "user"
  },

  // --- Gotchas / postmortems
  {
    id: "gotcha-the-bug-was",
    // v0.4.1 — clause-anchored. "fixed by" mid-sentence ("...issue mostly fixed
    // by then, but we still saw...") captured "then, but we still saw..." as
    // a fake gotcha. Require clause boundary on the left.
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:the bug was|root cause was|turned out to be|the issue was|fixed by)\s+([a-z][^.\n!?]{6,300}?)(?=[.!?]|\n|$)/i,
    type: "gotcha",
    confidence: 0.7
  },
  {
    id: "gotcha-til",
    pattern: /\b(?:TIL|gotcha|surprise|huh|interesting):\s*([^.\n!?]{6,300})/i,
    type: "gotcha",
    confidence: 0.6
  },
  {
    id: "gotcha-doesnt-work",
    pattern: /\b([a-z][a-z0-9._\-\s]{2,80})\s+(?:doesn'?t work|is broken|fails)\s+(?:because|when|due to)\s+([^.\n!?]{4,200})/i,
    type: "gotcha",
    confidence: 0.55,
    composer: (match) => `${match[1].trim()} fails because ${match[2].trim()}`
  },

  // --- Tools / commands
  {
    id: "tool-the-command-is",
    // v0.4.1 — clause-anchored. "run it with" mid-sentence ("...you'd run it
    // with care here...") captured "care here..." as a fake command. Require
    // clause boundary; capture up to backtick OR clause end.
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:the (?:right|correct) command is|run it with|invoke (?:it )?with)\s+`?([^`.\n]{4,200}?)(?:`|(?=[.!?\n]|$))/i,
    type: "tool",
    confidence: 0.55
  },

  // --- Hinglish / Hindi-Roman rules (v0.5 — WS-6a)
  //
  // All clause-anchored with confidence 0.45 — lower than English because
  // vernacular has higher false-positive risk. Drain step boosts on duplicates.
  // The looksMeaningful() filter still applies, so single-word captures drop.
  //
  {
    id: "correction-galti-hindi",
    // "ye galti mat karna X" / "yeh galti hai X" — user calling out a mistake
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:ye|yeh)\s+galti\s+(?:mat\s+karna|hai)\s+([^.\n!?]{4,200})/i,
    type: "correction",
    confidence: 0.45,
    speakerHint: "user"
  },
  {
    id: "pattern-yaad-rakhna",
    // "yaad rakhna: X" / "yaad rakhiye X" — explicit "remember this"
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)yaad\s+(?:rakhna|rakhiye|rakho)\s*[:,-]?\s*([^.\n!?]{4,250})/i,
    type: "pattern",
    confidence: 0.45
  },
  {
    id: "convention-yun-karna",
    // "isko yun karna X" / "ise aise karte hain X" — convention statement
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:isko|ise|yeh|ye)\s+(?:yun|aise|aisa)\s+(?:karna|karte\s+hain|karte)\s+([^.\n!?]{4,250})/i,
    type: "pattern",
    confidence: 0.45
  },
  {
    id: "decision-decide-kiya",
    // "maine X decide kiya" / "humne X tay kiya" — decision statement
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:maine|humne|hum)\s+([^.\n!?]{4,200})\s+(?:decide|tay)\s+kiya/i,
    type: "decision",
    confidence: 0.45
  },
  {
    id: "gotcha-mistake-thi",
    // "mistake ye thi ki X" / "galti ye thi ki X" — post-mortem gotcha
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:mistake|galti|problem|issue)\s+(?:ye|yeh|yh)\s+(?:thi|tha|hai)\s+(?:ki|that)\s+([^.\n!?]{4,300})/i,
    type: "gotcha",
    confidence: 0.45
  },
  {
    id: "tool-command-chalana",
    // "ye command chalana X" / "yeh command chalao X" — command pointer
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)(?:ye|yeh)\s+command\s+(?:chalana|chalao|run\s+karna)\s+`?([^`.\n]{4,200}?)(?:`|(?=[.!?\n]|$))/i,
    type: "tool",
    confidence: 0.45
  },
  {
    id: "pattern-nahi-karna",
    // "X mat karna" / "X nahi karna" — prohibition pattern (anti-pattern)
    // Captures what came BEFORE the prohibition (the action not to do).
    pattern: /(?:^|[.!?,;:—–-]\s+|\n\s*)([^.\n!?]{4,200})\s+(?:mat|nahi)\s+karna/i,
    type: "gotcha",
    confidence: 0.45,
    composer: (match) => `don't ${match[1].trim()}`
  }
];

/**
 * Run all rules against a text chunk.
 *
 * @param {string} text                Text to scan (any source — assistant turn, user prompt, tool output)
 * @param {Object} [meta]
 * @param {"user"|"agent"} [meta.speaker]   Defaults to "user"
 * @param {number} [meta.maxLearnings]      Soft cap. Default 6 per call.
 * @returns {ExtractedLearning[]}
 */
export function extractFromText(text, meta = {}) {
  if (!text || typeof text !== "string") return [];
  const speaker = meta.speaker || "user";
  const cap = meta.maxLearnings ?? 6;

  const out = [];
  const seen = new Set();   // dedupe within this call by `rule_id + text-prefix`

  // Slice big inputs — extractors operate on a window
  const window = text.length > 16_000 ? text.slice(-16_000) : text;

  for (const rule of RULES) {
    if (out.length >= cap) break;
    // Use exec in a loop to capture multiple non-overlapping hits per rule
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    let m;
    let safety = 0;
    while ((m = re.exec(window)) !== null && safety < 8) {
      safety++;
      const composed = rule.composer ? rule.composer(m) : (m[1] || "");
      const cleanText = sanitize(composed);
      if (!cleanText) continue;
      const dedupeKey = `${rule.id}:${cleanText.slice(0, 60).toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const evidence = extractContext(window, m.index, m[0].length);
      out.push({
        type: rule.type,
        text: cleanText,
        evidence_quote: evidence,
        evidence_speaker: rule.speakerHint || speaker,
        confidence: rule.confidence,
        tags: tagsFor(cleanText),
        rule_id: rule.id
      });
      if (out.length >= cap) break;
    }
  }

  return out;
}

function sanitize(s) {
  if (!s) return "";
  let t = String(s).trim();
  // Trim quote marks, backticks, trailing punctuation
  t = t.replace(/^["'`*_]+|["'`*_]+$/g, "").trim();
  t = t.replace(/[.,;:!?]+$/, "").trim();
  if (t.length < 4) return "";
  if (t.length > 300) t = t.slice(0, 297) + "...";
  if (!looksMeaningful(t)) return "";
  return t;
}

// Reject fragment captures that start with a preposition / conjunction or are
// a single word. These produced the "for sidebar history" / "on typing" /
// "appears" garbage we saw in real-world v0.3 runs.
//
// NOTE: do NOT include articles (the/a/an) or pronouns (it/this/these/their/
// there/here) — those are legitimate sentence starts ("the build script lives
// in scripts/build.sh", "a missing await caused the bug"). The filter targets
// the specific class of FRAGMENT-led captures from mid-sentence regex matches.
const FRAGMENT_LEADERS = new Set([
  // prepositions
  // NOTE: "to" is intentionally NOT in this list — "decided to drop X",
  // "chose to use Y", "we'll go with to-foo" are legitimate clause-shapes
  // where the captured tail naturally starts with "to". Filtering "to" here
  // breaks real captures from clause-anchored rules.
  "for", "in", "on", "at", "of", "from", "with", "by", "as", "into",
  "onto", "out", "off", "over", "under",
  // conjunctions
  "than", "then", "but", "and", "or",
  // subordinators
  "because", "since", "though", "when", "while", "where", "if", "else"
]);

function looksMeaningful(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // Single-word captures (e.g. "appears") are almost always fragments.
  if (words.length === 1) return false;
  // Capture begins with a preposition / conjunction → almost always a fragment.
  if (FRAGMENT_LEADERS.has(words[0])) return false;
  return true;
}

function extractContext(text, idx, matchLen, before = 60, after = 100) {
  const start = Math.max(0, idx - before);
  const end = Math.min(text.length, idx + matchLen + after);
  let ctx = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (ctx.length > 200) ctx = ctx.slice(0, 197) + "...";
  return ctx;
}

const TAG_KEYWORDS = [
  // Tooling
  "npm", "pnpm", "yarn", "bun", "git", "docker", "make", "cmake",
  // Languages/frameworks
  "typescript", "javascript", "python", "rust", "go", "node", "react", "next",
  "vue", "svelte", "fastify", "express", "django", "flask",
  // DBs
  "postgres", "sqlite", "mysql", "redis", "mongo",
  // Workflow
  "test", "lint", "build", "deploy", "ci", "merge", "rebase", "commit", "branch"
];

function tagsFor(text) {
  const lower = text.toLowerCase();
  const tags = [];
  for (const k of TAG_KEYWORDS) {
    if (tags.length >= 5) break;
    if (lower.includes(k)) tags.push(k);
  }
  return tags;
}
