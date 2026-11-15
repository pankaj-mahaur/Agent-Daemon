// The starter safety policy's matcher (MCP launch plan L7b; L7b design §1–2). Four
// families, each asked before (L7's enforcement path decides ask or deny per host):
//   recursive-delete    a recursive delete of a home folder, a filesystem or drive root,
//                       or the project root (~, $HOME, %USERPROFILE%, $env:USERPROFILE
//                       expanded; . and .. resolved against the cwd a chain's `cd` left);
//   force-push-default  git push with --force, -f, --force-with-lease or a +refspec whose
//                       destination is the default branch (a feature branch is allowed);
//   env-read            reading .env, .env.local or .env.<x>.local by a shell command or the
//                       Read tool (.env.example, .env.sample and .env.template are exempt);
//   no-verify           --no-verify on git commit or git push.
// A gate against accidents, not a sandbox: indirection (eval, a target held in a variable,
// xargs, a script the agent writes) is a stated limit.
//
// A call: {tool, input, os, cwd, project_root, policy: {homes, project_root,
// default_branches, current_branch}} — the branch fields may be functions (the hook reads
// git only when a push needs it). Pure: no fs, no spawn.

import { commandsIn, programName } from "./shell.mjs";

export const FAMILIES = Object.freeze(["recursive-delete", "force-push-default", "env-read", "no-verify"]);

/** What each family asks before, as the user and the model read it. */
export const FAMILY_TEXT = Object.freeze({
  "recursive-delete": "a recursive delete of the home folder, a drive or filesystem root, or the project folder",
  "force-push-default": "a force push to the default branch",
  "env-read": "reading a .env file",
  "no-verify": "--no-verify on git commit or git push",
});

const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "shell_command", "exec_command", "local_shell", "exec", "container.exec"]);
const lower = (s) => String(s ?? "").toLowerCase();
const prog = (a) => lower(programName(String(a ?? "")));
const resolveVal = (v) => (typeof v === "function" ? v() : v);

function dialectOf(call) {
  const tool = lower(call.tool);
  if (tool === "powershell") return "powershell";
  if (tool === "bash") return "bash";
  return call.os === "windows" ? "powershell" : "bash";
}

const commandOf = (input) => input?.command ?? input?.cmd ?? input?.action?.command;
const rawText = (c) => (Array.isArray(c) ? c.map(String).join(" ") : String(c ?? ""));

// ---- paths -------------------------------------------------------------------------------

const HOME_FORMS = [
  /^~(?=$|[\\/])/,
  /^\$\{HOME(?::?[-?=+][^}]*)?\}(?=$|[\\/])/,
  /^\$HOME(?=$|[\\/])/i,
  /^\$\{env:(?:USERPROFILE|HOME)\}(?=$|[\\/])/i,
  /^\$env:(?:USERPROFILE|HOME)(?=$|[\\/])/i,
  /^%USERPROFILE%(?=$|[\\/])/i,
  /^%HOMEDRIVE%%HOMEPATH%(?=$|[\\/])/i,
  /^\$env:HOMEDRIVE\$env:HOMEPATH(?=$|[\\/])/i,
  /^\$USERPROFILE(?=$|[\\/])/,
  /^\$\{USERPROFILE(?::?[-?=+][^}]*)?\}(?=$|[\\/])/,
];

/** ~, $HOME, %USERPROFILE% … at the start of a word → the home folder. */
export function expandHome(word, home) {
  const w = String(word);
  if (!home) return w;
  for (const re of HOME_FORMS) {
    const m = re.exec(w);
    if (m) return home + w.slice(m[0].length);
  }
  return w;
}

/**
 * A comparable absolute path: forward slashes, Git Bash /c/ as c:/, `.` and `..` resolved
 * against `cwd`, no trailing separator (roots stay "/" and "c:/"), case-folded on Windows
 * and macOS. → null when it can't be made absolute.
 */
