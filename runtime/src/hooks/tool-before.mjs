// tool.before (plan L2; L7 design D5, D7, D8, D9, D11): the check before every Bash,
// PowerShell, Write and Edit call (Codex: its shell, patches included). It reads only the
// rules snapshot (guards.json), its sentinel, a folder's .git file for worktrees, and the
// pure matcher: no memory store, no project registry, nothing that can be slow.
//
//   1. the snapshot (both files gone, or a last-good copy older than the sentinel, while
//      guards.active says rules exist → can't check: the failure decision, never "no rules");
//   2. self-protection (L7 P2; always, zero rules included);
//   3. the folder's projects: by the session folder and the call's own folder, each as
//      spelled and as its real path, and — in a git worktree — the main repository's (a
//      worktree gets its own project id, but its main project's rules apply to it);
//   4. the rules: each project's (unless paused there or everywhere; a pause past its end
//      is over) and the global ones (unless paused where the folder is, or everywhere);
//   5. the decision: deny wins over ask; a matcher error or a command too long to read is
//      ask; the host turns ask into deny where it can't or may not ask (D7). A write rule
//      matches against every base a project can be spelled from (stricter is safe).
// The model's text never names a command (S4); the user's line does (systemMessage, which
// no host sends to the model: Codex checked in P0).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadGuards, projectFor, pauseLive, readActive, activeRuleCount } from "./guards.mjs";
import { gitRoots } from "./git-root.mjs";
import { matchRule } from "../rules/match.mjs";
import { neutralText } from "../rules/neutral.mjs";
import { toolDecision, noticeOnly } from "./host-capabilities.mjs";
import { appendRuleEvent } from "./rule-events.mjs";
import { allowability, matchedParts, tryAllowOnce } from "./allow-once.mjs";
import { PRODUCT } from "../product.mjs";
import { FAMILY_TEXT } from "../rules/policy.mjs";
import { currentBranch, defaultBranches } from "./git-branch.mjs";

const OS = { win32: "windows", darwin: "macos" };
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

// node:crypto only when a rule matched: most calls never need it (latency, L2 budgets).
const sha256 = (text) => (process.getBuiltinModule?.("node:crypto") ?? createRequire(import.meta.url)("node:crypto")).createHash("sha256").update(text).digest("hex");

/** The hook payload as a matcher call. */
export function callOf(input, { host, platform = process.platform, root = null } = {}) {
  const os = OS[platform] ?? "linux";
  const name = String(input?.tool_name ?? "");
  const tin = input?.tool_input ?? {};
  let tool = name;
  let callInput = tin;
  if (host === "codex") {
    // Codex names its shell tool Bash (it runs PowerShell on Windows) and sends patches in command.
    if (/^(?:bash|shell|exec_command|shell_command|local_shell)$/i.test(name)) tool = "shell";
    else if (name === "apply_patch") callInput = { patch: tin.command ?? tin.patch ?? tin.input };
  }
  const cwd = input?.cwd ?? null;
  return { tool, input: callInput, os, cwd: cwd ?? root, project_root: root ?? cwd };
}

// Fields that don't change what runs: the model rewrites them on a retry (D9).
const NOT_EXECUTED = new Set(["description", "timeout"]);

/**
 * The canonical call (D9): {tool_name, tool_input} as JSON with sorted keys and every field
 * that changes what runs (unknown fields included), without `description` and `timeout`;
 * on Claude Code also the folder it runs in (Codex hides it: D5), so the same command in
 * another folder is another call.
 */
export function canonicalCall(input, { host = "claude", cwd = undefined } = {}) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  const tin = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const kept = Object.fromEntries(Object.entries(tin).filter(([k]) => !NOT_EXECUTED.has(k)));
  const call = { tool_input: kept, tool_name: String(input?.tool_name ?? "") };
  if (host === "claude") call.cwd = cwd === undefined ? String(input?.cwd ?? "") : cwd;
  return JSON.stringify(sort(call));
}

const realOf = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/** The user-facing name and command (the snapshot says which route wrote it). */
const naming = (snapshot) => {
  const cmd = typeof snapshot?.cmd === "string" && snapshot.cmd ? snapshot.cmd : "ad";
  return { cmd, name: cmd === "ad" ? "ad" : PRODUCT.displayName };
};

/**
 * The projects these folders belong to, each with every base its write globs may be
 * relative to: the root as the snapshot spells it, that root as the folder spells it
 * (reached through a link), and a worktree's own top. The first folder's project is first.
 */
