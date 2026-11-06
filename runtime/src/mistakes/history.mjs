// The mistakes report's history reader (plan L4a, D13, D31). Read-only: it
// lists and reads Claude Code transcripts and Codex rollouts and returns the
// prompts the user typed. It never writes, never spawns and never opens a
// socket; `mistakes-cli.test.mjs` checks all three.
//
// What counts as typed (S-HISTORY, 06 §1):
//   Claude Code  <config>/projects/<slug>/<session>.jsonl, top level only
//                (subagents live in <session>/subagents/, older sidechains in
//                agent-*.jsonl). Dropped: isMeta, isSidechain,
//                isCompactSummary, promptSource "system", non-typed origins
//                (task notifications, schedules), tool_result entries,
//                command wrappers, injected reminders, generated prompts.
//   Codex        $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl and
//                archived_sessions/. Typed text is a user response_item that
//                isn't injected context; event_msg user_message is the legacy
//                fallback. Subagent rollouts are skipped (they embed the
//                parent's history).
// Resumed and forked copies repeat entries; prompts are deduplicated by the
// entry's uuid (Claude Code) or item id (Codex).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { typedText } from "../hooks/typed-text.mjs";

export const HOSTS = Object.freeze({ claude: "Claude Code", codex: "Codex" });

/** Claude Code's folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir({ env = process.env, home = os.homedir() } = {}) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
}

/** The user's Codex home: CODEX_HOME, else ~/.codex. */
export function codexHomeDir({ env = process.env, home = os.homedir() } = {}) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
}

/** Claude Code names a project folder after its cwd with every non-alphanumeric character as "-". */
export function claudeProjectSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The project a folder belongs to: the nearest folder above it with a .git.
 * Without one (a home folder, a folder of projects) the folder itself, and
 * then only sessions started in exactly that folder count.
 * @returns {{root:string, git:boolean}}
 */
export function findProject(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return { root: dir, git: true };
    const up = path.dirname(dir);
    if (up === dir) return { root: path.resolve(cwd), git: false };
    dir = up;
  }
}

export const projectRoot = (cwd) => findProject(cwd).root;

const caseFold = process.platform === "win32" || process.platform === "darwin";
const fold = (s) => (caseFold ? s.toLowerCase() : s);
const norm = (p) => fold(path.resolve(String(p)).replace(/[\\/]+$/, ""));

/** Is `dir` the project root or (unless `exact`) a folder inside it? */
export function inProject(dir, root, { exact = false } = {}) {
  if (!dir || !root) return false;
  const d = norm(dir);
  const r = norm(root);
  return d === r || (!exact && d.startsWith(r + path.sep));
}

const safeStat = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};
const safeList = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * List the transcript files without opening them (the consent screen shows
 * this before anything is read).
 * @returns {{root:string|null, claude:{dir:string, exists:boolean, projects:number, files:object[]}, codex:{dir:string, exists:boolean, files:object[], compressed:number}}}
 */
