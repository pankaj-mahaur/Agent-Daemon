// ad's state, protected from writes (MCP launch plan L7, D12c). Reads always pass; a write
// into ad's own files (its databases, guard snapshots, hooks, the memory product, project
// markers and journals) is denied, a few are asked about, and the rest of `.agent-daemon`
// stays writable (notes, flags, queues, logs). Shell text and the file tools (Write, Edit,
// apply_patch) are both judged here: a path is expanded the way the shell would (home
// spellings, ad's own variables, literal assignments), normalised (Windows spellings, case
// on Windows and macOS, trailing dots), and tested both as written and with its deepest
// existing folder resolved through links.

import fs from "node:fs";
import path from "node:path";
import { PRODUCT } from "../product.mjs";
import { ENTRY_NAMES } from "./self-protect-words.mjs";

const realNative = (p) => fs.realpathSync.native(p);

/** Everything a state check needs: the folders, how paths are spelled here, the line's assignments. */
export function stateContext({ os, homeDir, adRoot, env = {}, pathMod, literals = new Map(), realpath = realNative, isFile, installDir = null }) {
  const windows = os === "windows";
  const pm = pathMod ?? (windows ? path.win32 : path.posix);
  const fold = os === "windows" || os === "macos" ? (s) => s.toLowerCase() : (s) => s;
  const pick = (v, d) => (typeof v === "string" && v && pm.isAbsolute(v) ? v : d);
  const s = {
    os,
    windows,
    pm,
    fold,
    homeDir,
    adRoot,
    claudeDir: pick(env.CLAUDE_CONFIG_DIR, pm.join(homeDir, ".claude")),
    codexHome: pick(env.CODEX_HOME, pm.join(homeDir, ".codex")),
    systemRoot: windows ? pick(env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR, "C:\\Windows") : null,
    systemDrive: windows ? `${/^[A-Za-z]:$/.test(env.SystemDrive ?? "") ? env.SystemDrive : "C:"}\\` : null,
    xdgConfig: pick(env.XDG_CONFIG_HOME, pm.join(homeDir, ".config")),
    appData: pick(env.APPDATA, pm.join(homeDir, "AppData", "Roaming")),
    localAppData: pick(env.LOCALAPPDATA, pm.join(homeDir, "AppData", "Local")),
    // PATH folders (a file named like ad, npx or node written into one is a shim).
    pathDirs: [...String(env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").filter((d) => d && pm.isAbsolute(d)), ...(windows ? [pm.join(pick(env.APPDATA, pm.join(homeDir, "AppData", "Roaming")), "npm")] : [])],
    envFile: pick(env.CLAUDE_ENV_FILE, null),
    literals,
    realpath,
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: isFile ?? ((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }),
    installDir: installDir && /[\\/]node_modules[\\/]/.test(installDir) ? installDir : null,
    // Per call: shared by the copies a line's commands make (they add their own assignments).
    realCache: new Map(),
    rpCache: new Map(),
    sensitiveCache: new Map(),
  };
  s.roots = [...new Set([pm.join(homeDir, ".agent-daemon"), adRoot, realOf(adRoot, s)].filter(Boolean))];
  return s;
}

// ---- paths -------------------------------------------------------------------------------

const HOME_SPELLING = /^(?:~[\w.-]*|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|\$\{env:USERPROFILE\}|\$\{env:HOME\}|%USERPROFILE%|%HOMEPATH%)(?=[\\/]|$)/i;
const VAR_DIRS = [
  [/^(?:\$CODEX_HOME|\$\{CODEX_HOME\}|%CODEX_HOME%|\$env:CODEX_HOME)(?=[\\/]|$)/i, "codexHome"],
  [/^(?:\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\}|%CLAUDE_CONFIG_DIR%|\$env:CLAUDE_CONFIG_DIR)(?=[\\/]|$)/i, "claudeDir"],
  [/^(?:\$AD_ROOT|\$\{AD_ROOT\}|%AD_ROOT%|\$env:AD_ROOT)(?=[\\/]|$)/i, "adRoot"],
  [/^(?:%SystemRoot%|%windir%|\$env:SystemRoot|\$env:windir|\$\{env:SystemRoot\}|\$\{env:windir\})(?=[\\/]|$)/i, "systemRoot"],
  [/^(?:\$XDG_CONFIG_HOME|\$\{XDG_CONFIG_HOME\})(?=[\\/]|$)/i, "xdgConfig"],
  [/^(?:%SystemDrive%|\$env:SystemDrive|\$\{env:SystemDrive\})[\\/]?(?=[\\/]|$|\w)/i, "systemDrive"],
  [/^(?:%APPDATA%|\$env:APPDATA|\$\{env:APPDATA\})(?=[\\/]|$)/i, "appData"],
  [/^(?:%LOCALAPPDATA%|\$env:LOCALAPPDATA|\$\{env:LOCALAPPDATA\})(?=[\\/]|$)/i, "localAppData"],
];

/**
 * A word as the path it names: → { path } (absolute, normalised), { text } (relative with an
 * unknown folder: only name rules apply), or { unresolved: true, home } (an expansion left).
 */
export function pathOf(word, s, cwd, cwdKnown = true) {
  let w = String(word ?? "");
  if (!w) return null;
  // The line's own assignments first (their values may start with a home spelling).
  w = w.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => (s.literals.has(a ?? b) && !/^(?:HOME|AD_ROOT|CODEX_HOME|CLAUDE_CONFIG_DIR)$/.test(a ?? b) ? s.literals.get(a ?? b) : m));
  // PowerShell's $PROFILE (and $PROFILE.CurrentUserAllHosts…): a profile script.
  // An admin share of a drive (\\localhost\C$\) is that drive (its $ isn't an expansion).
  if (s.windows) w = w.replace(/^\\\\(?:localhost|127\.0\.0\.1)\\([a-z])\$\\/i, "$1:\\");
  if (/^\$profile(?:\.\w+)?$/i.test(w)) return { path: s.pm.join(s.homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1") };
  const home = HOME_SPELLING.test(w);
  w = w.replace(HOME_SPELLING, s.homeDir.replace(/\$/g, "$$$$"));
  for (const [re, key] of VAR_DIRS) w = w.replace(re, (s[key] ?? "").replace(/\$/g, "$$$$"));
  if (/\$|%[A-Za-z_]\w*%|`/.test(w)) return { unresolved: true, home, text: w };
  w = normalise(w, s);
  if (!s.pm.isAbsolute(w)) {
    if (!cwdKnown || !cwd) return { text: w };
    w = s.pm.resolve(cwd, w);
  }
  // (A trailing separator names the same folder: dropped, the root kept.)
  const n = s.pm.normalize(w);
  return { path: n.length > 1 && !/^[A-Za-z]:[\\/]?$/.test(n) ? n.replace(/[\\/]+$/, "") : n };
}

function normalise(w, s) {
  let p = w;
  p = p.replace(/^\/proc\/(?:self|thread-self|\d+)\/root(?=\/|$)/, "") || "/";
  if (s.windows) {
    p = p.replace(/^\\\\[?.]\\(?:UNC\\)?/i, "").replace(/^\/\/[?.]\//, "");
    p = p.replace(/^\\\\(?:localhost|127\.0\.0\.1)\\([a-z])\$\\/i, "$1:\\");
    p = p.replace(/^\/(?:mnt\/)?([a-z])(?=\/|$)/i, "$1:");
    // Trailing dots and spaces in each part, and 8.3 short names of ad's folder.
    p = p.split(/[\\/]/).map((seg) => (/^\.+$/.test(seg) ? seg : seg.replace(/[. ]+$/, ""))).map((seg) => (/^agent-~\d+$/i.test(seg) ? ".agent-daemon" : seg)).join("\\");
  }
  return p;
}

/** The path with its deepest existing folder resolved through links (null when nothing resolves). */
function realOf(p, s) {
  if (!p) return null;
  s.realCache ??= new Map();
  if (s.realCache.has(p)) return s.realCache.get(p);
  const r = realOfUncached(p, s);
  if (s.realCache.size < 5000) s.realCache.set(p, r);
  return r;
}
function realOfUncached(p, s) {
  let cur = p;
  const tail = [];
  s.rpCache ??= new Map();
  for (let i = 0; i < 64; i++) {
    let r = s.rpCache.get(cur);
    if (r === undefined) {
      try {
        r = s.realpath(cur);
      } catch {
        r = null;
      }
      if (s.rpCache.size < 20000) s.rpCache.set(cur, r);
    }
    if (r) return tail.length ? s.pm.join(r, ...tail.reverse()) : r;
    {
      const parent = s.pm.dirname(cur);
      if (parent === cur) return null;
      tail.push(s.pm.basename(cur));
      cur = parent;
    }
  }
  return null;
}

const segsOf = (p, s) => s.fold(String(p)).split(/[\\/]+/).filter(Boolean);
/** Is p inside folder (or the folder itself)? → the parts below it, or null. */
function below(p, folder, s) {
  if (!folder) return null;
  const a = segsOf(p, s);
  const b = segsOf(folder, s);
  if (a.length < b.length || b.some((x, i) => a[i] !== x)) return null;
  return a.slice(b.length);
}

// ---- what is protected (D12c) ------------------------------------------------------------

const ANCHORED = [
  /(?:^|\/)[^/]*\.db(?:-wal|-shm|-journal)?$/,
  /^guards[^/]*\.json$/,
  /^guards\.active$/,
  /^guards-consumed(?:\/|$)/,
  /^hooks(?:\/|$)/,
  /^memory(?:\/|$)/,
  /^projects\.json$/,
  /^install-ledger\.json$/,
  /^locks(?:\/|$)/,
  /^policy[^/]*(?:\/|$)/,
  /^buffer(?:\/|$)/,
  /^engine\/(?:config\.toml|hooks\.json)$/,
  /^recall(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^projects\/.*\/learning-journal[^/]*\.jsonl$/,
];
// ad-only names right under any `.agent-daemon` folder (a link or an unknown home still matches).
const AD_ONLY = /^(?:guards[^/]*\.json|guards\.active|guards-consumed(?:\/.*)?|episodic\.db[^/]*|install-ledger\.json|rule-events\.jsonl|memory\/(?:launch|dist)(?:\/.*)?|memory\/ledger[^/]*\.json|hooks(?:\/.*)?)$/;
// In any folder: a project's marker, journal and buffer.
const ANY_FOLDER = /^(?:project\.json|learning-journal[^/]*\.jsonl|buffer[^/]*(?:\/.*)?)$/;
const AD_PLUGIN = new RegExp(`(?:agent-daemon|teachonce|${String(PRODUCT.package ?? "agent-daemon").replace(/[^\w-]/g, "")})`, "i");

// Names a glob is tested against, by the folder it sits in.
const ROOT_SAMPLES = ["episodic.db", "episodic.db-wal", "guards.json", "guards.active", "guards-consumed/x", "hooks/x", "memory/x", "projects.json", "install-ledger.json", "locks/x", "policy.json", "buffer/x", "engine/config.toml", "engine/hooks.json", "recall/x", "node_modules/x", "projects/p/learning-journal.jsonl", "rule-events.jsonl", "project.json", "learning-journal.jsonl"];
// (A wildcard that starts a part never matches a leading dot, as the shell's globs don't.)
const globRe = (pat, s) => new RegExp(`^${pat.split("/").map((seg) => (/^[*?[]/.test(seg) ? "(?!\\.)" : "") + seg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[:\w+:\]/g, "\\w").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\[!/g, "[^")).join("/")}(?:/.*)?$`, s.windows || s.os === "macos" ? "i" : "");

/** A glob path: does any protected path match it? → a rule or null. */
function globRule(p, s) {
  const segs = String(p).split(/[\\/]+/);
  const k = segs.findIndex((x) => /[*?[]/.test(x));
  if (k < 0) return null;
  const base = segs.slice(0, k).join(s.windows ? "\\" : "/") || (s.windows ? "\\" : "/");
  const pat = segs.slice(k).join("/");
  let re;
  try {
    re = globRe(pat, s);
  } catch {
    return stateRule(s.pm.join(base, "x"), s) ?? (byText(p, s) ? DENY(STATE) : null);
  }
  // Candidates under the base: ad's state as it would sit there.
  const cands = [];
  for (const root of s.roots) {
    const rel = below(root, base, s);
    if (rel) for (const n of ROOT_SAMPLES) cands.push([...rel, ...n.split("/")].join("/"));
    // The base inside ad's root: the samples that fall under it.
    const inside = below(base, root, s);
    if (inside && inside.length) {
      const pre = `${inside.join("/")}/`;
      for (const n of ROOT_SAMPLES) if (n.startsWith(pre)) cands.push(n.slice(pre.length));
    }
  }
  if (segsOf(base, s).at(-1) === ".agent-daemon") cands.push(...ROOT_SAMPLES);
  cands.push(...ROOT_SAMPLES.map((n) => `.agent-daemon/${n}`));
  for (const c of cands) {
    if (!re.test(c)) continue;
    const r = stateRule(s.pm.join(base, ...c.split("/")), s);
    if (r) return r;
  }
  // Inside a protected folder (hooks/*, memory/**): anything there is protected.
  return stateRule(s.pm.join(base, "x"), s);
}

/** Brace expansion of a word (at most 32 results). */
function braces(w) {
  // Short ranges {a..c} and {1..3} become lists first.
  const word = String(w).replace(/\{([a-zA-Z0-9])\.\.([a-zA-Z0-9])\}/g, (m, a, b) => {
    const [x, y] = [a.charCodeAt(0), b.charCodeAt(0)];
    if (Math.abs(y - x) > 64) return m;
    const list = [];
    for (let c = Math.min(x, y); c <= Math.max(x, y); c++) list.push(String.fromCharCode(c));
    return list.length > 1 ? `{${list.join(",")}}` : list[0];
  });
  if (!/\{[^{}]*,/.test(word)) return [word];
  if (word.length > 1024) return perGroup(word);
  const out = [];
  const go = (x) => {
    if (out.length >= 32) return;
    const m = commaGroups(x)[0];
    if (!m) return void out.push(x);
    for (const alt of m[1].split(",")) {
      if (out.length >= 32) return;
      go(x.slice(0, m.index) + alt + x.slice(m.index + m[0].length));
    }
  };
  go(word);
  // Too many to list: every alternative of every group, the other groups as globs.
  return out.length >= 32 ? [...new Set([...out, ...perGroup(word)])] : out;
}
/** The {…} groups of a word that hold a comma (one linear pass). */
function commaGroups(x) {
  return [...String(x).matchAll(/\{([^{}]*)\}/g)].filter((m) => m[1].includes(",")).slice(0, 64);
}
function perGroup(word) {
  const groups = commaGroups(word);
  const out = [];
  for (const g of groups) {
    for (const alt of g[1].split(",")) {
      if (out.length >= 512) return out;
      let x = "";
      let from = 0;
      for (const h of groups) {
        x += word.slice(from, h.index) + (h === g ? alt : "*");
        from = h.index + h[0].length;
      }
      out.push(x + word.slice(from));
    }
  }
  return out;
}

const DENY = (why) => ({ decision: "deny", class: "c", why });
const ASK = (why) => ({ decision: "ask", class: "c", why });
const STATE = "a write to ad's own state";

/** The rule for a write to one spelled path (text only: names under `.agent-daemon` folders). */
function byText(text, s) {
  const segs = segsOf(text, s);
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] !== ".agent-daemon") continue;
    const rest = segs.slice(i + 1).join("/");
    if (AD_ONLY.test(rest) || ANY_FOLDER.test(rest)) return DENY(STATE);
  }
  return null;
}

/** The rule for a write to an absolute path (null: an ordinary file). */
export function stateRule(p, s) {
  for (const q of [p, realOf(p, s)]) {
    if (!q) continue;
    const r = ruleFor(q, s);
    if (r) return r;
  }
  return null;
}

function ruleFor(p, s) {
  for (const root of s.roots) {
    const rel = below(p, root, s);
    if (!rel || !rel.length || rel[0] === "worktrees") continue;
    const r = rel.join("/");
    if (r === "user.md") return ASK("a write to the user's profile in ad's state");
    if (ANCHORED.some((re) => re.test(r))) return DENY(STATE);
  }
  const t = byText(p, s);
  if (t) return t;
  const n = segsOf(p, s);
  // A worktree's .git pointer and git's worktree records decide which project's rules apply.
  if (/^(?:commondir|gitdir)$/.test(n.at(-1) ?? "") && n.at(-3) === "worktrees" && n.at(-4) === ".git") return ASK("a write that changes which project's rules apply");
  if (n.at(-1) === ".git" && s.isFile(p)) return ASK("a write that changes which project's rules apply");
  const c = below(p, s.claudeDir, s);
  if (c && c.length) {
    const r = c.join("/");
    if (/^session-env(?:\/|$)/.test(r) || /^plugins\/(?:installed_plugins|known_marketplaces)\.json$/.test(r)) return DENY(STATE);
    if (/^plugins\/(?:cache|marketplaces)\//.test(r) && AD_PLUGIN.test(c.slice(2, 4).join("/"))) return DENY(STATE);
  }
  if (s.envFile && below(p, s.envFile, s)?.length === 0) return DENY(STATE);
  if (s.installDir && below(p, s.installDir, s)) return DENY(STATE);
  return null;
}

/** A cd target with a glob or braces: ad's root when it can be one of them, else null. */
export function cdGlobRoot(word, s, cwd, cwdKnown) {
  for (const cand of braces(word)) {
    const w = pathOf(cand, s, cwd, cwdKnown);
    if (!w?.path) continue;
    if (!/[*?[]/.test(w.path)) {
      if (s.roots.some((r) => below(w.path, r, s)?.length === 0)) return w.path;
      continue;
    }
    const segs = w.path.split(/[\\/]+/);
    const k = segs.findIndex((x) => /[*?[]/.test(x));
    const base = segs.slice(0, k).join(s.windows ? "\\" : "/") || "/";
    let re;
    try {
      re = globRe(segs.slice(k).join("/"), s);
    } catch {
      continue;
    }
    for (const r of s.roots) {
      const rel = below(r, base, s);
      if (rel && rel.length && re.test(rel.join("/"))) return r;
    }
  }
  return null;
}

/** A folder where a bare file name may already be protected (ad's root, a .agent-daemon folder, a host's config). */
function sensitive(dir, s) {
  s.sensitiveCache ??= new Map();
  if (s.sensitiveCache.has(dir)) return s.sensitiveCache.get(dir);
  const real = realOf(dir, s);
  const hit = [dir, real].some((d) => d && (segsOf(d, s).includes(".agent-daemon") || s.roots.some((r) => below(d, r, s)) || below(d, s.claudeDir, s) || below(d, s.codexHome, s) || segsOf(d, s).some((x) => x === ".git" || x === ".claude" || x === ".codex") || (s.systemRoot && below(d, s.systemRoot, s))));
  s.sensitiveCache.set(dir, hit);
  return hit;
}

// ---- host config, the Windows folder, startup and persistence (D12d, f, g) --------------

const GIT_RUN_KEYS = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass)|alias\..+|include\.path|includeif\..+\.path|diff\..+\.(?:textconv|command)|filter\..+\.(?:clean|smudge|process)|credential\.helper|sequence\.editor|gpg\.program|merge\..+\.driver)$/i;
const RC_FILES = new Set([".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".kshrc", ".cshrc", ".tcshrc", ".login", ".sqliterc", ".inputrc"]);
const SHIM_NAMES = new Set([...ENTRY_NAMES.map((n) => String(n).toLowerCase()), "npx", "node", "nodejs"]);
const HOST = (decision, cls, why) => ({ decision, class: cls, why });
// Bare names checked in any folder (rc files, shims, settings, startup entries).
const SPECIAL_NAME = (w) => RC_FILES.has(w) || SHIM_NAMES.has(w.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1|com)$/, "")) || /\.desktop$|^settings.*\.json$|^\.claude\.json$|^\.mcp\.json$|^\.gitconfig$|^(?:hooks\.json|config\.toml|config)$/.test(w);

/** Which host file a path is: "claude-settings" | "claude-json" | "codex" | "mcp" | null. */
export function hostFile(p, s) {
  const n = segsOf(p, s);
  const base = n.at(-1) ?? "";
  if (base === ".claude.json") return "claude-json";
  if (/^settings.*\.json$/.test(base) && (n.at(-2) === ".claude" || below(p, s.claudeDir, s)?.length === 1)) return "claude-settings";
  if (/^(?:hooks\.json|config\.toml)$/.test(base) && (n.at(-2) === ".codex" || below(p, s.codexHome, s)?.length === 1)) return "codex";
  if (base === ".mcp.json") return "mcp";
  return null;
}

/** A folder whose files start programs (a copy into it names each file there). */
function startupFolder(p, s) {
  const n = segsOf(p, s);
  const xdg = below(p, s.xdgConfig, s);
  return (n.at(-1) === "hooks" && n.at(-2) === ".git") || (xdg && /^(?:autostart|systemd\/user|fish\/conf\.d)$/.test(xdg.join("/"))) || /\/library\/launchagents$/.test(n.join("/").toLowerCase()) || s.pathDirs.some((d) => below(p, d, s)?.length === 0);
}

/** The rule for a write to a host's config, the Windows folder, or a startup file (null: none). */
export function hostRule(p, s) {
  if (s.windows && [s.systemRoot, "C:\\Windows"].some((r) => r && below(p, r, s))) return HOST("deny", "f", "a write into the Windows folder");
  const kind = hostFile(p, s);
  if (kind === "claude-settings" || kind === "claude-json" || kind === "codex") return HOST("ask", "d", "a change to a host's settings, which run ad's hooks");
  const n = segsOf(p, s);
  const base = n.at(-1) ?? "";
  const home = below(p, s.homeDir, s);
  const xdg = below(p, s.xdgConfig, s);
  const startup =
    (home && home.length === 1 && RC_FILES.has(base)) ||
    (xdg && /^(?:fish\/(?:config\.fish|conf\.d\/.+)|sqlite3\/sqliterc|autostart\/.+|systemd\/user\/.+|powershell\/.*profile.*\.ps1)$/.test(xdg.join("/"))) ||
    (/\.desktop$/.test(base) && /^(?:autostart|applications)$/.test(n.at(-2) ?? "")) ||
    (home && /^library\/launchagents\/.+/.test(home.join("/").toLowerCase())) ||
    (home && /(?:^|\/)documents\/(?:windows)?powershell\/.*profile.*\.ps1$/.test(home.join("/").toLowerCase())) ||
    /\/microsoft\/windows\/start menu\/programs\/startup\/.+/.test(n.join("/").toLowerCase()) ||
    (n.at(-2) === "hooks" && n.at(-3) === ".git") ||
    // git's config can move its hooks folder (core.hooksPath).
    (base === "config" && n.at(-2) === ".git") ||
    (home && home.length === 1 && base === ".gitconfig") ||
    (xdg && xdg.join("/") === "git/config");
  if (startup) return HOST("ask", "g", "a write to a file that runs at startup");
  // A shim: a file named like ad, npx or node in a PATH folder.
  const stem = base.replace(/\.(?:cmd|exe|bat|ps1|com)$/i, "");
  if (SHIM_NAMES.has(stem) && s.pathDirs.some((d) => below(p, d, s)?.length === 1)) return HOST("deny", "g", "a file in a PATH folder named like a program ad runs");
  return null;
}

/** A folder that holds protected paths: deleting or moving it (or copying a tree into it) touches them. */
function holdsProtected(p, s) {
  const n = segsOf(p, s);
  if (!n.length || (s.windows && n.length === 1 && /^[a-z]:$/i.test(n[0]))) return true; // / or a drive root
  if (n.at(-1) === ".agent-daemon") return true;
  for (const root of s.roots) {
    const rel = below(p, root, s);
    if (!rel || rel[0] === "worktrees") continue;
    if (rel.length === 0) return true;
    if (rel[0] === "projects") return true; // any project's folder may hold its journal
    const pre = `${rel.join("/")}/`;
    if (ROOT_SAMPLES.some((n) => n.startsWith(pre))) return true;
  }
  // a home spelling, or an ancestor of ad's root or a host config folder
  for (const f of [s.homeDir, ...s.roots, s.claudeDir, s.codexHome]) if (f && below(f, p, s)) return true;
  return false;
}

// ---- shell commands ----------------------------------------------------------------------

const lower = (x) => String(x).toLowerCase();
const READERS = new Set(["cat", "head", "tail", "less", "more", "wc", "stat", "file", "ls", "dir", "tree", "du", "grep", "egrep", "fgrep", "rg", "ag", "diff", "cmp", "md5sum", "jq", "find", "get-content", "gc", "get-childitem", "gci", "get-item", "gi", "test-path", "type", "select-string", "sls", "sort", "uniq", "cut", "tr", "column", "nl", "bat", "readlink", "realpath", "basename", "dirname", "which", "file", "od", "xxd", "hexdump", "strings"]);
const DATA_ONLY = new Set(["echo", "printf", "write-output", "write-host", "echo.", "say"]);
// Text filters a reader may feed (anything else reading ad's files from a pipe could write them).
const FILTERS = new Set([...READERS, "tee-object"]);
const RUNNERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "python2", "ruby", "perl", "php", "bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "source", "."]);
// Options that name where a program writes.
const OUT_OPTION = /^(?:--prefix|--directory|-C|-o|--output|--out-?dir|--outdir|-d|--dest\w*|--target(?:-directory)?|--install-dir|--root|--cache|--cwd|--work-tree|--git-dir)$/;
const GIT_READS = new Set(["status", "log", "diff", "show", "blame", "ls-files"]);

/** A reader's flags that write (or run) after all. */
function readerWrites(prog, args) {
  // uniq IN OUT and xxd [-r] IN OUT write OUT.
  if ((prog === "uniq" || prog === "xxd") && args.filter((a) => a === "-" || !a.startsWith("-")).length >= 2) return true;
  if (prog === "tree" || prog === "sort") return args.some((a) => /^-o/.test(a) || /^--output/.test(a));
  if (prog === "grep" || prog === "rg" || prog === "ag" || prog === "egrep" || prog === "fgrep") return args.some((a) => /^--pre/.test(a));
  if (prog === "find") {
    if (args.some((a) => /^-(?:delete|fprint\w*|fls)$/.test(a))) return true;
    // -exec/-execdir/-ok run a program: only a reader keeps find a reader.
    return args.some((a, i) => {
      if (!/^-(?:exec\w*|ok\w*)$/.test(a)) return false;
      const p = lower(String(args[i + 1] ?? "")).split(/[\\/]/).pop();
      const end = args.findIndex((x, k) => k > i && (x === ";" || x === "+" || x === "\\;"));
      const own = args.slice(i + 2, end < 0 ? args.length : end);
      return !READERS.has(p) || readerWrites(p, own);
    });
  }
  return false;
}

/** The words of argv that may name a file, option values included (`--out=x`, `of=x`, `-o x`). */
function fileWords(args) {
  const out = [];
  for (const a of args) {
    const eq = /^(?:--?[\w-]+|of|if|[a-z]+)=(.*)$/i.exec(a);
    if (eq) out.push(eq[1]);
    else if (!/^-/.test(a) || a === "-") out.push(a);
    else if (/^-[A-Za-z]\S/.test(a) && /[\\/]/.test(a)) out.push(a.slice(2)); // -o/path
  }
  return out;
}

/** The first positional word (skipping options and, roughly, their values). */
const positionals = (args) => args.filter((a) => !/^-/.test(a));

/**
 * Judge one command's writes to ad's state. f: the parsed command (argv, redirects,
 * assigns, heredocs); cwd as tracked. → { decision, class, why } or null.
 */
export function judgeState(f, s, cwd, cwdKnown, { inlineCode = () => null } = {}) {
  const argv = f.argv.map(String);
  const prog = lower(argv[0]).replace(/\.exe$/, "").split(/[\\/]/).pop();
  const args = argv.slice(1);
  let out = null;
  const worst = (r) => {
    if (r && (!out || (out.decision === "ask" && r.decision === "deny"))) out = r;
  };
  // A bare name (no folder in it) can only be protected where the folder it lands in is
  // itself sensitive (or it's a .git pointer): skipped elsewhere, so long lines stay cheap.
  const plainCwd = cwdKnown && cwd && !sensitive(cwd, s);
  const write = (word0) => {
    for (const word of braces(word0)) writeOne(word);
  };
  const writeOne = (word) => {
    if (s.deadline && Date.now() > s.deadline) return void worst(ASK("a line too long to check for writes to ad's state"));
    // Claude Code's env file, named by its variable (the hook's env may not have it).
    // (Any spelling: a default, a substitution, its folder; or a target built on a line that names it.)
    if (/CLAUDE_ENV_FILE/i.test(String(word)) || (/[$`%]/.test(String(word)) && /CLAUDE_ENV_FILE/i.test(s.line ?? ""))) return void worst(DENY(STATE));
    if (plainCwd && !/[\\/~$%*?[]/.test(String(word)) && String(word) !== ".git" && !/^[A-Za-z]:/.test(String(word)) && !SPECIAL_NAME(String(word))) return;
    const w = pathOf(word, s, cwd, cwdKnown);
    if (!w) return;
    if (w.path && /[*?[]/.test(w.path)) worst(globRule(w.path, s));
    else if (w.path) {
      worst(stateRule(w.path, s));
      worst(hostRule(w.path, s));
      const kind = hostFile(w.path, s);
      if ((kind === "claude-settings" || kind === "claude-json" || kind === "mcp") && (/disableAllHooks/i.test(s.line ?? "") || DISPATCHER_ONE.test(s.line ?? ""))) worst(HOST("deny", "d", "a host config that turns hooks off or names ad's dispatcher"));
    }
    else if (w.unresolved) {
      worst(byText(w.text, s));
      if (w.home) worst(ASK("a write under the home folder to a path built at run time"));
    } else worst(byText(w.text, s));
  };
  // Redirect targets.
  for (const r of f.redirects ?? []) if (r.write) write(r.target);
  // g: commands that make something run later.
  const startup = (why) => worst(HOST(s.badLine ? "deny" : "ask", "g", why));
  if (prog === "crontab" && !args.includes("-l")) startup("a change to the crontab");
  // git config keys that run a program or move the hooks: setting one (a read passes).
  if (prog === "git" && args.includes("config")) {
    const k = args.findIndex((a) => GIT_RUN_KEYS.test(a));
    if (k >= 0) {
      const value = args[k + 1];
      const sets = (value !== undefined && !value.startsWith("-")) || args.some((a) => /^(?:set|--add|--replace-all|--unset(?:-all)?|unset)$/.test(a));
      const reads = args.some((a) => /^(?:--get(?:-all|-regexp)?|get|--list|-l)$/.test(a));
      if (sets && !reads && (!/^alias\./i.test(args[k]) || String(value ?? "").startsWith("!"))) startup("a git setting that runs a program");
    }
  }
  if (/^(?:reg|reg\.exe)$/.test(prog) && /^add$/i.test(args[0] ?? "") && /\\run(?:once)?\b/i.test(args.join(" "))) startup("a Run key that starts a program at sign-in");
  if (/^(?:set-itemproperty|sp|new-itemproperty)$/.test(prog) && /[\\/]run(?:once)?\b/i.test(args.join(" "))) startup("a Run key that starts a program at sign-in");
  if (/^(?:reg|reg\.exe)$/.test(prog) && /^import$/i.test(args[0] ?? "")) startup("registry entries imported (a Run key among them, maybe)");
  if (prog === "schtasks" && args.some((a) => /^[-/]create$/i.test(a))) startup("a scheduled task");
  if (prog === "launchctl" && /^(?:load|bootstrap|enable|submit)$/.test(args[0] ?? "")) startup("a launch agent set to start");
  if (prog === "systemd-run" && args.some((a) => /^--on-(?:calendar|boot|startup|unit-active|unit-inactive|active)/.test(a))) startup("a timer that runs a program later");
  if (prog === "register-scheduledtask") startup("a scheduled task");
  if (prog === "systemctl" && args.includes("--user") && args.some((a) => /^(?:enable|link|edit|add-wants|add-requires)$/.test(a))) startup("a user service set to start");
  // BASH_ENV (any value) or ENV naming a file: a script every shell runs first.
  const startupVar = (a) => /^BASH_ENV=/.test(a) || /^ENV=(?:[/~]|\$HOME|\$\{HOME\})/.test(a);
  if ((f.assigns ?? []).some(startupVar) || (/^(?:export|env|declare|typeset)$/.test(prog) && args.some(startupVar))) startup("a shell startup file set for commands");
  // apply_patch fed a patch on stdin (Codex runs it as a shell command).
  if (prog === "apply_patch" || prog === "applypatch") {
    for (const h of f.heredocs ?? []) for (const p of patchPaths(h)) write(p);
    for (const a of args) for (const p of patchPaths(a)) write(p);
    return out;
  }
  if (DATA_ONLY.has(prog)) return out;
  // Readers with the path in a read position.
  if (READERS.has(prog) && !readerWrites(prog, args)) return out;
  if (/^sha\d*sum$/.test(prog)) return out;
  // Recursive copies, extracts, syncs and clones into a protected folder or an ancestor.
  const into = treeDestination(prog, args, cwd);
  if (into !== undefined) {
    const w = into && pathOf(into, s, cwd, cwdKnown);
    if (w?.path && holdsProtected(w.path, s)) worst(ASK("a copy whose files can't be listed, into the home folder or ad's state"));
  }
  // find that deletes or runs: its start folders count as deleted.
  if (prog === "find" && readerWrites(prog, args)) {
    const firstExpr = args.findIndex((a) => /^[-(!]/.test(a));
    for (const word of args.slice(0, firstExpr < 0 ? args.length : firstExpr)) {
      const w = pathOf(word, s, cwd, cwdKnown);
      if (w?.path && (holdsProtected(w.path, s) || stateRule(w.path, s))) worst(DENY("find deleting or running on ad's state"));
    }
  }
  // An option naming where a program writes (an install prefix, an output folder): ad's root or above → deny.
  // (git, and the extracts and copies above, have their own rules for these.)
  for (let i = 0; into === undefined && prog !== "git" && i < args.length; i++) {
    const eq = /^(--[\w-]+)=(.*)$/.exec(args[i]);
    if (!OUT_OPTION.test(eq ? eq[1] : args[i])) continue;
    const w = pathOf(eq ? eq[2] : args[i + 1], s, cwd, cwdKnown);
    if (w?.path && holdsProtected(w.path, s) && !READERS.has(prog)) worst(DENY("a program writing into ad's state folder"));
  }
  // git: reads outside ad's root; anything in ad's root but a read → deny; messages are data.
  if (prog === "git") return worst(gitState(argv, f, s, cwd, cwdKnown)), out;
  if (prog === "sqlite3") return worst(sqliteState(argv, f, s, cwd, cwdKnown)), out;
  // Deletes and moves: a folder holding protected paths, or a protected file.
  if (/^(?:rm|rmdir|unlink|shred|mv|remove-item|ri|del|erase|rd|move-item|mi|move|ren|rename-item|rni)$/.test(prog)) {
    for (const word0 of fileWords(args)) {
      for (const word of braces(word0)) {
        const w = pathOf(word, s, cwd, cwdKnown);
        // A glob that matches everything (*, .*) in a folder that holds ad's state deletes it; a
        // narrower one (*.log) is judged by the names it can match.
        const parts = w?.path ? w.path.split(/[\\/]+/) : [];
        const g = parts.findIndex((x) => /[*?[]/.test(x));
        const dir = g < 0 ? w?.path : g === parts.length - 1 && /^\.?\*+$/.test(parts[g]) ? parts.slice(0, g).join(s.windows ? "\\" : "/") || "/" : null;
        if (dir && holdsProtected(dir, s)) worst(DENY("deleting or moving a folder that holds ad's state"));
        if (w?.unresolved && !w.home && /\.agent-daemon|AD_ROOT/i.test(s.line ?? "")) worst(ASK("a delete whose target is built at run time, on a line that names ad's state"));
        writeOne(word);
      }
    }
    // A move into a folder: each source lands under its own name there.
    if (/^(?:mv|move-item|mi|move)$/.test(prog)) {
      const pos = positionals(args);
      const to = pos.at(-1);
      const tw = to && pathOf(to, s, cwd, cwdKnown);
      if (tw?.path && pos.length > 1 && (/[\\/]$/.test(to) || pos.length > 2 || s.isDir(tw.path) || holdsProtected(tw.path, s))) {
        for (const src of pos.slice(0, -1)) {
          const j = s.pm.join(tw.path, String(src).split(/[\\/]/).filter(Boolean).pop() ?? "");
          worst(stateRule(j, s));
          worst(hostRule(j, s));
        }
      }
    }
    return out;
  }
  // Links, junctions and bind mounts aimed at a home, ad's root, a host config folder or above.
  const link = linkTarget(prog, args);
  if (link !== undefined) {
    const w = link && pathOf(link, s, cwd, cwdKnown);
    if (w?.path && holdsProtected(w.path, s)) worst(ASK("a link to the home folder, ad's state or a host's config"));
    for (const word of fileWords(args)) write(word);
    return out;
  }
  // cp, Copy-Item, copy, rsync: sources are reads; the destination is the write.
  if (/^(?:cp|copy-item|copy|cpi|rsync|install)$/.test(prog) && !args.includes("--remove-source-files")) {
    const t = args.findIndex((a) => a === "-t" || /^--target-directory/.test(a));
    const dest = t >= 0 ? (args[t].includes("=") ? args[t].split("=")[1] : args[t + 1]) : positionals(args).at(-1);
    const named = args.find((a, i) => /^-(?:destination|path)$/i.test(args[i - 1] ?? "")) ?? null;
    const to = named ?? dest;
    if (to) write(to);
    // Into a folder (a trailing separator, -t, several sources, or a folder that holds ad's
    // state): each source lands under its own name there.
    const sources = named ? positionals(args).filter((a) => a !== named) : t >= 0 ? positionals(args).filter((a) => a !== dest) : positionals(args).slice(0, -1);
    const tw = to && pathOf(to, s, cwd, cwdKnown);
    const intoDir = to && (/[\\/]$/.test(to) || t >= 0 || sources.length > 1 || (tw?.path && (holdsProtected(tw.path, s) || segsOf(tw.path, s).at(-1) === ".agent-daemon" || s.isDir(tw.path) || startupFolder(tw.path, s))));
    if (intoDir && tw?.path) {
      for (const src of sources) {
        const j = s.pm.join(tw.path, String(src).split(/[\\/]/).filter(Boolean).pop() ?? "");
        worst(stateRule(j, s));
        worst(hostRule(j, s));
      }
    }
    return out;
  }
  // Interpreters: a script is run, not written; inline code or stdin code naming a protected path → deny.
  // .NET file methods in PowerShell: their text is code.
  if (/^\[(?:system\.)?io\.(?:file|directory)\]::/i.test(argv[0])) {
    // (The parser keeps only the method: its arguments are read from the line.)
    const code = `${argv.join(" ")} ${s.line ?? ""}`;
    for (const word of pathsInCode(code)) write(word);
    worst(splitPathRule(code));
    return out;
  }
  // sed's w, W and e commands (an address may come first) and s///w write or run.
  if (prog === "sed") {
    for (const a of args) {
      for (const m of String(a).matchAll(/(?:^|[;\n{}])\s*(?:[\d$]+|\/(?:\\.|[^/\n])*\/)?(?:\s*,\s*(?:[\d$]+|\/(?:\\.|[^/\n])*\/))?\s*!?\s*([wWe])\s+([^;\n}]+)/g)) {
        if (m[1] === "e") {
          // e runs a shell command: a delete or move of a folder that holds ad's state in it counts.
          for (const word of pathsInCode(m[2])) {
            const w = pathOf(word, s, cwd, cwdKnown);
            if (w?.path && holdsProtected(w.path, s)) worst(DENY("sed running a command on ad's state"));
            write(word);
          }
        }
        else write(m[2].trim());
      }
      for (const m of String(a).matchAll(/s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpIi0-9]*w\s*([^;\n}]+)/g)) write(m[2].trim());
    }
  }
  // awk writing with print > "file" or a redirect in its program.
  if (/^(?:awk|gawk|mawk|nawk)$/.test(prog)) {
    for (const word of pathsInCode(args.join(" "))) write(word);
    worst(deleteInCode(args.join(" "), s, cwd, cwdKnown));
  }
  // New-Item -Path <folder> -Name <file>: the file is the folder plus the name.
  if (prog === "new-item" || prog === "ni") {
    const at = (re) => args[args.findIndex((a) => re.test(a)) + 1];
    const dir = at(/^-path$/i);
    const name = at(/^-name$/i);
    if (dir && name) write(`${dir}${s.windows ? "\\" : "/"}${name}`);
  }
  if (RUNNERS.has(prog)) {
    const code = inlineCode(prog, argv) ?? (f.heredocs?.length ? f.heredocs.join("\n") : null);
    if (code !== null) {
      for (const word of pathsInCode(code)) write(word);
      worst(splitPathRule(code));
      worst(deleteInCode(code, s, cwd, cwdKnown));
    }
    const rest = positionals(args).slice(1);
    for (const word of fileWords(rest)) write(word);
    return out;
  }
  // Any other program: a protected path in its argv (positional or option value) is a write.
  for (const word of fileWords(args)) write(word);
  return out;
}

