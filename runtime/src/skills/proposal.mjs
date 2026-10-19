// Skill proposal format v1 (P5.7). One file per proposal:
//
//   ---
//   ad-proposal: 1
//   kind: skill-update | skill-lesson
//   skill: <kebab-case name>          (skill-lesson: absent when no skill was named)
//   base-sha256: <SKILL.md the change was made from>   (skill-update)
//   new-sha256: <the fenced content>
//   origin: gepa | gepa-inline | digest
//   run: <run or session id>
//   host: <where the evidence came from>
//   created: <ISO time>
//   ---
//   # Proposed skill update — <name>
//   <why, in prose>
//   ## Proposed SKILL.md            (skill-lesson: ## Lesson)
//   <N backticks>markdown            N = the longest backtick run inside + 1, at least 3
//   <the full SKILL.md, frontmatter included>
//   <N backticks>
//
// Checksums (skillSha) ignore a BOM and CRLF, so a file saved on another OS is not
// "damaged". Older proposals (ad evolve's winner body, /evolve's full file) parse
// best-effort and are marked legacy.

import crypto from "node:crypto";

export const PROPOSAL_TEXTS = Object.freeze({
  damaged: "This proposal file is damaged (its content doesn't match its checksum).",
  badName: "This proposal names a skill that isn't a valid skill name.",
  oldFormat: "This proposal is in an old format ad can't apply. Apply it by hand, then accept to file it.",
});

export const KINDS = Object.freeze(["skill-update", "skill-lesson"]);
const KEYS = ["ad-proposal", "kind", "skill", "base-sha256", "new-sha256", "origin", "run", "host", "created"];
// Windows device names can't be folder names.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** A skill name ad will use as a folder name: kebab-case, at most 64 characters. */
export function isSkillName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && !RESERVED.test(name);
}

const normalize = (text) => String(text ?? "").replace(/^\u{FEFF}/u, "").replace(/\r\n/g, "\n");

/** sha256 of a SKILL.md (or any proposal payload), BOM and line endings ignored. */
export function skillSha(text) {
  return crypto.createHash("sha256").update(normalize(text), "utf8").digest("hex");
}

/** A body-only SKILL.md (ad evolve's variants) under the frontmatter of `skillMd`. */
export function withFrontmatterOf(skillMd, body) {
  const m = /^\u{FEFF}?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/u.exec(String(skillMd));
  if (!m) return body;
  return `${m[0]}\n${String(body).replace(/^(\s*\r?\n)+/, "")}`;
}

