// allow-once (MCP launch plan L7, design D9): one call, the one the user saw, once, soon.
//
//   allowability(call)     can this canonical call be shown faithfully? null, or why not
//   matchedParts(rule, c)  every sub-command (or path) a rule matched in a call
//   tryAllowOnce(...)      the hook's side: lift a stopped call when every rule that stops
//                          it is covered by an unexpired token for this project and this
//                          exact call, consuming each with an exclusive create (the only
//                          files the hook makes in the guard state; they only make rules
//                          stricter: a consumed token can't be used again)
//   allowOnceView(entry)   the review service's side: the call as the code prompt shows it
//
// Pure except tryAllowOnce's marker files. Hook path: no store, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { findSecrets } from "../security/secret-patterns.mjs";
import { commandsIn } from "../rules/shell.mjs";
import { argvMatches, dialectOf, writeTargets } from "../rules/match.mjs";
import { projectRelative, globsMatch } from "../rules/paths.mjs";
import { consumedDir } from "./guards.mjs";

/** Calls longer than this can't be shown in a prompt the user reads. */
export const MAX_ALLOWABLE = 4096;

// Text that can make a prompt show something other than what runs: every control (C0
// except LF and TAB — CR and ESC included — DEL, C1), every format character (zero-width,
// bidi, soft hyphen, word joiners, tags, the BOM), line and paragraph separators, and
// variation selectors. LF and TAB are allowed: the view shows them visibly.
const DISGUISE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u;
const disguised = (text) => DISGUISE.test(String(text).replace(/[\n\t]/g, ""));

/**
 * Can this canonical call (its JSON text) be allowed once? null, or "long" | "chars" |
 * "secret" (a stop like that is logged without its text and can't be allowed once).
 */
export function allowability(callJson) {
  const text = String(callJson ?? "");
  if (text.length > MAX_ALLOWABLE) return "long";
  // The JSON escapes control characters; look at the decoded text as well.
  let decoded = text;
  try {
    decoded = collectStrings(JSON.parse(text)).join("\n");
  } catch {
    // not JSON: judge the text itself
  }
  if (disguised(decoded) || disguised(text)) return "chars";
  if (findSecrets(decoded).length || findSecrets(text).length) return "secret";
  return null;
}

// Every string in the call, field names included (a key is shown in the prompt too).
function collectStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    out.push(k);
    collectStrings(x, out);
  }
  return out;
}

/** Every sub-command (or project-relative path) a rule matched in a matcher call. */
export function matchedParts(rule, call) {
  try {
    if (rule?.type === "command") {
      const command = call?.input?.command ?? call?.input?.cmd;
      if (command == null) return [];
      const os = call.os ?? "linux";
      return commandsIn(command, { dialect: dialectOf(call), os })
        .filter(({ argv, dialect }) => argvMatches(rule, argv, { os, dialect }))
        .map(({ argv }) => argv.join(" "))
        .slice(0, 20);
    }
    if (rule?.type === "write") {
      const os = call.os ?? "linux";
      return writeTargets(call)
        .map((t) => projectRelative(t, { cwd: call.cwd ?? call.project_root, root: call.project_root ?? call.cwd, os }))
        .filter((rel) => rel !== null && globsMatch(rule.globs ?? [], rel, { os }))
        .slice(0, 20);
    }
  } catch {
    // a part we can't list: the full call is shown anyway
  }
  return [];
}

/**
 * The hook's side. → {passed: true, rules: [ids]} when every rule id is covered by an
 * unexpired, unconsumed token for this project and call, and every marker was created;
 * else null (the stop stands).
 */
export function tryAllowOnce(snapshot, { callHash, projectId, ruleIds, root, now = Date.now(), fsx = fs }) {
  const tokens = Array.isArray(snapshot?.allowOnce) ? snapshot.allowOnce : [];
  if (!tokens.length || !Array.isArray(ruleIds) || !ruleIds.length) return null;
  const dir = consumedDir(root);
  // The clock is read now, not when the hook started: a hook that stalled past the grace
  // period must not find its token's marker swept and pass a consumed token again.
  const t0 = Math.max(now, Date.now());
  const usable = tokens
    .filter((t) => t && typeof t.callHash === "string" && t.callHash.length === 64 && t.callHash === callHash && (t.project ?? null) === (projectId ?? null) && Date.parse(t.expires) > t0 && /^[0-9a-f]{32}$/.test(String(t.nonce)))
    // Skips a token already used (a cheap pre-check; the exclusive create below decides).
    .filter((t) => !fsx.existsSync(path.join(dir, t.nonce)));
  // A set of tokens that covers every rule that stopped the call (the fewest: greedy).
  const need = new Set(ruleIds);
  const chosen = [];
  for (const t of usable.sort((a, b) => (b.rules?.length ?? 0) - (a.rules?.length ?? 0))) {
    const covers = (t.rules ?? []).filter((id) => need.has(id));
    if (!covers.length) continue;
    chosen.push(t);
    for (const id of covers) need.delete(id);
    if (!need.size) break;
  }
  if (need.size) return null;
  // Exclusive creates in one order for every process, stopping at the first taken one: two
  // racing calls never both pass (D9).
  // A failed create later in the list leaves the earlier markers: those tokens are spent
  // (stricter, never looser).
  try {
    fsx.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  for (const t of chosen.sort((a, b) => (a.nonce < b.nonce ? -1 : 1))) {
    try {
      fsx.writeFileSync(path.join(dir, t.nonce), String(t0), { flag: "wx" });
    } catch {
      return null; // taken by another call, or can't be written: the stop stands
    }
  }
  return { passed: true, rules: [...ruleIds] };
}

/**
 * The call as the review service shows it before the typed code: every field that runs,
 * LF and TAB made visible, anything outside printable ASCII escaped (look-alike letters
 * can't pass for others), and each rule's matched parts.
 */
export function allowOnceView(entry) {
  let call = {};
  try {
    call = JSON.parse(entry?.call ?? "{}");
  } catch {
    call = {};
  }
  // Backslashes and literal ⏎/→ are escaped first, so neither an escape sequence nor a
  // look-alike of the LF/TAB marks can pass for the real thing.
  const show = (v) =>
    (typeof v === "string" ? v : JSON.stringify(v))
      .replace(/\\/g, "\\\\")
      .replace(/[⏎→]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`)
      .replace(/\n/g, "⏎")
      .replace(/\t/g, "→")
      .replace(/[^\x20-\x7e⏎→]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  const tin = call.tool_input && typeof call.tool_input === "object" ? call.tool_input : {};
  // The first field that names what runs leads; every field is shown, each once.
  const lead = ["command", "cmd", "file_path", "patch"].find((k) => k in tin);
  const lines = [`${show(call.tool_name ?? "?")}: ${lead ? show(tin[lead]) : ""}`];
  for (const [k, v] of Object.entries(tin)) if (k !== lead) lines.push(`  ${show(k)}: ${show(v)}`);
  if (call.cwd) lines.push(`  in: ${show(call.cwd)}`);
  for (const r of entry?.rules ?? []) {
    const parts = (r.matched ?? []).map((m) => `\`${show(m)}\``);
    lines.push(`  rule ${r.id} matched ${parts.length ? parts.join(", ") : "this call"}`);
  }
  return lines.join("\n");
}