/** A startup write on a line that names one of ad's token or variant verbs: denied. */
export function startupDeny(r, s) {
  return r && r.class === "g" && r.decision === "ask" && s.badLine ? { ...r, decision: "deny" } : r;
}

// A path built from pieces in code: ".agent-daemon" with one of ad's state names, or with a recursive delete.
const STATE_PIECE = /["'`](?:guards[^"'`]*|episodic[^"'`]*|hooks|memory|projects\.json|install-ledger\.json|locks|buffer|recall|node_modules|project\.json|learning-journal[^"'`]*|rule-events\.jsonl|policy[^"'`]*)["'`]/i;
function splitPathRule(code) {
  const c = String(code);
  if (!/\.agent-daemon/i.test(c)) return null;
  if (/\.agent-daemon[\\/]+(?:guards|episodic|hooks|memory|projects\.json|projects[\\/]|install-ledger|locks|buffer|recall|node_modules|engine[\\/]+(?:config\.toml|hooks\.json)|policy|rule-events|project\.json|learning-journal)/i.test(c)) return DENY("code writing ad's state");
  if (STATE_PIECE.test(c) || /rmSync|rmdirSync|rmtree|removedirs|rm_rf|remove_dir_all|Remove-Item|Delete\(|recursive\s*:\s*true|-Recurse/i.test(c)) return DENY("code writing ad's state");
  return null;
}

/** Code that runs a shell delete or move (system(), .shell, subprocess…): the folders it names, judged. */
function deleteInCode(code, s, cwd, cwdKnown) {
  const c = String(code);
  if (!/system\s*\(|\.shell\b|\.system\b|subprocess|child_process|exec\w*\s*\(|spawn|popen|`/i.test(c)) return null;
  if (!/\brm\b|\brmdir\b|remove-item|\bmv\b|\bdel\b|\brd\b/i.test(c)) return null;
  for (const tok of c.split(/[\s"'`(),;{}[\]]+/)) {
    if (!/^(?:~|\$HOME|\$\{HOME\}|\/|[A-Za-z]:\\|\.agent-daemon)/.test(tok)) continue;
    const w = pathOf(tok, s, cwd, cwdKnown);
    if (w?.path && tok !== "/" && holdsProtected(w.path, s)) return DENY("code deleting or moving ad's state");
    if (w?.path && stateRule(w.path, s)) return DENY("code deleting or moving ad's state");
  }
  return null;
}

/** Path-like words inside code (quoted strings and bare paths). */
function pathsInCode(code) {
  const out = [];
  for (const m of String(code).matchAll(/["'`]([^"'`\n]{1,400})["'`]|(?:^|[\s(=,])((?:~|\$HOME|\/|[A-Za-z]:\\)[^\s"'`;,)]{1,400})/g)) {
    const w = m[1] ?? m[2];
    if (w && /[\\/]/.test(w)) out.push(w.trim());
  }
  return out;
}

