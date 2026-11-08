// `setup` (MCP launch plan L3, Decisions 12–13): the hook and marker items of the
// memory product, written into a host's settings through the stable launcher and
// recorded one per item in ledger v2, plus their removal on uninstall.
//
//   Claude Code, user settings.json:
//     plugin on      → the tool.before entry (exec form, onFailure "continue") + env.AD_TOOL_SHELL
//     --no-plugin    → every memory route (the plugin's routes + tool.before) + env.AD_TOOL_SHELL
//     neither        → nothing; the /plugin lines are printed
//   A route whose steps ad's own live entry (ad init) already runs is skipped.
//
// Every edit is made on the edited lines only (jsonc-parser), parsed again and compared
// with the object expected, and written only over the bytes it was planned from
// (one re-plan when the host wrote the file meanwhile, then a refusal).
// Codex's items arrive in L3 part 3c.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SyntaxKind, applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree, printParseErrorCode } from "jsonc-parser";
import { PRODUCT } from "../product.mjs";
import { EXEC_FORM_MIN_VERSION, classifyHandler, entryAlive, ourHandlers, routesFor } from "../hooks/routes.mjs";
import { cmpVersion, distsFile, launchDir, launcherFile, setHostDisabled } from "../memory/launch/dists.mjs";
import { backup, inspect, writeChecked } from "./fsx.mjs";
import { claudePluginEnabled } from "./hosts.mjs";
import { canonicalSha256, itemId, openLedger2ForWrite, readLedger2, removalDecision, upsertItem, writeLedger2 } from "./ledger2.mjs";
import { CODEX_MARKER_PATH, UNSAFE_ROOT, codexConfigFile, codexHandler, codexHooksFile, inlineHooks, markerFiltered, safeToml, tomlAppendGroup, tomlGroupBlock, tomlMarkerAdd, tomlMarkerRemove, tomlRemoveGroup } from "./setup-codex.mjs";

/** The memory steps setup routes through the launcher (with the always-installed ones: the plugin's routes + tool.before). */
export const MEMORY_STEPS = Object.freeze(["session-start", "user-prompt-extract", "query-retrieve"]);
export const MARKER_PATH = Object.freeze(["env", "AD_TOOL_SHELL"]);
/** The hosts setup writes items for. */
export const SETUP_HOSTS = Object.freeze(["claude-code", "codex"]);

/** Claude Code's user settings file (CLAUDE_CONFIG_DIR when set). */
export function claudeSettingsFile(ctx) {
  const dir = ctx.env.CLAUDE_CONFIG_DIR && path.isAbsolute(ctx.env.CLAUDE_CONFIG_DIR) ? ctx.env.CLAUDE_CONFIG_DIR : path.join(ctx.home, ".claude");
  return path.join(dir, "settings.json");
}

/** One route's handler through the launcher (exec form: no shell). */
export function launcherHandler(launcher, route, host = "claude-code") {
  const h = { type: "command", command: "node", args: [launcher, "hook", route.event, "--host", host], timeout: route.timeout };
  // A tool.before that can't run must never block a tool call (02 §3).
  if (route.event === "tool.before") h.onFailure = "continue";
  return h;
}

/** The routes setup writes for Claude Code. */
export function claudeRoutes({ plugin, noPlugin }) {
  const all = routesFor(MEMORY_STEPS, "claude");
  if (plugin) return all.filter((r) => r.event === "tool.before");
  return noPlugin ? all : [];
}

/* ------------------------------------------------------------------ */
/* JSON settings, edited in place                                      */
/* ------------------------------------------------------------------ */

const BOM = "\u{FEFF}";

/** → {ok, root, bom, body} or {ok: false, error}. An empty file is an empty object. */
export function parseSettings(text) {
  const src = String(text ?? "");
  const bom = src.startsWith(BOM) ? BOM : "";
  const body = src.slice(bom.length);
  if (!body.trim()) return { ok: true, root: {}, bom, body: "{}\n", empty: true };
  const errors = [];
  const root = parseJsonc(body, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) return { ok: false, error: `it isn't valid JSON (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})` };
  if (!root || typeof root !== "object" || Array.isArray(root)) return { ok: false, error: "its top level isn't an object" };
  return { ok: true, root, bom, body };
}

// The file's line ending and indent unit.
function formatting(text) {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const m = /\n([ \t]+)"/.exec(text);
  return { eol, unit: m ? (m[1].startsWith("\t") ? "\t" : m[1]) : "  " };
}

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const lineStart = (text, i) => text.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (text, i) => {
  const n = text.indexOf("\n", i);
  if (n < 0) return text.length;
  return text[n - 1] === "\r" ? n - 1 : n;
};
const indentAt = (text, i) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))[0];
const render = (value, indent, { eol, unit }) => JSON.stringify(value, null, unit).split("\n").join(eol + indent);
// The node for a path, or null (the root for []).
const nodeAt = (tree, p) => (p.length ? findNodeAtLocation(tree, p) ?? null : tree);

/**
 * Insert `value` at `p` (an object key, or -1 to append to an array), creating
 * missing containers. Only new lines are added: a comma after the last member
 * (before a trailing line comment), then the new member on its own lines at the
 * siblings' indent. Nothing the user wrote is re-laid out.
 */
function insertAt(text, p, value) {
  const f = formatting(text);
  const tree = parseTree(text);
  let k = p.length - 1;
  let parent = nodeAt(tree, p.slice(0, k));
  while (!parent && k > 0) parent = nodeAt(tree, p.slice(0, --k));
  if (!parent || (parent.type !== "object" && parent.type !== "array")) return null;
  let v = value;
  for (let j = p.length - 1; j > k; j--) v = typeof p[j] === "number" ? [v] : { [p[j]]: v };
  const members = parent.children ?? [];
  const parentIndent = indentAt(text, parent.offset);
  const indent = members.length ? indentAt(text, members[0].offset) : parentIndent + f.unit;
  const body = (parent.type === "array" ? "" : `${JSON.stringify(p[k])}: `) + render(v, indent, f);
  if (!members.length) {
    const open = parent.offset + 1;
    const close = parent.offset + parent.length - 1;
    // An empty container: its inside becomes our member (a comment in it stays).
    if (!text.slice(open, close).trim()) return text.slice(0, open) + f.eol + indent + body + f.eol + parentIndent + text.slice(close);
    return text.slice(0, close) + f.eol + indent + body + f.eol + parentIndent + text.slice(close);
  }
  const last = members.at(-1);
  let end = last.offset + last.length;
  let comma = ",";
  // A trailing comma the user left (JSONC allows it) is the separator.
  const trailing = /^\s*,/.exec(text.slice(end));
  if (trailing) {
    end += trailing[0].length;
    comma = "";
  }
  const le = lineEnd(text, end);
  const at = /^\s*(\/\/.*)?$/.test(text.slice(end, le)) ? le : end;
  // In the container's style: after a trailing comma, ours ends with one too.
  return text.slice(0, end) + comma + text.slice(end, at) + f.eol + indent + body + (trailing ? "," : "") + text.slice(at);
}

/** Replace the value at `p`, laid out at its own line's indent. */
function replaceAt(text, p, value) {
  const node = nodeAt(parseTree(text), p);
  if (!node) return null;
  return text.slice(0, node.offset) + render(value, indentAt(text, node.offset), formatting(text)) + text.slice(node.offset + node.length);
}

/**
 * Remove the member at `p`. A member alone on its lines goes with its lines and
 * its separator, so setup's insertion is undone byte for byte; anything else is
 * left to jsonc-parser's plain removal (the caller verifies either way).
 */
