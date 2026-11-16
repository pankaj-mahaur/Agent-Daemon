// The instructions in an agent instruction file (plan L4b): CLAUDE.md, AGENTS.md,
// Cursor rules, Copilot instructions, GEMINI.md. Pure: text in, units out.
//
// A unit is one list item or one prose paragraph, outside code fences, HTML comments,
// tables, headings and YAML front matter, and outside every block ad wrote itself
// (memory/managed-blocks.mjs). Front matter is read for its scope only (Cursor's
// `globs` and `alwaysApply`, Copilot's `applyTo`).

import { stripManaged } from "./managed-blocks.mjs";

export const MIN_UNIT = 8;
export const MAX_UNIT = 1000;

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}(?:\s+(.*?))?\s*#*\s*$/;
const SETEXT = /^\s{0,3}(?:=+|-+)\s*$/;
const RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const TABLE = /^\s*\|/;
// Claude Code's import line ("@AGENTS.md", "@docs/rules.md"): a pointer, not a rule.
const IMPORT_LINE = /^\s*@[^\s@]+\s*$/;

/** Front matter at the very start of the file: its lines and where the body starts. */
function frontMatter(lines) {
  if (!/^---\s*$/.test(lines[0] ?? "")) return { body: 0, scope: null };
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) return { body: i + 1, scope: scopeOf(lines.slice(1, i)) };
  }
  return { body: 0, scope: null }; // never closed: not front matter
}

// Only the keys that scope a rule, read as plain strings (no YAML library: a value we
// can't read is kept as written).
function scopeOf(lines) {
  const out = {};
  for (const l of lines) {
    const m = /^(globs|applyTo|alwaysApply)\s*:\s*(.*)$/.exec(l.trim());
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (m[1] === "alwaysApply") out.alwaysApply = /^true$/i.test(v);
    else if (v) out.globs = v.replace(/^\[|\]$/g, "").split(",").map((g) => g.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return Object.keys(out).length ? out : null;
}

/** Markdown out, text kept: links keep their text, images go, emphasis marks go, code spans stay. */
export function plainText(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A bullet that names no rule: only a link, only a command, or the header of a sub-list.
function notARule(raw) {
  const t = raw.trim();
  return /^\[[^\]]*\]\([^)]*\)\W*$/.test(t) || /^`[^`]+`\W*$/.test(t) || /:\s*$/.test(t);
}

/**
 * @param {string} text  the file's text
 * @returns {{units: {text:string, heading:string|null, kind:"item"|"paragraph"}[], scope: {globs?:string[], alwaysApply?:boolean}|null,
 *           tooLong: number}}
 */
export function instructionUnits(text) {
  let s = String(text ?? "").replace(/^\u{FEFF}/u, "");
  s = stripManaged(s);
  // HTML comments, closed or not (an open one hides the rest of the file when rendered).
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const lines = s.split(/\r?\n/);
  const { body, scope } = frontMatter(lines);
  const units = [];
  let tooLong = 0;
  let heading = null;
  let fence = null;
  let para = []; // lines of the open paragraph
  let item = null; // { parts: [], indent, raw }

  const push = (raw, kind) => {
    const t = plainText(raw);
    if (t.length < MIN_UNIT) return;
    if (t.length > MAX_UNIT) {
      tooLong++;
      return;
    }
    units.push({ text: t, heading, kind });
  };
  const closePara = () => {
    if (para.length) push(para.join(" "), "paragraph");
    para = [];
  };
  const closeItem = () => {
    if (item && !notARule(item.raw)) push(item.parts.join(" "), "item");
    item = null;
  };

  for (let i = body; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      closePara();
      closeItem();
      fence = f[1];
      continue;
    }
    if (!line.trim()) {
      closePara();
      closeItem();
      continue;
    }
    if (SETEXT.test(line) && para.length === 1 && !item) {
      heading = plainText(para[0]) || heading;
      para = [];
      continue;
    }
    if (RULE.test(line)) {
      closePara();
      closeItem();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      closePara();
      closeItem();
      heading = plainText(h[1] ?? "") || null;
      continue;
    }
    if (TABLE.test(line) || IMPORT_LINE.test(line)) {
      closePara();
      closeItem();
      continue;
    }
    const m = ITEM.exec(line);
    if (m) {
      closePara();
      closeItem();
      item = { parts: [m[2]], indent: m[1].length, raw: m[2] };
      continue;
    }
    const quoted = line.replace(/^\s{0,3}>\s?/, "");
    // An indented line after a list item continues it.
    if (item && /^\s{2,}\S/.test(line)) {
      item.parts.push(quoted.trim());
      continue;
    }
    closeItem();
    para.push(quoted.trim());
  }
  closePara();
  closeItem();
  return { units, scope, tooLong };
}
