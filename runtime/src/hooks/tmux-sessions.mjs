// The tmux own-session record (MCP launch plan L7, D12b). Agents run dev servers in tmux:
// `send-keys|new-window|split-window` into a session the hook saw this agent create in this
// session isn't asked about. A session is recorded (before `tmux new` runs) only when no
// session of the user's can have its name: no server socket yet, or a running server that
// a root-owned tmux at a fixed absolute path says has no such session. Records are kept per
// agent session and keyed by the real socket path; a later target must name the session
// exactly (`=name:` or `=name:win.pane`). The socket is resolved the way tmux resolves it,
// never through $TMPDIR, and anything not literal leaves it unresolved (so it asks).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// tmux sockets are POSIX paths wherever this runs (its records live on the host's own paths).
const P = path.posix;

/** The only tmux binaries ever run (by absolute path; never a PATH lookup). */
export const TRUSTED_TMUX = ["/usr/bin/tmux", "/bin/tmux", "/usr/local/bin/tmux"];

const realpathOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** A literal word (no expansion, glob or home spelling). */
const literal = (v) => typeof v === "string" && v !== "" && !/[$`*?[\]{}~\\]/.test(v);

/** tmux's own options before its subcommand: { S, L, sub, rest }. */
export function tmuxGlobals(args) {
  const out = { S: null, L: null, c: null, sub: null, rest: [] };
  let i = 0;
  for (; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const L = letters[k];
      if ("SLfcT".includes(L)) {
        const val = k < letters.length - 1 ? letters.slice(k + 1) : args[++i];
        if (L === "S") out.S = val === undefined ? "" : String(val);
        else if (L === "L") out.L = val === undefined ? "" : String(val);
        else if (L === "c") out.c = val === undefined ? "" : String(val);
        break;
      }
    }
  }
  out.sub = args[i] === undefined ? null : String(args[i]);
  out.rest = args.slice(i + 1).map(String);
  return out;
}

/** A socket path as tmux will open it: its real path, or its folder's real path and its name. */
function realSocket(p, realpath) {
  if (!p) return null;
  const r = realpath(p);
  if (r) return r;
  const d = realpath(P.dirname(p));
  return d ? P.join(d, P.basename(p)) : p;
}

/**
 * The server socket a tmux command talks to: `-S <path>`; else `-L <name>` under
 * `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/`; else the first field of $TMUX; else the default
 * socket there. TMUX_TMPDIR goes through realpath (set but missing → null); /tmp is taken
 * as it is when its realpath fails. → the real path, or null when it can't be told.
 */
export function resolveSocket({ S, L }, { env = {}, uid, realpath = realpathOrNull, cwd } = {}) {
  if (S !== null && S !== undefined) {
    if (!literal(S)) return null;
    // (A relative path depends on a folder the hook can't follow: never resolved.)
    return P.isAbsolute(S) ? realSocket(S, realpath) : null;
  }
  const dir = () => {
    const t = env.TMUX_TMPDIR;
    if (t !== undefined && t !== "") return literal(t) && P.isAbsolute(t) ? realpath(t) : null;
    return realpath("/tmp") ?? "/tmp";
  };
  if (L !== null && L !== undefined) {
    if (!literal(L) || /[/\\]/.test(L)) return null;
    const d = dir();
    return d ? realSocket(`${d}/tmux-${uid}/${L}`, realpath) : null;
  }
  if (env.TMUX) {
    const first = String(env.TMUX).split(",")[0];
    return first && P.isAbsolute(first) && literal(first) ? realSocket(first, realpath) : null;
  }
  const d = dir();
  return d ? realSocket(`${d}/tmux-${uid}/default`, realpath) : null;
}

/**
 * A call that is one tmux command and nothing else: no separators, pipes, groups or
 * substitutions outside quotes. → its leading literal assignments ({ NAME: value }), or null.
 */
export function loneTmux(line) {
  const t = String(line ?? "").trim();
  let single = false;
  let double = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (single) {
      if (c === "'") single = false;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" && !double) single = true;
    else if (c === '"') double = !double;
    else if (c === "`" || (c === "$" && t[i + 1] === "(")) return null;
    else if (!double && /[;&|()\n\r]/.test(c)) return null;
  }
  if (single || double) return null;
  const words = t.split(/\s+/);
  const assign = {};
  let k = 0;
  for (; k < words.length && /^[A-Za-z_]\w*=/.test(words[k]); k++) {
    const [name, ...v] = words[k].split("=");
    const value = v.join("=").replace(/^(["'])(.*)\1$/, "$2");
    if (/^TMUX(?:_TMPDIR)?$/.test(name)) {
      if (/[$`'"\\]/.test(value)) return null; // not literal (a backslash the shell would drop)
      assign[name] = value;
    }
  }
  return words[k] === "tmux" ? assign : null;
}

/**
 * The environment a call gives its tmux: the hook's, with the call's own literal TMUX or
 * TMUX_TMPDIR prefix applied. Only a lone tmux command is read (anything else → null: the
 * socket can't be told).
 */
export function commandEnv(line, env = {}) {
  const lone = loneTmux(line);
  return lone ? { ...env, ...lone } : null;
}

/** The root-owned tmux at one of the fixed paths (file and folder not group- or world-writable), or null. */
export function trustedTmux({ stat = fs.statSync, realpath = realpathOrNull } = {}) {
  const ok = (s) => s.uid === 0 && (s.mode & 0o022) === 0;
  for (const p of TRUSTED_TMUX) {
    try {
      const real = realpath(p);
      // (Where it really is must be one of those folders too: never home, a temp or the session folder.)
      if (!real || !TRUSTED_TMUX.some((t) => P.dirname(t) === P.dirname(real))) continue;
      const f = stat(real);
      if (f.isFile() && ok(f) && ok(stat(P.dirname(real)))) return real;
    } catch {
      // not there or unreadable: the next one
    }
  }
  return null;
}

const recordFile = (adRoot, sessionId) => path.join(adRoot, "hooks", "tmux", `${String(sessionId).replace(/[^\w.-]/g, "_").slice(0, 120)}.json`);

/** This agent session's recorded tmux sessions: [{ socket, name }]. */
export function readRecords(adRoot, sessionId) {
  if (!adRoot || !sessionId) return [];
  try {
    const j = JSON.parse(fs.readFileSync(recordFile(adRoot, sessionId), "utf8"));
    return Array.isArray(j?.sessions) ? j.sessions.filter((x) => typeof x?.socket === "string" && typeof x?.name === "string") : [];
  } catch {
    return [];
  }
}

function addRecord(adRoot, sessionId, socket, name) {
  const list = readRecords(adRoot, sessionId);
  if (list.some((x) => x.socket === socket && x.name === name)) return;
  list.push({ socket, name });
  const file = recordFile(adRoot, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ sessions: list }));
  fs.renameSync(tmpFile, file);
}

// Session names tmux keeps as they are ("." and ":" it replaces).
const NAME = /^[\w-]+$/;
const NEW_VALUES = "cefFnstxy";

/**
 * The `-s <name>` of a `new-session` (in a cluster too: -ds name); null with `-t` (it joins
 * another session's group) or `-A` (it may attach to an existing session).
 */
function newSessionName(rest) {
  let name = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--" || !a.startsWith("-")) break;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      if (letters[k] === "A") return null;
      if (!NEW_VALUES.includes(letters[k])) continue;
      const val = k < letters.length - 1 ? letters.slice(k + 1) : rest[++i];
      if (letters[k] === "t") return null;
      if (letters[k] === "s") name = val ?? null;
      break;
    }
  }
  return name;
}

/**
 * Before a `tmux new[-session] -s <name>` runs: record it when no session of the user's can
 * have that name. → true when recorded.
 */
export function recordNewSession(argv, { line, env = process.env, uid = process.getuid?.() ?? 0, cwd, adRoot, sessionId, realpath = realpathOrNull, exists = (p) => fs.existsSync(p), spawn = spawnSync, tmuxBin = () => trustedTmux({ realpath }) } = {}) {
  if (!adRoot || !sessionId) return false;
  const g = tmuxGlobals(argv.slice(1));
  g.sub = resolveTmuxCommand(g.sub);
  if (g.sub !== "new-session" || chained(g.rest)) return false;
  const name = newSessionName(g.rest);
  // (A number is the name plain `tmux` gives the user's own sessions.)
  if (!name || !NAME.test(name) || /^\d+$/.test(name)) return false;
  const e = commandEnv(line, env);
  if (!e) return false;
  const socket = resolveSocket(g, { env: e, uid, realpath, cwd });
  if (!socket) return false;
  if (exists(socket)) {
    // A server is running: only a trusted tmux may say the name is free.
    const bin = tmuxBin();
    if (!bin) return false;
    // Free only on tmux's own answer that the session isn't there (exit 1 is every error too).
    const r = spawn(bin, ["-S", socket, "has-session", "-t", `=${name}`], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 2000, shell: false, windowsHide: true });
    if (r?.error || r?.status !== 1 || !/can't find session/i.test(String(r?.stderr ?? ""))) return false;
  }
  addRecord(adRoot, sessionId, socket, name);
  return true;
}

const OWN_SUBS = new Set(["send-keys", "send", "new-window", "neww", "split-window", "splitw"]);

// Each subcommand's options (tmux 3.8): flags, and letters that take a value. tmux reads
// options up to the first word that isn't one; a letter not listed (a newer tmux) → no match.
const SUB_OPTS = {
  "send-keys": { flags: "FHKlMRX", values: "cNt" },
  "new-window": { flags: "abdkPS", values: "ceFnt" },
  "split-window": { flags: "bdfhIvPZ", values: "BceFlmpRsSTt" },
};
SUB_OPTS.send = SUB_OPTS["send-keys"];
SUB_OPTS.neww = SUB_OPTS["new-window"];
SUB_OPTS.splitw = SUB_OPTS["split-window"];

/** The one `-t` target of a subcommand's options; null with none, more than one, or an unknown option. */
function targetOf(sub, rest) {
  const { flags, values } = SUB_OPTS[sub] ?? { flags: "", values: "t" };
  const targets = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--" || !a.startsWith("-") || a === "-") break;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      if (!values.includes(letters[k]) && !flags.includes(letters[k])) return null;
      if (!values.includes(letters[k])) continue;
      const val = k < letters.length - 1 ? letters.slice(k + 1) : rest[++i];
      if (letters[k] === "t") targets.push(val);
      break;
    }
  }
  return targets.length === 1 ? targets[0] ?? null : null;
}

// tmux 3.8's commands (name → alias) and its default command-alias entries: a command is
// found by its exact name, an alias, or a unique prefix of a name, as tmux finds it.
const TMUX_TABLE = {
  "attach-session": "attach", "bind-key": "bind", "break-pane": "breakp", "capture-pane": "capturep", "choose-buffer": "", "choose-client": "", "choose-tree": "",
  "clear-history": "clearhist", "clear-prompt-history": "clearphist", "clock-mode": "", "command-prompt": "", "confirm-before": "confirm", "copy-mode": "", "customize-mode": "",
  "delete-buffer": "deleteb", "detach-client": "detach", "display-menu": "menu", "display-message": "display", "display-popup": "popup", "display-panes": "displayp",
  "find-window": "findw", "has-session": "has", "join-pane": "joinp", "kill-pane": "killp", "kill-server": "", "kill-session": "", "kill-window": "killw",
  "last-pane": "lastp", "last-window": "last", "link-window": "linkw", "list-buffers": "lsb", "list-clients": "lsc", "list-commands": "lscm", "list-keys": "lsk",
  "list-panes": "lsp", "list-sessions": "ls", "list-windows": "lsw", "load-buffer": "loadb", "lock-client": "lockc", "lock-server": "lock", "lock-session": "locks",
  "move-pane": "movep", "move-window": "movew", "new-session": "new", "new-window": "neww", "next-layout": "nextl", "next-window": "next", "paste-buffer": "pasteb",
  "pipe-pane": "pipep", "previous-layout": "prevl", "previous-window": "prev", "refresh-client": "refresh", "rename-session": "rename", "rename-window": "renamew",
  "resize-pane": "resizep", "resize-window": "resizew", "respawn-pane": "respawnp", "respawn-window": "respawnw", "rotate-window": "rotatew", 
  "save-buffer": "saveb", "select-layout": "selectl", "select-pane": "selectp", "select-window": "selectw", "send-keys": "send", "send-prefix": "", "server-access": "",
  "set-buffer": "setb", "set-environment": "setenv", "set-hook": "", "set-option": "set", "set-window-option": "setw", "show-buffer": "showb", "show-environment": "showenv",
  "show-hooks": "", "show-messages": "showmsgs", "show-options": "show", "show-prompt-history": "showphist", "show-window-options": "showw", "source-file": "source",
  "split-window": "splitw", "start-server": "start", "suspend-client": "suspendc", "swap-pane": "swapp", "swap-window": "swapw", "switch-client": "switchc",
  "unbind-key": "unbind", "unlink-window": "unlinkw", "wait-for": "wait",
};
// (Added as pairs: the no-shell scan reads a key ending in that word as a spawn option.)
for (const [n, al] of [["if-shell", "if"], ["run-shell", "run"]]) TMUX_TABLE[n] = al;
const TMUX_ALIASES = { "split-pane": "split-window", splitp: "split-window", "server-info": "show-messages", info: "show-messages", "choose-window": "choose-tree", "choose-session": "choose-tree" };
for (const [name, alias] of Object.entries(TMUX_TABLE)) if (alias) TMUX_ALIASES[alias] = name;

/** The tmux command a word names (its full name), as tmux resolves it; null when it names none or several. */
export function resolveTmuxCommand(word) {
  const w = String(word ?? "");
  if (!w) return null;
  if (Object.hasOwn(TMUX_TABLE, w)) return w;
  if (Object.hasOwn(TMUX_ALIASES, w)) return TMUX_ALIASES[w];
  const hits = Object.keys(TMUX_TABLE).filter((n) => n.startsWith(w));
  return hits.length === 1 ? hits[0] : null;
}

/** A subcommand's words after its options, read as tmux's getopt reads them (values attached or not). */
export function subWords(sub, rest, values = SUB_OPTS[sub]?.values ?? "") {
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") return rest.slice(i + 1);
    if (!a.startsWith("-") || a === "-") break;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      if (!values.includes(letters[k])) continue;
      if (k === letters.length - 1) i++;
      break;
    }
  }
  return rest.slice(i);
}

/** tmux runs several commands from one argv: a lone `;`, or a word ending in an unescaped `;`. */
const chained = (args) => args.some((a) => a === ";" || /(?<!\\);$/.test(String(a)));

/** The option letters a subcommand's words carry (values skipped). */
function subOptionLetters(sub, rest) {
  const { values } = SUB_OPTS[sub] ?? { values: "" };
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--" || !a.startsWith("-") || a === "-") break;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      out.push(letters[k]);
      if (!values.includes(letters[k])) continue;
      if (k === letters.length - 1) i++;
      break;
    }
  }
  return out;
}

/** The words send-keys types, after its options. */
function keysOf(rest) {
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") return rest.slice(i + 1);
    if (!a.startsWith("-") || a === "-") break;
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      if (!"cNt".includes(letters[k])) continue;
      if (k === letters.length - 1) i++;
      break;
    }
  }
  return rest.slice(i);
}

// A key name tmux turns into a key (Space, BSpace, C-x, M-x, 0x20, F1, Up…): only plain text,
// Enter and C-m keep the exception (what they type is what the check reads).
const SAFE_KEYS = new Set(["Enter", "C-m", "C-c", "C-d", "Escape"]);
const KEY_NAME = /^(?:[CMS]-.+|\^.|0x[0-9a-fA-F]+|F\d{1,2}|[A-Z][A-Za-z]*\d*)$/;

/** Is this send-keys|new-window|split-window aimed exactly at a session this agent session recorded? */
export function isOwnTarget(argv, { line, env = process.env, uid = process.getuid?.() ?? 0, cwd, adRoot, sessionId, realpath = realpathOrNull } = {}) {
  const g = tmuxGlobals(argv.slice(1));
  g.sub = resolveTmuxCommand(g.sub);
  if (!OWN_SUBS.has(g.sub) || chained(g.rest)) return false;
  if (g.sub === "send-keys") {
    // Hex keys (-H), keys to a client (-K: it ignores -t) and key names type what the check
    // can't read, or go elsewhere: asked. Enter, C-m, C-c, C-d and Escape type no text.
    if (subOptionLetters("send-keys", g.rest).some((l) => l === "H" || l === "K")) return false;
    if (keysOf(g.rest).some((k) => KEY_NAME.test(k) && !SAFE_KEYS.has(k))) return false;
  }
  const m = /^=([\w-]+):(?:\w*(?:\.\d+)?)?$/.exec(targetOf(g.sub, g.rest) ?? "");
  if (!m) return false;
  const e = commandEnv(line, env);
  if (!e) return false;
  const socket = resolveSocket(g, { env: e, uid, realpath, cwd });
  if (!socket) return false;
  return readRecords(adRoot, sessionId).some((x) => x.socket === socket && x.name === m[1]);
}