export function listSources({ env = process.env, home = os.homedir(), cwd = process.cwd(), allProjects = false } = {}) {
  const project = allProjects ? null : findProject(cwd);
  const root = project?.root ?? null;
  const exactFolder = project ? !project.git : false;
  const claudeDir = path.join(claudeConfigDir({ env, home }), "projects");
  const claude = { dir: claudeDir, exists: Boolean(safeStat(claudeDir)?.isDirectory()), projects: 0, files: [] };
  // Slugs keep the drive letter's case as the session saw it (c:\ from some terminals).
  const rootSlug = root ? fold(claudeProjectSlug(root)) : null;
  for (const d of safeList(claudeDir)) {
    if (!d.isDirectory()) continue;
    // A folder inside the project has a longer slug with the same start; the
    // entries' own cwd decides later (slugs collide: "a-b" and "a_b").
    const slug = fold(d.name);
    if (rootSlug && !(slug === rootSlug || (!exactFolder && slug.startsWith(rootSlug + "-")))) continue;
    let any = false;
    for (const f of safeList(path.join(claudeDir, d.name))) {
      if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith("agent-")) continue;
      const p = path.join(claudeDir, d.name, f.name);
      const st = safeStat(p);
      if (!st) continue;
      claude.files.push({ host: "claude", path: p, slug: d.name, exact: slug === rootSlug, mtimeMs: st.mtimeMs, size: st.size });
      any = true;
    }
    if (any) claude.projects++;
  }

  const codexDir = codexHomeDir({ env, home });
  const codex = { dir: codexDir, exists: Boolean(safeStat(codexDir)?.isDirectory()), files: [], compressed: 0 };
  const walk = (dir, depth) => {
    for (const e of safeList(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst"))) {
        const st = safeStat(p);
        if (!st) continue;
        const zst = e.name.endsWith(".zst");
        if (zst && typeof zlib.zstdDecompressSync !== "function") {
          codex.compressed++;
          continue;
        }
        codex.files.push({ host: "codex", path: p, zst, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(path.join(codexDir, "sessions"), 0);
  walk(path.join(codexDir, "archived_sessions"), 0);
  return { root, exactFolder, claude, codex };
}

// Text that is a wrapper around something the user didn't type, or a prompt
// a client generated: one definition, shared with the prompt hook.
export { typedText };

// Origins of prompts no one typed (S-HOOKS: task notifications carry
// promptSource "system" and origin.kind "task-notification").
const NON_TYPED_ORIGIN = /notification|schedul|cron|wake|loop|cross|session|agent|hook|system|queue|remote|channel/i;

function claudeText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === "tool_result")) return null;
  const parts = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
  return parts.length ? parts.join("\n") : null;
}

// The readers take a file's text or its lines (readPrompts splits once for both readers).
const linesOf = (raw) => (Array.isArray(raw) ? raw : String(raw ?? "").split("\n"));

const toMs = (ts) => {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
};

// Headless `claude -p` runs: scripts, CI and plugins more often than a person.
const CLAUDE_AUTOMATED_ENTRYPOINT = /^sdk-cli$/;

/**
 * Typed prompts in one Claude Code transcript. Prompts from headless runs
 * come back tagged `automated` (the report counts them apart).
 * @param {string} raw  the file's text
 * @param {{root?:string|null, exactFolder?:boolean, exact?:boolean, file?:string}} opts
 *   root: the project (null: every project); exactFolder: no subfolders;
 *   exact: this file's slug is the project's own (used when an entry has no cwd)
 */
export function claudePrompts(raw, { root = null, exactFolder = false, exact = true, file = "" } = {}) {
  const out = [];
  for (const line of linesOf(raw)) {
    // Prefilter (S-HISTORY): only user entries, and prompts typed while the
    // agent was working (queued_command attachments), can hold a typed prompt.
    const queued = line.includes('"queued_command"');
    if (!queued && !line.includes('"type":"user"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || e.isMeta || e.isSidechain || e.isCompactSummary) continue;
    let content;
    let id;
    if (e.type === "user") {
      if (e.promptSource === "system") continue;
      if (e.origin?.kind && NON_TYPED_ORIGIN.test(String(e.origin.kind))) continue;
      if (e.toolUseResult !== undefined) continue;
      content = e.message?.content ?? e.content;
      id = e.uuid;
    } else if (e.type === "attachment" && e.attachment?.type === "queued_command") {
      // A prompt sent mid-turn is kept only as this attachment (the queue
      // records it as "absorbed_mid_turn"); source_uuid names the command.
      if ((e.attachment.commandMode ?? "prompt") !== "prompt") continue;
      if (e.attachment.origin?.kind && NON_TYPED_ORIGIN.test(String(e.attachment.origin.kind))) continue;
      content = e.attachment.prompt;
      id = e.attachment.source_uuid ?? e.uuid;
    } else continue;
    if (root && (e.cwd ? !inProject(e.cwd, root, { exact: exactFolder }) : !exact)) continue;
    const text = typedText(claudeText(content));
    if (!text) continue;
    out.push({
      host: "claude",
      id: typeof id === "string" && id ? `cc:${id}` : `cc:${hashOf(`${e.timestamp}|${text}`)}`,
      ts: toMs(e.timestamp),
      text,
      cwd: e.cwd ?? null,
      session: e.sessionId ?? file,
      automated: CLAUDE_AUTOMATED_ENTRYPOINT.test(String(e.entrypoint ?? "")),
    });
  }
  return out;
}

function codexText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/**
 * Typed prompts in one Codex rollout.
 * @param {string} raw
 * @param {{root?:string|null, exactFolder?:boolean, file?:string}} opts
 */
export function codexPrompts(raw, { root = null, exactFolder = false, file = "" } = {}) {
  const responses = [];
  const legacy = [];
  let cwd = null;
  let session = file;
  let automated = false;
  const outside = () => root && cwd && !inProject(cwd, root, { exact: exactFolder });
  for (const line of linesOf(raw)) {
    const meta = line.includes('"session_meta"') || (cwd === null && line.includes('"turn_context"'));
    if (!meta && !line.includes('"role":"user"') && !line.includes('"user_message"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o?.payload;
    if (!p || typeof p !== "object") continue;
    if (o.type === "session_meta") {
      // A subagent's rollout embeds its parent's history with no boundary.
      if (p.source && typeof p.source === "object" && p.source.subagent) return [];
      if (typeof p.thread_source === "string" && /subagent|review|agent/i.test(p.thread_source)) return [];
      cwd ??= p.cwd ?? null;
      session = p.session_id ?? p.id ?? session;
      // `codex exec` runs: scripts and CI more often than a person.
      automated = p.originator === "codex_exec" || p.source === "exec";
      if (outside()) return [];
      continue;
    }
    if (o.type === "turn_context") {
      cwd ??= p.cwd ?? null;
      if (outside()) return [];
      continue;
    }
    if (o.type === "response_item" && p.type === "message" && p.role === "user") {
      const text = typedText(codexText(p.content));
      if (text) responses.push({ id: p.id, ts: toMs(o.timestamp), text });
    } else if (o.type === "event_msg" && p.type === "user_message") {
      const text = typedText(String(p.message ?? ""));
      if (text) legacy.push({ id: null, ts: toMs(o.timestamp), text });
    }
  }
  if (root && !(cwd && inProject(cwd, root, { exact: exactFolder }))) return [];
  // One source per file, never both: the same prompt is in each.
  const picked = responses.length ? responses : legacy;
  return picked.map((r) => ({
    host: "codex",
    id: r.id ? `cx:${r.id}` : `cx:${hashOf(`${r.ts}|${r.text}`)}`,
    ts: r.ts,
    text: r.text,
    cwd,
    session,
    automated,
  }));
}

function hashOf(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

// ---- tool calls (for replaying a rule over history, plan L4c) ---------------------

/** The OS a session ran on, from its folder's spelling. */
export function osOfPath(p) {
  const s = String(p ?? "");
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(s)) return "windows";
  if (/^\/Users\//.test(s) || /^\/Volumes\//.test(s)) return "macos";
  return "linux";
}

const CLAUDE_CALL_TOOLS = new Set(["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * The shell and file-write calls the agent made in one Claude Code transcript.
 * @returns {{host:string, id:string, tool:string, input:object, cwd:string|null, os:string, ts:number|null, automated:boolean}[]}
 */
export function claudeToolCalls(raw, { root = null, exactFolder = false, exact = true } = {}) {
  const out = [];
  for (const line of linesOf(raw)) {
    if (!line.includes('"tool_use"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "assistant" || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    if (root && (e.cwd ? !inProject(e.cwd, root, { exact: exactFolder }) : !exact)) continue;
    for (const b of e.message.content) {
      if (b?.type !== "tool_use" || !CLAUDE_CALL_TOOLS.has(b.name) || !b.input || typeof b.input !== "object") continue;
      out.push({ host: "claude", id: `cc:${b.id ?? hashOf(line)}`, tool: b.name, input: b.input, cwd: e.cwd ?? null, os: osOfPath(e.cwd), ts: toMs(e.timestamp), automated: CLAUDE_AUTOMATED_ENTRYPOINT.test(String(e.entrypoint ?? "")) });
    }
  }
  return out;
}

const CODEX_SHELL = new Set(["shell", "shell_command", "exec_command", "container.exec", "local_shell", "exec"]);

/** The shell and patch calls in one Codex rollout (subagent rollouts skipped). */
export function codexToolCalls(raw, { root = null, exactFolder = false } = {}) {
  const out = [];
  let cwd = null;
  let automated = false;
  for (const line of linesOf(raw)) {
    const meta = line.includes('"session_meta"') || line.includes('"turn_context"');
    if (!meta && !line.includes('"function_call"') && !line.includes('"custom_tool_call"') && !line.includes('"local_shell_call"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o?.payload;
    if (!p || typeof p !== "object") continue;
    if (o.type === "session_meta") {
      if (p.source && typeof p.source === "object" && p.source.subagent) return [];
      if (typeof p.thread_source === "string" && /subagent|review|agent/i.test(p.thread_source)) return [];
      cwd ??= p.cwd ?? null;
      automated = p.originator === "codex_exec" || p.source === "exec";
      continue;
    }
    if (o.type === "turn_context") {
      cwd = p.cwd ?? cwd;
      continue;
    }
    if (o.type !== "response_item") continue;
    let call = null;
    if (p.type === "function_call" && CODEX_SHELL.has(p.name)) {
      let args = {};
      try {
        args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? {};
      } catch {
        args = { command: String(p.arguments ?? "") };
      }
      const command = args.command ?? args.cmd;
      if (command == null) continue;
      call = { tool: "shell", input: { command }, cwd: args.workdir ?? args.cwd ?? cwd };
    } else if (p.type === "local_shell_call" && p.action?.command) {
      call = { tool: "shell", input: { command: p.action.command }, cwd: p.action.working_directory ?? cwd };
    } else if ((p.type === "custom_tool_call" || p.type === "function_call") && p.name === "apply_patch") {
      let patch = p.input;
      if (patch == null) {
        try {
          patch = JSON.parse(p.arguments ?? "{}").input;
        } catch {
          patch = null;
        }
      }
      if (typeof patch !== "string") continue;
      call = { tool: "apply_patch", input: { patch }, cwd };
    }
    if (!call) continue;
    if (root && !(call.cwd && inProject(call.cwd, root, { exact: exactFolder }))) continue;
    out.push({ host: "codex", id: `cx:${p.call_id ?? p.id ?? hashOf(line)}`, ...call, os: osOfPath(call.cwd), ts: toMs(o.timestamp), automated });
  }
  return out;
}

// The first line of a file, read in chunks (a session_meta line carries the
// base instructions, so it can be tens of KB); null past `max` bytes.
function firstLine(file, max = 4 << 20) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    const buf = Buffer.alloc(64 << 10);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
      if (total > max) return null;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Does this rollout's session_meta say it ran in another folder? (Unknown means read it.) */
function otherProject(file, root, exactFolder) {
  const line = firstLine(file);
  if (!line) return false;
  try {
    const o = JSON.parse(line);
    const cwd = o?.type === "session_meta" ? o.payload?.cwd : null;
    return typeof cwd === "string" && !inProject(cwd, root, { exact: exactFolder });
  } catch {
    return false;
  }
}

function readText(file) {
  const buf = fs.readFileSync(file.path);
  return (file.zst ? zlib.zstdDecompressSync(buf) : buf).toString("utf8");
}

/**
 * Read every listed file and return the typed prompts, deduplicated and in
 * time order. Prompts from headless runs (`claude -p`, `codex exec`) are
 * counted in stats.automated and left out unless `automated` is set. With
 * `calls`, the agents' shell and file-write calls come back too (the same
 * read; scripted runs left out the same way).
 * @param {ReturnType<typeof listSources>} sources
 */
export function readPrompts(sources, { automated = false, calls: withCalls = false } = {}) {
  const seen = new Set();
  const prompts = [];
  const calls = [];
  const seenCalls = new Set();
  const takeCalls = (list) => {
    for (const c of list) {
      if (seenCalls.has(c.id) || (c.automated && !automated)) continue;
      seenCalls.add(c.id);
      calls.push(c);
    }
  };
  const stats = { claude: { files: 0, unreadable: 0 }, codex: { files: 0, unreadable: 0 }, duplicates: 0, automated: 0 };
  const scope = { root: sources.root, exactFolder: Boolean(sources.exactFolder) };
  const take = (list) => {
    for (const p of list) {
      if (seen.has(p.id)) {
        stats.duplicates++;
        continue;
      }
      seen.add(p.id);
      if (p.automated && !automated) {
        stats.automated++;
        continue;
      }
      prompts.push(p);
    }
  };
  for (const f of sources.claude.files) {
    let raw;
    try {
      raw = readText(f);
    } catch {
      stats.claude.unreadable++;
      continue;
    }
    stats.claude.files++;
    const lines = raw.split("\n");
    take(claudePrompts(lines, { ...scope, exact: f.exact, file: path.basename(f.path, ".jsonl") }));
    if (withCalls) takeCalls(claudeToolCalls(lines, { ...scope, exact: f.exact }));
  }
  for (const f of sources.codex.files) {
    // This project only: a rollout whose first line names another folder isn't read further.
    if (scope.root && !f.zst && otherProject(f.path, scope.root, scope.exactFolder)) continue;
    let raw;
    try {
      raw = readText(f);
    } catch {
      stats.codex.unreadable++;
      continue;
    }
    stats.codex.files++;
    const lines = raw.split("\n");
    take(codexPrompts(lines, { ...scope, file: path.basename(f.path) }));
    if (withCalls) takeCalls(codexToolCalls(lines, scope));
  }
  prompts.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  calls.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return withCalls ? { prompts, stats, calls } : { prompts, stats };
}

/** Claude Code's transcript retention: settings.json cleanupPeriodDays, 30 by default. */
export function claudeRetentionDays({ env = process.env, home = os.homedir() } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeConfigDir({ env, home }), "settings.json"), "utf8"));
    const n = Number(s?.cleanupPeriodDays);
    return Number.isFinite(n) && n >= 1 ? n : 30;
  } catch {
    return 30;
  }
}