const fenceFor = (body) => "`".repeat(Math.max(3, ...[...String(body).matchAll(/`+/g)].map((m) => m[0].length + 1)));
const oneLine = (v) => String(v).replace(/[\r\n]+/g, " ").trim();

/**
 * @param {{ kind?: "skill-update"|"skill-lesson", skill?: string, base?: string, body: string,
 *           origin: string, run?: string, host?: string, created?: string, why?: string }} p
 */
export function renderSkillProposal({ kind = "skill-update", skill, base, body, origin, run, host, created = new Date().toISOString(), why = "" }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown skill proposal kind: ${kind}`);
  if ((kind === "skill-update" || skill !== undefined) && !isSkillName(skill)) throw new Error(`not a valid skill name: ${JSON.stringify(skill)}`);
  if (kind === "skill-update" && !/^[0-9a-f]{64}$/.test(String(base))) throw new Error("a skill update needs the base SKILL.md's sha256");
  const meta = { "ad-proposal": 1, kind, skill, "base-sha256": kind === "skill-update" ? base : undefined, "new-sha256": skillSha(body), origin, run, host, created };
  const front = KEYS.filter((k) => meta[k] !== undefined && meta[k] !== null && meta[k] !== "").map((k) => `${k}: ${oneLine(meta[k])}`);
  const fence = fenceFor(body);
  const title = kind === "skill-update" ? `# Proposed skill update — ${skill}` : `# Proposed lesson${skill ? ` for ${skill}` : ""}`;
  const section = kind === "skill-update" ? "## Proposed SKILL.md" : "## Lesson";
  // A payload heading inside the prose (an LLM's reflection quoting one) would be taken
  // for the real one: indented, it is no heading.
  const prose = String(why).trimEnd().replace(/^(## (Proposed SKILL\.md|Lesson)[ \t]*)$/gm, " $1");
  return ["---", ...front, "---", title, "", ...(prose ? [prose, ""] : []), section, `${fence}markdown`, `${body}`, fence, ""].join("\n");
}

// The text between an opening fence line (at `from`) and the first line that is exactly
// that fence. → { body, end } | null. A CRLF file's separator before the fence is dropped whole.
function fenced(text, from, { last = false } = {}) {
  const open = /^(`{3,})markdown[ \t]*(\r?\n)/m;
  const rest = text.slice(from);
  const m = open.exec(rest);
  if (!m) return null;
  const fence = m[1];
  const start = from + m.index + m[0].length;
  const close = new RegExp(`(\\r?\\n|^)${fence}[ \\t]*(\\r?\\n|$)`, "g");
  close.lastIndex = start === 0 ? 0 : start - 1;
  let hit = null;
  for (let c; (c = close.exec(text)); ) {
    if (c.index + c[1].length < start) continue;
    hit = c;
    if (!last) break;
    close.lastIndex = c.index + c[0].length - (c[2] ? c[2].length : 0);
  }
  if (!hit) return null;
  return { body: text.slice(start, hit.index), sep: hit[1], end: hit.index + hit[0].length };
}

function parseFront(text) {
  const t = text.replace(/^\u{FEFF}/u, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, rest: m[0].length + (text.length - t.length) };
}

/**
 * → { legacy: false, meta, body, error? }            a v1 proposal (error: damaged or a bad name)
 *   { legacy: "evolve" | "evolve-inline", meta, body, bodyOnly }   an older skill proposal
 *   { legacy: "unknown", meta: null, body: null }     anything else (memory proposals included)
 * bodyOnly: the body has no frontmatter (ad evolve wrote only the body); apply adds today's.
 */
export function parseProposal(text) {
  const s = String(text ?? "");
  const unknown = { legacy: "unknown", meta: null, body: null };
  const front = parseFront(s);
  if (front && front.meta["ad-proposal"] !== undefined) {
    const meta = front.meta;
    if (meta["ad-proposal"] !== "1" || !KINDS.includes(meta.kind)) return unknown;
    const heading = meta.kind === "skill-update" ? /^## Proposed SKILL\.md[ \t]*$/m : /^## Lesson[ \t]*$/m;
    const h = heading.exec(s.slice(front.rest));
    const f = h ? fenced(s, front.rest + h.index) : null;
    if (!f) return { legacy: false, meta, body: null, error: PROPOSAL_TEXTS.damaged };
    // In a CRLF file the line ending before the closing fence belongs to the file, not the body.
    const body = f.body;
    if ((meta.kind === "skill-update" || meta.skill !== undefined) && !isSkillName(meta.skill)) return { legacy: false, meta, body: null, error: PROPOSAL_TEXTS.badName };
    if (meta["new-sha256"] !== skillSha(body)) return { legacy: false, meta, body: null, error: PROPOSAL_TEXTS.damaged };
    return { legacy: false, meta, body };
  }
  // /evolve: the full SKILL.md, then a metadata block.
  const marker = s.indexOf("<!-- evolve-metadata -->");
  if (front && marker > 0) {
    const name = front.meta.name;
    if (!isSkillName(name)) return unknown;
    return { legacy: "evolve-inline", meta: { kind: "skill-update", skill: name }, body: s.slice(0, marker).replace(/(\r?\n)+$/, "$1"), bodyOnly: false };
  }
  // ad evolve: "## Winner body", the body only (no frontmatter), in a 3-backtick fence.
  const evolve = /^# Proposed skill update — (\S+)[ \t]*$/m.exec(s);
  const winner = /^## Winner body[ \t]*$/m.exec(s);
  if (evolve && winner && isSkillName(evolve[1])) {
    const f = fenced(s, winner.index);
    if (f) return { legacy: "evolve", meta: { kind: "skill-update", skill: evolve[1] }, body: f.body + f.sep, bodyOnly: true };
  }
  // The gepa-evolve-inline template: "## Proposed SKILL.md" with the full file, no ad-proposal key.
  const proposed = /^## Proposed SKILL\.md[ \t]*$/m.exec(s);
  if (proposed) {
    const f = fenced(s, proposed.index, { last: true });
    const inner = f ? parseFront(f.body) : null;
    if (inner && isSkillName(inner.meta.name)) return { legacy: "evolve-inline", meta: { kind: "skill-update", skill: inner.meta.name }, body: f.body + f.sep, bodyOnly: false };
  }
  return unknown;
}
