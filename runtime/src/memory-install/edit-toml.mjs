// The memory server's entry in Codex's config.toml. ad never rewrites the file:
// it appends one block between its own markers and, on uninstall, removes that
// block. It refuses (file untouched, snippet shown) when the file doesn't parse,
// when mcp_servers isn't a table, or when agent-daemon-memory is defined
// outside the markers in any shape: a [mcp_servers.agent-daemon-memory] table,
// dotted keys (mcp_servers.agent-daemon-memory.command = …), an inline table
// under [mcp_servers], or mcp_servers = { … }. Every candidate is parsed again
// and must hold exactly our entry, with everything else unchanged.
//
//   planTomlAdd(text, entry, {owned}) → {action: "add"|"update"|"same"|"refuse", text?, reason?}
//   planTomlRemove(text, {entry}) → {action: "remove"|"absent"|"edited"|"refuse", text?, reason?}
//   tomlBlock(entry, eol) → the managed block's text (also the snippet ad prints)

import { parse } from "smol-toml";
import { isDeepStrictEqual } from "node:util";

export const ENTRY_KEY = "agent-daemon-memory";
export const BEGIN = "# >>> agent-daemon-memory (managed by ad; edits inside are kept but not updated) >>>";
export const END = "# <<< agent-daemon-memory <<<";

/** A TOML string: literal ('…') when it can be, else a basic string with escapes. */
export function tomlString(s) {
  const str = String(s);
  if (!/['\u{0}-\u{1f}\u{7f}]/u.test(str)) return `'${str}'`;
  return `"${str.replace(/[\\"\u{0}-\u{1f}\u{7f}]/gu, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`)}"`;
}
const bareKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

export function tomlBlock(entry, eol = "\n") {
  const lines = [BEGIN, `[mcp_servers.${ENTRY_KEY}]`, `command = ${tomlString(entry.command)}`, `args = [${entry.args.map(tomlString).join(", ")}]`];
  if (entry.env && Object.keys(entry.env).length) lines.push(`env = { ${Object.entries(entry.env).map(([k, v]) => `${bareKey(k)} = ${tomlString(v)}`).join(", ")} }`);
  lines.push(END);
  return lines.join(eol) + eol;
}

function safeParse(text) {
  try {
    return { ok: true, doc: parse(text) };
  } catch (e) {
    return { ok: false, error: `it doesn't parse as TOML (${String(e.message).split("\n")[0]})` };
  }
}

// The managed block (from the BEGIN line through the END line and its line break).
function findBlock(text) {
  const begin = text.indexOf(BEGIN);
  if (begin < 0) return null;
  if (text.indexOf(BEGIN, begin + 1) >= 0) return { error: "it holds ad's markers twice" };
  const endAt = text.indexOf(END, begin);
  if (endAt < 0) return { error: "ad's start marker has no end marker" };
  let end = endAt + END.length;
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text[end] === "\n") end += 1;
  // The line break ad put before the block (a blank line) goes with it.
  let start = begin;
  if (text.slice(0, start).endsWith("\r\n\r\n")) start -= 2;
  else if (text.slice(0, start).endsWith("\n\n")) start -= 1;
  return { start, begin, end };
}

const entryOf = (doc) => doc?.mcp_servers?.[ENTRY_KEY];
const withoutEntry = (doc) => {
  const copy = structuredClone(doc);
  if (copy.mcp_servers && typeof copy.mcp_servers === "object") {
    delete copy.mcp_servers[ENTRY_KEY];
    if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers;
  }
  return copy;
};
// Compare the entry TOML gave back with ours: arrays and strings only.
const normalize = (e) => (e === undefined ? undefined : JSON.parse(JSON.stringify(e)));

function outsideText(text) {
  const b = findBlock(text);
  if (b?.error) return { error: b.error };
  if (!b) return { outside: text, block: null };
  return { outside: text.slice(0, b.start) + text.slice(b.end), block: text.slice(b.begin, b.end) };
}

export function planTomlAdd(text, entry, { owned = false } = {}) {
  const src = String(text ?? "");
  const whole = safeParse(src);
  if (!whole.ok) return { action: "refuse", reason: whole.error };
  const o = outsideText(src);
  if (o.error) return { action: "refuse", reason: o.error };
  const out = safeParse(o.outside);
  if (!out.ok) return { action: "refuse", reason: out.error };
  const ms = out.doc.mcp_servers;
  if (ms !== undefined && (typeof ms !== "object" || Array.isArray(ms) || ms instanceof Date)) return { action: "refuse", reason: "its mcp_servers isn't a table" };
  if (entryOf(out.doc) !== undefined) return { action: "refuse", reason: "it already defines agent-daemon-memory outside ad's markers" };

  const eol = /\r\n/.test(src) ? "\r\n" : "\n";
  if (o.block) {
    // Ours already: the same → nothing to do; edited by the user → kept.
    const current = normalize(entryOf(whole.doc));
    if (isDeepStrictEqual(current, normalize(entry))) return { action: "same" };
    if (!owned) return { action: "refuse", reason: "ad's block was edited by hand, so it was left as it is" };
  }
  let candidate;
  if (o.block) {
    // An update stays where the block is.
    const b = findBlock(src);
    candidate = src.slice(0, b.begin) + tomlBlock(entry, eol) + src.slice(b.end);
  } else {
    let base = o.outside;
    if (base.length && !base.endsWith("\n")) base += eol;
    candidate = `${base}${base.trim() ? eol : ""}${tomlBlock(entry, eol)}`;
  }
  const after = safeParse(candidate);
  if (!after.ok) return { action: "refuse", reason: `ad's entry can't go into this file (${after.error.replace(/^it /, "")})` };
  if (!isDeepStrictEqual(normalize(entryOf(after.doc)), normalize(entry)) || !isDeepStrictEqual(withoutEntry(normalize(after.doc)), withoutEntry(normalize(out.doc)))) {
    return { action: "refuse", reason: "ad couldn't add its entry without changing something else" };
  }
  return { action: o.block ? "update" : "add", text: candidate };
}

export function planTomlRemove(text, { entry } = {}) {
  const src = String(text ?? "");
  const o = outsideText(src);
  if (o.error) return { action: "refuse", reason: o.error };
  if (!o.block) return { action: "absent" };
  const whole = safeParse(src);
  if (!whole.ok) return { action: "refuse", reason: whole.error };
  if (entry !== undefined && !isDeepStrictEqual(normalize(entryOf(whole.doc)), normalize(entry))) return { action: "edited", reason: "you changed ad's entry, so it was left as it is" };
  const after = safeParse(o.outside);
  if (!after.ok || entryOf(after.doc) !== undefined || !isDeepStrictEqual(withoutEntry(normalize(after.doc)), withoutEntry(normalize(whole.doc)))) {
    return { action: "refuse", reason: "ad couldn't remove its entry without changing something else" };
  }
  return { action: "remove", text: o.outside };
}
