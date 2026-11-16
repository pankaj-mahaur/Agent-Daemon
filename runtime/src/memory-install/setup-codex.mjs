// Codex's side of `setup` (MCP launch plan L3, Decisions 14–15): the memory hooks
// through the stable launcher and the agent-shell marker in $CODEX_HOME/config.toml.
//
//   handler   node "<root>/memory/launch/run.mjs" hook <event> --host codex
//             (one line: Codex runs it through the session's shell, so the path is
//             double-quoted with "/" and a root holding $ ` % or " is refused)
//   placement config.toml when that file already has hook event arrays, else hooks.json;
//             ours are appended as new groups, so the user's groups keep their indices
//             (Codex trusts hooks by position: "<file>:<event>:<group>:<handler>")
//   marker    [shell_environment_policy.set] AD_TOOL_SHELL = "1"
//
// Codex entries are never rewritten once written (any change voids their trust):
// uninstall removes them when unchanged and otherwise leaves them, turned off.
// TOML is edited as text: blocks appended, and removed only when found as written.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { tomlString } from "./edit-toml.mjs";

export const CODEX_MARKER_PATH = Object.freeze(["shell_environment_policy", "set", "AD_TOOL_SHELL"]);
const SET_HEADER = "[shell_environment_policy.set]";
const MARKER_LINE = 'AD_TOOL_SHELL = "1"';

export const codexHome = (ctx) => (ctx.env.CODEX_HOME && path.isAbsolute(ctx.env.CODEX_HOME) ? ctx.env.CODEX_HOME : path.join(ctx.home, ".codex"));
export const codexConfigFile = (ctx) => path.join(codexHome(ctx), "config.toml");
export const codexHooksFile = (ctx) => path.join(codexHome(ctx), "hooks.json");

/**
 * A root a shell would read something into: $ (pwsh, sh), ` (pwsh, sh), % and ! (cmd,
 * the latter with delayed expansion), " and the curly double quotes PowerShell takes for
 * it, and control characters (a line break ends the command).
 */
export const UNSAFE_ROOT = /[$`%!"\u{201C}\u{201D}\u{201E}\u{0}-\u{1F}\u{7F}]/u;

/** The exact line Codex runs: stable across updates (node from PATH, the launcher's fixed path). */
export const codexCommand = (launcher, event, platform = process.platform) => `node "${platform === "win32" ? String(launcher).replace(/\\/g, "/") : String(launcher)}" hook ${event} --host codex`;
export const codexHandler = (launcher, route, platform) => ({ type: "command", command: codexCommand(launcher, route.event, platform), timeout: route.timeout });
export const codexGroup = (route, handler) => (route.matcher ? { matcher: route.matcher, hooks: [handler] } : { hooks: [handler] });

/** The hooks go into config.toml only when it already holds hook event arrays ([hooks] alone may hold only trust state). */
export function inlineHooks(doc) {
  const h = doc?.hooks;
  return Boolean(h && typeof h === "object" && !Array.isArray(h) && Object.entries(h).some(([k, v]) => k !== "state" && Array.isArray(v)));
}

export function safeToml(text) {
  try {
    return { ok: true, doc: JSON.parse(JSON.stringify(parseToml(String(text ?? "")))) };
  } catch (e) {
    return { ok: false, error: `it doesn't parse as TOML (${String(e.message).split("\n")[0]})` };
  }
}

// The line ending of the file's last line break (a file mixing them gets the one at its end).
const eolOf = (text) => {
  const i = String(text).lastIndexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
};
// What goes before an appended block: a line break ending the user's last line when it
// has none, then a blank line. Recorded, so removal takes exactly this back.
const leadFor = (base, eol) => (!base.length ? "" : base.endsWith("\n") ? (base.trim() ? eol : "") : eol + eol);

/** One group as an array-of-tables block (appended: it becomes the event's last group). */
export function tomlGroupBlock(route, handler, eol = "\n") {
  const lines = [`[[hooks.${route.hostEvent}]]`];
  if (route.matcher) lines.push(`matcher = ${tomlString(route.matcher)}`);
  lines.push(`[[hooks.${route.hostEvent}.hooks]]`, `type = ${tomlString(handler.type)}`, `command = ${tomlString(handler.command)}`, `timeout = ${Number(handler.timeout)}`);
  return lines.join(eol) + eol;
}