/** git: its work tree and git dir, its subcommand; → a decision or null. */
function gitState(argv, f, s, cwd, cwdKnown) {
  let i = 1;
  let wt = null;
  let gd = null;
  let dir = cwd;
  let known = cwdKnown;
  for (const a of f.assigns ?? []) {
    const m = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(a);
    if (m) (m[1] === "GIT_DIR" ? (gd = m[2]) : (wt = m[2]));
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-C") {
      const w = pathOf(argv[++i], s, dir, known);
      if (w?.path) dir = w.path;
      else known = false;
    } else if (a === "-c") i++;
    else if (/^--work-tree=/.test(a)) wt = a.split("=").slice(1).join("=");
    else if (/^--git-dir=/.test(a)) gd = a.split("=").slice(1).join("=");
    else if (a === "--work-tree" || a === "--git-dir") (a === "--work-tree" ? (wt = argv[++i]) : (gd = argv[++i]));
    else if (!a.startsWith("-")) break;
  }
  const sub = argv[i] ?? "";
  const rest = argv.slice(i + 1);
  const inside = [wt, gd].filter(Boolean).map((x) => pathOf(x, s, dir, known)).concat(known && dir ? [{ path: dir }] : []).some((w) => w?.path && s.roots.some((r) => {
    const rel = below(w.path, r, s);
    return rel && rel[0] !== "worktrees";
  }));
  if (inside) {
    if (GIT_READS.has(sub) && !(sub === "diff" && rest.some((a) => /^--output/.test(a)))) return null;
    return DENY("git changing files inside ad's state");
  }
  if (GIT_READS.has(sub) && !rest.some((a) => /^--output/.test(a))) return null;
  // Messages are data; every other word may name a file the command writes.
  const words = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (/^(?:commit|tag|notes)$/.test(sub) && (a === "-m" || a === "--message" || a === "-F")) {
      k++;
      continue;
    }
    if (/^--message=/.test(a)) continue;
    words.push(a);
  }
  let out = null;
  for (const word of fileWords(words)) {
    const w = pathOf(word, s, dir, known);
    const r = w?.path ? stateRule(w.path, s) : w ? byText(w.text, s) : null;
    if (r && (!out || r.decision === "deny")) out = r;
  }
  return out;
}

