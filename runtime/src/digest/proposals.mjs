// Proposals and memory-file appends, shared by the digest (apply.mjs), the
// memory server's record tools (memory/capture.mjs) and ad review (P5.2).
//
//   writeProposal(...)          a skill-lesson (v1, skills/proposal.mjs), constitution-add or quarantined-learning proposal
//   writeMemoryProposal(...)    a memory-add or memory-promote proposal for one learning
//   readProposalMeta(content)   the machine line of a memory proposal, or null
//   appendToMemory(...)         append learnings to a memory markdown file, deduplicated

import fs from "node:fs/promises";
import path from "node:path";
import { neutralizeText } from "./sanitize.mjs";
import { isSkillName, renderSkillProposal } from "../skills/proposal.mjs";

// The first line of a memory proposal: what ad review acts on. Only the first
// line counts, so text quoted further down can't pose as one.
const META_RE = /^<!-- agent-daemon:proposal (\{[^\n]*\}) -->\r?(?:\n|$)/;
export const MEMORY_KINDS = Object.freeze(["memory-add", "memory-promote", "memory-reword"]);

/** {kind, learning} from a memory proposal's first line, or null. */
export function readProposalMeta(content) {
  const m = META_RE.exec(String(content ?? ""));
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    if (!MEMORY_KINDS.includes(meta?.kind) || !Number.isInteger(meta?.learning) || meta.learning < 1) return null;
    return { kind: meta.kind, learning: meta.learning };
  } catch {
    return null;
  }
}

/**
 * A memory-add (accept the note into this project) or memory-promote (make it a
 * cross-project note) proposal for learning `learningId`.
 * @returns {Promise<string>} the file written
 */
export async function writeMemoryProposal({ kind, learningId, text, evidence, origin = "the agent", proposedDir, stamp = new Date().toISOString() }) {
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`not a memory proposal kind: ${kind}`);
  // memory-promote sorts after memory-add for the same note.
  const filename = `${kind}-${String(learningId).padStart(6, "0")}-${stamp.replace(/[:.]/g, "-")}.md`;
  const action = {
    "memory-add": "Accept to let this note reach your sessions in this project; reject to drop it.",
    "memory-promote": "Accept to make this note apply in every project; reject to keep it in this project only.",
    "memory-reword": "This lesson was shown and the same correction still came back twice. Accept to rewrite it in your words (your editor opens); reject to keep it as it is.",
  }[kind];
  const content = [
    `<!-- agent-daemon:proposal ${JSON.stringify({ kind, learning: learningId })} -->`,
    `# Proposal — ${kind}`,
    "",
    `_Recorded by ${origin} on ${stamp}. Learning #${learningId}._`,
    "",
    "## Note",
    "",
    neutralizeText(text),
    "",
    ...(evidence ? ["## Evidence", "", `> ${neutralizeText(evidence).replace(/\s+/g, " ").trim()}`, ""] : []),
    "## Action",
    "",
    action,
    "",
  ].join("\n");
  await fs.mkdir(proposedDir, { recursive: true });
  const filePath = path.join(proposedDir, filename);
  await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  return filePath;
}