const withGroup = (doc, hostEvent, group) => {
  const out = structuredClone(doc);
  out.hooks = out.hooks && typeof out.hooks === "object" ? out.hooks : {};
  out.hooks[hostEvent] = [...(Array.isArray(out.hooks[hostEvent]) ? out.hooks[hostEvent] : []), group];
  return out;
};

/**
 * Append one group to config.toml. → { text } or { refuse }. The result must parse to
 * the same document plus exactly this group at the end of its event (the user's groups
 * keep their places, so their trust keys stay valid).
 */
export function tomlAppendGroup(text, route, handler) {
  const before = safeToml(text);
  if (!before.ok) return { refuse: before.error };
  const base = String(text);
  const eol = eolOf(base);
  const lead = leadFor(base, eol);
  const candidate = `${base}${lead}${tomlGroupBlock(route, handler, eol)}`;
  const after = safeToml(candidate);
  if (!after.ok || !isDeepStrictEqual(after.doc, withGroup(before.doc, route.hostEvent, codexGroup(route, handler)))) {
    return { refuse: `its hooks.${route.hostEvent} isn't a list of tables ad can add to (add the entry yourself)` };
  }
  return { text: candidate, appended: { lead, eol } };
}

/**
 * Remove a group ad appended, found as ad wrote it (with what it put before it, when
 * recorded). → { text, index } or { refuse }; index: the group's place in its event before.
 */
export function tomlRemoveGroup(text, route, handler, appended) {
  const src = String(text);
  const before = safeToml(src);
  if (!before.ok) return { refuse: before.error };
  const groups = before.doc.hooks?.[route.hostEvent] ?? [];
  const i = groups.findIndex((g) => isDeepStrictEqual(g, codexGroup(route, handler)));
  if (i < 0) return { refuse: "ad couldn't find its lines as it wrote them" };
  const expected = structuredClone(before.doc);
  expected.hooks[route.hostEvent].splice(i, 1);
  if (!expected.hooks[route.hostEvent].length) delete expected.hooks[route.hostEvent];
  if (!Object.keys(expected.hooks).length) delete expected.hooks;
  // The block as written (the recorded line ending, or the file's own if it was converted
  // since), with exactly what ad put before it, else a blank line, else nothing: the first
  // candidate that parses to the expected document wins.
  for (const eol of [...new Set([appended?.eol, eolOf(src)].filter(Boolean))]) {
    const block = tomlGroupBlock(route, handler, eol);
    const at = src.lastIndexOf(block);
    if (at < 0 || src.indexOf(block) !== at) continue;
    const head = src.slice(0, at);
    const tail = src.slice(at + block.length);
    // A lead goes only while what is left still ends its last line (the user may have
    // deleted ad's blank line since; then their own line break stays).
    const keepsLine = (lead) => {
      if (!head.endsWith(lead)) return false;
      const rest = head.slice(0, head.length - lead.length);
      return !lead || !rest || rest.endsWith("\n") || (appended?.lead === lead && lead === eol + eol);
    };
    const leads = [...new Set([appended?.eol === eol ? appended.lead : null, eol, ""].filter((l) => l !== null && l !== undefined))];
    for (const lead of leads) {
      if (!keepsLine(lead)) continue;
      const candidate = head.slice(0, head.length - lead.length) + tail;
      const after = safeToml(candidate);
      if (after.ok && isDeepStrictEqual(after.doc, expected)) return { text: candidate, index: i, count: groups.length };
    }
  }
  return { refuse: "ad couldn't find its lines as it wrote them" };
}

const markerOf = (doc) => doc?.shell_environment_policy?.set?.AD_TOOL_SHELL;
const withoutMarker = (doc, created) => {
  const out = structuredClone(doc);
  const set = out.shell_environment_policy?.set;
  if (set && typeof set === "object") {
    delete set.AD_TOOL_SHELL;
    if (created.some((p) => p.length === 2) && !Object.keys(set).length) delete out.shell_environment_policy.set;
  }
  if (created.some((p) => p.length === 1) && out.shell_environment_policy && !Object.keys(out.shell_environment_policy).length) delete out.shell_environment_policy;
  return out;
};