function removeAt(text, p) {
  const node = nodeAt(parseTree(text), p);
  if (!node?.parent) return null;
  const member = node.parent.type === "property" ? node.parent : node;
  const container = member.parent;
  const members = container.children;
  const i = members.indexOf(member);
  const start = member.offset;
  const end = member.offset + member.length;
  const aloneBefore = !text.slice(lineStart(text, start), start).trim();
  if (members.length === 1) {
    const open = container.offset + 1;
    const close = container.offset + container.length - 1;
    if (!text.slice(open, start).trim() && !text.slice(end, close).trim()) return text.slice(0, open) + text.slice(close);
    // A container holding a comment too: setup added its own lines before the bracket, so
    // those go (the exact inverse); else only the member's own lines; else just the member.
    // The caller keeps the first that parses right and keeps every comment.
    const lsOne = lineStart(text, start);
    const eolBefore = text[lsOne - 2] === "\r" ? 2 : 1;
    const out = [];
    if (aloneBefore && /^\r?\n[ \t]*$/.test(text.slice(end, close)) && lsOne > open) out.push(text.slice(0, lsOne - eolBefore) + text.slice(close));
    if (aloneBefore && lsOne > open) out.push(text.slice(0, lsOne - eolBefore) + text.slice(end));
    out.push(text.slice(0, start) + text.slice(end));
    return out;
  }
  if (i === members.length - 1) {
    const prev = members[i - 1];
    const pEnd = prev.offset + prev.length;
    const sep = /^\s*,/.exec(text.slice(pEnd));
    if (!sep) return null;
    const comma = pEnd + sep[0].length - 1;
    // Alone on its lines (setup put it after the previous member's line): those lines go.
    // In a trailing-comma container its own comma goes with it and the one before stays.
    const rest = text.slice(end, lineEnd(text, end)).trim();
    const out = [];
    if (aloneBefore && (rest === "" || rest === ",")) {
      const ls = lineStart(text, start);
      const from = ls - (text[ls - 2] === "\r" ? 2 : 1);
      if (rest === ",") out.push(text.slice(0, from) + text.slice(text.indexOf(",", end) + 1));
      else if (from > comma) out.push(text.slice(0, comma) + text.slice(comma + 1, from) + text.slice(end));
    }
    // Else from the separator to its end (setup put it right after the previous member),
    // or the separator and the member alone, keeping whatever sits between (a comment).
    out.push(text.slice(0, comma) + text.slice(end), text.slice(0, comma) + text.slice(comma + 1, start) + text.slice(end));
    return out;
  }
  const next = members[i + 1];
  const after = /^\s*,[^\S\r\n]*\r?\n/.exec(text.slice(end));
  const out = [];
  if (after && aloneBefore && !text.slice(lineStart(text, next.offset), next.offset).trim()) out.push(text.slice(0, lineStart(text, start)) + text.slice(end + after[0].length));
  out.push(text.slice(0, start) + text.slice(next.offset));
  // The member and its separator alone, keeping a comment between them and the next member.
  const sep = /^\s*,/.exec(text.slice(end));
  if (sep) out.push(text.slice(0, start) + text.slice(end + sep[0].length));
  return out;
}