function projectsHere(snapshot, dirs, { platform, realpath }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const out = new Map();
  const add = (found, base) => {
    if (!found) return;
    const e = out.get(found.id) ?? { id: found.id, project: found.project, bases: new Set() };
    e.bases.add(base ?? found.root);
    out.set(found.id, e);
  };
  for (const dir of dirs) {
    add(projectFor(snapshot, dir, { platform }), null);
    const real = realpath(dir);
    if (real && real !== dir) {
      const viaReal = projectFor(snapshot, real, { platform });
      add(viaReal, null);
      // The same root, spelled the way the folder (and the call's paths) spell it — when the
      // link names the root itself or a folder above it (a link into a subfolder has no
      // spelling of the root: the real one serves).
      const rel = viaReal ? p.relative(real, viaReal.root) : null;
      if (viaReal && !rel.split(p.sep).includes("..")) add(viaReal, p.resolve(dir, rel));
    }
    // A worktree (nested ones included, such as Claude Code's own .claude/worktrees/<name>):
    // the main project's rules, with globs relative to the worktree's own top as well.
    const git = gitRoots(real ?? dir, { platform });
    if (git?.worktree) {
      const main = projectFor(snapshot, git.main, { platform });
      if (main) {
        add(main, git.top);
        const rel = real && real !== dir ? p.relative(real, git.top) : null;
        if (rel !== null && !rel.split(p.sep).includes("..")) add(main, p.resolve(dir, rel));
      }
    }
  }
  return [...out.values()];
}

/**
 * The decision when the check itself can't run (an internal error, an unreadable payload,
 * a snapshot that can't be read while rules exist): ask (deny where the host can't or may
 * not ask) while any rule is active; nothing when none is.
 */
/**
 * The snapshot the failure path may judge "no active rules" by (D5, D10): a current one the
 * sentinel vouches for (a known count it holds, the same store); otherwise none, and the
 * sentinel decides. With no sentinel, whatever was read.
 */
export function failSnapshot(g, active) {
  if (!active) return g?.snapshot ?? null;
  const s = g?.source === "current" ? g.snapshot : null;
  if (!s || !Number.isInteger(active.ruleCount)) return null;
  if (active.ruleCount > Number(s.ruleCount ?? 0)) return null;
  if (active.store_id && s.store_id !== active.store_id) return null;
  return s;
}

export function failDecision(input, { host = "claude", snapshot = null, rulesExist = false, now = Date.now(), why = "couldn't check this call against your rules" } = {}) {
  const active = snapshot ? activeRuleCount(snapshot, now) > 0 : rulesExist;
  if (!active) return null;
  const { cmd, name } = naming(snapshot);
  return toolDecision("ask", {
    host,
    permissionMode: input?.permission_mode,
    reason: `${name} ${why}. Tell the user.`,
    notice: `${name}: ${why} · pause rules: \`${cmd} rules pause --all\` · repair: \`${cmd} repair\``,
  });
}

/**
 * Decide one PreToolUse call.
 * @returns {object|null} the JSON to print, or null for no output (the tool runs)
 */