export function normPath(p, { cwd = null, os = "linux" } = {}) {
  let s = String(p ?? "").replace(/\\/g, "/");
  if (!s) return null;
  const fold = os === "windows" || os === "macos";
  const gitBash = /^\/([a-zA-Z])(?=\/|$)/.exec(s);
  if (os === "windows" && gitBash) s = `${gitBash[1]}:${s.slice(2) || "/"}`;
  let drive = "";
  let rest;
  const d = /^([a-zA-Z]):(.*)$/.exec(s);
  if (d) {
    drive = d[1].toLowerCase() + ":";
    rest = d[2].startsWith("/") ? d[2] : null; // C:foo is drive-relative: unknown
    if (rest === null) {
      if (d[2] === "") rest = "/"; // "C:" — the drive's root as far as a delete goes
      else return null;
    }
  } else if (s.startsWith("/")) {
    rest = s;
  } else {
    if (!cwd) return null;
    const base = normPath(cwd, { os });
    if (!base) return null;
    const b = /^([a-z]:)(.*)$/i.exec(base);
    drive = b ? b[1] : "";
    rest = (b ? b[2] : base) + "/" + s;
  }
  const out = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  let r = drive + "/" + out.join("/");
  if (fold) r = r.toLowerCase();
  return r;
}

/** $PWD, ${PWD}, $(pwd), `pwd` and PowerShell's $PWD at the start of a word → the tracked cwd. */
const expandPwd = (w, cwd) => {
  const m = /^(?:\$\{PWD(?::?[-?=+][^}]*)?\}|\$PWD|\$\(pwd\)|`pwd`)(?=$|[\\/])/i.exec(String(w));
  return m && cwd ? cwd + String(w).slice(m[0].length) : String(w);
};

/** The system drive by name (%SystemDrive%, $env:SystemDrive, $env:HOMEDRIVE) → the home folder's drive (C: when unknown). */
const expandDrive = (w, home) => {
  const drive = /^([a-zA-Z]:)/.exec(String(home ?? ""))?.[1] ?? "C:";
  return String(w).replace(/^(?:%(?:SystemDrive|HOMEDRIVE)%|\$env:(?:SystemDrive|HOMEDRIVE)|\$\{env:(?:SystemDrive|HOMEDRIVE)\})(?=$|[\\/])/i, drive);
};

const isRoot = (n) => n === "/" || /^[a-z]:\/$/i.test(n);

// ---- recursive-delete ------------------------------------------------------------------

const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/i;
const PS_WHATIF = /^-wh(?:a(?:t(?:i(?:f)?)?)?)?(?::\$?true)?$/i;
const PS_PATH = /^-(?:p(?:a(?:t(?:h)?)?)?|l(?:i(?:t(?:e(?:r(?:a(?:l(?:p(?:a(?:t(?:h)?)?)?)?)?)?)?)?)?)?|lp|pspath)$/i;
const PS_VALUED = /^-(?:f(?:i(?:l(?:t(?:e(?:r)?)?)?)?)?|i(?:n(?:c(?:l(?:u(?:d(?:e)?)?)?)?)?)?|e(?:x(?:c(?:l(?:u(?:d(?:e)?)?)?)?)?)?|cr(?:e(?:d(?:e(?:n(?:t(?:i(?:a(?:l)?)?)?)?)?)?)?)?|st(?:r(?:e(?:a(?:m)?)?)?)?)$/i;

/** The targets a recursive delete names, or null when the argv isn't one. */
function deleteTargets(argv, dialect) {
  const name = prog(argv[0]);
  const args = argv.slice(1);
  if (name === "remove-item" || (dialect === "powershell" && ["rm", "ri", "del", "erase", "rd", "rmdir"].includes(name))) {
    // -Recurse by any prefix; bash habits typed into PowerShell (rm -rf ~) are asked too.
    if (!args.some((a) => PS_RECURSE.test(a) || /^-(?=[a-z]*r)[rf]{2}$/i.test(a)) || args.some((a) => PS_WHATIF.test(a))) return null;
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (PS_PATH.test(a)) {
        if (args[i + 1] !== undefined) out.push(...String(args[++i]).split(","));
        continue;
      }
      if (PS_VALUED.test(a)) {
        i++;
        continue;
      }
      if (/^-/.test(a)) continue;
      out.push(...a.split(","));
    }
    return out.map((s) => s.trim()).filter(Boolean);
  }
  if (dialect === "cmd" && ["rd", "rmdir", "del", "erase"].includes(name)) {
    const flags = args.filter((a) => a.startsWith("/")).join("").toLowerCase();
    if (!/\/s(?![a-z])/.test(flags)) return null;
    // cmd switches: /s, /q, glued /s/q, /a:h; everything else is a target.
    return args.filter((a) => !/^(?:\/[a-z?](?::\S*)?)+$/i.test(a));
  }
  if (name === "rm") {
    let recursive = false;
    const out = [];
    let opts = true;
    for (const a of args) {
      if (opts && a === "--") {
        opts = false;
        continue;
      }
      if (opts && /^--recursive$/.test(a)) recursive = true;
      else if (opts && /^-[a-zA-Z]+$/.test(a)) {
        if (/[rR]/.test(a)) recursive = true;
      } else if (opts && a.startsWith("--")) continue;
      else out.push(a);
    }
    return recursive ? out : null;
  }
  if (name === "find" && args.includes("-delete")) {
    // find <paths> -delete with nothing narrowing it deletes the whole tree.
    const i = args.findIndex((a) => /^[-(!]/.test(a));
    const rest = i < 0 ? [] : args.slice(i);
    const narrowing = rest.filter((a, k) => !/^-(?:delete|depth|xdev|mount|maxdepth|mindepth)$/.test(a) && !/^-(?:maxdepth|mindepth)$/.test(rest[k - 1] ?? ""));
    return narrowing.length ? null : i < 0 ? args : args.slice(0, i);
  }
  return null;
}

