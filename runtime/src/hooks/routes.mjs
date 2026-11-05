// Hook routes (plan L2): which host events reach which dispatcher event, and
// how ad writes, recognises and replaces its own hook entries.
//
//   Claude Code  {command: "node", args: [<abs>/runtime/bin/hook.mjs, <event>]}   exec form, no shell
//   Codex        '<node>' '<abs>/runtime/bin/hook.mjs' <event> --host ad          Codex runs hooks through a shell
//
// One route per host and dispatcher event. A route serves "steps", the hook
// ids of runtime/profiles/profiles.json: a profile picks steps and the routes
// serving them are installed, so no step runs from two entries. ad's older
// entries (`ad hook <name>`, `ad session-start`, `ad query-retrieve`,
// `ad digest`) are recognised and replaced by the route serving the same step;
// a step found installed is kept even when the profile doesn't name it, so
// re-running `ad init` never drops a guard the user had.
//
// No imports beyond node built-ins: the plugin's dispatcher loads this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_PATH = fileURLToPath(new URL("../../bin/hook.mjs", import.meta.url));

/** The dispatcher's events (runtime/bin/hook.mjs). `stop` has no route: there is no Stop work yet. */
export const EVENTS = Object.freeze(["tool.before", "tool.after", "prompt.submit", "session.start", "session.end", "stop", "subagent.stop", "skill.use", "bash.guard", "mcp.audit"]);

/**
 * The route table, one row per host event and dispatcher event.
 * - steps: what the route runs; matcher: the tool names it matches when it runs any step
 * - stepMatchers: tool names one step adds to the matcher (the step runs for those tools)
 * - hosts: the hosts that have this event (default: every host)
 * - timeout: seconds on Claude Code (Codex: at least 10, SessionEnd 3)
 */
export const ROUTES = Object.freeze([
  { event: "session.start", hostEvent: "SessionStart", steps: ["session-start"], timeout: 10 },
  { event: "session.end", hostEvent: "SessionEnd", steps: ["session-end"], timeout: 10 },
  { event: "prompt.submit", hostEvent: "UserPromptSubmit", steps: ["user-prompt-extract", "capability-route-advice", "query-retrieve"], timeout: 10 },
  { event: "tool.before", hostEvent: "PreToolUse", matcher: ["Bash", "PowerShell", "Write", "Edit"], steps: ["rules-check"], timeout: 5 },
  { event: "bash.guard", hostEvent: "PreToolUse", matcher: ["Bash"], steps: ["bash-pre-guard"], timeout: 5 },
  { event: "mcp.audit", hostEvent: "PreToolUse", matcher: ["mcp__.*"], steps: ["mcp-pre-audit"], timeout: 5 },
  { event: "skill.use", hostEvent: "PreToolUse", matcher: ["Skill"], steps: ["skill-use"], hosts: ["claude"], timeout: 5 },
  { event: "skill.use", hostEvent: "UserPromptExpansion", steps: ["slash-command-use"], hosts: ["claude"], timeout: 5 },
  { event: "tool.after", hostEvent: "PostToolUse", steps: [], stepMatchers: { "scheduled-hashes": ["CronCreate", "ScheduleWakeup"], "bash-post-log": ["Bash"], "edit-post-lint": ["Edit", "Write", "MultiEdit"] }, timeout: 5 },
  { event: "subagent.stop", hostEvent: "SubagentStop", steps: ["subagent-hashes"], hosts: ["claude"], timeout: 5 },
]);

/**
 * Steps every install has, whatever the profile:
 * - rules-check: tool.before, installed at setup (02 §3); with no rules it prints nothing
 * - scheduled-hashes, subagent-hashes: CronCreate/ScheduleWakeup inputs and
 *   SubagentStop messages come back as prompts that look typed (02 §2.1)
 */
export const ALWAYS_STEPS = Object.freeze({ claude: ["rules-check", "scheduled-hashes", "subagent-hashes"], codex: ["rules-check"] });

// Codex's tool names (apply_patch also matches Edit and Write); a name it never sends is dropped.
const CODEX_TOOLS = new Set(["Bash", "Edit", "Write"]);
const isPattern = (name) => /[^A-Za-z0-9_]/.test(name);
const toolOn = (host, name) => host !== "codex" || isPattern(name) || CODEX_TOOLS.has(name);
const timeoutFor = (r, host) => (host !== "codex" ? r.timeout : r.hostEvent === "SessionEnd" ? 3 : Math.max(r.timeout, 10));

/**
 * The routes that serve `steps` (and the always-installed steps) on `host`.
 * @returns {{event:string, hostEvent:string, matcher:string|null, steps:string[], timeout:number}[]}
 */