export function toolBefore(input, { host = "claude", env = process.env, root, platform = process.platform, onWarning = null, now = Date.now(), realpath = realOf, log = null, homes = null, gitRead = null } = {}) {
  const opts = root ? { root } : undefined;
  const { snapshot, warning, source } = loadGuards(opts);
  if (warning) onWarning?.(warning);
  if (!snapshot) {
    // Rules exist (the sentinel says so) but neither file can be read: can't check.
    if (readActive(opts)) return failDecision(input, { host, rulesExist: true, now, why: "can't read your rules right now" });
    return warning ? noticeOnly(host, warning) : null;
  }
  // The snapshot in use (current or last-good) must hold every rule the sentinel knows of
  // and come from its store: a truncated, stale or other-store guards.json can't read as
  // "fewer rules" (D5). A check against accidents and naive rewrites: a write past the
  // self-protection filter can forge both files (the filter's limit, stated).
  // rebuildGuards writes the sentinel first, so at worst a call asks while a rule is being
  // added. An unreadable sentinel ({}) can vouch only for the current file.
  const active = readActive(opts);
  if (active) {
    const unknown = !Number.isInteger(active.ruleCount);
    const behind = !unknown && active.ruleCount > Number(snapshot.ruleCount ?? 0);
    // L7 writers always record the store: a snapshot without one while the sentinel names one is not ours.
    const otherStore = Boolean(active.store_id && snapshot.store_id !== active.store_id);
    if (behind || otherStore || (unknown && source === "last-good")) {
      return failDecision(input, { host, rulesExist: true, now, why: source === "last-good" ? "can't read your newest rules right now" : "can't trust the rules file right now" });
    }
  }
  // Nothing in force: no folder lookups, no matching (the common case stays near node's start-up).
  if (activeRuleCount(snapshot, now) === 0) return null;
  // CLAUDE_PROJECT_DIR is Claude Code's; under another host it is an outer session's leftover.
  const sessionDir = host === "claude" ? env.CLAUDE_PROJECT_DIR || null : null;
  const callDir = input?.cwd || null;
  const dirs = [...new Set([sessionDir, callDir].filter(Boolean))];
  const here = projectsHere(snapshot, dirs, { platform, realpath });
  // A pause where the folder is (its own project: the first found) also pauses the global rules there.
  const pausedHere = Boolean(here[0] && pauseLive(here[0].project?.paused, now));
  const candidates = [];
  for (const p of here) {
    if (pauseLive(p.project?.paused, now)) continue;
    for (const r of Array.isArray(p.project?.rules) ? p.project.rules : []) candidates.push({ r, projectId: p.id, bases: [...p.bases] });
  }
  const first = here[0];
  for (const r of Array.isArray(snapshot.global?.rules) ? snapshot.global.rules : []) {
    // The starter safety policy is the user's own level (D18, L7b): a project's pause
    // doesn't lift it there; only a pause of every rule does (activeRuleCount above).
    if (pausedHere && r?.rule?.type !== "policy") continue;
    candidates.push({ r, projectId: first?.id ?? null, bases: first ? [...first.bases] : [callDir ?? sessionDir] });
  }
  // The policy's context, built once and only when a policy rule is judged (L7b design §3).
  let pctx = null;
  const policyContext = () => (pctx ??= lazyPolicyContext({ here, dirs, callDir, sessionDir, env, platform, realpath, homes, gitRead }));
  const hits = [];
  for (const c of candidates) {
    if (!c.r || typeof c.r !== "object" || !c.r.rule) continue;
    // Command rules don't use the base; write rules match against every base (stricter is safe).
    const bases = c.r.rule?.type === "write" ? c.bases : c.bases.slice(0, 1);
    let res = { match: false };
    let call = null;
    for (const base of bases.length ? bases : [null]) {
      call = callOf(input, { host, platform, root: base ?? callDir ?? sessionDir });
      // Lazy: a family reads the folders it needs inside matchRule, whose catch turns a failed read into an ask.
      if (c.r.rule?.type === "policy") call.policy = policyContext();
      res = matchRule(c.r.rule, call);
      if (res.match || res.error) break;
    }
    if (!res.match && !res.error) continue;
    hits.push({ ...c, call, decision: res.error || res.incomplete ? "ask" : c.r.decision === "deny" ? "deny" : "ask" });
  }
  if (!hits.length) return null;
  const lead = hits.find((h) => h.decision === "deny") ?? hits[0];
  // One canonical call and one hash for allow-once, the message and the log (a large Write is hashed once).
  const canonical = canonicalCall(input, { host, cwd: host === "claude" ? realpath(callDir ?? "") ?? String(callDir ?? "") : undefined });
  const callHash = sha256(canonical);
  const writeLog = log ?? ((e) => appendRuleEvent(e, root ? { root, now } : { now }));
  const ruleIds = [...new Set(hits.map((h) => h.r.id).filter((id) => id !== undefined && id !== null))];
  const mode = typeof input?.permission_mode === "string" ? input.permission_mode.slice(0, 40) : null;
  // The user allowed exactly this call once (D9): every rule that stops it must be covered.
  if (ruleIds.length === hits.length && tryAllowOnce(snapshot, { callHash, projectId: lead.projectId ?? null, ruleIds, root: root ?? undefined, now })) {
    writeLog({ project: lead.projectId, rules: ruleIds.map((id) => ({ id })), decision: "passed", host, mode, callId: callHash.slice(0, 6), callHash });
    const { name } = naming(snapshot);
    return noticeOnly(host, `${name}: allowed once: rule ${ruleIds.join(", rule ")}`) ?? {};
  }
  const out = render(input, { host, snapshot, lead, hits, callId: callHash.slice(0, 6) });
  const final = out.hookSpecificOutput.permissionDecision;
  const notAllowable = final === "deny" ? allowability(canonical) : null;
  // Only a stop the user can be shown in full keeps any of its text (its call, its matched parts).
  const keepText = final === "deny" && !notAllowable;
  const entry = {
    project: lead.projectId,
    rules: hits.map((h) => ({ id: h.r.id ?? null, ...(keepText ? { matched: matchedParts(h.r.rule, h.call) } : {}) })),
    decision: final === "deny" ? "stopped" : "asked",
    host,
    mode,
    callId: callHash.slice(0, 6),
    callHash,
  };
  // A stop keeps its call, so the user can see it in full before allowing it once — unless
  // it can't be shown faithfully (too long, a secret, disguising characters): then no text.
  if (notAllowable) entry.notAllowable = notAllowable;
  else if (keepText) entry.call = canonical;
  writeLog(entry);
  return out;
}