const CD = new Set(["cd", "set-location", "sl", "chdir", "pushd", "push-location"]);

function cdTarget(argv, dialect) {
  const args = argv.slice(1).filter((a) => !(dialect === "cmd" && /^\/d$/i.test(a)));
  for (let i = 0; i < args.length; i++) {
    if (/^-(?:p(?:ath)?|literalpath|lp)$/i.test(args[i])) return args[i + 1] ?? null;
    if (args[i] === "-" || args[i] === "--") continue;
    if (!/^-/.test(args[i])) return args[i];
  }
  return "~";
}

function protectedTargets(call, ctx) {
  const os = call.os ?? "linux";
  const homes = (ctx.homes ?? []).filter(Boolean);
  const set = new Set();
  for (const h of homes) {
    const n = normPath(h, { os });
    if (n) set.add(n);
  }
  const pr = ctx.project_root ?? call.project_root;
  for (const r of Array.isArray(pr) ? pr : [pr]) {
    const n = r ? normPath(r, { os }) : null;
    if (n) set.add(n);
  }
  return set;
}

function matchDelete(commands, call, ctx) {
  const os = call.os ?? "linux";
  // Read the folders only when a cd or a delete needs them (the hook builds them lazily).
  let homeV;
  let protV;
  const homeOf = () => (homeV === undefined ? (homeV = (ctx.homes ?? []).find(Boolean) ?? null) : homeV);
  const protOf = () => (protV ??= protectedTargets(call, ctx));
  let cwd = call.cwd ?? null;
  for (const { argv, dialect } of commands) {
    const name = prog(argv[0]);
    const home = CD.has(name) || deleteTargets(argv, dialect) ? homeOf() : null;
    if (CD.has(name)) {
      const t = cdTarget(argv, dialect);
      const n = t ? normPath(expandHome(t, home), { cwd, os }) : null;
      if (n) cwd = n;
      continue;
    }
    const targets = deleteTargets(argv, dialect);
    if (!targets) continue;
    for (const t of targets) {
      let s = expandHome(expandPwd(expandDrive(t, home), cwd), home).replace(/\\/g, "/");
      // `.*` alone takes in `..` on bash before 5.2 (no globskipdots): the parent folder.
      if (s === ".*") s = "..";
      if (dialect === "powershell" && s === "/") s = "/";
      // A folder's contents glob is the folder: /*, ~/*, C:\*, ./*, *
      s = s.replace(/\/(?:\*|\.\*)$/, "/").replace(/^\*$/, ".");
      if (/^\/+$/.test(s)) return { match: true, argv };
      const n = normPath(s, { cwd, os });
      if (!n) continue;
      // The folder itself, or one above it (rm -rf /home takes the home folder with it).
      if (isRoot(n) || [...protOf()].some((p) => p === n || p.startsWith(n + "/"))) return { match: true, argv };
    }
  }
  return null;
}

// ---- git ---------------------------------------------------------------------------------

const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/** git's subcommand and the arguments after it, or null. */
function gitSub(argv) {
  if (prog(argv[0]) !== "git") return null;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (GIT_VALUED.has(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith("-")) continue;
    const configs = args.slice(0, i).filter((a, k, all) => all[k - 1] === "-c");
    const elsewhere = args.slice(0, i).some((a) => a === "-C" || a === "--git-dir" || a.startsWith("--git-dir=") || a === "--work-tree" || a.startsWith("--work-tree="));
    return { sub: args[i], rest: args.slice(i + 1), configs, elsewhere };
  }
  return null;
}