export function routesFor(steps, host = "claude") {
  const want = new Set([...steps, ...(ALWAYS_STEPS[host] ?? [])]);
  const out = [];
  for (const r of ROUTES) {
    if (r.hosts && !r.hosts.includes(host)) continue;
    const served = r.steps.filter((s) => want.has(s));
    const names = served.length ? [...(r.matcher ?? [])] : [];
    for (const [s, m] of Object.entries(r.stepMatchers ?? {})) {
      const on = m.filter((n) => toolOn(host, n));
      if (!want.has(s) || !on.length) continue;
      served.push(s);
      names.push(...on);
    }
    if (!served.length) continue;
    const matcher = [...new Set(names)].filter((n) => toolOn(host, n));
    if ((r.matcher || r.stepMatchers) && !matcher.length) continue;
    out.push({ event: r.event, hostEvent: r.hostEvent, matcher: matcher.length ? matcher.join("|") : null, steps: served, timeout: timeoutFor(r, host) });
  }
  return out;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A Claude Code settings.json hook group for one route. Exec form (no shell);
 * a command string (form "string") for a Claude Code older than the exec form was verified on
 * (EXEC_FORM_MIN_VERSION), where `args` might be ignored and node would read
 * the payload as code.
 */
export function claudeGroup(route, { hookPath = HOOK_PATH, form = "exec", oldPluginTags = false } = {}) {
  // A memory plugin from before the dispatcher stands aside only for ad's older command
  // words; after a shell comment they change nothing else (a shell without # comments
  // would pass them as arguments, which the dispatcher ignores). Single quotes: Claude
  // Code runs command strings through bash (Git Bash on Windows), where a backslash or
  // `$` in a double-quoted path could be read.
  const tag = oldPluginTags ? OLD_PLUGIN_TAGS[route.event] : null;
  const handler =
    form === "string" || tag
      ? { type: "command", command: `node ${shQuote(hookPath)} ${route.event}${tag ? ` # ${tag}` : ""}`, timeout: route.timeout }
      : { type: "command", command: "node", args: [hookPath, route.event], timeout: route.timeout };
  return route.matcher ? { matcher: route.matcher, hooks: [handler] } : { hooks: [handler] };
}

/**
 * The words the memory plugin's duplicate guard looked for before the dispatcher
 * (agent-daemon-memory 3.1.0 and older), per route: written while such a plugin
 * is on, so it doesn't run each memory step a second time.
 */
export const OLD_PLUGIN_TAGS = Object.freeze({ "prompt.submit": "ad hook user-prompt-extract ad query-retrieve", "session.start": "ad session-start" });

/** Exec-form hooks (command + args) are verified from this Claude Code version (S-HOOKS). */
export const EXEC_FORM_MIN_VERSION = "2.1.314";

// ad's older entries: `ad …`, `agent-daemon …` or node with ad's own runtime/src/cli.mjs, then the step.
// Another tool's cli.mjs with a step-like word is never ad's.
const LEGACY_RE = /(?:(?:^|[\s"'/\\])(?:ad|agent-daemon)(?:\.cmd|\.ps1|\.exe)?["']?|[\\/]runtime[\\/]src[\\/]cli\.mjs["']?)\s+(hook\s+[\w-]+|session-start|query-retrieve|digest)(?=\s|$|["'])/;
const LEGACY_STEPS = {
  "hook bash-pre": "bash-pre-guard",
  "hook bash-post": "bash-post-log",
  "hook edit-post": "edit-post-lint",
  "hook mcp-pre": "mcp-pre-audit",
  "hook user-prompt-extract": "user-prompt-extract",
  "hook capability-route-advice": "capability-route-advice",
  "hook skill-use": "skill-use",
  "hook session-end-digest": "session-end",
  "session-start": "session-start",
  "query-retrieve": "query-retrieve",
  digest: "session-end",
};
// The dispatcher: ad's runtime/bin/hook.mjs, or the memory plugin's server/hook.mjs (with --plugin).
// Another tool's hook.mjs is never ad's.
const DISPATCH_ARG_RE = /(?:^|[\\/])runtime[\\/]bin[\\/]hook\.mjs$/i;
const PLUGIN_ARG_RE = /(?:^|[\\/])server[\\/]hook\.mjs$/i;

// A shell command's words: '…' (with sh's '\'' escape), "…", or bare.
const shellWords = (command) => [...String(command).matchAll(/'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2] ?? m[3]));

function stepsOfRoute(event, hostEvent, matcher) {
  const names = new Set(String(matcher ?? "").split("|"));
  const steps = [];
  for (const r of ROUTES) {
    if (r.event !== event || (hostEvent && r.hostEvent !== hostEvent)) continue;
    steps.push(...(r.steps ?? []));
    for (const [s, m] of Object.entries(r.stepMatchers ?? {})) if (m.some((n) => names.has(n))) steps.push(s);
  }
  return [...new Set(steps)];
}

/**
 * What one handler in a host's hook config is to ad: a dispatcher route, an
 * older `ad …` entry, or null (not ad's, or not one ad knows). `plugin`: the
 * memory plugin's own entry (--plugin), which passes through when ad's runs.
 * @returns {{kind:"dispatcher"|"legacy", event:string|null, steps:string[], plugin:boolean}|null}
 */
export function classifyHandler(handler, { hostEvent = null, matcher = null } = {}) {
  if (!handler || typeof handler !== "object") return null;
  const args = Array.isArray(handler.args) ? handler.args.map(String) : null;
  const command = String(handler.command ?? "");
  const plugin = Boolean(args?.includes("--plugin")) || /\s--plugin(?=\s|$|["'])/.test(command);
  let event = null;
  let script = null;
  const isScript = (s) => DISPATCH_ARG_RE.test(s) || (plugin && PLUGIN_ARG_RE.test(s));
  if (args && args.length >= 2 && EVENTS.includes(args[1]) && isScript(args[0])) [script, event] = args;
  else if (!args) {
    const words = shellWords(command);
    const i = words.findIndex((w, k) => isScript(w) && EVENTS.includes(words[k + 1]));
    if (i >= 0) [script, event] = [words[i], words[i + 1]];
  }
  if (event) return { kind: "dispatcher", event, steps: stepsOfRoute(event, hostEvent, matcher), plugin, script };
  const lm = command.match(LEGACY_RE);
  if (!lm) return null;
  const sub = lm[1].replace(/\s+/g, " ");
  const step = sub === "hook skill-use" && hostEvent === "UserPromptExpansion" ? "slash-command-use" : LEGACY_STEPS[sub];
  return step ? { kind: "legacy", event: null, steps: [step], plugin: false, script: null } : null;
}

/**
 * The entry can run: a dispatcher route's script is still there (an `ad init`
 * run from a checkout or cache that is gone leaves a dead path). Older `ad …`
 * entries go through PATH and the plugin's through its own variable: assumed live.
 */
export function entryAlive(info, { exists = fs.existsSync } = {}) {
  if (info?.kind !== "dispatcher" || info.plugin || !info.script || !path.isAbsolute(info.script)) return true;
  return exists(info.script);
}

/** Every ad handler in a hooks map ({<HostEvent>: [{matcher, hooks: [...]}]}). */
export function ourHandlers(hooks) {
  const out = [];
  for (const [hostEvent, groups] of Object.entries(hooks && typeof hooks === "object" ? hooks : {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const info = classifyHandler(h, { hostEvent, matcher: g.matcher });
        if (info) out.push({ hostEvent, matcher: g.matcher || null, handler: h, info });
      }
    }
  }
  return out;
}

/** The steps ad's entries in a hooks map run (live: only entries whose script is still there). */
export function installedSteps(hooks, { live = false } = {}) {
  return new Set(ourHandlers(hooks).filter((o) => !live || entryAlive(o.info)).flatMap((o) => o.info.steps));
}

const foldCase = process.platform === "win32" || process.platform === "darwin";
// One entry as a comparable string: keys sorted, the script path case-folded where the file system is.
const canon = (hostEvent, matcher, h) => {
  const x = { ...h };
  if (foldCase && Array.isArray(x.args)) x.args = x.args.map((a, i) => (i === 0 ? String(a).toLowerCase() : a));
  if (foldCase && !x.args && typeof x.command === "string") x.command = x.command.toLowerCase();
  return JSON.stringify([hostEvent, matcher || null, Object.keys(x).sort().map((k) => [k, x[k]])]);
};

/**
 * What a new route keeps from the entries of ad's it replaces (the user's own
 * edits): `onFailure` from a route of the same event (the review service sets
 * it once rules exist; "block" wins); `if` and `async` when every replaced entry
 * agrees; the longest timeout; for a route with no matcher of its own, a
 * matcher every replaced entry shares (SessionStart "startup", say).
 */
function carryInto(group, route, ours) {
  const h = group.hooks[0];
  const prev = ours.filter((o) => o.hostEvent === route.hostEvent && o.info.steps.some((s) => route.steps.includes(s)));
  const failures = ours.filter((o) => o.info.kind === "dispatcher" && o.hostEvent === route.hostEvent && o.info.event === route.event && o.handler.onFailure !== undefined).map((o) => o.handler.onFailure);
  if (failures.length) h.onFailure = failures.includes("block") ? "block" : failures[0];
  if (!prev.length) return group;
  for (const key of ["if", "async"]) {
    const vals = prev.map((o) => o.handler[key]);
    if (vals[0] !== undefined && vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]))) h[key] = vals[0];
  }
  const longest = Math.max(...prev.map((o) => (Number.isFinite(o.handler.timeout) ? o.handler.timeout : 0)));
  if (longest > h.timeout) h.timeout = longest;
  const spec = ROUTES.find((r) => r.event === route.event && r.hostEvent === route.hostEvent);
  if (!spec?.matcher && !spec?.stepMatchers) {
    const ms = prev.map((o) => o.matcher ?? "");
    if (ms[0] && ms[0] !== "*" && ms.every((m) => m === ms[0])) group.matcher = ms[0];
  }
  return group;
}

/**
 * The Claude Code hooks map with ad's routes in place: ad's older entries and
 * routes elsewhere are removed, every step they ran stays served (carrying the
 * user's settings on them, carryInto), the user's own hooks are untouched. An
 * install that is already exactly this is left alone.
 * @param {object} hooks  settings.json `hooks`
 * @param {{steps?: string[], hookPath?: string, form?: "exec"|"string", oldPluginTags?: boolean}} opts
 *   steps: the profile's; oldPluginTags: a memory plugin from before the dispatcher is on (OLD_PLUGIN_TAGS)
 * @returns {{hooks: object, changed: boolean, routes: object[], removed: object[]}}
 */
export function planClaudeHooks(hooks, { steps = [], hookPath = HOOK_PATH, form = "exec", oldPluginTags = false } = {}) {
  const current = hooks && typeof hooks === "object" && !Array.isArray(hooks) ? hooks : {};
  const ours = ourHandlers(current);
  const routes = routesFor([...new Set([...steps, ...ours.flatMap((o) => o.info.steps)])], "claude");
  const groups = routes.map((route) => ({ route, group: carryInto(claudeGroup(route, { hookPath, form, oldPluginTags }), route, ours) }));
  // Already exactly these routes, each once, and nothing else of ad's: leave the file alone.
  const have = ours.map((o) => canon(o.hostEvent, o.matcher, o.handler)).sort();
  const want = groups.map(({ route, group }) => canon(route.hostEvent, group.matcher, group.hooks[0])).sort();
  if (JSON.stringify(have) === JSON.stringify(want)) return { hooks: current, changed: false, routes, removed: [] };

  const next = {};
  for (const [hostEvent, groups] of Object.entries(current)) {
    if (!Array.isArray(groups)) {
      next[hostEvent] = groups;
      continue;
    }
    const kept = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) {
        kept.push(g);
        continue;
      }
      const hs = g.hooks.filter((h) => !classifyHandler(h, { hostEvent, matcher: g.matcher }));
      if (hs.length) kept.push(hs.length === g.hooks.length ? g : { ...g, hooks: hs });
    }
    next[hostEvent] = kept;
  }
  for (const { route, group } of groups) (next[route.hostEvent] ??= []).push(group);
  // A host event that only held ad's older entries, and now none, goes.
  for (const [hostEvent, groups] of Object.entries(next)) if (Array.isArray(groups) && !groups.length && current[hostEvent]?.length) delete next[hostEvent];
  return { hooks: next, changed: true, routes, removed: ours };
}

/** Claude Code's settings files that can hold hooks: the user's, the project's, the project's local one. */
export function claudeSettingsFiles({ env = process.env, home = os.homedir(), cwd = env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const userDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  const files = [path.join(userDir, "settings.json")];
  if (cwd) files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  return files;
}

const readHooks = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))?.hooks ?? null;
  } catch {
    return null;
  }
};

/**
 * One of ad's own entries runs `step` in Claude Code (any settings file). An
 * entry with an `if` condition doesn't count (it may not fire), nor one whose
 * script is gone (it can't run). The plugin's dispatcher passes a step through
 * when this is true, so nothing runs twice.
 */
export function adStepInClaudeSettings(step, opts = {}) {
  return claudeSettingsFiles(opts).some((file) => ourHandlers(readHooks(file)).some((o) => !o.info.plugin && o.handler.if === undefined && entryAlive(o.info) && o.info.steps.includes(step)));
}

/**
 * Steps run by more than one of ad's entries across the given sources.
 * @param {{name:string, hooks:object}[]} sources
 * @returns {{step:string, entries:{source:string, hostEvent:string, kind:string, event:string|null}[]}[]}
 */
export function duplicateSteps(sources) {
  const by = new Map();
  for (const { name, hooks } of sources) {
    for (const o of ourHandlers(hooks)) {
      for (const step of o.info.steps) {
        if (!by.has(step)) by.set(step, []);
        by.get(step).push({ source: name, hostEvent: o.hostEvent, kind: o.info.kind, event: o.info.event });
      }
    }
  }
  return [...by].filter(([, e]) => e.length > 1).map(([step, entries]) => ({ step, entries }));
}

/** Claude Code's hooks from each settings file that exists and parses, for doctor. */
export function claudeHookSources(opts = {}) {
  return claudeSettingsFiles(opts)
    .map((file) => ({ name: file, hooks: readHooks(file) }))
    .filter((s) => s.hooks);
}