function render(input, { host, snapshot, lead, hits, callId }) {
  const { cmd, name } = naming(snapshot);
  const id = lead.r.id ?? "?";
  const tool = String(input?.tool_name ?? "");
  const what = WRITE_TOOLS.has(tool) || /^\s*apply_patch\b/.test(String(input?.tool_input?.command ?? "")) ? "file change" : /^(?:read|grep|notebookread)$/i.test(tool) ? "file read" : "command";
  if (lead.r.rule?.type === "policy") return renderPolicy(input, { host, cmd, name, id, what, family: lead.r.rule.family, callId, more: hits.length - 1 });
  // Re-neutralised here too: a snapshot from an older writer may hold raw words (S4).
  const why = neutralText(lead.r.reason) || "a rule you set";
  const policyToo = hits.some((h) => h.r.rule?.type === "policy") ? " · also the starter safety policy" : "";
  const more = (hits.length > 1 ? ` (+${hits.length - 1} more)` : "") + policyToo;
  const base = `${name} rule ${id}${more}: ${why} · remove: \`${cmd} rules rm ${id}\` · pause rules here: \`${cmd} rules pause\``;
  const trial = toolDecision(lead.decision, { host, permissionMode: input?.permission_mode, reason: `Your rule ${id} (${why}) asks before this ${what}.`, notice: base });
  if (trial.hookSpecificOutput.permissionDecision !== "deny") return trial;
  return toolDecision("deny", {
    host,
    permissionMode: input?.permission_mode,
    reason: `Your rule ${id} (${why}) stops this ${what} here. Tell the user; only they can allow it.`,
    notice: `${base} · allow this once: \`${cmd} rules allow-once ${id} ${callId}\``,
  });
}

/** The starter safety policy's messages (L7b design §4): it asks before; the model is told no command (S4). */
function renderPolicy(input, { host, cmd, name, id, what, family, callId, more }) {
  const text = FAMILY_TEXT[family] ?? "a command the starter safety policy asks before";
  const base = `${name} starter safety policy (rule ${id}${more > 0 ? `, +${more} more` : ""}): asks before ${text} · turn it off: \`${cmd} safety off\` · pause every rule: \`${cmd} rules pause --all\``;
  const trial = toolDecision("ask", { host, permissionMode: input?.permission_mode, reason: `The user's starter safety policy asks before this ${what}: ${text}.`, notice: base });
  if (trial.hookSpecificOutput.permissionDecision !== "deny") return trial;
  return toolDecision("deny", {
    host,
    permissionMode: input?.permission_mode,
    reason: `The user's starter safety policy stops this ${what} here: ${text}. Tell the user; only they can allow it.`,
    notice: `${base} · allow this once: \`${cmd} rules allow-once ${id} ${callId}\``,
  });
}

/**
 * What the policy matcher needs about this folder (L7b design §3): the user's home folders,
 * every spelling of the project folder (registered roots, the git top, a worktree's top),
 * and — read only when a push needs them — the current and default branches.
 */
function policyContextOf({ here, dirs, callDir, sessionDir, env, platform, realpath, homes, gitRead }) {
  const homeList = [];
  const addHome = (h) => {
    if (!h || homeList.includes(h)) return;
    homeList.push(h);
    const real = realpath(h);
    if (real && !homeList.includes(real)) homeList.push(real);
  };
  if (Array.isArray(homes)) homes.forEach(addHome);
  else {
    addHome(env.HOME);
    addHome(env.USERPROFILE);
    try {
      addHome(os.homedir());
    } catch {
      // no home folder known: the expansions find nothing
    }
  }
  const roots = new Set();
  for (const p of here) for (const b of p.bases) if (b) roots.add(b);
  // The git top as the folder spells it and as its real path (a linked folder names both).
  for (const d of dirs) {
    for (const spelled of new Set([d, realpath(d) ?? d])) {
      const g = gitRoots(spelled, { platform });
      if (g?.top) roots.add(g.top);
    }
  }
  const dir = callDir ?? sessionDir;
  const read = gitRead ?? { currentBranch: (d) => currentBranch(d, { platform }), defaultBranches: (d) => defaultBranches(d, { platform }) };
  return { homes: homeList, project_root: [...roots], current_branch: () => (dir ? read.currentBranch(dir) : null), default_branches: () => (dir ? read.defaultBranches(dir) : ["main", "master"]) };
}

/** The policy context with the folder reads deferred until a family asks for them (latency). */
function lazyPolicyContext(args) {
  let built = null;
  const get = () => (built ??= policyContextOf(args));
  return {
    get homes() {
      return get().homes;
    },
    get project_root() {
      return get().project_root;
    },
    current_branch: () => get().current_branch(),
    default_branches: () => get().default_branches(),
  };
}
