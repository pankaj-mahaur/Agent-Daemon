// The memory server's entry in Codex's config.toml, as one inline table under
// [mcp_servers] (MCP launch plan L3, D14/D17):
//
//   [mcp_servers]
//   agent-daemon-memory = { command = "…", args = […], env = { … } }
//
// `codex mcp add/remove` re-serialise every table-form [mcp_servers.x] entry
// (comments lost) but keep an inline one as written. 3.1.0 wrote a table between
// ad's markers; `codex mcp add` drops its first marker and moves the second, so a
// marker search alone would miss a live entry. Install moves either shape (intact
// or damaged) to the inline form when it is ad's; uninstall removes any of them.
//
// ad never rewrites the file: it adds or removes its own lines, parses every
// candidate again, and requires exactly its entry with everything else unchanged.
// It refuses (file untouched, snippet shown) when the file doesn't parse, when
// mcp_servers isn't a table, or when an entry of that name isn't ad's.
//
//   planTomlAdd(text, entry, {owned}) → {action: "add"|"update"|"same"|"refuse", text?, reason?}
//   planTomlRemove(text, {entry}) → {action: "remove"|"absent"|"edited"|"refuse", text?, reason?}
//   tomlBlock(entry, eol) → the snippet ad prints for a manual add
//   tomlInlineLine(entry) → the one line ad writes

import { parse } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import { PRODUCT } from "../product.mjs";

export const ENTRY_KEY = PRODUCT.mcpServerKey;
// 3.1.0's markers, still recognised (and removed) around an entry it wrote.
export const BEGIN = "# >>> agent-daemon-memory (managed by ad; edits inside are kept but not updated) >>>";
export const END = "# <<< agent-daemon-memory <<<";

