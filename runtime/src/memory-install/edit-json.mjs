// The memory server's entry in a host's JSON(C) config (Cursor's mcp.json;
// P5.4 adds more hosts). jsonc-parser edits in place, so comments, order and
// formatting outside our entry stay byte-for-byte. Every candidate is parsed
// again: it must hold exactly our entry and leave everything else as it was.
//
//   planJsonAdd(text, entry, {owned}) → {action: "add"|"update"|"same"|"refuse", text?, reason?}
//   planJsonRemove(text, {entry}) → {action: "remove"|"absent"|"edited"|"refuse", text?, reason?}
//   jsonEntry(text) → {ok, entry?, error?}

import { applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode } from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";

export const ENTRY_KEY = "agent-daemon-memory";
const PATH = ["mcpServers", ENTRY_KEY];

function format(text) {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const m = /\n([ \t]+)"/.exec(text);
  const indent = m ? m[1] : "  ";
  return { eol, insertSpaces: !indent.startsWith("\t"), tabSize: indent.startsWith("\t") ? 1 : indent.length };
}

/** The parsed document: {ok, root} or {ok:false, error}. An empty file is an empty object. */
export function parseJson(text) {
  if (!String(text ?? "").trim()) return { ok: true, root: undefined };
  const errors = [];
  const root = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) return { ok: false, error: `it isn't valid JSON (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})` };
  if (!root || typeof root !== "object" || Array.isArray(root)) return { ok: false, error: "its top level isn't an object" };
  if (root.mcpServers !== undefined && (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers))) return { ok: false, error: "its mcpServers isn't an object" };
  return { ok: true, root };
}

/** Our entry as the file holds it. */
export function jsonEntry(text) {
  const p = parseJson(text);
  if (!p.ok) return p;
  return { ok: true, entry: p.root?.mcpServers?.[ENTRY_KEY] };
}

const lineIndent = (text, offset) => {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))[0];
};

/**
 * Insert our entry touching nothing else. jsonc-parser's own formatter re-lays
 * out the whole parent object (a neighbour's one-line entry would be rewritten),
 * so the insertion point comes from modify() without formatting and only our
 * property is laid out: on its own line, at the siblings' indent, in the file's
 * line endings.
 */
function insertEntry(text, entry) {
  const [edit] = modify(text, PATH, entry, {});
  const m = /^(,?)("(?:[^"\\]|\\.)*"):\s*/.exec(edit.content);
  const key = JSON.parse(m[2]);
  const value = JSON.parse(edit.content.slice(m[0].length));
  const { eol, insertSpaces, tabSize } = format(text);
  const unit = insertSpaces ? " ".repeat(tabSize) : "\t";
  const tree = parseTree(text);
  const parent = key === "mcpServers" ? tree : findNodeAtLocation(tree, ["mcpServers"]);
  const siblings = parent?.children ?? [];
  const indent = siblings.length ? lineIndent(text, siblings[0].offset) : lineIndent(text, parent.offset) + unit;
  const prop = `${JSON.stringify(key)}: ${JSON.stringify(value, null, unit).split("\n").join(eol + indent)}`;
  const content = siblings.length ? `${m[1]}${eol}${indent}${prop}` : `${eol}${indent}${prop}${eol}${lineIndent(text, parent.offset)}`;
  return text.slice(0, edit.offset) + content + text.slice(edit.offset + edit.length);
}

const without = (root) => {
  if (!root) return {};
  const copy = structuredClone(root);
  if (copy.mcpServers) delete copy.mcpServers[ENTRY_KEY];
  return copy;
};

// The candidate holds `want` as our entry (or none) and nothing else changed.
function verify(before, candidate, want) {
  const after = parseJson(candidate);
  if (!after.ok) return false;
  if (!isDeepStrictEqual(after.root?.mcpServers?.[ENTRY_KEY], want)) return false;
  const a = without(after.root);
  const b = without(before);
  // An mcpServers object we created (or emptied) is ours.
  if (a.mcpServers && !Object.keys(a.mcpServers).length && !b.mcpServers) delete a.mcpServers;
  if (b.mcpServers && !Object.keys(b.mcpServers).length && !a.mcpServers) delete b.mcpServers;
  return isDeepStrictEqual(a, b);
}

/**
 * @param {string} text the file's text ("" when it doesn't exist)
 * @param {object} entry {command, args, env?, type?}
 * @param {{owned?: boolean}} [opts] owned: the entry there is the one ad wrote (ledger hash matches)
 */
export function planJsonAdd(text, entry, { owned = false } = {}) {
  const p = parseJson(text);
  if (!p.ok) return { action: "refuse", reason: p.error };
  const current = p.root?.mcpServers?.[ENTRY_KEY];
  if (isDeepStrictEqual(current, entry)) return { action: "same" };
  if (current !== undefined && !owned) return { action: "refuse", reason: "it already defines agent-daemon-memory" };
  const base = String(text ?? "").trim() ? text : "{}\n";
  const candidate = current === undefined ? insertEntry(base, entry) : applyEdits(base, modify(base, PATH, entry, {}));
  if (!verify(p.root, candidate, entry)) return { action: "refuse", reason: "ad couldn't add its entry without changing something else" };
  return { action: current === undefined ? "add" : "update", text: candidate };
}

/**
 * @param {string} text
 * @param {{entry?: object}} [opts] entry: what ad wrote; a different entry there is the user's edit and stays
 */
export function planJsonRemove(text, { entry } = {}) {
  const p = parseJson(text);
  if (!p.ok) return { action: "refuse", reason: p.error };
  const current = p.root?.mcpServers?.[ENTRY_KEY];
  if (current === undefined) return { action: "absent" };
  if (entry !== undefined && !isDeepStrictEqual(current, entry)) return { action: "edited", reason: "you changed ad's entry, so it was left as it is" };
  const candidate = applyEdits(text, modify(text, PATH, undefined, {}));
  if (!verify(p.root, candidate, undefined)) return { action: "refuse", reason: "ad couldn't remove its entry without changing something else" };
  return { action: "remove", text: candidate };
}