export async function writeProposal({ item, proposedDir, sessionId, stamp, dryRun, kindOverride, quarantineReasons }) {
  const safeStamp = stamp.replace(/[:.]/g, "-");
  // A lesson for a skill (the classifier's skill-edit route) is a skill-lesson in the
  // v1 format (skills/proposal.mjs), which ad review applies after showing the diff.
  const kind = kindOverride || (item.targets.includes("skill-edit") ? "skill-lesson" : "constitution-add");
  const slug = (item.learning.tags?.[0] || item.learning.type).replace(/[^a-z0-9-]/gi, "-").slice(0, 32);
  const filename = `${kind}-${slug}-${safeStamp}.md`;
  const filePath = path.join(proposedDir, filename);

  const content = kind === "skill-lesson" ? renderSkillLesson(item, sessionId, stamp) : renderProposalMd(item, sessionId, kind, quarantineReasons);

  if (!dryRun) {
    await fs.mkdir(proposedDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  return filePath;
}

function renderSkillLesson(item, sessionId, stamp) {
  const l = item.learning;
  // The skill the classifier matched (classify.mjs); else review asks which one.
  const skill = isSkillName(item.skill) ? item.skill : undefined;
  const why = [
    `Evidence: > ${neutralizeText(l.evidence_quote || "").replace(/\s+/g, " ").trim()}`,
    "",
    `_(${l.evidence_speaker}, confidence ${l.confidence.toFixed(2)}; ${item.routeReason})_`,
  ].join("\n");
  return renderSkillProposal({ kind: "skill-lesson", skill, body: neutralizeText(l.text).replace(/\s+/g, " ").trim(), origin: "digest", run: sessionId || undefined, created: stamp, why });
}

function renderProposalMd(item, sessionId, kind, quarantineReasons) {
  const l = item.learning;
  // Proposals quote transcript-derived text — neutralize so a quarantined
  // injection can't fire from the proposal file itself.
  const safeText = neutralizeText(l.text);
  const safeEvidence = neutralizeText(l.evidence_quote || "");
  const actionByKind = {
    "skill-edit": "Review, then either:\n- Apply the suggested change to the relevant `skills/<name>/SKILL.md`, OR\n- Reject by deleting this file.",
    "constitution-add": "Review, then either:\n- Promote to a constitution rule by editing `constitution/core.md`, OR\n- Reject by deleting this file.",
    "quarantined-learning": "This learning matched injection-screen patterns and was NOT written to memory.\nReview, then either:\n- Confirm it is benign and manually add it to the right memory file, OR\n- Reject by deleting this file."
  };
  const lines = [
    `# Proposal — ${kind}`,
    "",
    `_Generated: ${new Date().toISOString()}_  ${sessionId ? `· _Source session: ${sessionId}_` : ""}`,
    "",
    ...(quarantineReasons && quarantineReasons.length > 0
      ? ["## Quarantine reasons", "", ...quarantineReasons.map(r => `- ${r}`), ""]
      : []),
    "## Summary",
    "",
    safeText,
    "",
    "## Evidence",
    "",
    `> ${safeEvidence}`,
    "",
    `_(${l.evidence_speaker}, confidence ${l.confidence.toFixed(2)})_`,
    "",
    "## Routing",
    "",
    `- **Targets:** ${item.targets.join(", ")}`,
    `- **Reason:** ${item.routeReason}`,
    `- **Tags:** ${(l.tags || []).join(", ") || "(none)"}`,
    "",
    "## Action",
    "",
    actionByKind[kind] || actionByKind["constitution-add"],
    ""
  ];
  return lines.join("\n");
}

export async function appendToMemory(memPath, items, sessionId, stamp) {
  await fs.mkdir(path.dirname(memPath), { recursive: true });

  // Read existing content (if any) — used both to seed a fresh file AND to
  // dedup against entries already present from previous sessions. Without
  // this, real-world dogfood runs accumulate the same "pattern: X" /
  // "decision: Y" line 4-5 times across a week's sessions because SQLite's
  // content-hash uniqueness only gates the episodic store, not this markdown.
  let existing = "";
  try {
    existing = await fs.readFile(memPath, "utf8");
  } catch { /* file doesn't exist yet */ }

  const initial = existing
    ? ""
    : `# Memory\n\n_Auto-managed by agent-daemon. Hand-edits welcome._\n\n`;

  // Build the set of (type, text-prefix) tuples already in the file. The
  // markdown shape we append is `- **<type>** (conf X.XX): <text>` so we
  // match on that prefix to extract previously-written learnings. Match by
  // first ~80 chars of text (case-insensitive, whitespace-collapsed) so
  // near-identical drift ("X is the cause" vs "X is the cause.") still
  // dedupes.
  const seen = collectSeenLearnings(existing);
  const fresh = items.filter((it) => {
    const key = makeDedupKey(it.learning.type, it.learning.text);
    if (seen.has(key)) return false;
    seen.add(key);  // also dedup within the batch in case classify produced near-dupes
    return true;
  });

  if (fresh.length === 0 && !initial) return;  // nothing new, nothing to seed

  const block = fresh.length > 0
    ? renderMemoryBlock(fresh, sessionId, stamp)
    : "";
  await fs.appendFile(memPath, initial + block, "utf8");
}

/**
 * Walk an existing memory markdown file and return the set of dedup keys
 * for learnings already recorded. Format we recognise:
 *   - **<type>** (conf 0.NN): <text...>
 *
 * @param {string} content
 * @returns {Set<string>}
 */
function collectSeenLearnings(content) {
  const seen = new Set();
  if (!content) return seen;
  const re = /^-\s+\*\*([a-z]+)\*\*\s+\(conf\s+\d+\.\d+\)\s*:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(content)) !== null) {
    seen.add(makeDedupKey(m[1], m[2]));
  }
  return seen;
}

function makeDedupKey(type, text) {
  const normText = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "")
    .trim()
    .slice(0, 80);
  return `${type}|${normText}`;
}

function renderMemoryBlock(items, sessionId, stamp) {
  const lines = [];
  lines.push("");
  // Full ISO stamp — same-day appends from different sessions stay distinguishable.
  lines.push(`<!-- agent-daemon: digested ${stamp}${sessionId ? ` (session ${sessionId.slice(0, 8)})` : ""} -->`);
  for (const it of items) {
    const l = it.learning;
    const tagPart = l.tags && l.tags.length > 0 ? `  _tags: ${l.tags.map(t => neutralizeText(t)).join(", ")}_` : "";
    lines.push(`- **${l.type}** (conf ${l.confidence.toFixed(2)}): ${neutralizeText(l.text).replace(/\s+/g, " ").trim()}${tagPart}`);
    if (l.evidence_quote) {
      lines.push(`  > ${neutralizeText(l.evidence_quote).replace(/\s+/g, " ").trim()}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