// sqlite3 is a reader on a protected DB only with a null -init, allow-listed options, and only SELECTs on the line.
const SQLITE_OPTS = /^-(?:readonly|json|csv|header|line|list|batch|bail|noheader)$/;
const SQLITE_BAD = /writefile|edit\(|load_extension|\.output|\.once|\.save|\.backup|\.restore|\.import|\.shell|\.system|\.read|\battach\b|-init|-cmd/i;
function sqliteState(argv, f, s, cwd, cwdKnown) {
  let worst0 = null;
  const args = argv.slice(1);
  let db = null;
  let nullInit = false;
  const sql = [];
  let optsOk = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-init") {
      // (NUL is the null device on Windows only: elsewhere it's a file in the folder.)
      nullInit = args[i + 1] === "/dev/null" || (s.windows && /^nul$/i.test(args[i + 1] ?? ""));
      i++;
    } else if (/^-/.test(a)) {
      if (!SQLITE_OPTS.test(a)) optsOk = false;
      if (a === "-cmd") sql.push(args[i + 1] ?? "");
      if (/^-(?:cmd|separator|newline|nullvalue|vfs|mmap|pagecache|lookaside|heap|maxsize|zip|key|hexkey)$/.test(a)) i++; // its value
    } else if (db === null) db = a;
    else sql.push(a);
  }
  // .shell/.system in its SQL runs a command.
  worst0 = deleteInCode([...sql, ...(f.heredocs ?? [])].join("\n"), s, cwd, cwdKnown);
  if (worst0) return worst0;
  // A protected database attached from any SQL it gets (arguments, -cmd, heredocs, here-strings).
  for (const word of [...sql, ...(f.heredocs ?? [])].flatMap((q) => pathsInCode(q))) {
    const a = pathOf(word, s, cwd, cwdKnown);
    if (a?.path && stateRule(a.path, s)) return DENY("sqlite3 changing ad's state");
  }
  if (db === null) return null;
  const w = pathOf(db, s, cwd, cwdKnown);
  const rule = w?.path ? stateRule(w.path, s) : w ? byText(w.text, s) : null;
  if (!rule) {
    // A protected database attached from the SQL itself.
    for (const word of sql.flatMap((q) => pathsInCode(q))) {
      const a = pathOf(word, s, cwd, cwdKnown);
      if (a?.path && stateRule(a.path, s)) return DENY("sqlite3 changing ad's state");
    }
    return null;
  }
  const fed = (f.redirects ?? []).some((r) => !r.write) || (f.heredocs ?? []).length || f.pipedFrom;
  const selects = sql.length > 0 && sql.every((q) => !SQLITE_BAD.test(q) && String(q).split(";").filter((x) => x.trim()).every((st) => /^\s*(?:with\b[\s\S]*?\)\s*)?select\b|^\s*explain\b[\s\S]*\bselect\b|^\s*\.(?:schema|tables|indexes|dump)\b/i.test(st)));
  return nullInit && optsOk && selects && !fed ? null : DENY("sqlite3 changing ad's state");
}