const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function matchForcePush(commands, ctx) {
  for (const { argv } of commands) {
    const g = gitSub(argv);
    if (!g || g.sub !== "push") continue;
    let force = false;
    let dry = false;
    let all = false;
    const pos = [];
    let opts = true;
    for (let i = 0; i < g.rest.length; i++) {
      const a = g.rest[i];
      if (opts && a === "--") {
        opts = false;
        continue;
      }
      if (opts && PUSH_VALUED.has(a)) {
        i++;
        continue;
      }
      if (opts && a.startsWith("--")) {
        const n = a.split("=")[0];
        // git takes an unambiguous prefix (--forc, --force-w).
        if (n.length >= 6 && ["--force", "--force-with-lease", "--force-if-includes"].some((f) => f.startsWith(n))) force = true;
        else if (n === "--dry-run") dry = true;
        else if (n === "--all" || n === "--branches") all = true;
        else if (n === "--mirror") {
          all = true;
          force = true;
        }
        continue;
      }
      if (opts && /^-[a-zA-Z0-9]+$/.test(a)) {
        if (a.includes("f")) force = true;
        if (a.includes("n")) dry = true;
        continue;
      }
      pos.push(a);
    }
    const refspecs = pos.slice(1);
    if (refspecs.some((r) => r.startsWith("+"))) force = true;
    if (!force || dry) continue;
    const defaults = (resolveVal(ctx.default_branches) ?? []).filter(Boolean);
    // git -C <dir>: another repository, whose branch the folder's reads don't know.
    const current = g.elsewhere ? null : resolveVal(ctx.current_branch) ?? null;
    const isDefault = (b) => (b == null ? true : defaults.includes(b));
    if (all) return { match: true, argv };
    const real = refspecs.filter((r) => r !== "HEAD" && r !== "+HEAD" && r !== "@");
    if (!real.length) {
      if (isDefault(current)) return { match: true, argv };
      continue;
    }
    for (const r of refspecs) {
      const s = r.replace(/^\+/, "");
      if (s.startsWith(":")) continue; // a delete, not a force push
      let dst = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
      if (dst === "HEAD" || dst === "@") dst = current;
      else dst = dst.replace(/^refs\/heads\//, "");
      if (dst === null ? isDefault(null) : defaults.includes(dst)) return { match: true, argv };
    }
  }
  return null;
}

const COMMIT_VALUED = new Set(["-m", "-F", "-c", "-C", "-t", "--author", "--date", "--fixup", "--squash", "--cleanup", "--trailer", "--template", "--file", "--message", "--reuse-message", "--reedit-message", "--pathspec-from-file"]);

function matchNoVerify(commands) {
  for (const { argv } of commands) {
    const g = gitSub(argv);
    if (!g || (g.sub !== "commit" && g.sub !== "push")) continue;
    // Pointing core.hooksPath away skips the hooks just the same.
    if (g.configs.some((c) => /^core\.hookspath=/i.test(c))) return { match: true, argv };
    const valued = g.sub === "commit" ? COMMIT_VALUED : PUSH_VALUED;
    for (let i = 0; i < g.rest.length; i++) {
      const a = g.rest[i];
      if (a === "--") break;
      if (valued.has(a)) {
        i++;
        continue;
      }
      // git takes any unambiguous prefix of a long option (--no-verif).
      if (a.length >= 7 && "--no-verify".startsWith(a)) return { match: true, argv };
      // git commit -n is --no-verify (on push, -n is a dry run); in a cluster, a letter
      // that takes a value ends it (-mn is the message "n").
      if (g.sub === "commit" && /^-[a-zA-Z]+$/.test(a)) {
        for (const ch of a.slice(1)) {
          if (ch === "n") return { match: true, argv };
          if ("mFcCt".includes(ch)) break;
        }
      }
    }
  }
  return null;
}

// ---- env-read ----------------------------------------------------------------------------

const EXEMPT = new Set([".env.example", ".env.sample", ".env.template"]);

/** Is this path's last segment .env, .env.local or .env.<x>.local (not an exempt name)? */
export function isEnvFile(p, { os = "linux" } = {}) {
  let s = String(p ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!s) return false;
  const base = s.split(/[\\/]/).pop();
  const b = os === "windows" ? base.toLowerCase() : base;
  if (EXEMPT.has(b)) return false;
  if (/[*?{]/.test(b)) {
    // A glob that takes in a protected file (.env*, .env.*, .env.{local,production}) reads it.
    const alts = /\{([^{}]*)\}/.exec(b);
    if (alts) return alts[1].split(",").some((alt) => isEnvFile(b.slice(0, alts.index) + alt + b.slice(alts.index + alts[0].length), { os }));
    const re = new RegExp("^" + b.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", os === "windows" ? "i" : "");
    return [".env", ".env.local", ".env.development.local"].some((n) => re.test(n)) && b.startsWith(".");
  }
  return b === ".env" || b === ".env.local" || /^\.env\..+\.local$/.test(b);
}

/** Does this argument name a protected file, directly or as an @file / key=@file value? */
function argNamesEnv(a, os) {
  const s = String(a);
  if (isEnvFile(s, { os })) return true;
  const at = s.lastIndexOf("@");
  if (at >= 0 && isEnvFile(s.slice(at + 1).split(/[;,]/)[0], { os })) return true;
  const eq = s.indexOf("=");
  if (eq > 0 && isEnvFile(s.slice(eq + 1).replace(/^@/, "").split(/[;,]/)[0], { os })) return true;
  return false;
}

const VIEWERS = new Set(["cat", "less", "more", "head", "tail", "tac", "nl", "bat", "batcat", "type", "sort", "uniq", "cut", "wc", "strings", "xxd", "od", "hexdump", "base64", "diff", "cmp", "comm", "get-content", "gc", "source", ".", "dos2unix", "iconv", "jq", "yq", "column", "fold", "paste", "openssl", "gpg"]);
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "findstr", "select-string", "sls"]);
const SCRIPTED = new Set(["sed", "awk", "gawk", "mawk", "nawk", "perl"]);
const COPIERS = new Set(["cp", "copy", "copy-item", "cpi", "scp", "rsync", "xcopy", "robocopy"]);
const UPLOADERS = new Set(["curl", "wget", "http", "https", "nc"]);
const INTERP = { python: ["-c"], python3: ["-c"], py: ["-c"], node: ["-e", "-p", "--eval", "--print"], deno: ["eval"], bun: ["-e", "--eval"], ruby: ["-e"], perl: ["-e", "-E"], php: ["-r"] };

function readsEnv(argv, dialect, os) {
  const name = prog(argv[0]);
  const args = argv.slice(1);
  if (VIEWERS.has(name) || (dialect === "cmd" && name === "type")) return args.some((a) => argNamesEnv(a, os));
  if (SEARCHERS.has(name)) {
    // The pattern isn't a file: the first non-option, unless -e/-f/--regexp/-Pattern gave it.
    const patternFlag = args.some((a) => /^(?:-e|-f|--regexp(?:=.*)?|--file(?:=.*)?|-pattern|\/c:.*|\/g:.*)$/i.test(a));
    let skippedPattern = patternFlag;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^(?:-e|--regexp|-pattern)$/i.test(a)) {
        i++;
        continue;
      }
      if (/^(?:-path|-literalpath)$/i.test(a)) {
        if (argNamesEnv(args[i + 1] ?? "", os)) return true;
        i++;
        continue;
      }
      if (/^[-/]/.test(a) && a.length > 1) continue;
      if (!skippedPattern) {
        skippedPattern = true;
        continue;
      }
      if (argNamesEnv(a, os)) return true;
    }
    return false;
  }
  if (SCRIPTED.has(name)) {
    const scriptFlag = args.some((a) => /^(?:-e|-f|--expression(?:=.*)?|--file(?:=.*)?|-E|-n?e)$/.test(a));
    let skipped = scriptFlag;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^(?:-e|-E|--expression|-F|-v)$/.test(a)) {
        i++;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) continue;
      if (!skipped) {
        skipped = true;
        continue;
      }
      if (argNamesEnv(a, os)) return true;
    }
    return false;
  }
  if (COPIERS.has(name)) {
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-(?:path|literalpath)$/i.test(a)) {
        if (argNamesEnv(args[i + 1] ?? "", os)) return true;
        i++;
        continue;
      }
      if (/^-(?:destination|t|target-directory)$/i.test(a)) {
        i++;
        continue;
      }
      if (/^[-/]/.test(a) && a.length > 1 && !/^\/[^/]*\//.test(a) && (a.startsWith("-") || dialect === "cmd")) continue;
      pos.push(a);
    }
    return pos.slice(0, -1).some((a) => argNamesEnv(a, os));
  }
  if (UPLOADERS.has(name)) return args.some((a) => (a.includes("@") || /^--(?:post|body)-file=/.test(a)) && argNamesEnv(a, os)) || args.some((a, i) => /^(?:-T|--upload-file|--post-file|--body-file)$/.test(args[i - 1] ?? "") && argNamesEnv(a, os));
  if (INTERP[name]) {
    for (let i = 0; i < args.length; i++) if (INTERP[name].includes(args[i]) && quotedEnv(args[i + 1] ?? "", os)) return true;
    return false;
  }
  return false;
}