/** A TOML string: literal ('…') when it can be, else a basic string with escapes. */
export function tomlString(s) {
  const str = String(s);
  if (!/['\u{0}-\u{1f}\u{7f}]/u.test(str)) return `'${str}'`;
  return `"${str.replace(/[\\"\u{0}-\u{1f}\u{7f}]/gu, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`)}"`;
}
const bareKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** The inline table ad writes for its entry (one line: TOML inline tables can't span lines). */
export function tomlInlineValue(entry) {
  const parts = [`command = ${tomlString(entry.command)}`, `args = [${entry.args.map(tomlString).join(", ")}]`];
  if (entry.env && Object.keys(entry.env).length) parts.push(`env = { ${Object.entries(entry.env).map(([k, v]) => `${bareKey(k)} = ${tomlString(v)}`).join(", ")} }`);
  return `{ ${parts.join(", ")} }`;
}
export const tomlInlineLine = (entry) => `${bareKey(ENTRY_KEY)} = ${tomlInlineValue(entry)}`;

/** The snippet ad prints when it won't edit the file itself. */
export function tomlBlock(entry, eol = "\n") {
  return ["[mcp_servers]", tomlInlineLine(entry)].join(eol) + eol;
}

function safeParse(text) {
  try {
    return { ok: true, doc: JSON.parse(JSON.stringify(parse(text))) };
  } catch (e) {
    return { ok: false, error: `it doesn't parse as TOML (${String(e.message).split("\n")[0]})` };
  }
}

const entryOf = (doc) => doc?.mcp_servers?.[ENTRY_KEY];
// The document without ad's entry, an mcp_servers left empty counting as none.
const withoutEntry = (doc) => {
  const copy = structuredClone(doc ?? {});
  if (copy.mcp_servers && typeof copy.mcp_servers === "object" && !Array.isArray(copy.mcp_servers)) {
    delete copy.mcp_servers[ENTRY_KEY];
    if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers;
  }
  return copy;
};
const normalize = (e) => (e === undefined ? undefined : JSON.parse(JSON.stringify(e)));
const eolOf = (text) => {
  const i = String(text).lastIndexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KEY_RE = `(?:${esc(ENTRY_KEY)}|"${esc(ENTRY_KEY)}"|'${esc(ENTRY_KEY)}')`;
const INLINE_UNDER = new RegExp(`^[ \\t]*${KEY_RE}[ \\t]*=[ \\t]*\\{.*\\}[ \\t]*(?:#.*)?$`);
const INLINE_ROOT = new RegExp(`^[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*${KEY_RE}[ \\t]*=[ \\t]*\\{.*\\}[ \\t]*(?:#.*)?$`);
const MARKER = new RegExp(`^[ \\t]*(?:${esc(BEGIN)}|${esc(END)})[ \\t]*$`);

// A header's table name with spaces and quotes taken out: [ mcp_servers . "x" ] → mcp_servers.x
const headerName = (line) => {
  const m = /^[ \t]*\[\[?([^\]#]*)\]\]?[ \t]*(?:#.*)?$/.exec(line);
  return m ? m[1].split(".").map((s) => s.trim().replace(/^["']|["']$/g, "")).join(".") : null;
};

/** The text as lines (each keeps its line break) with the table each one is in. */
function scan(text) {
  const lines = String(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let table = "";
  return lines.map((raw) => {
    const body = raw.replace(/\r?\n$/, "");
    const name = headerName(body);
    if (name !== null) table = name;
    const kind = name !== null ? "header" : !body.trim() ? "blank" : /^[ \t]*#/.test(body) ? "comment" : "line";
    return { raw, body, kind, table, name };
  });
}

/**
 * Where ad's entry sits: the inline line (under [mcp_servers], or a root dotted key),
 * the table form's sections ([mcp_servers.<key>] and its sub-tables, as `codex mcp add`
 * writes an env), and 3.1.0's marker lines. → { del: Set of line indexes, mains, header }
 */
function locate(lines) {
  const main = `mcp_servers.${ENTRY_KEY}`;
  const del = new Set();
  let mains = 0;
  let inline = -1;
  lines.forEach((l, i) => {
    if (l.kind === "line" && ((l.table === "mcp_servers" && INLINE_UNDER.test(l.body)) || (l.table === "" && INLINE_ROOT.test(l.body)))) {
      del.add(i);
      mains++;
      inline = i;
    }
    if (l.kind === "header" && (l.name === main || l.name.startsWith(`${main}.`))) {
      if (l.name === main) mains++;
      // The section: the header and its lines, up to the next header; a comment block
      // right above the next header is that table's, not ad's (blank lines before it go).
      let end = i + 1;
      while (end < lines.length && lines[end].kind !== "header") end++;
      let tail = end;
      while (tail > i + 1 && (lines[tail - 1].kind === "comment" || lines[tail - 1].kind === "blank")) tail--;
      let firstComment = -1;
      for (let k = tail; k < end; k++) if (lines[k].kind === "comment") {
        firstComment = k;
        break;
      }
      const stop = firstComment >= 0 ? firstComment : end;
      for (let k = i; k < stop; k++) del.add(k);
      // At the end of the file, the blank line before it goes instead (ad put one there).
      if (stop === lines.length && i > 0 && lines[i - 1].kind === "blank" && !del.has(i - 1)) del.add(i - 1);
    }
    if (l.kind === "comment" && MARKER.test(l.body)) {
      del.add(i);
      // The blank line 3.1.0 put before its block.
      if (l.body.includes(">>>") && i > 0 && lines[i - 1].kind === "blank") del.add(i - 1);
    }
  });
  return { del, mains, inline };
}

/**
 * The text without ad's entry, in whatever shape it is. headerAdded: ad appended the
 * [mcp_servers] header with its line (recorded at install), so a header left with
 * nothing after it goes too; a header that was there before never does.
 * → { text } or { error }.
 */
function cut(text, { headerAdded = false } = {}) {
  const lines = scan(text);
  const { del, mains, inline } = locate(lines);
  if (mains > 1) return { error: `it defines ${ENTRY_KEY} more than once` };
  if (headerAdded && inline > 0 && lines[inline - 1].kind === "header" && lines[inline - 1].name === "mcp_servers" && /^[ \t]*\[[ \t]*mcp_servers[ \t]*\][ \t]*$/.test(lines[inline - 1].body)) {
    // ad's header holding nothing else (up to the next table, or the end) goes, with the
    // blank line ad put before it; one that gained keys of the user's stays.
    let k = inline + 1;
    while (k < lines.length && lines[k].kind === "blank") k++;
    if (k === lines.length || lines[k].kind === "header") {
      del.add(inline - 1);
      if (inline > 1 && lines[inline - 2].kind === "blank") del.add(inline - 2);
    }
  }
  return { text: lines.filter((_, i) => !del.has(i)).map((l) => l.raw).join("") };
}

/** Candidate texts holding the inline entry, most natural first: [{text, placement}]. */
function placements(text, entry) {
  const src = String(text);
  const eol = eolOf(src);
  const line = tomlInlineLine(entry);
  const lines = scan(src);
  const out = [];
  const headers = lines.map((l, i) => [l, i]).filter(([l]) => l.kind === "header" && l.name === "mcp_servers" && /^[ \t]*\[[ \t]*mcp_servers[ \t]*\]/.test(l.body));
  if (headers.length === 1) {
    const i = headers[0][1];
    const head = lines.slice(0, i + 1).map((l) => l.raw).join("");
    const sep = head.endsWith("\n") ? "" : eol;
    out.push({ placement: "under", text: head + sep + line + eol + lines.slice(i + 1).map((l) => l.raw).join("") });
  }
  // An [mcp_servers] table of its own at the end (TOML allows a super-table after its sub-tables).
  const base = src.length && !src.endsWith("\n") ? src + eol : src;
  out.push({ placement: "table", text: `${base}${base.trim() ? eol : ""}[mcp_servers]${eol}${line}${eol}` });
  // A root dotted key before the first table, as a last resort.
  const first = lines.findIndex((l) => l.kind === "header");
  const head = (first < 0 ? lines : lines.slice(0, first)).map((l) => l.raw).join("");
  const sep = head.length && !head.endsWith("\n") ? eol : "";
  out.push({ placement: "dotted", text: `${head}${sep}mcp_servers.${line}${eol}${first >= 0 ? eol : ""}${first >= 0 ? lines.slice(first).map((l) => l.raw).join("") : ""}` });
  return out;
}

/**
 * placement in the result: "under" (an [mcp_servers] header that was there), "table"
 * (ad appended the header too: record it, so uninstall takes the header back), "dotted".
 */
export function planTomlAdd(text, entry, { owned = false } = {}) {
  const src = String(text ?? "");
  const whole = safeParse(src);
  if (!whole.ok) return { action: "refuse", reason: whole.error };
  const ms = whole.doc.mcp_servers;
  if (ms !== undefined && (typeof ms !== "object" || Array.isArray(ms))) return { action: "refuse", reason: "its mcp_servers isn't a table" };
  const current = normalize(entryOf(whole.doc));
  const found = locate(scan(src));
  if (found.mains > 1) return { action: "refuse", reason: `it defines ${ENTRY_KEY} more than once` };
  if (found.inline >= 0 && isDeepStrictEqual(current, normalize(entry))) return { action: "same" };
  if (current !== undefined && !owned && !isDeepStrictEqual(current, normalize(entry))) {
    const ads = src.includes(BEGIN) || src.includes(END);
    return { action: "refuse", reason: ads ? "ad's entry was edited by hand, so it was left as it is" : `it already defines ${ENTRY_KEY}, which ad didn't write` };
  }
  const c = cut(src);
  if (c.error) return { action: "refuse", reason: c.error };
  const base = safeParse(c.text);
  if (!base.ok || !isDeepStrictEqual(withoutEntry(base.doc), withoutEntry(whole.doc)) || entryOf(base.doc) !== undefined) {
    return { action: "refuse", reason: `ad couldn't take out the ${ENTRY_KEY} entry it found without changing something else` };
  }
  for (const { text: candidate, placement } of placements(c.text, entry)) {
    const after = safeParse(candidate);
    if (after.ok && isDeepStrictEqual(normalize(entryOf(after.doc)), normalize(entry)) && isDeepStrictEqual(withoutEntry(after.doc), withoutEntry(whole.doc))) {
      return { action: current === undefined ? "add" : "update", text: candidate, placement };
    }
  }
  return { action: "refuse", reason: "ad couldn't add its entry without changing something else" };
}

/** headerAdded: the install recorded that ad appended the [mcp_servers] header (placement "table"). */
export function planTomlRemove(text, { entry, headerAdded = false } = {}) {
  const src = String(text ?? "");
  const whole = safeParse(src);
  if (!whole.ok) return { action: "refuse", reason: whole.error };
  const current = normalize(entryOf(whole.doc));
  if (current === undefined) {
    // 3.1.0's markers with no entry left: tidy them away (comment lines only, nothing else).
    const lines = scan(src);
    const marks = lines.filter((l) => l.kind === "comment" && MARKER.test(l.body));
    if (!marks.length) return { action: "absent" };
    return { action: "remove", text: lines.filter((l) => !(l.kind === "comment" && MARKER.test(l.body))).map((l) => l.raw).join("") };
  }
  if (entry !== undefined && !isDeepStrictEqual(current, normalize(entry))) return { action: "edited", reason: "you changed ad's entry, so it was left as it is" };
  const c = cut(src, { headerAdded });
  if (c.error) return { action: "refuse", reason: c.error };
  const after = safeParse(c.text);
  if (!after.ok || entryOf(after.doc) !== undefined || !isDeepStrictEqual(withoutEntry(after.doc), withoutEntry(whole.doc))) {
    return { action: "refuse", reason: "ad couldn't remove its entry without changing something else" };
  }
  return { action: "remove", text: c.text };
}