// The comments in a JSONC text, in order (an edit may move them, never drop them).
function commentsOf(text) {
  const s = createScanner(String(text), false);
  const out = [];
  for (let k = s.scan(); k !== SyntaxKind.EOF; k = s.scan()) {
    if (k === SyntaxKind.LineCommentTrivia || k === SyntaxKind.BlockCommentTrivia) out.push(s.getTokenValue().trim());
  }
  return out;
}
const containsAll = (have, need) => {
  const left = [...have];
  for (const c of need) {
    const i = left.indexOf(c);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
};

/** Apply ops ({path, value, insert?}; value undefined removes) to the text, each verified. */
export function applyOps(body, ops) {
  let text = body;
  let obj = parseSettings(body).root;
  for (const op of ops) {
    const want = applyOpsTo(obj, [op]);
    const exists = !op.insert && nodeAt(parseTree(text), op.path) !== null;
    const own = () => (op.value === undefined ? removeAt(text, op.path) : exists ? replaceAt(text, op.path, op.value) : insertAt(text, op.path, op.value));
    const plain = () => applyEdits(text, modify(text, op.path, op.value, { isArrayInsertion: Boolean(op.insert) }));
    // Every comment outside the part this op replaces or removes must still be there; a
    // container ad created and now prunes keeps the user's comments inside it too (op.prune).
    const node = exists ? nodeAt(parseTree(text), op.path) : null;
    const member = node?.parent?.type === "property" ? node.parent : node;
    const keep = commentsOf(member && !op.prune ? text.slice(0, member.offset) + text.slice(member.offset + member.length) : text);
    let next = null;
    for (const attempt of [own, plain]) {
      for (const c of [attempt()].flat()) {
        if (c === null || c === undefined) continue;
        const parsed = parseSettings(c);
        if (parsed.ok && isDeepStrictEqual(parsed.root, want) && containsAll(commentsOf(c), keep)) {
          next = c;
          break;
        }
      }
      if (next !== null) break;
    }
    // A prune is optional: a container holding the user's comment stays (empty but theirs now).
    if (next === null && op.prune) continue;
    if (next === null) throw new Error("ad couldn't make its change without changing something else");
    text = next;
    obj = want;
  }
  return { text, obj };
}

/** The containers an insertion at `p` creates in `obj` (to remove them again, and only them). */
function createdBy(obj, p) {
  const out = [];
  let cur = obj;
  for (let j = 0; j < p.length - 1; j++) {
    if (cur === undefined || cur === null || cur[p[j]] === undefined) {
      out.push(p.slice(0, j + 1));
      cur = undefined;
    } else cur = cur[p[j]];
  }
  return out;
}

/** The same ops on a plain object (what the file must parse to afterwards). */
function applyOpsTo(root, ops) {
  const out = structuredClone(root);
  for (const op of ops) {
    let parent = out;
    for (let i = 0; i < op.path.length - 1; i++) {
      const k = op.path[i];
      if (parent[k] === undefined) parent[k] = typeof op.path[i + 1] === "number" ? [] : {};
      parent = parent[k];
    }
    const last = op.path.at(-1);
    if (Array.isArray(parent)) {
      if (op.value === undefined) parent.splice(last, 1);
      else if (op.insert) parent.splice(last < 0 ? parent.length : last, 0, op.value);
      else parent[last] = op.value;
    } else if (op.value === undefined) delete parent[last];
    else parent[last] = op.value;
  }
  return out;
}

// Same file path however it was spelled (case on Windows, separators).
const samePath = (a, b) => {
  const n = (p) => path.resolve(String(p)).replace(/\\/g, "/");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Our launcher handlers for one locator ({hostEvent, event, script}) → [{gi, hi, handler}]. */
export function locateHook(root, { hostEvent, event, script }) {
  const groups = root?.hooks?.[hostEvent];
  const out = [];
  if (!Array.isArray(groups)) return out;
  groups.forEach((g, gi) => {
    (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => {
      const info = classifyHandler(h, { hostEvent, matcher: g?.matcher });
      if (info?.launcher && info.event === event && samePath(info.script, script)) out.push({ gi, hi, handler: h, matcher: g?.matcher ?? null, groupSize: g.hooks.length });
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/**
 * What setup does to Claude Code's settings text. Pure.
 * @param {string} text
 * @param {{launcher: string, routes: object[], marker?: boolean, owned?: object[], file: string}} o
 *   owned: ledger v2 items of this host and file (ad's earlier writes)
 * @returns {{ok:false, error:string} | {ok:true, ops:object[], expected:object, root:object, results:object[]}}
 */
export function planClaudeSetup(text, { launcher, routes, marker = true, owned = [], file, host = "claude-code", handlerFor = (route) => launcherHandler(launcher, route), rewrite = true }) {
  const p = parseSettings(text);
  if (!p.ok) return p;
  const { root } = p;
  if (root.hooks !== undefined && !isObj(root.hooks)) return { ok: false, error: "its hooks isn't an object" };
  const ops = [];
  const results = [];
  // The object as the ops so far leave it: which containers an insertion creates.
  let running = root;
  const push = (op) => {
    const created = createdBy(running, op.path);
    ops.push(op);
    running = applyOpsTo(running, [op]);
    return created;
  };
  const ownedItem = (kind, locator) => owned.find((i) => i.id === itemId({ host, kind, file, locator }));
  // ad's own entries (ad init's dispatcher) that can run: their steps aren't routed again.
  const adSteps = new Set(ourHandlers(root.hooks).filter((o) => !o.info.launcher && !o.info.plugin && o.handler.if === undefined && entryAlive(o.info)).flatMap((o) => o.info.steps));
  for (const route of routes) {
    const locator = { hostEvent: route.hostEvent, event: route.event, script: launcher };
    const want = handlerFor(route);
    const served = route.steps.filter((s) => adSteps.has(s));
    if (served.length) {
      results.push({ kind: "hook", event: route.event, action: "skip", why: `ad's own hooks already run ${served.join(", ")} here` });
      continue;
    }
    const groups = root.hooks?.[route.hostEvent];
    if (groups !== undefined && !Array.isArray(groups)) {
      results.push({ kind: "hook", event: route.event, action: "refuse", why: `its hooks.${route.hostEvent} isn't a list` });
      continue;
    }
    const found = locateHook(root, locator);
    const item = { kind: "hook", locator, value: want, preExisted: false };
    if (!found.length) {
      const created = push({ path: ["hooks", route.hostEvent, -1], value: route.matcher ? { matcher: route.matcher, hooks: [want] } : { hooks: [want] }, insert: true });
      results.push({ kind: "hook", event: route.event, action: "add", item: { ...item, created } });
      continue;
    }
    const live = found[0].handler;
    // onFailure and timeout are ad's to change later (the review service): a difference
    // there alone is not a new version of the entry, and is never undone here.
    if (canonicalSha256(live, { kind: "hook" }) === canonicalSha256(want, { kind: "hook" })) {
      results.push({ kind: "hook", event: route.event, action: "same", item: ownedItem("hook", locator) ? item : { ...item, preExisted: true } });
      continue;
    }
    const mine = ownedItem("hook", locator);
    // Codex: never rewritten (a changed handler loses the user's trust in it).
    if (!rewrite && mine && canonicalSha256(live, { kind: "hook" }) === mine.canonicalSha256) {
      results.push({ kind: "hook", event: route.event, action: "same", item: { ...item, value: live } });
    } else if (mine && canonicalSha256(live, { kind: "hook" }) === mine.canonicalSha256) {
      const next = { ...want };
      if (live.onFailure === "block") next.onFailure = "block";
      if (Number.isFinite(live.timeout) && live.timeout > next.timeout) next.timeout = live.timeout;
      push({ path: ["hooks", route.hostEvent, found[0].gi, "hooks", found[0].hi], value: next });
      results.push({ kind: "hook", event: route.event, action: "update", item: { ...item, value: next } });
    } else {
      results.push({ kind: "hook", event: route.event, action: "keep", why: mine ? "you changed it, so it was left as it is" : "an entry like ad's that ad has no record of; left as it is" });
    }
  }
  if (marker) {
    const item = { kind: "env", locator: { path: [...MARKER_PATH] }, value: "1", preExisted: false };
    if (root.env !== undefined && !isObj(root.env)) results.push({ kind: "env", action: "refuse", why: "its env isn't an object" });
    else if (root.env?.AD_TOOL_SHELL === undefined) {
      const created = push({ path: [...MARKER_PATH], value: "1" });
      results.push({ kind: "env", action: "add", item: { ...item, created } });
    } else if (root.env.AD_TOOL_SHELL === "1") {
      // Already there: ad's from an earlier setup, or the user's own (kept on uninstall).
      results.push({ kind: "env", action: "same", item: ownedItem("env", item.locator) ? item : { ...item, preExisted: true } });
    } else {
      results.push({ kind: "env", action: "refuse", why: `env.AD_TOOL_SHELL is set to ${JSON.stringify(root.env.AD_TOOL_SHELL)}, which ad leaves as you set it` });
    }
  }
  return { ok: true, ops, root, bom: p.bom, body: p.body, expected: running, results };
}

/** The candidate text for a plan, verified: → text, or throws. */
function candidateFor(plan) {
  const { text, obj } = applyOps(plan.body, plan.ops);
  const after = parseSettings(text);
  // Each op was verified; a skipped prune leaves its container, so the object the ops
  // reached is the check (it equals plan.expected whenever nothing was skipped).
  const skipped = plan.ops.some((o) => o.prune) && !isDeepStrictEqual(obj, plan.expected);
  if (!after.ok || !isDeepStrictEqual(after.root, skipped ? obj : plan.expected)) throw new Error("ad couldn't make its change without changing something else");
  return plan.bom + text;
}

/* ------------------------------------------------------------------ */
/* The ledger lock                                                     */
/* ------------------------------------------------------------------ */

/** One install, setup or uninstall at a time writes the ledgers (v1 and v2). */
export async function withLedgerLock(ctx, fn) {
  const { acquireLockWithin } = await import("../lock.mjs");
  let release;
  try {
    release = await acquireLockWithin("memory-ledger", { dir: path.join(ctx.root, "locks"), waitMs: ctx.lockWaitMs ?? 10_000 });
  } catch (e) {
    if (e?.code === "LOCK_BUSY") throw new Error("another install, setup or uninstall of ad's memory is running; try again when it ends");
    throw e;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ */
/* setup                                                               */
/* ------------------------------------------------------------------ */

const ACTION_WORD = { add: "added", update: "updated", same: "already there" };
const what = (r) => (r.kind === "env" ? "the agent-shell marker (AD_TOOL_SHELL)" : `the ${r.event} hook`);

/** The /plugin lines (Decision 13): Claude Code's memory route is the plugin. */
export function pluginLines(command) {
  return [
    "  Claude Code captures through the plugin. In Claude Code:",
    "    /plugin marketplace add <the agent-daemon marketplace repository>",
    `    /plugin install ${PRODUCT.plugin}@${PRODUCT.marketplace}`,
    `  then run ${command("setup")} again. Without the plugin: ${command("setup --no-plugin")}.`,
  ];
}

// ad init's own hooks capture here (a live dispatcher entry runs the prompt capture).
function adCapturesHere(file) {
  try {
    const hooks = parseSettings(fs.readFileSync(file, "utf8")).root?.hooks;
    return ourHandlers(hooks).some((o) => !o.info.launcher && !o.info.plugin && entryAlive(o.info) && o.info.steps.includes("user-prompt-extract"));
  } catch {
    return false;
  }
}

/**
 * What setup would do for a host now, without writing: → {routes, marker, notes} or null
 * (nothing to set up there).
 */
export async function setupWork(ctx, hostId, { noPlugin = false } = {}) {
  if (hostId === "codex") return codexWork(ctx);
  if (hostId !== "claude-code") return null;
  const plugin = claudePluginEnabled(ctx.home, ctx.env);
  // With ad init's hooks capturing, every route is offered and skipped step by step
  // (ad's own entries run them); the marker is still setup's to write.
  const adHooks = !plugin && !noPlugin && adCapturesHere(claudeSettingsFile(ctx));
  let routes = claudeRoutes({ plugin, noPlugin: noPlugin || adHooks });
  if (!plugin && !noPlugin && !adHooks) return { routes: [], marker: false, notes: pluginLines(ctx.command), none: true };
  const notes = [];
  const v = routes.length ? await ctx.claudeVersion() : null;
  if (v && cmpVersion(String(v), EXEC_FORM_MIN_VERSION) < 0) {
    notes.push(`  Claude Code ${v} predates the hook form ad writes (${EXEC_FORM_MIN_VERSION} or later): no hooks added. Update Claude Code, then run ${ctx.command("setup")} again.`);
    routes = [];
  }
  return { routes, marker: true, notes, plugin };
}

/** Setup for one host, under the ledger lock. → {code, changed} */
async function setupClaude(ctx, work, { dryRun }) {
  const { out } = ctx;
  const file = claudeSettingsFile(ctx);
  const launcher = launcherFile(ctx.root);
  for (const n of work.notes) out(n);
  for (let attempt = 0; ; attempt++) {
    const t = inspect(file);
    if (t.readOnly) {
      out(`✗ Claude Code: ${ctx.display(file)} is read-only; nothing changed`);
      return { code: 1 };
    }
    if (t.exists && !Buffer.from(t.text, "utf8").equals(t.bytes)) {
      out(`✗ Claude Code: ${ctx.display(file)} isn't UTF-8 text, so ad can't edit it without changing other bytes`);
      return { code: 1 };
    }
    // A dry run reads the ledger only (a garbled one stays where it is).
    const opened = dryRun ? { ledger: readLedger2(ctx.root) } : openLedger2ForWrite(ctx.root);
    if (opened.refuse) {
      out(`✗ ${opened.refuse}`);
      return { code: 1 };
    }
    if (opened.note) out(`· ${opened.note}`);
    const owned = opened.ledger.items.filter((i) => i.host === "claude-code" && !i.source);
    const plan = planClaudeSetup(t.text, { launcher, routes: work.routes, marker: work.marker, owned, file });
    if (!plan.ok) {
      out(`✗ Claude Code: ${ctx.display(file)}: ${plan.error}; nothing changed`);
      return { code: 1 };
    }
    for (const r of plan.results) {
      if (r.action === "skip") out(`· Claude Code: ${what(r)}: ${r.why}`);
      else if (r.action === "refuse" || r.action === "keep") out(`${r.action === "refuse" ? "✗" : "·"} Claude Code: ${what(r)}: ${r.why}`);
    }
    if (dryRun) {
      for (const r of plan.results.filter((x) => x.action === "add" || x.action === "update")) out(`  would ${r.action === "add" ? "add" : "update"} ${what(r)} in ${ctx.display(file)}`);
      return { code: 0 };
    }
    let text = null;
    if (plan.ops.length) {
      try {
        text = candidateFor(plan);
      } catch (e) {
        out(`✗ Claude Code: ${e.message}; nothing changed in ${ctx.display(file)}`);
        return { code: 1 };
      }
      // A linked settings file (a dotfile manager): only with a yes, as install asks.
      if (t.symlink && attempt === 0) {
        const a = String(await ctx.ask(`${ctx.display(file)} is a link to ${t.realFile}. Write through it? [y/N] `)).trim().toLowerCase();
        if (a !== "y" && a !== "yes") {
          out(`Claude Code: nothing changed in ${ctx.display(file)}`);
          return { code: 1 };
        }
      }
      await ctx.beforeWrite?.(file);
      // Written only over the bytes it was planned from: Claude Code may have written meanwhile.
      const now = inspect(file);
      const same = now.exists === t.exists && (!t.exists || now.bytes.equals(t.bytes));
      if (!same) {
        if (attempt === 0) continue;
        out(`✗ Claude Code: ${ctx.display(file)} keeps changing (is Claude Code writing it?); nothing changed. Run setup again.`);
        return { code: 1 };
      }
      // The file as it was before ad's first change to it.
      if (t.exists && !owned.some((i) => i.file && samePath(i.file, file))) out(`· backup: ${ctx.display(backup(ctx.root, "claude-code", file, t.bytes))}`);
      await writeChecked(t.realFile, text, t.exists ? t.bytes : null);
    }
    for (const r of plan.results.filter((x) => x.item)) {
      upsertItem(opened.ledger, { host: "claude-code", kind: r.item.kind, file, locator: r.item.locator, value: r.item.value, preExisted: r.item.preExisted, version: ctx.version, created: r.item.created, fileCreated: (!t.exists && r.action === "add") || undefined });
    }
    await writeLedger2(ctx.root, opened.ledger);
    for (const r of plan.results.filter((x) => ACTION_WORD[x.action])) out(`${r.action === "same" ? "·" : "✓"} Claude Code: ${what(r)} ${ACTION_WORD[r.action]}${r.action === "same" ? "" : ` in ${ctx.display(file)}`}`);
    const failed = plan.results.some((r) => r.action === "refuse");
    return { code: failed ? 2 : 0, changed: Boolean(text) };
  }
}

/**
 * What setup would write for a host now (nothing is written): [{kind, event?, action, file}]
 * or [{error, file}]. install's preview, and whether a run without a terminal must say "finish".
 */
export async function setupPending(ctx, id, work) {
  if (!work || work.none) return [];
  const owned = readLedger2(ctx.root).items.filter((i) => i.host === id && !i.source);
  const launcher = launcherFile(ctx.root);
  try {
    if (id === "codex") {
      const config = codexConfigFile(ctx);
      const text = inspect(config).text;
      const parsed = safeToml(text);
      if (!parsed.ok) return [{ error: parsed.error, file: config }];
      const inline = inlineHooks(parsed.doc);
      const hooksFile = inline ? config : codexHooksFile(ctx);
      const jsonRoot = parseSettings(inspect(codexHooksFile(ctx)).text).root ?? {};
      // As setup would: an entry of ad's in either file is there already; one the file
      // refuses (a static array) isn't pending either (else "finish in a terminal" forever).
      const writes = [];
      let toml = text;
      for (const r of work.routes) {
        const loc = { hostEvent: r.hostEvent, event: r.event, script: launcher };
        if (locateHook(parsed.doc, loc).length || locateHook(jsonRoot, loc).length) continue;
        if (inline) {
          const a = tomlAppendGroup(toml, r, codexHandler(launcher, r, ctx.platform ?? process.platform));
          if (a.refuse) continue;
          toml = a.text;
        }
        writes.push({ kind: "hook", event: r.event, action: "add", file: hooksFile });
      }
      if (work.marker && tomlMarkerAdd(toml).action === "add") writes.push({ kind: "env", action: "add", file: config });
      return writes;
    }
    const file = claudeSettingsFile(ctx);
    const plan = planClaudeSetup(inspect(file).text, { launcher, routes: work.routes, marker: work.marker, owned, file });
    return plan.ok ? plan.results.filter((r) => r.action === "add" || r.action === "update").map((r) => ({ ...r, file })) : [{ error: plan.error, file }];
  } catch (e) {
    return [{ error: e.message }];
  }
}

/** What setup does for Codex (Decisions 14–15), or null when Codex isn't here. */
async function codexWork(ctx) {
  const { hostById } = await import("./hosts.mjs");
  if (!hostById("codex").detect(ctx).found) return null;
  const notes = [];
  let routes = routesFor(MEMORY_STEPS, "codex");
  // C-L3-CODEXWIN: on Windows each hook starts a shell (1–4 s); tool.before does nothing
  // before the first rule, so it arrives with that rule.
  if ((ctx.platform ?? process.platform) === "win32") routes = routes.filter((r) => r.event !== "tool.before");
  if (UNSAFE_ROOT.test(launcherFile(ctx.root))) {
    notes.push(`  Codex: no hooks: ad's folder ${ctx.display(ctx.root)} holds $, \`, % or ", which Codex's shell would read. Set AD_ROOT to a plain path and run ${ctx.command("setup")} again.`);
    routes = [];
  }
  return { host: "codex", routes, marker: true, notes, refused: notes.some((n) => n.includes("no hooks:")) };
}

const tomlManual = (route, handler) => tomlGroupBlock(route, handler).trimEnd();

/** Codex: hooks (hooks.json, or config.toml when it already holds hook arrays) and the marker. → {code, changed} */
async function setupCodex(ctx, work, { dryRun }) {
  const { out } = ctx;
  const launcher = launcherFile(ctx.root);
  const config = codexConfigFile(ctx);
  for (const n of work.notes) out(n);
  for (let attempt = 0; ; attempt++) {
    const tc = inspect(config);
    const bad = tc.readOnly ? "it is read-only" : tc.exists && !Buffer.from(tc.text, "utf8").equals(tc.bytes) ? "it isn't UTF-8 text" : null;
    const parsed = bad ? { ok: false, error: bad } : safeToml(tc.text);
    if (!parsed.ok) {
      out(`✗ Codex: ${ctx.display(config)}: ${parsed.error}; nothing changed`);
      return { code: 1 };
    }
    const opened = dryRun ? { ledger: readLedger2(ctx.root) } : openLedger2ForWrite(ctx.root);
    if (opened.refuse) {
      out(`✗ ${opened.refuse}`);
      return { code: 1 };
    }
    const owned = opened.ledger.items.filter((i) => i.host === "codex" && !i.source);
    const inline = inlineHooks(parsed.doc);
    const hooksFile = inline ? config : codexHooksFile(ctx);
    const handlerOf = (route) => codexHandler(launcher, route, ctx.platform ?? process.platform);
    const results = [];
    // ad's entries already in the other file (the placement flips when the user adds hook
    // arrays to config.toml later): they stay there, recorded there, never added twice.
    const otherFile = inline ? codexHooksFile(ctx) : config;
    let otherDoc = inline ? null : parsed.doc;
    if (inline) {
      try {
        otherDoc = parseSettings(fs.readFileSync(otherFile, "utf8")).root ?? null;
      } catch {
        // no hooks.json
      }
    }
    const routes = [];
    for (const route of work.routes) {
      const locator = { hostEvent: route.hostEvent, event: route.event, script: launcher };
      const there = otherDoc ? locateHook(otherDoc, locator)[0] : null;
      if (!there) {
        routes.push(route);
        continue;
      }
      const mine = owned.find((i) => i.id === itemId({ host: "codex", kind: "hook", file: otherFile, locator }));
      if (canonicalSha256(there.handler, { kind: "hook" }) === canonicalSha256(handlerOf(route), { kind: "hook" })) {
        results.push({ kind: "hook", event: route.event, action: "same", file: otherFile, item: { kind: "hook", locator, value: handlerOf(route), preExisted: !mine } });
      } else results.push({ kind: "hook", event: route.event, action: "keep", why: mine ? "you changed it, so it was left as it is" : "an entry like ad's that ad has no record of; left as it is" });
    }
    const fileOf = (r) => r.file ?? (r.kind === "env" || inline ? config : hooksFile);
    let tomlText = tc.text;
    let json = null;
    if (inline) {
      // Each group appended on its own, so one the file can't take doesn't hold back the others.
      for (const route of routes) {
        const handler = handlerOf(route);
        const locator = { hostEvent: route.hostEvent, event: route.event, script: launcher };
        const found = locateHook(parsed.doc, locator)[0];
        const item = { kind: "hook", locator, value: handler, preExisted: false };
        if (found) {
          const mine = owned.find((i) => i.id === itemId({ host: "codex", kind: "hook", file: config, locator }));
          const same = canonicalSha256(found.handler, { kind: "hook" }) === canonicalSha256(handler, { kind: "hook" });
          // The same entry with no record of ad writing it: the user's (kept on uninstall).
          if (same) results.push({ kind: "hook", event: route.event, action: "same", item: mine ? item : { ...item, preExisted: true } });
          else results.push({ kind: "hook", event: route.event, action: "keep", why: mine ? "you changed it, so it was left as it is" : "an entry like ad's that ad has no record of; left as it is" });
          continue;
        }
        const r = tomlAppendGroup(tomlText, route, handler);
        if (r.refuse) {
          results.push({ kind: "hook", event: route.event, action: "refuse", why: `${r.refuse}:\n${tomlManual(route, handler)}` });
          continue;
        }
        tomlText = r.text;
        results.push({ kind: "hook", event: route.event, action: "add", item: { ...item, created: createdBy(parsed.doc, ["hooks", route.hostEvent, -1]), appended: r.appended } });
      }
    } else if (routes.length) {
      const th = inspect(hooksFile);
      const jbad = th.readOnly ? "it is read-only" : th.exists && !Buffer.from(th.text, "utf8").equals(th.bytes) ? "it isn't UTF-8 text" : null;
      const plan = jbad ? { ok: false, error: jbad } : planClaudeSetup(th.text, { launcher, routes, marker: false, owned, file: hooksFile, host: "codex", handlerFor: handlerOf, rewrite: false });
      if (!plan.ok) {
        out(`✗ Codex: ${ctx.display(hooksFile)}: ${plan.error}; no hooks added`);
        results.push({ kind: "hook", action: "refuse", why: plan.error });
      } else {
        json = { file: hooksFile, t: th, plan };
        results.push(...plan.results.map((r) => (r.item ? { ...r, item: { ...r.item, fileCreated: !th.exists || undefined } } : r)));
      }
    }
    // The marker, in config.toml whatever the hooks' placement.
    if (work.marker) {
      const m = tomlMarkerAdd(tomlText);
      const item = { kind: "env", locator: { path: [...CODEX_MARKER_PATH] }, value: "1", preExisted: false };
      if (m.action === "add") {
        tomlText = m.text;
        results.push({ kind: "env", action: "add", item: { ...item, created: m.created, fileCreated: !tc.exists || undefined, appended: m.appended } });
      } else if (m.action === "there") {
        const mine = owned.find((i) => i.id === itemId({ host: "codex", kind: "env", file: config, locator: item.locator }));
        results.push({ kind: "env", action: "same", item: mine ? item : { ...item, preExisted: true } });
      } else results.push({ kind: "env", action: "refuse", why: m.why });
      if (markerFiltered(safeToml(tomlText).doc)) out(`· Codex: your shell_environment_policy.include_only drops AD_TOOL_SHELL, so the marker does nothing; add "AD_TOOL_SHELL" to it`);
    }
    for (const r of results) {
      if (r.action === "skip" || r.action === "keep") out(`· Codex: ${what(r)}: ${r.why}`);
      else if (r.action === "refuse") out(`✗ Codex: ${r.kind === "env" ? what(r) : r.event ? what(r) : "hooks"}: ${r.why}`);
    }
    const writes = results.filter((x) => x.action === "add" || x.action === "update");
    if (dryRun) {
      for (const r of writes) out(`  would add ${what(r)} in ${ctx.display(fileOf(r))}`);
      return { code: 0 };
    }
    let jsonText = null;
    if (json?.plan.ops.length) {
      try {
        jsonText = candidateFor(json.plan);
      } catch (e) {
        out(`✗ Codex: ${e.message}; nothing changed in ${ctx.display(json.file)}`);
        return { code: 1 };
      }
    }
    const tomlChanged = tomlText !== tc.text;
    if (tomlChanged || jsonText !== null) {
      await ctx.beforeWrite?.(config);
      // Written only over the bytes each was planned from (Codex rewrites its config too).
      const nowC = inspect(config);
      const nowJ = json ? inspect(json.file) : null;
      const unchanged = (now, t) => now.exists === t.exists && (!t.exists || now.bytes.equals(t.bytes));
      if (!unchanged(nowC, tc) || (json && !unchanged(nowJ, json.t))) {
        if (attempt === 0) continue;
        out(`✗ Codex: its config keeps changing (is Codex writing it?); nothing changed. Run setup again.`);
        return { code: 1 };
      }
      const first = (file) => !owned.some((i) => i.file && samePath(i.file, file));
      if (tomlChanged && tc.exists && first(config)) out(`· backup: ${ctx.display(backup(ctx.root, "codex", config, tc.bytes))}`);
      if (jsonText !== null && json.t.exists && first(json.file)) out(`· backup: ${ctx.display(backup(ctx.root, "codex", json.file, json.t.bytes))}`);
      if (jsonText !== null) await writeChecked(json.t.realFile, jsonText, json.t.exists ? json.t.bytes : null);
      if (tomlChanged) await writeChecked(tc.realFile, tomlText, tc.exists ? tc.bytes : null);
    }
    for (const r of results.filter((x) => x.item)) {
      const file = fileOf(r);
      upsertItem(opened.ledger, { host: "codex", kind: r.item.kind, file, locator: r.item.locator, value: r.item.value, preExisted: r.item.preExisted, version: ctx.version, created: r.item.created, fileCreated: r.item.fileCreated, appended: r.item.appended });
    }
    await writeLedger2(ctx.root, opened.ledger);
    for (const r of results.filter((x) => ACTION_WORD[x.action])) out(`${r.action === "same" ? "·" : "✓"} Codex: ${what(r)} ${ACTION_WORD[r.action]}${r.action === "same" ? "" : ` in ${ctx.display(fileOf(r))}`}`);
    const changed = tomlChanged || jsonText !== null;
    // Codex runs a new or changed hook only after the user trusts it (D16).
    if (changed && writes.some((r) => r.kind === "hook")) out("  Codex: open it and run /hooks to trust ad's hooks; until then Codex doesn't run them.");
    return { code: work.refused || results.some((r) => r.action === "refuse") ? 2 : 0, changed };
  }
}

/**
 * `setup [--host claude-code|codex] [--no-plugin] [--dry-run]` → exit code (0 ok, 2 partly, 1 nothing done).
 * The caller (cli.mjs) refuses it in the agent's shell and without a terminal.
 */
export async function setup(opts = {}) {
  const ctx = opts.ctx;
  const { out } = ctx;
  const ids = opts.hosts?.length ? opts.hosts : SETUP_HOSTS;
  const unknown = ids.filter((id) => !SETUP_HOSTS.includes(id));
  if (unknown.length) {
    out(`setup handles ${SETUP_HOSTS.join(", ")} for now (not ${unknown.join(", ")})`);
    return 1;
  }
  out(`ad memory — setup${opts.dryRun ? " (dry run: nothing written)" : ""}`);
  const works = [];
  for (const id of ids) works.push([id, await setupWork(ctx, id, { noPlugin: opts.noPlugin })]);
  if (works.every(([, w]) => !w || w.none)) {
    for (const [, w] of works) for (const n of w?.notes ?? []) out(n);
    return 0;
  }
  const codes = [];
  let changed = false;
  let restartClaude = false;
  try {
    await withLedgerLock(ctx, async () => {
      // Entries start the launcher, so it is in place first (under the lock: an
      // uninstall can't remove it between here and the entries being written).
      if (!opts.dryRun) {
        try {
          const { installLauncher } = await import("./install.mjs");
          installLauncher(ctx);
        } catch (e) {
          out(`✗ couldn't set up the launcher in ${ctx.display(launchDir(ctx.root))}: ${e.message}; nothing changed`);
          codes.push(1);
          return;
        }
      }
      for (const [id, w] of works) {
        if (!w) continue;
        if (w.none) {
          for (const n of w.notes) out(n);
          continue;
        }
        const r = id === "codex" ? await setupCodex(ctx, w, { dryRun: opts.dryRun }) : await setupClaude(ctx, w, { dryRun: opts.dryRun });
        if (r.changed && id === "claude-code") restartClaude = true;
        codes.push(r.code);
        changed ||= Boolean(r.changed);
        // Set up again: its entries capture again (uninstall turned the host off).
        if (!opts.dryRun && r.code !== 1) setHostDisabled(distsFile(ctx.root), id, false);
      }
    });
  } catch (e) {
    out(`✗ ${e.message}`);
    return 1;
  }
  if (restartClaude) out("Restart Claude Code (or start a new session) to load the hooks.");
  if (codes.length && codes.every((c) => c === 1)) return 1;
  return codes.some((c) => c !== 0) ? 2 : 0;
}

/* ------------------------------------------------------------------ */
/* uninstall of setup's items                                          */
/* ------------------------------------------------------------------ */

const GATED = (item) => (item.kind === "hook" && item.locator?.event === "tool.before") || item.kind === "env";

/** The manual step for one kept item. */
export function manualStep(item, display = (p) => p) {
  if (item.kind === "env" && item.host === "codex") return `delete the line AD_TOOL_SHELL = "1" under [shell_environment_policy.set] in ${display(item.file)}`;
  if (item.kind === "env") return `delete "AD_TOOL_SHELL" from "env" in ${display(item.file)}`;
  if (item.kind === "hook") return `delete the ${item.locator.hostEvent} entry that runs memory/launch/run.mjs hook ${item.locator.event} from ${display(item.file)}`;
  return null;
}

/**
 * Remove setup's items from one Claude Code settings file. A kept tool.before is set
 * to onFailure "continue" (a later deletion of ~/.agent-daemon can't block a tool call).
 * gate: {rulesExist: bool, token: () => Promise<boolean>} — while rules exist, removing
 * tool.before or the marker, or changing onFailure, needs the review token.
 * → [{item, action: "removed"|"kept"|"gone", why?, how?, held? (the review gate kept it), retry? (the file was the problem)}]
 */
export async function removeSettingsItems(ctx, file, items, gate) {
  // The file itself is the problem (not ad's items): kept, still ad's, try again later.
  const retry = (why) => items.map((item) => ({ item, action: "kept", why, how: manualStep(item, ctx.display), retry: true }));
  for (let attempt = 0; ; attempt++) {
    const t = inspect(file);
    if (!t.exists) return items.map((item) => ({ item, action: "gone" }));
    const p = parseSettings(t.text);
    const unreadable = !p.ok ? p.error : t.readOnly ? "it is read-only" : !Buffer.from(t.text, "utf8").equals(t.bytes) ? "it isn't UTF-8 text" : null;
    if (unreadable) return retry(`${ctx.display(file)}: ${unreadable}; run uninstall again once that is fixed`);
    const results = [];
    const removals = [];
    const continues = [];
    for (const item of items) {
      const loc = item.kind === "hook" ? locateHook(p.root, item.locator)[0] : null;
      const live = item.kind === "hook" ? loc?.handler : item.kind === "env" ? (isObj(p.root.env) ? p.root.env.AD_TOOL_SHELL : undefined) : undefined;
      const d = removalDecision(item, live);
      if (d.action === "gone") {
        results.push({ item, action: "gone" });
        continue;
      }
      if (d.action === "remove" && GATED(item) && gate.rulesExist && !(await gate.token())) {
        results.push({ item, action: "kept", why: "rules exist, and removing it needs your review in your own terminal", how: manualStep(item, ctx.display), held: true });
        if (loc && item.locator.event === "tool.before" && item.host === "claude-code") continues.push({ item, loc });
        continue;
      }
      if (d.action === "remove") {
        removals.push({ item, loc });
        results.push({ item, action: "removed" });
        continue;
      }
      results.push({ item, action: "kept", why: d.why, how: manualStep(item, ctx.display) });
      if (loc && item.locator.event === "tool.before" && item.host === "claude-code") continues.push({ item, loc });
    }
    const ops = [];
    // onFailure first (no index moves), then removals from the end so earlier indices hold.
    for (const c of continues) {
      if (c.loc.handler.onFailure === "continue") continue;
      const r = results.find((x) => x.item === c.item);
      if (gate.rulesExist && !(await gate.token())) {
        r.why += `; its onFailure stays ${JSON.stringify(c.loc.handler.onFailure ?? null)} (changing it needs your review)`;
        continue;
      }
      ops.push({ path: ["hooks", c.item.locator.hostEvent, c.loc.gi, "hooks", c.loc.hi, "onFailure"], value: "continue" });
      r.why += '; it now has onFailure "continue", so it can\'t block a tool call';
    }
    const hookRemovals = removals.filter((r) => r.item.kind === "hook").sort((a, b) => b.loc.gi - a.loc.gi || b.loc.hi - a.loc.hi);
    const notes = [];
    for (const r of hookRemovals) {
      const he = r.item.locator.hostEvent;
      // The group held only this handler: the group goes.
      ops.push(r.loc.groupSize === 1 ? { path: ["hooks", he, r.loc.gi], value: undefined } : { path: ["hooks", he, r.loc.gi, "hooks", r.loc.hi], value: undefined });
      // Codex trusts hooks by position: groups after a removed one move up and need trusting again.
      const after = (p.root.hooks?.[he]?.length ?? 0) - 1 - r.loc.gi;
      if (r.item.host === "codex" && r.loc.groupSize > 1 && r.loc.hi < r.loc.groupSize - 1) {
        notes.push(`Codex: the hook you added in ad's ${he} group moved up one place; trust it again in /hooks`);
      }
      if (r.item.host === "codex" && r.loc.groupSize === 1 && after > 0 && !hookRemovals.some((x) => x !== r && x.item.locator.hostEvent === he && x.loc.gi > r.loc.gi)) {
        notes.push(`Codex: the ${he} hook${after === 1 ? "" : "s"} you added after ad's moved up one place; trust ${after === 1 ? "it" : "them"} again in /hooks`);
      }
    }
    if (removals.some((r) => r.item.kind === "env")) ops.push({ path: [...MARKER_PATH], value: undefined });
    if (!ops.length) return results;
    // Containers setup created and these removals emptied go too (deepest first); ones
    // the user had, empty or not, stay.
    let expected = applyOpsTo(p.root, ops);
    const createdPaths = removals.flatMap((r) => r.item.created ?? []).sort((a, b) => b.length - a.length);
    const seen = new Set();
    const stay = [];
    for (const cp of createdPaths) {
      const key = JSON.stringify(cp);
      if (seen.has(key)) continue;
      seen.add(key);
      let v = expected;
      for (const s of cp) v = v?.[s];
      if ((Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length)) {
        const op = { path: cp, value: undefined, prune: true };
        ops.push(op);
        expected = applyOpsTo(expected, [op]);
      } else if (v !== undefined) stay.push(cp);
    }
    // Containers ad created that still hold something: an item the review gate held
    // takes them over, so its own removal later takes them too once they are empty.
    for (const r of results.filter((x) => x.held)) {
      const mine = r.item.created ?? [];
      r.created = [...mine, ...stay.filter((cp) => !mine.some((m) => JSON.stringify(m) === JSON.stringify(cp)))];
    }
    let text;
    try {
      text = candidateFor({ body: p.body, bom: p.bom, ops, expected });
    } catch (e) {
      return retry(`${e.message} in ${ctx.display(file)}`);
    }
    await ctx.beforeWrite?.(file);
    const now = inspect(file);
    if (!now.exists || !now.bytes.equals(t.bytes)) {
      if (attempt === 0) continue;
      return retry(`${ctx.display(file)} keeps changing (is Claude Code writing it?); run uninstall again`);
    }
    try {
      // A file ad's setup created, now holding nothing but ad's leftovers ({}): it goes. A
      // comment the user wrote into it keeps it (the text decides, not the parsed object).
      const created = items.some((i) => i.fileCreated) && results.every((r) => r.action !== "kept") && /^\s*(\{\s*\})?\s*$/.test(text.replace(/^\u{FEFF}/u, ""));
      if (created) fs.rmSync(t.realFile, { force: true });
      else await writeChecked(t.realFile, text, t.bytes);
    } catch (e) {
      return retry(`couldn't write ${ctx.display(file)} (${e.code ?? e.message}); run uninstall again`);
    }
    results.notes = notes;
    return results;
  }
}

/**
 * Remove setup's Codex items from config.toml (inline hook groups, the marker): text
 * edits found as ad wrote them, each verified. Codex items are never rewritten.
 * → the same results as removeSettingsItems
 */
export async function removeTomlItems(ctx, file, items, gate) {
  const retry = (why) => items.map((item) => ({ item, action: "kept", why, how: manualStep(item, ctx.display), retry: true }));
  for (let attempt = 0; ; attempt++) {
    const t = inspect(file);
    if (!t.exists) return items.map((item) => ({ item, action: "gone" }));
    const bad = t.readOnly ? "it is read-only" : !Buffer.from(t.text, "utf8").equals(t.bytes) ? "it isn't UTF-8 text" : null;
    const parsed = bad ? { ok: false, error: bad } : safeToml(t.text);
    if (!parsed.ok) return retry(`${ctx.display(file)}: ${parsed.error}; run uninstall again once that is fixed`);
    const results = [];
    let text = t.text;
    const notes = [];
    // Last appended first (the one furthest down the file): each removal then undoes
    // exactly its own append, leads included.
    const routeOf = (item) => routesFor(MEMORY_STEPS, "codex").find((r) => r.event === item.locator.event && r.hostEvent === item.locator.hostEvent) ?? { hostEvent: item.locator.hostEvent, event: item.locator.event };
    const posOf = (item) => (item.kind === "env" ? t.text.search(/^[ \t]*AD_TOOL_SHELL[ \t]*=/m) : Math.max(...[...new Set([item.appended?.eol, "\n", "\r\n"].filter(Boolean))].map((e) => t.text.lastIndexOf(tomlGroupBlock(routeOf(item), item.value, e)))));
    const ordered = [...items].sort((a, b) => posOf(b) - posOf(a));
    for (const item of ordered) {
      const live = item.kind === "hook" ? locateHook(parsed.doc, item.locator)[0]?.handler : item.kind === "env" ? parsed.doc.shell_environment_policy?.set?.AD_TOOL_SHELL : undefined;
      const d = removalDecision(item, live);
      if (d.action === "gone") {
        results.push({ item, action: "gone" });
        continue;
      }
      if (d.action === "remove" && GATED(item) && gate.rulesExist && !(await gate.token())) {
        results.push({ item, action: "kept", why: "rules exist, and removing it needs your review in your own terminal", how: manualStep(item, ctx.display), held: true });
        continue;
      }
      if (d.action !== "remove") {
        results.push({ item, action: "kept", why: d.why, how: manualStep(item, ctx.display) });
        continue;
      }
      const route = routesFor(MEMORY_STEPS, "codex").find((r) => r.event === item.locator.event && r.hostEvent === item.locator.hostEvent) ?? { hostEvent: item.locator.hostEvent, event: item.locator.event };
      const r = item.kind === "env" ? tomlMarkerRemove(text, item.created ?? [], item.appended) : tomlRemoveGroup(text, route, item.value, item.appended);
      if (r.refuse) {
        results.push({ item, action: "kept", why: `${r.refuse} in ${ctx.display(file)}`, how: manualStep(item, ctx.display) });
        continue;
      }
      text = r.text;
      results.push({ item, action: "removed" });
      // Codex trusts hooks by position: groups after the removed one move up.
      const after = item.kind === "hook" ? (r.count ?? 0) - 1 - (r.index ?? 0) : 0;
      if (after > 0) notes.push(`Codex: the ${item.locator.hostEvent} hook${after === 1 ? "" : "s"} you added after ad's moved up one place; trust ${after === 1 ? "it" : "them"} again in /hooks`);
    }
    results.notes = notes;
    if (text === t.text) return results;
    await ctx.beforeWrite?.(file);
    const now = inspect(file);
    if (!now.exists || !now.bytes.equals(t.bytes)) {
      if (attempt === 0) continue;
      return retry(`${ctx.display(file)} keeps changing (is Codex writing it?); run uninstall again`);
    }
    try {
      // A config.toml ad's setup created and left empty goes.
      if (items.some((i) => i.fileCreated) && !text.trim() && results.every((r) => r.action !== "kept")) fs.rmSync(t.realFile, { force: true });
      else await writeChecked(t.realFile, text, t.bytes);
    } catch (e) {
      return retry(`couldn't write ${ctx.display(file)} (${e.code ?? e.message}); run uninstall again`);
    }
    return results;
  }
}

/* ------------------------------------------------------------------ */
/* the launcher scan (Decision 11)                                     */
/* ------------------------------------------------------------------ */

/** Every host config the installer knows, plus the files the ledger names. */
export function launcherReferenceFiles(ctx, ledgerFiles = []) {
  const files = new Set(ledgerFiles.filter(Boolean));
  const claudeDir = path.dirname(claudeSettingsFile(ctx));
  files.add(path.join(claudeDir, "settings.json"));
  files.add(path.join(claudeDir, "settings.local.json"));
  // ~/.claude.json holds `claude mcp add`'s user entries (inside CLAUDE_CONFIG_DIR when that is set).
  files.add(ctx.env.CLAUDE_CONFIG_DIR && path.isAbsolute(ctx.env.CLAUDE_CONFIG_DIR) ? path.join(ctx.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(ctx.home, ".claude.json"));
  const codexHome = ctx.env.CODEX_HOME && path.isAbsolute(ctx.env.CODEX_HOME) ? ctx.env.CODEX_HOME : path.join(ctx.home, ".codex");
  files.add(path.join(codexHome, "config.toml"));
  files.add(path.join(codexHome, "hooks.json"));
  return [...files];
}

/** The files that still start the launcher → [path]. */
export async function launcherReferences(ctx, ledgerFiles = []) {
  const { HOSTS } = await import("./hosts.mjs");
  const { referencesLauncher } = await import("./ledger2.mjs");
  const files = launcherReferenceFiles(ctx, [...ledgerFiles, ...HOSTS.filter((h) => h.file).map((h) => h.file(ctx))]);
  const out = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      // A huge file is read anyway: finding one too many keeps the launcher (the safe side).
      if (st.isFile() && referencesLauncher(fs.readFileSync(f, "utf8"))) out.push(f);
    } catch {
      // not there
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Codex's trust in ad's hooks (Decision 16)                           */
/* ------------------------------------------------------------------ */

/** The Codex version the hash below was checked on (the golden test, against hooks/list); follows the engine pin. */
export const TRUST_HASH_CHECKED_ON = "0.163.0";

/** Codex's event names in its trust keys and hashes: SessionStart → session_start. */
export const snakeEvent = (hostEvent) => String(hostEvent).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const sortedJson = (v) => (Array.isArray(v) ? v.map(sortedJson) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedJson(v[k])])) : v);

/**
 * The hash Codex keeps as trusted_hash for one hook group holding one of ad's
 * handlers: sha256 of the key-sorted compact JSON of {event_name, hooks: [handler
 * with Codex's defaults], matcher when set}. Only the fields ad writes are known.
 */
export function codexTrustHash(hostEvent, matcher, handler) {
  const h = { async: handler.async ?? false, command: handler.command, timeout: handler.timeout, type: handler.type ?? "command" };
  const g = { event_name: snakeEvent(hostEvent), hooks: [h], ...(matcher ? { matcher } : {}) };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortedJson(g))).digest("hex")}`;
}

/**
 * Codex's trust in each hook ad's setup wrote, read from config.toml's
 * [hooks.state."<file>:<event>:<group>:<handler>"] (positional, so a hook's key
 * moves with its place). → [{item, key?, state}], state: "trusted" (Codex runs it),
 * "pending" (never reviewed: open /hooks), "modified" (trusted as something else:
 * Codex won't run it until reviewed again), "disabled", "changed" (you edited ad's
 * entry), "gone", or "unknown" (a mismatch on a Codex newer than the one the hash
 * was checked on: can't confirm).
 */
export function codexTrust(ctx, { codexVersion = null } = {}) {
  const items = readLedger2(ctx.root).items.filter((i) => i.host === "codex" && i.kind === "hook" && !i.source);
  if (!items.length) return [];
  let state = {};
  try {
    state = safeToml(fs.readFileSync(codexConfigFile(ctx), "utf8")).doc?.hooks?.state ?? {};
  } catch {
    // no config.toml: nothing trusted yet
  }
  const newer = Boolean(codexVersion) && cmpVersion(String(codexVersion), TRUST_HASH_CHECKED_ON) > 0;
  return items.map((item) => {
    let doc;
    try {
      const text = fs.readFileSync(item.file, "utf8");
      doc = /\.toml$/i.test(item.file) ? safeToml(text).doc : parseSettings(text).root;
    } catch {
      return { item, state: "gone" };
    }
    const loc = locateHook(doc ?? {}, item.locator)[0];
    if (!loc) return { item, state: "gone" };
    if (canonicalSha256(loc.handler, { kind: "hook" }) !== item.canonicalSha256) return { item, state: "changed" };
    // Codex resolves its home folder (a linked ~/.codex, the case on Windows) but keeps the file name.
    let dir = path.dirname(item.file);
    try {
      dir = fs.realpathSync.native(dir);
    } catch {
      // as recorded
    }
    const key = `${path.join(dir, path.basename(item.file))}:${snakeEvent(item.locator.hostEvent)}:${loc.gi}:${loc.hi}`;
    const s = state[key];
    if (s?.enabled === false) return { item, key, state: "disabled" };
    if (!s?.trusted_hash) return { item, key, state: "pending" };
    if (s.trusted_hash === codexTrustHash(item.locator.hostEvent, loc.matcher, loc.handler)) return { item, key, state: "trusted" };
    return { item, key, state: newer ? "unknown" : "modified" };
  });
}