/** A quoted protected name inside code text: open('.env'), File.ReadAllText(".env"). */
function quotedEnv(code, os) {
  for (const m of String(code).matchAll(/["'`]([^"'`\n]{1,300})["'`]/g)) if (isEnvFile(m[1], { os })) return true;
  return false;
}

/** Reads the parser can't show as argv: `< .env` input redirects and .NET file reads. */
function rawEnvRead(text, os) {
  for (const m of text.matchAll(/(?:^|[^<0-9])\d?<(?![<(&])\s*(["']?)([^\s"'<>|&;)]+)\1/g)) if (isEnvFile(m[2], { os })) return true;
  for (const m of text.matchAll(/\[(?:System\.)?IO\.File\]::(?:Read\w*|Open\w*|Copy)\s*\(\s*(["'])([^"']+)\1/gi)) if (isEnvFile(m[2], { os })) return true;
  for (const m of text.matchAll(/\bStreamReader\s*\(?\s*(["'])([^"']+)\1/gi)) if (isEnvFile(m[2], { os })) return true;
  return false;
}

function matchEnvRead(commands, call, text) {
  const os = call.os ?? "linux";
  for (const { argv, dialect } of commands) {
    if (readsEnv(argv, dialect, os)) return { match: true, argv };
    // git show HEAD:.env, git cat-file -p main:.env.local
    const g = gitSub(argv);
    if (g && (g.sub === "show" || g.sub === "cat-file") && g.rest.some((a) => /^[^-][^:]*:/.test(a) && isEnvFile(a.slice(a.indexOf(":") + 1), { os }))) return { match: true, argv };
  }
  if (rawEnvRead(text, os)) return { match: true };
  return null;
}

// ---- the matcher -------------------------------------------------------------------------

const TRIGGER = {
  "recursive-delete": /(?:^|[^\w-])(?:rm|remove-item|ri|rd|rmdir|del|erase)(?:$|[^\w-])/i,
  "force-push-default": /\bgit\b[^\n;|&]*\bpush\b/i,
  "env-read": /(?:^|[\s"'`=@<\\/])\.env(?:\.local|\.[^\s"'`\\/;|&]+\.local)?(?=$|[\s"'`;|&)])/i,
  "no-verify": /--no-verify\b/i,
};

/**
 * Does the call do what the family asks before?
 * @returns {{match:boolean, argv?:string[], path?:string, incomplete?:boolean, error?:string}}
 */
export function matchPolicy(family, call) {
  if (!FAMILIES.includes(family)) return { match: false, error: `unknown policy family ${family}` };
  const tool = lower(call?.tool);
  const ctx = call?.policy ?? {};
  if (family === "env-read" && (tool === "read" || tool === "grep" || tool === "notebookread")) {
    for (const p of [call.input?.file_path, call.input?.path, call.input?.notebook_path, call.input?.glob, call.input?.include]) {
      if (typeof p !== "string" || !p) continue;
      if (isEnvFile(p, { os: call.os })) return { match: true, path: p };
    }
    return { match: false };
  }
  if (!SHELL_TOOLS.has(tool)) return { match: false };
  const command = commandOf(call.input);
  if (command == null) return { match: false };
  const dialect = dialectOf(call);
  // The shared parser reads PowerShell's ${env:X} as a script block: say it as $env:X.
  const said = dialect === "powershell" && typeof command === "string" ? command.replace(/\$\{env:(\w+)\}/gi, "$$env:$1") : command;
  const commands = commandsIn(said, { dialect, os: call.os ?? "linux" });
  const text = rawText(command);
  const hit =
    family === "recursive-delete" ? matchDelete(commands, call, ctx)
    : family === "force-push-default" ? matchForcePush(commands, ctx)
    : family === "env-read" ? matchEnvRead(commands, call, text)
    : matchNoVerify(commands);
  if (hit) return hit;
  if (commands.incomplete && TRIGGER[family].test(text)) return { match: true, incomplete: true };
  return { match: false };
}