/**
 * The marker in config.toml. → { action: "add", text, created } | { action: "there" } |
 * { action: "refuse", why }. created: the tables ad's lines create (removed again with it).
 */
export function tomlMarkerAdd(text) {
  const src = String(text ?? "");
  const before = safeToml(src);
  if (!before.ok) return { action: "refuse", why: before.error };
  const v = markerOf(before.doc);
  if (v === "1") return { action: "there" };
  if (v !== undefined) return { action: "refuse", why: `shell_environment_policy.set.AD_TOOL_SHELL is set to ${JSON.stringify(v)}, which ad leaves as you set it` };
  const sep = before.doc.shell_environment_policy;
  const created = sep === undefined ? [["shell_environment_policy"], ["shell_environment_policy", "set"]] : sep.set === undefined ? [["shell_environment_policy", "set"]] : [];
  const headers = [...src.matchAll(/^[ \t]*\[[ \t]*shell_environment_policy[ \t]*\.[ \t]*set[ \t]*\][ \t]*(?:#[^\r\n]*)?\r?\n/gm)];
  let candidate;
  let appended;
  if (headers.length === 1) {
    const h = headers[0];
    const eol = h[0].endsWith("\r\n") ? "\r\n" : "\n";
    candidate = src.slice(0, h.index + h[0].length) + MARKER_LINE + eol + src.slice(h.index + h[0].length);
    appended = { eol, header: false };
  } else {
    const eol = eolOf(src);
    const lead = leadFor(src, eol);
    candidate = `${src}${lead}${SET_HEADER}${eol}${MARKER_LINE}${eol}`;
    appended = { lead, eol, header: true };
  }
  const after = safeToml(candidate);
  if (!after.ok || markerOf(after.doc) !== "1" || !isDeepStrictEqual(withoutMarker(after.doc, created), before.doc)) {
    return { action: "refuse", why: `ad couldn't add ${MARKER_LINE} under ${SET_HEADER} without changing something else (add it yourself)` };
  }
  return { action: "add", text: candidate, created, appended };
}

/** Remove ad's marker line (and the table it created, now empty). → { text } or { refuse }. */
export function tomlMarkerRemove(text, created = [], appended) {
  const src = String(text);
  const eol = appended?.eol ?? eolOf(src);
  const lines = [...src.matchAll(/^[ \t]*AD_TOOL_SHELL[ \t]*=[ \t]*"1"[ \t]*\r?\n?/gm)];
  if (lines.length !== 1) return { refuse: "ad couldn't find its line as it wrote it" };
  const lineGone = src.slice(0, lines[0].index) + src.slice(lines[0].index + lines[0][0].length);
  const before = safeToml(src);
  if (!before.ok) return { refuse: before.error };
  const expected = withoutMarker(before.doc, created);
  const candidates = [lineGone];
  if (created.some((p) => p.length === 2)) {
    // ad's own table, now empty: its header goes, with exactly what ad put before it, else
    // a blank line, else nothing — while what is left still ends its last line.
    const h = /^\[shell_environment_policy\.set\][ \t]*\r?\n/m.exec(lineGone);
    if (h && /^\s*(\[|$)/.test(lineGone.slice(h.index + h[0].length))) {
      const head = lineGone.slice(0, h.index);
      const tail = lineGone.slice(h.index + h[0].length);
      const leads = [...new Set([appended?.eol === eol ? appended.lead : null, eol, ""].filter((l) => l !== null && l !== undefined))];
      candidates.length = 0;
      for (const lead of leads) {
        if (!head.endsWith(lead)) continue;
        const rest = head.slice(0, head.length - lead.length);
        if (lead && rest && !rest.endsWith("\n") && !(appended?.lead === lead && lead === eol + eol)) continue;
        candidates.push(rest + tail);
      }
    }
  }
  for (const candidate of candidates) {
    const after = safeToml(candidate);
    if (after.ok && isDeepStrictEqual(after.doc, expected)) return { text: candidate };
  }
  return { refuse: "ad couldn't remove its line without changing something else" };
}

/** include_only patterns that would drop the marker from the agent's shell (Codex applies them after set). */
export function markerFiltered(doc) {
  const inc = doc?.shell_environment_policy?.include_only;
  if (!Array.isArray(inc) || !inc.length) return false;
  const re = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return !inc.some((g) => re(g).test("AD_TOOL_SHELL"));
}