/** A link command's target (the folder the link points to); undefined when this isn't one. */
function linkTarget(prog, args) {
  const pos = positionals(args);
  if (prog === "ln") return pos[0] ?? null;
  if (prog === "mklink") return args.some((a) => /^\/[jd]$/i.test(a)) ? pos.filter((a) => !/^\//.test(a))[1] ?? null : undefined;
  if (prog === "new-item" || prog === "ni") {
    const t = args.findIndex((a) => /^-itemtype$/i.test(a));
    if (t < 0 || !/^(?:symboliclink|junction|hardlink)$/i.test(args[t + 1] ?? "")) return undefined;
    const v = args.findIndex((a) => /^-(?:target|value)$/i.test(a));
    return v >= 0 ? args[v + 1] ?? null : null;
  }
  if (prog === "mount" && args.some((a) => /^--r?bind$/.test(a) || a === "-B")) return pos[0] ?? null;
  if (prog === "subst") return pos[1] ?? null;
  return undefined;
}

/** Where a tree-writing command (extract, recursive copy, sync, clone) writes; undefined when it isn't one. */
function treeDestination(prog, args, cwd) {
  const pos = positionals(args);
  const opt = (re) => {
    const i = args.findIndex((a) => re.test(a));
    if (i < 0) return undefined;
    return args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
  };
  if (prog === "tar" && args.some((a) => /^-?[a-zA-Z]*x/.test(a) && !/^--/.test(a) || a === "--extract")) return opt(/^-C$|^--directory/) ?? cwd ?? null;
  if (prog === "unzip") return opt(/^-d$/) ?? cwd ?? null;
  if ((prog === "cp" || prog === "copy-item" || prog === "cpi") && args.some((a) => /^-[a-zA-Z]*[rRa]/.test(a) || /^--recursive$|^-recurse$/i.test(a))) return pos.at(-1) ?? null;
  if (prog === "rsync") return pos.at(-1) ?? null;
  if (prog === "git" && pos[0] === "clone") return pos[2] ?? null;
  if (prog === "expand-archive") return opt(/^-destinationpath$/i) ?? cwd ?? null;
  if (prog === "robocopy" || prog === "xcopy") return pos[1] ?? null;
  return undefined;
}

/** Does this reader read a protected path? (Its output piped into anything but a reader could write it.) */
export function readsState(f, s, cwd, cwdKnown) {
  const prog = lower(f.argv[0]).replace(/\.exe$/, "").split(/[\\/]/).pop();
  if (!READERS.has(prog) && !/^sha\d*sum$/.test(prog) && !DATA_ONLY.has(prog)) return false;
  // A protected file, or a folder that holds them (a listing of it names them).
  return fileWords(f.argv.slice(1).map(String)).some((word0) => braces(word0).some((word) => {
    const w = pathOf(word, s, cwd, cwdKnown);
    if (w?.path && /[*?[]/.test(w.path)) {
      const base = w.path.split(/[\\/]+/).slice(0, w.path.split(/[\\/]+/).findIndex((x) => /[*?[]/.test(x))).join(s.windows ? "\\" : "/") || "/";
      return Boolean(globRule(w.path, s) || holdsProtected(base, s));
    }
    return Boolean(w?.path ? stateRule(w.path, s) || holdsProtected(w.path, s) : w ? byText(w.text ?? "", s) : null);
  }));
}
/** A text filter a reader may feed (sed without -i, w or e; awk without system or a redirect). */
export const isFilter = (prog, argv = []) => {
  const p = lower(prog).replace(/\.exe$/, "").split(/[\\/]/).pop();
  const text = argv.slice(1).join(" ");
  if (p === "sed") return !argv.slice(1).some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)) && !/(?:^|[;\s'"{}\d$\/])[wWe](?:\s|$)|\/[gpIi0-9]*w\s/.test(text);
  if (p === "awk" || p === "gawk" || p === "mawk") return !/system\s*\(|>|\|/.test(text);
  if (p === "xargs") {
    // xargs running a reader (or echo) only prints.
    const a = argv.slice(1);
    let i = 0;
    while (i < a.length && /^-/.test(a[i])) i += /^-(?:[nILPdsEa]|-max-args|-replace|-max-lines|-max-procs|-delimiter|-arg-file)$/.test(a[i]) ? 2 : 1;
    const run = lower(String(a[i] ?? "")).split(/[\\/]/).pop();
    return Boolean(run) && (READERS.has(run) || DATA_ONLY.has(run)) && !readerWrites(run, a.slice(i + 1));
  }
  return FILTERS.has(p) || DATA_ONLY.has(p);
};

// ---- file tools ---------------------------------------------------------------------------

/** The paths an apply_patch text writes: Add, Update, Delete, and Move to. */
export function patchPaths(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)) out.push(m[1]);
  return out;
}

/** Write, Edit or apply_patch: → a decision or null. */
export function judgeFileTool(paths, s, cwd, { tool = "write", input = {} } = {}) {
  let out = null;
  const take = (r) => {
    if (r && (!out || (out.decision === "ask" && r.decision === "deny"))) out = r;
  };
  for (const p of paths) {
    const w = pathOf(p, s, cwd, Boolean(cwd));
    if (!w?.path) {
      take(w ? byText(w.text ?? "", s) : null);
      continue;
    }
    take(stateRule(w.path, s));
    const kind = hostFile(w.path, s);
    // Claude Code's settings: the edit applied as the host would, the protected keys compared.
    if ((kind === "claude-settings" || kind === "claude-json") && /^(?:write|edit|multiedit)$/i.test(tool)) take(settingsChange(w.path, kind, tool.toLowerCase(), input, s));
    else if (kind === "mcp" && /^(?:write|edit|multiedit)$/i.test(tool)) take(namesDispatcher(w.path, tool.toLowerCase(), input) ? HOST("deny", "d", "a host config naming ad's dispatcher") : null);
    else {
      const r = hostRule(w.path, s);
      // An ad verb written into a startup file: denied.
      const text = [input.content, input.new_string, ...(Array.isArray(input.edits) ? input.edits.map((e) => e?.new_string) : [])].filter((x) => typeof x === "string").join("\n");
      take(r && r.class === "g" && r.decision === "ask" && s.mentions?.(text) ? { ...r, decision: "deny" } : r);
    }
  }
  return out;
}

const PROTECTED_KEYS = ["hooks", "disableAllHooks", "env", "statusLine", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "enabledPlugins", "enableAllProjectMcpServers", "enabledMcpjsonServers"];
const DISPATCHER_ONE = /bin[\\/]+hook\.mjs|memory[\\/]+launch[\\/]+run\.mjs|agent-daemon[^"']*\bhook\b/i;
const DISPATCHER = /bin[\\/]+hook\.mjs|memory[\\/]+launch[\\/]+run\.mjs|agent-daemon[^"']*\bhook\b/gi;

/** The file's text after this Write or Edit (null: an edit that doesn't apply exactly once). */
function afterEdit(p, tool, input) {
  let cur = null;
  try {
    // (A byte-order mark and CRLF line ends don't change what the host matches or parses.)
    cur = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  } catch {
    cur = null;
  }
  if (tool === "write") return { cur, next: String(input.content ?? "").replace(/^\uFEFF/, "") };
  let t = cur ?? "";
  for (const e of tool === "multiedit" ? (Array.isArray(input.edits) ? input.edits : []) : [input]) {
    const from = String(e?.old_string ?? "").replace(/\r\n/g, "\n");
    const to = String(e?.new_string ?? "").replace(/\r\n/g, "\n");
    if (!from) {
      if (cur !== null && cur !== "") return { cur, next: null };
      t = to;
      continue;
    }
    const n = t.split(from).length - 1;
    if (e.replace_all) t = t.split(from).join(to);
    else if (n === 1) t = t.replace(from, () => to);
    else return { cur, next: null };
  }
  return { cur, next: t };
}

function namesDispatcher(p, tool, input) {
  const { cur, next } = afterEdit(p, tool, input);
  if (next === null) return false;
  return (String(next).match(DISPATCHER) ?? []).length > (String(cur ?? "").match(DISPATCHER) ?? []).length;
}

function settingsChange(p, kind, tool, input, s) {
  const { cur, next } = afterEdit(p, tool, input);
  if (next === null) return HOST("ask", "d", "an edit to a host's settings that doesn't apply cleanly");
  let a;
  let b;
  try {
    a = cur === null || !cur.trim() ? {} : JSON.parse(cur);
    b = JSON.parse(next);
  } catch {
    return HOST("ask", "d", "a host's settings that can't be read");
  }
  if (b?.disableAllHooks && !a?.disableAllHooks) return HOST("deny", "d", "turning off every hook");
  if ((String(next).match(DISPATCHER) ?? []).length > (String(cur ?? "").match(DISPATCHER) ?? []).length) return HOST("deny", "d", "a host's settings naming ad's dispatcher");
  const keys = [...PROTECTED_KEYS, ...(kind === "claude-json" ? ["mcpServers"] : [])];
  if (keys.some((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]))) return HOST("ask", "d", "a change to a host's hooks, environment or helpers");
  // .claude.json keeps each project's MCP servers and approvals under projects[folder].
  if (kind === "claude-json") {
    const pick = (o) => JSON.stringify(Object.fromEntries(Object.entries(o?.projects ?? {}).map(([k, v]) => [k, [v?.mcpServers, v?.enabledMcpjsonServers, v?.enableAllProjectMcpServers]])));
    if (pick(a) !== pick(b)) return HOST("ask", "d", "a change to a project's MCP servers in the host's settings");
  }
  return null;
}
