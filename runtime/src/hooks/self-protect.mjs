// ad's self-protection filter for shell calls (MCP launch plan L7, design D12 a, b, e, h).
// Run first for every Bash, PowerShell and Codex shell call, before the rules snapshot is
// read; pause and allow-once never apply. Enumerated and incomplete by design (stated): it
// recognises the verbs, wrappers, launchers and variables an agent would use to run ad's
// review-only commands or to change how ad's hooks see the agent's shell.
//
//   selfProtect(input, opts) → null | { decision: "deny" | "ask", class, why }
//
//   a  protected verbs: ad's review-only commands (token-only) never run from the agent's
//      shell; the token-variant ones run bare but never under a wrapper (b); a verb that
//      isn't a literal counts as token-only; ad's internal entry files are token-only.
//      An entry point reached any other way (an argument of another program, inline code,
//      a shell fed on stdin, a command held in a variable) is judged as wrapped.
//   b  wrappers and other terminals: PTY and reparenting wrappers are seen through (a verb
//      inside is judged as wrapped); anything that starts a program in the user's desktop
//      session or types into a terminal asks, and denies with a token or token-variant verb
//      inside; nested agents with their settings or config moved deny or ask.
//   e  env tampering: AD_TOOL_SHELL touched in any way but a read; injection and root
//      variables set for an ad command with a non-read verb (outside the scratch-root case).
//   h  run-time-built programs whose first argument is one of ad's verbs ask.
//
// Writes to ad's state, host config, startup files and the Windows folder (c, d, f, g) are
// P2b's. Pure apart from reading ad's dist list (lazily, for a `node <script>` call) and
// the real path of a scratch root. The reason never names a command (S4).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandsIn, programName } from "../rules/shell.mjs";
import { dialectOf } from "../rules/match.mjs";
import { callOf, strongTrigger } from "./tool-before.mjs";
import { ENTRY_NAMES, REPARENTING as REPARENTING_LIST, TERMINALS as TERMINAL_LIST, DESKTOP as DESKTOP_LIST } from "./self-protect-words.mjs";

const lower = (s) => String(s ?? "").toLowerCase();
const ENTRIES = new Set(ENTRY_NAMES.map(lower));
const AD_CLI = new Set(["ad", "agent-daemon"]);

const WORDS = {
  token: "a command only the user can run from their own terminal (it changes what is remembered or enforced)",
  variant: "a command the agent may run only directly, never through another program or terminal",
  nonliteral: "a command of ad's whose verb is built at run time, so it can't be checked",
  internal: "one of ad's own hook or job entry points, which only its hooks start",
  marker: "a change to the marker ad's hooks use to recognise the agent's shell",
  env: "a variable that changes what code or which settings a command of ad's uses",
  built: "a program built at run time with one of ad's verbs",
  desktop: "a program started in the user's desktop session or typed into a terminal",
  agent: "a nested agent started with its settings, config or hooks moved",
  agentAsk: "a nested agent or its settings changed",
};

const deny = (cls, why) => ({ decision: "deny", class: cls, why });
const ask = (cls, why) => ({ decision: "ask", class: cls, why });
const worst = (a, b) => (!a ? b : !b ? a : a.decision === "deny" ? a : b.decision === "deny" ? b : a);

/**
 * A word whose value the shell builds at run time: a variable, a substitution, a cmd or
 * PowerShell variable, an xargs placeholder; in PowerShell also `(…)` and `@splat`.
 */
export const isExpansion = (w, ps = false) => /\$|`|%[A-Za-z_]\w*%|![A-Za-z_]\w*!|\{\}/.test(String(w ?? "")) || (ps && /^[(@]/.test(String(w ?? "")));

// ---- ANSI-C quoting ($'\x61d'): decoded before parsing (the parser keeps it literal) ----

function decodeAnsiC(body) {
  const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  const cp = (n) => (n > 0x10ffff ? "\u{fffd}" : String.fromCodePoint(n)); // bash clamps too
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/g, (m, e) => {
    if (e[0] === "x" || e[0] === "u" || e[0] === "U") return cp(Number.parseInt(e.slice(1), 16) || 0);
    if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8));
    if (e[0] === "c") return String.fromCharCode(e.charCodeAt(1) & 31);
    return simple[e] ?? m;
  });
}
/** $'…' spans as ordinary single-quoted text. */
export function decodeAnsiCQuotes(text) {
  return String(text).replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, body) => `'${decodeAnsiC(body).replace(/'/g, `'\\''`)}'`);
}

// ---- text views -------------------------------------------------------------------------

/** Text with quotes, backslashes, carets and backticks removed (the fast path's view). */
export const flat = (t) => String(t ?? "").replace(/["'\\^`]/g, "");
/** Quoted spans blanked (same length): a quoted `&` or `NAME=` is data. */
export const unquoted = (t) => String(t ?? "").replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));
/** 'a'+'d' → 'ad': string concatenation (PowerShell, JavaScript) joined before the words are read. */
function joinConcat(t) {
  let s = String(t ?? "");
  for (let i = 0; i < 20; i++) {
    const next = s.replace(/(['"])([^'"]*)\1\s*\+\s*(['"])([^'"]*)\3/g, "$1$2$4$1");
    if (next === s) break;
    s = next;
  }
  return s;
}
/** Words as the shell may join them at run time: escapes, concatenations, operators and brackets as spaces. */
const mentionText = (t) => flat(joinConcat(t).replace(/\\[ntr0]|\^M|\{ENTER\}/gi, " ")).replace(/[+,()[\]{};|&<>=]/g, " ");

const VERB_RE = "review|rules|safety|learnings?|setup|install|repair|uninstall|config|consolidate|memory|remember|forget|restore|tui|init|hook|session-start|user-prompt-extract|query-retrieve";
const ENTRY_RE = [...ENTRIES].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const MENTION = new RegExp(`(?<![\\w$-])(?:${ENTRY_RE})(?:@[^\\s@]*)?(?:\\.\\w+)?\\s+(?:-\\S+\\s+)*(?:${VERB_RE})(?![\\w-])`, "i");
/** An ad entry point followed by one of its verbs anywhere in the text (as it may run). */
export const mentionsVerb = (text) => MENTION.test(mentionText(text));
const PS_GROUP_OPTION = new RegExp(`(?<![\\w$-])(?:${ENTRY_RE})\\s+(?:-\\S+\\s+){1,6}\\(`, "i");
const PS_GROUP_ARG = new RegExp(`(?<![\\w$-])(?:${ENTRY_RE})\\s+(?:[^\\s;|(]+\\s+){0,4}(?:${VERB_RE})\\s+(?:[^\\s;|(]+\\s+){0,4}\\(`, "gi");

/** Programs that only read or print their arguments: text in them is data. */
const READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "echo", "cat", "less", "more", "head", "tail", "git", "wc", "diff", "man", "which", "type", "whereis", "printenv", "jq", "yq", "ls", "tree", "file", "stat", "nl", "sort", "uniq", "cut", "tr", "column", "bat", "test", "[", "select-string", "sls", "write-output", "write-host", "get-content", "apropos", "tldr", "help"]);
/** Programs whose arguments are files or text, never a command line to run. */
// (A container's command runs in the container, not on this machine's ad.)
const NOT_RUNNERS = new Set([...READERS, "cp", "mv", "rm", "ln", "mkdir", "touch", "chmod", "chown", "tar", "zip", "unzip", "rsync", "scp", "printf", "npm", "pnpm", "yarn", "pip", "pip3", "brew", "apt", "apt-get", "dnf", "cargo", "go", "docker", "podman", "nerdctl", "kubectl", "docker-compose"]);

/** Does a sed command line run a command (the `e` command, or the `e` flag of `s`)? */
const SED_ADDR = String.raw`(?:[\d$~+]+|\/(?:\\.|[^/\n])*\/[IM]*)`;
const SED_E = new RegExp(String.raw`(?:^|[;\n{}])\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?)?\s*!?\s*e(?:\s|$)`);
const SED_S_E = new RegExp(String.raw`(?:^|[;\n{}])\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?)?\s*!?\s*s([^\\\n])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-zA-Z0-9]*e`);
const sedRuns = (argv) => argv.slice(1).map((a) => a.replace(/^--expression=/, "")).some((a) => SED_E.test(a) || SED_S_E.test(a));

/**
 * The line's terminated heredocs in one pass: { tag, quoted, head (index of `<<`), bodyStart, bodyEnd, end }.
 * A tag's terminator is looked up once and reused, so many heads stay linear.
 */
function heredocs(t) {
  const out = [];
  const next = new Map(); // tag → { from, at, len } (at -1: none after from)
  const termAfter = (tag, from) => {
    let hit = next.get(tag);
    if (!hit || from < hit.from || (hit.at >= 0 && from > hit.at)) {
      const term = new RegExp(String.raw`\n[ \t]*${tag}[ \t]*(?=\r?\n|$)`, "g");
      term.lastIndex = from;
      const f = term.exec(t);
      hit = { from, at: f ? f.index : -1, len: f ? f[0].length : 0 };
      next.set(tag, hit);
    }
    return hit;
  };
  const re = /(?<!<)<<(?!<)-?[ \t]*(?:\\(\w+)|(['"])(\w+)\2|(\w+))/g;
  let m;
  let seen = 0;
  while ((m = re.exec(t))) {
    // A head budget: past it the line isn't read for heredocs (the caller decides without them).
    if (++seen > 256) {
      out.over = true;
      break;
    }
    const nl = t.indexOf("\n", re.lastIndex);
    if (nl < 0) break;
    // Every head on this line, in order: their bodies follow one another after it.
    const heads = [m];
    let k;
    while ((k = re.exec(t)) && k.index < nl) {
      heads.push(k);
      if (++seen > 256) {
        out.over = true;
        break;
      }
    }
    let from = nl;
    for (const h of heads) {
      const tag = h[1] ?? h[3] ?? h[4];
      const hit = termAfter(tag, from);
      if (hit.at < 0) continue; // no terminator (an arithmetic <<, say): not a heredoc; the text stays as it is
      out.push({ tag, quoted: h[1] !== undefined || h[2] !== undefined, head: h.index, bodyStart: from + 1, bodyEnd: hit.at, end: hit.at + hit.len });
      from = hit.at + hit.len;
    }
    if (out.over) break;
    re.lastIndex = from;
  }
  return out;
}

/** A heredoc fed to a reader (cat, git, tee, grep, rg) is data: its body is dropped. */
function readerHeredocsRemoved(t) {
  // (Only the bodies: the head lines are words the check reads anyway.)
  let out = "";
  let from = 0;
  for (const h of heredocs(t)) {
    if (h.bodyStart < from) continue;
    const lineStart = t.lastIndexOf("\n", h.head) + 1;
    if (!/\b(?:cat|git|tee|grep|rg)\b[^\n;&|]*$/.test(t.slice(Math.max(lineStart, h.head - 512), h.head))) continue;
    // (Piped on into a shell or an interpreter, the body runs.)
    if (/\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|python\d?|node|perl|ruby|php|lua|source|eval|xargs)\b/.test(t.slice(h.head, h.bodyStart))) continue;
    out += t.slice(from, h.bodyStart);
    from = h.end;
  }
  return out + t.slice(from);
}

/** Text with data an agent's command can't run removed: reader arguments, heredocs fed to readers, comments. */
function dataStripped(text, found, ps = false, deadline = Infinity) {
  const t0 = String(text).replace(/-c?replace\s+(?:'[^']*'|"[^"$`]*")(?:\s*,\s*(?:'[^']*'|"[^"$`]*"))?/gi, " ");
  const t = readerHeredocsRemoved(t0);
  // Each found command is placed by its program word and all its arguments in a row, inside
  // one segment of the line (separators, groups and substitutions start a new one), from where
  // the last one ended, else from the start; so a copy elsewhere on the line is never taken for
  // it. Only a reader's or an ad command's own arguments are cut.
  const words = wordSpans(t, ps);
  const byProg = new Map();
  words.forEach((w, k) => {
    const list = byProg.get(w.p);
    if (list) list.push(k);
    else byProg.set(w.p, [k]);
  });
  const cut = [];
  let cur = 0;
  // A budget of word compares (and the deadline): a command that can't be placed in it stays
  // unplaced, so nothing of it is cut.
  let compares = 0;
  for (const f of found) {
    if (Date.now() > deadline || compares > 200000) break;
    const prog = lower(programName(f.argv[0]));
    const args = f.argv.slice(1);
    const starts = byProg.get(prog) ?? [];
    const place = (from) => {
      for (const p of starts) {
        if (p < from || p + args.length >= words.length) continue;
        if (++compares > 200000 || ((compares & 1023) === 0 && Date.now() > deadline)) return -1;
        let j = 0;
        while (j < args.length && words[p + 1 + j].v === args[j] && words[p + 1 + j].seg === words[p].seg) j++;
        compares += j;
        if (j === args.length) return p;
      }
      return -1;
    };
    let p = place(cur);
    if (p < 0) p = place(0);
    if (p < 0) continue;
    cur = p + 1 + args.length;
    // An ad command's own text (`ad remember "…"`) is data here too: its verb is judged on its own.
    // sed's script is data unless it runs a command (the `e` command or flag).
    const reader = READERS.has(prog) || entryKind(f.argv[0]) || (prog === "printf" && !f.argv.includes("-v")) || (prog === "sed" && !sedRuns(f.argv));
    // (A word holding a substitution is cut too: what runs inside it is judged on its own.)
    if (reader) for (let k = p + 1; k < cur; k++) cut.push(words[k]);
    // A shell's literal -c script is judged on its own: here it is data.
    else if (SHELL_PROGS.has(prog)) for (let k = p + 2; k < cur; k++) if (isScriptFlag(words[k - 1].v) && !WHOLE_EXPANSION.test(words[k].v)) cut.push(words[k]);
  }
  let out = "";
  let from = 0;
  for (const w of cut.sort((a, b) => a.start - b.start)) {
    if (w.start < from) continue;
    out += t.slice(from, w.start) + " ";
    from = w.end;
  }
  out += t.slice(from);
  return out.replace(/(^|\s)#[^\n]*/g, "$1");
}

/** The line's words with their unquoted text and where they sit (redirect targets left out). */
function wordSpans(t, ps) {
  const out = [];
  const n = t.length;
  const esc = ps ? "`" : "\\";
  let i = 0;
  let seg = 0;
  let redirect = false;
  while (i < n) {
    const c = t[i];
    if (c === esc && t[i + 1] === "\n") {
      i += 2; // a line continuation joins the lines
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") {
      seg++;
      redirect = false;
      i++;
      continue;
    }
    if (c === "<" || c === ">") {
      while (i < n && (t[i] === "<" || t[i] === ">" || t[i] === "&" || t[i] === "|")) i++;
      redirect = true;
      continue;
    }
    const start = i;
    let v = "";
    let sub = false;
    while (i < n && !/[\s;|&()<>]/.test(t[i])) {
      const ch = t[i];
      if (ch === esc && t[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (ch === "'") {
        const e = t.indexOf("'", i + 1);
        if (e < 0) {
          v += t.slice(i + 1);
          i = n;
          break;
        }
        v += t.slice(i + 1, e);
        i = e + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < n && t[i] !== '"') {
          if (t[i] === esc && t[i + 1] === "\n") i += 2;
          else if (!ps && t[i] === "\\" && i + 1 < n && '"\\$`'.includes(t[i + 1])) {
            v += t[i + 1];
            i += 2;
          } else if (ps && t[i] === "`" && i + 1 < n) {
            v += t[i + 1];
            i += 2;
          } else {
            if ((t[i] === "$" && t[i + 1] === "(") || (!ps && t[i] === "`")) sub = true;
            v += t[i++];
          }
        }
        i++;
        continue;
      }
      if (ch === esc) {
        if (i + 1 < n) v += t[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && t[i + 1] === "(") {
        // The whole balanced substitution is part of this word.
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          if (t[j] === "(") depth++;
          else if (t[j] === ")" && --depth === 0) break;
        }
        v += t.slice(i, j + 1);
        i = j + 1;
        sub = true;
        continue;
      }
      if (!ps && ch === "`") {
        const j = t.indexOf("`", i + 1);
        v += t.slice(i, j < 0 ? n : j + 1);
        i = j < 0 ? n : j + 1;
        sub = true;
        continue;
      }
      v += ch;
      i++;
    }
    if (/^\d*$/.test(v) && (t[i] === "<" || t[i] === ">")) continue; // 2>, 1>&2: the fd number
    if (redirect) {
      redirect = false;
      continue;
    }
    out.push({ v, p: lower(programName(v)), start, end: Math.min(i, n), seg, sub });
    // A word holding a substitution: what runs inside it is another segment, and so is what follows.
    if (sub) seg++;
  }
  return out;
}

// ---- variables (D12e) -------------------------------------------------------------------

/** Names the text sets or exports, the ones it unsets, and whether it clears the environment. */
export function variablesSet(text) {
  const t = flat(text);
  const set = new Set();
  const unset = new Set();
  for (const m of t.matchAll(/(?:^|[\s;&|(){}])(?:export\s+|declare\s+(?:-\w+\s+)*|typeset\s+(?:-\w+\s+)*|local\s+|readonly\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\+?=/g)) set.add(m[1]);
  for (const m of t.matchAll(/\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?\s*\+?=/gi)) set.add(m[1]);
  for (const m of t.matchAll(/SetEnvironmentVariable\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/gi)) set.add(m[1]);
  for (const m of t.matchAll(/\bsetx\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) set.add(m[1]);
  for (const m of t.matchAll(/\b(?:Set-Item|si|New-Item|ni|Set-Content|sc)\s+(?:-(?:Literal)?Path\s+)?env:[\\/]?([A-Za-z_][A-Za-z0-9_]*)/gi)) set.add(m[1]);
  for (const m of t.matchAll(/\bunset\s+((?:-[vfn]\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*)+)/g)) for (const n of m[1].split(/\s+/)) if (/^[A-Za-z_]/.test(n)) unset.add(n);
  for (const m of t.matchAll(/(?:\s-[a-zA-Z]*u\s*|--unset[=\s]+)([A-Za-z_][A-Za-z0-9_]*)/g)) unset.add(m[1]);
  for (const m of t.matchAll(/\b(?:export\s+-n|declare\s+\+x|typeset\s+\+x)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) unset.add(m[1]);
  for (const m of t.matchAll(/\b(?:Remove-Item|ri|rm|del|erase|Clear-Item|Clear-Content)\s+(?:-(?:Literal)?Path\s+)?env:[\\/]?([A-Za-z_][A-Za-z0-9_]*)/gi)) unset.add(m[1]);
  const clears = /\benv\s+(?:-\S+\s+)*(?:-[a-zA-Z]*i[a-zA-Z]*\b|--ignore-environment\b|-\s)/.test(t);
  return { set, unset, clears };
}

const MARKER_NAME = /AD_TOOL_SHELL/i;
// Names and lists that reach the marker without spelling it: globs, ${!AD*}, compgen, Env: as a whole.
const MARKER_GLOB = /AD_?\*|AD_TOOL[A-Z_]*\*|\$\{!A[A-Z_]*[*@]|env:[\\/]?(?:A[A-Z_]*)?\*|env:[\\/]?\s*(?:$|[|;])|compgen\s+(?:-\w+\s+)*-[ve]\b/im;
const ENV_WRITES = /\b(?:unset|export\s+-n|declare\s+\+x|typeset\s+\+x|Remove-Item|ri|del|erase|rm|Clear-Item|Clear-Content|Set-Item|si|Set-Content|sc|Rename-Item|rni|ren|Move-Item|mi)\b|SetEnvironmentVariable|\benv\s+(?:-\S+\s+)*-[a-zA-Z]*[ui]/i;
// Reads of the value: expansions, printenv, declare -p, an interpreter's lookup, a regex literal.
const MARKER_READS = [
  /\$\{AD_TOOL_SHELL(?::?[-+?][^}]*)?\}/g,
  /\$AD_TOOL_SHELL\b(?!\s*=)/g,
  /%AD_TOOL_SHELL%/gi,
  /\$\{env:AD_TOOL_SHELL\}(?!\s*\+?=)/gi,
  /\$env:AD_TOOL_SHELL\b(?![}\s]*\+?=)/gi,
  /\b(?:printenv|declare\s+-p|typeset\s+-p)\s+AD_TOOL_SHELL\b/g,
  /(?<!delete\s{0,8})process\.env(?:\.AD_TOOL_SHELL|\[\s*AD_TOOL_SHELL\s*\])(?!\s*=(?!=))/g,
  /os\.(?:environ\.get|getenv)\s*\(\s*AD_TOOL_SHELL/g,
  /\bAD_TOOL_SHELL\s+(?:not\s+)?in\s+os\.environ\b/g,
  /(?<!del\s{0,8})os\.environ\[\s*AD_TOOL_SHELL\s*\](?!\s*=(?!=))/g,
  /GetEnvironmentVariable\s*\(\s*AD_TOOL_SHELL/gi,
  /\b(?:Get-Item|gi|Test-Path|Get-ChildItem|gci|dir|ls|Get-Content|gc|cat|type)\s+(?:-\w+\s+)*env:[\\/]?AD_TOOL_SHELL\b/gi,
  /\/AD_TOOL_SHELL\//g,
];
/**
 * Does the line touch AD_TOOL_SHELL in any way but a read? Every mention counts unless it
 * is a read of the value, or data (a reader's argument, an ad command's own text, a heredoc
 * fed to a reader, a comment); a glob or list that reaches it counts with a write; unsetting
 * a name built at run time counts on a line that mentions ad's variables.
 */
/** Does every compgen on the line list only names that can't be AD_TOOL_SHELL? (false if none) */
function compgensRuleOut(line) {
  if (/AD_/.test(line)) return false;
  let any = false;
  let n = 0;
  for (const m of line.matchAll(/\bcompgen\b/g)) {
    if (++n > 32) return false;
    any = true;
    const after = line.slice(m.index + 7, m.index + 7 + 512);
    const words = after.split(/[\s]+/).filter(Boolean);
    let prefix;
    for (let k = 0; k < words.length; k++) {
      const w = words[k].replace(/[)|;].*$/, "");
      if (!w) break;
      if (w.startsWith("-")) {
        if (/[AGWFCXPSo]$/.test(w)) k++; // its value is the next word
        if (/[)|;]/.test(words[k] ?? "")) break;
        continue;
      }
      prefix = w;
      break;
    }
    if (prefix !== undefined) {
      if (!/^[A-Za-z_]\w*$/.test(prefix) || "AD_TOOL_SHELL".startsWith(prefix.toUpperCase())) return false;
      continue;
    }
    const grep = /^[^|;\n]{0,512}?\|\s*grep\s+((?:-\S+\s+)*)([^\s)]+)/.exec(after);
    if (!grep || /(?:^|\s)-[a-zA-Z]*[vief]|--invert|--ignore|--regexp|--file/.test(grep[1])) return false;
    const g = /^(\^?)([A-Za-z_]\w*)(\$?)$/.exec(grep[2]);
    if (!g) return false;
    const could = g[1] ? "AD_TOOL_SHELL".startsWith(g[2]) && (!g[3] || g[2] === "AD_TOOL_SHELL") : "AD_TOOL_SHELL".includes(g[2]);
    if (could) return false;
  }
  return any;
}

// A segment that unsets, or runs env, first (after a keyword or group that may come before it).
const LEAD = String.raw`^\s*(?:(?:then|do|else|elif|if|while|until|!|time|builtin|command|exec|nohup|[({])\s+|[({])*`;
const UNSET_AT = new RegExp(LEAD + String.raw`(?:unset|export\s+-n|declare\s+\+x|typeset\s+\+x)\b`);
const ENV_AT = new RegExp(LEAD + String.raw`env\b`);

/** A word's bash brace expansion (at most 64 results; an unbalanced brace stays as written). */
function braceExpand(w, budget = { left: 64 }) {
  const open = w.search(/\{[^{}]*,[^{}]*\}/);
  if (open < 0 || budget.left <= 0) return [w];
  const close = w.indexOf("}", open);
  const head = w.slice(0, open);
  const tail = w.slice(close + 1);
  const out = [];
  for (const alt of w.slice(open + 1, close).split(",")) {
    for (const x of braceExpand(head + alt + tail, budget)) {
      if (budget.left-- <= 0) return out;
      out.push(x);
    }
  }
  return out;
}

function touchesMarker(stripped, raw) {
  // PowerShell's Env: drive on a line that also removes or sets an item (the item piped in, kept
  // in a variable, or named in the cmdlet's own stage).
  const st = flat(stripped);
  if (/(?<![$\w{])env:[\\/]?AD_TOOL_SHELL/i.test(st)) {
    if (/(?<![\w.$-])(?:Remove-Item|ri|rm|del|erase|rd|rmdir|Clear-Item|cli|Set-Item|si|Rename-Item|rni|ren|Move-Item|mi|mv|move)(?![\w-])/i.test(st)) return true;
    for (const stage of st.split(/[|;\n]/)) if (/(?<![\w.$-])(?:Clear-Content|clc|Set-Content|sc|New-Item|ni|Add-Content|ac)(?![\w-])/i.test(stage) && /(?<![$\w{])env:/i.test(stage)) return true;
  }
  const line = flat(raw);
  // compgen's own prefix, or a grep after it, that can't match AD_TOOL_SHELL: the names it
  // lists are others. Every compgen on the line must rule it out.
  const otherNames = compgensRuleOut(line);
  const hasAd = /AD_|\^AD/.test(raw);
  if (hasAd || (!otherNames && /compgen/.test(raw))) {
    for (const seg of line.split(/[;\n|&]+/)) {
      if (UNSET_AT.test(seg) && /\$|compgen/.test(seg)) return true;
      if (hasAd && ENV_AT.test(seg) && /\s(?:-[a-zA-Z]*u\s*|--unset[=\s]+)["']?\$/.test(seg)) return true;
    }
  }
  // Pieces joined at run time ('AD_TOOL' + '_SHELL') and brace expansions (AD_{TOOL,X}_SHELL).
  let t = flat(joinConcat(stripped));
  // (Bounded, and only on a line with the marker's pieces, so it stays linear and small.)
  if (/\{[^{}\s]*,/.test(t)) {
    t = t.replace(/[^\s;|&<>()]{0,256}\{[^{}\s]{0,256},[^\s;|&<>()]{0,256}/g, (w) => {
      const budget = { left: 64 };
      const all = braceExpand(w, budget);
      // Too many to list: a word with ad's prefix in it counts as reaching the marker.
      return all.join(" ") + (budget.left <= 0 && /AD_|(?<![A-Za-z])AD(?![a-z])/.test(w) ? " AD_TOOL_SHELL" : "");
    });
  }
  let rest = t;
  for (const re of MARKER_READS) rest = rest.replace(re, " ");
  if (MARKER_NAME.test(rest)) return true;
  return MARKER_GLOB.test(otherNames ? t.replace(/compgen/g, " ") : t) && ENV_WRITES.test(t);
}

const TAMPER = /^(?:PSModulePath|COR_PROFILER\w*|COR_ENABLE_PROFILING|CORECLR_\w+|SystemRoot|windir|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES|HOME|USERPROFILE|XDG_CONFIG_HOME|AD_MEMORY_DB|AD_ROOT)$/i;
const AGENT_HOME = "HOME|USERPROFILE|XDG_CONFIG_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME";
const AGENT_WORD = String.raw`(?:npx\s+(?:-\S+\s+)*)?(?:claude|codex|@anthropic-ai\/claude-code|@openai\/codex)(?![\w-])`;
/** A nested agent started with its home or config folder moved (a prefix, env, or a statement before it). */
function agentHomeMoved(stripped, vars) {
  const t = flat(stripped);
  if (vars.clears) return true;
  if (new RegExp(String.raw`(?:^|[;&|\n(]\s*)(?:env\s+(?:-\S+\s+)*)?(?:[A-Za-z_]\w*=\S*\s+)*(?:${AGENT_HOME})=\S*\s+(?:[A-Za-z_]\w*=\S*\s+)*${AGENT_WORD}`, "i").test(t)) return true;
  return new RegExp(String.raw`\b(?:export|declare\s+-x|typeset\s+-x|set|setx)\s+(?:${AGENT_HOME})\b|\$\{?env:(?:${AGENT_HOME})\}?\s*=`, "i").test(t);
}

/** Literal assignments in the line (NAME → value), for a program held in a variable. */
function literalAssignments(text) {
  const out = new Map();
  for (const m of String(text).matchAll(/(?:^|[\s;&|(){}])(?:export\s+|local\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s;&|<>()$`'"]*))(?=[\s;&|)}]|$)/g)) out.set(m[1], m[2] ?? m[3] ?? m[4] ?? "");
  for (const m of String(text).matchAll(/\$([A-Za-z_]\w*)\s*=\s*(?:"([^"$`]*)"|'([^']*)')/g)) out.set(m[1], m[2] ?? m[3] ?? ""); // PowerShell
  return out;
}

/** argv with a program held in literal variables resolved (`c="ad review"; $c`). */
function resolveProgram(argv, literals) {
  const w = String(argv[0] ?? "");
  if (!/\$/.test(w)) return argv;
  let unknown = false;
  const v = w.replace(/^"|"$/g, "").replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, a, b) => {
    const n = a ?? b;
    if (!literals.has(n)) unknown = true;
    return literals.get(n) ?? "";
  });
  if (unknown || /[$`]/.test(v) || !v.trim()) return argv;
  return [...v.trim().split(/\s+/), ...argv.slice(1)];
}

// ---- ad's verbs (D12a) ------------------------------------------------------------------

const MEMORY_TOKEN = new Set(["held", "install", "setup", "uninstall", "repair", "promote", "redact", "assign", "migrate"]);
const HOOK_VERBS = new Set(["hook", "session-start", "user-prompt-extract", "query-retrieve", "bash-pre", "bash-post", "edit-post", "mcp-pre", "session-end-digest", "skill-use", "capability-route-advice"]);
const READS = new Set(["report", "doctor", "status", "serve", "help", "--help", "-h", "--version", "-v", "-V"]);
const AD_VALUE_OPTIONS = new Set(["--cwd", "--profile", "--home", "--root", "--host", "--project", "--model"]);
const SUB_VALUE_OPTIONS = new Set(["--days", "--project", "--limit", "--format", "--since", "--cwd", "--host", "--id", "--learning", "--table"]);
/** Verbs the scratch-root case never covers (they write host config whatever the root). */
const HOST_WRITERS = new Set(["setup", "install", "repair", "uninstall", "init"]);

/** The words after a subcommand that aren't options (or an option's value). */
function positionals(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (/^-/.test(rest[i])) {
      if (SUB_VALUE_OPTIONS.has(rest[i])) i++;
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

/**
 * How an ad command line is judged: "token" | "variant" | "read" | "nonliteral", and its verb.
 * kind "ad": `ad [options] <verb> …`; kind "pkg": the package bin, `<verb>` first.
 */
export function verbClass(kind, args, { ps = false } = {}) {
  let i = 0;
  const a = args.filter((x, k) => !(k === 0 && x === "--"));
  if (kind === "ad") {
    while (i < a.length && /^-/.test(a[i]) && !READS.has(a[i])) i += AD_VALUE_OPTIONS.has(a[i]) ? 2 : 1;
  }
  const verb = a[i];
  const rest = a.slice(i + 1);
  if (verb === undefined) return { cls: kind === "ad" ? "variant" : "read", verb: "" };
  if (isExpansion(verb, ps)) return { cls: "nonliteral", verb };
  // PowerShell: a verb the parser kept with its quotes or a `+` was built from pieces.
  if (ps && /['"+]/.test(verb)) return { cls: "nonliteral", verb };
  const only = (...shape) => rest.length === shape.length && shape.every((s, k) => rest[k] === s);
  const words = positionals(rest);
  if (words.some((w) => isExpansion(w, ps)) && ["memory", "learning", "learnings", "rules", "config", "safety", "consolidate"].includes(lower(verb))) return { cls: "nonliteral", verb: lower(verb) };
  const v = lower(verb);
  if (READS.has(v)) return { cls: "read", verb: v };
  switch (v) {
    case "review":
      return { cls: only("--list") || only("--help") || only("-h") ? "read" : "token", verb: v };
    case "rules":
      return { cls: only("list") || only("list", "--json") || only("--help") || only("-h") ? "read" : "token", verb: v };
    case "learning":
    case "learnings":
      return { cls: words.some((w) => ["edit", "forget"].includes(lower(w))) ? "token" : "read", verb: v };
    case "setup":
    case "install":
    case "repair":
    case "uninstall":
      return { cls: "token", verb: v };
    case "config":
      return { cls: lower(words[0]) === "review" && lower(words[1]) === "auto" ? "token" : "variant", verb: v };
    case "consolidate":
      return { cls: rest.some((x) => /^--apply/i.test(x)) ? "token" : "read", verb: v };
    case "memory": {
      // Any token subcommand among the words (an option before it doesn't hide it).
      const sub = words.find((w) => MEMORY_TOKEN.has(lower(w)));
      if (sub) return { cls: lower(sub) === "assign" && rest.includes("--list") ? "read" : "token", verb: `memory ${lower(sub)}` };
      if (words.some((w) => lower(w) === "consolidate") && rest.some((x) => /^--apply/i.test(x))) return { cls: "token", verb: "memory consolidate" };
      return { cls: "read", verb: v };
    }
    case "remember":
      return { cls: rest.some((x) => /^--token/i.test(x)) ? "token" : "variant", verb: v };
    case "forget":
    case "restore":
    case "tui":
    case "init":
      return { cls: "variant", verb: v };
    case "safety":
      // The starter safety policy (L7b): switching it is token-only; its status and help are reads.
      return { cls: words.some((w) => ["on", "off"].includes(lower(w))) ? "token" : "read", verb: v };
    case "mistakes":
      return { cls: rest.includes("--save") ? "variant" : "read", verb: v };
    default:
      if (HOOK_VERBS.has(v)) return { cls: "token", verb: v };
      return { cls: "read", verb: v };
  }
}

/** The ad entry point this word runs, if any: "ad" | "pkg" | null. */
function entryKind(word) {
  // npm:/jsr: specifiers, a git URL's last part (…/Agent-Daemon.git), a package name with its version.
  let name = lower(programName(String(word).replace(/^(?:npm|jsr):/i, "").replace(/\.git(?:#.*)?$/i, "")));
  // npx pkg@1.2.3 → pkg (a scoped name keeps its scope)
  name = name.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, "$1");
  if (!ENTRIES.has(name)) return null;
  return AD_CLI.has(name) ? "ad" : "pkg";
}

// ---- ad's own folders (for `node <script>`) ---------------------------------------------

const HERE_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The folders ad's code runs from: its root's memory/ (launcher, dists), this install, registered dists, the guard copy. */
export function adFolders({ root, home = os.homedir() } = {}) {
  const r = root ?? (process.env.AD_ROOT && path.isAbsolute(process.env.AD_ROOT) ? process.env.AD_ROOT : path.join(home, ".agent-daemon"));
  const out = new Set([path.join(r, "memory"), HERE_TREE]);
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };
  const d = read(path.join(r, "memory", "launch", "dists.json"));
  for (const x of Array.isArray(d?.dists) ? d.dists : []) if (typeof x?.path === "string") out.add(x.path);
  const g = read(path.join(r, "memory", "launch", "guard.json"));
  if (typeof g?.path === "string") out.add(g.path);
  return [...out];
}

const INTERNAL_FILES = new Set(["guards-refresh-job.mjs", "migrate-job.mjs", "recall-context-job.mjs"]);

/** A home folder's spellings at the start of a path. */
const HOME_SPELLING = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$\{env:USERPROFILE\})(?=[\\/]|$)/i;
const NATIVE = process.platform === "win32" ? path.win32 : path.posix;

/**
 * A path as the agent's shell spells it, made absolute for this OS: ~ and $HOME, Git Bash's
 * /c/…, Windows' \\?\ prefix and trailing dots or spaces; its real path when it exists here.
 */
function absolute(p, ctx, base) {
  let s = String(p).replace(HOME_SPELLING, ctx.homeDir);
  if (ctx.pathMod === path.win32) {
    s = s.replace(/^(?:\\\\|\/\/)[?.][\\/]/, "");
    if (/^\/[a-z](?:\/|$)/i.test(s)) s = `${s[1]}:\\${s.slice(3)}`;
    s = s.split(/[\\/]/).map((seg) => (/^\.+$/.test(seg) ? seg : seg.replace(/[. ]+$/, ""))).join("\\");
  }
  let abs = ctx.pathMod.resolve(base ?? ctx.homeDir, s);
  try {
    if (ctx.pathMod === NATIVE) abs = fs.realpathSync.native(abs);
  } catch {
    // not here: as written
  }
  return abs;
}
const foldFor = (ctx) => (p) => (ctx.pathMod === path.win32 || ctx.os === "macos" ? p.toLowerCase() : p);

/** ad's entry files by name (a relative script under a folder the line made unknown). */
const ENTRY_FILE = /^(?:run|cli|cli-full|hook|[\w-]+-job)\.mjs$/i;

/**
 * A `node|bun|deno <script> …` run of ad's code, or ad's script started directly (npm marks
 * its bins executable): → { kind: "internal" | "nonliteral" } | { kind: "ad"|"pkg", args } | null
 */
function nodeScript(argv, ctx, cwd, cwdKnown = true) {
  const prog = lower(programName(argv[0]));
  if (/\.(?:mjs|cjs|js)$/i.test(String(argv[0]))) return judgeScript(argv[0], argv.slice(1), ctx, cwd, cwdKnown);
  if (!["node", "nodejs", "bun", "deno"].includes(prog)) return null;
  // Node's options may take the next word as a value (more of them each release): every word
  // right after an option is a possible script too, and the first that is ad's decides.
  const candidates = [];
  let i = (prog === "bun" || prog === "deno") && argv[1] === "run" ? 2 : 1;
  for (; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--test" || x === "-e" || x === "--eval" || x === "-p" || x === "--print" || /^--(?:eval|print)=/.test(x)) return null; // test runner; inline code judged elsewhere
    if (x === "--") {
      if (i + 1 < argv.length) candidates.push(i + 1);
      break;
    }
    if (!x.startsWith("-")) {
      candidates.push(i);
      break;
    }
    if (!x.includes("=") && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      candidates.push(i + 1);
      i++;
    }
  }
  for (const k of candidates.slice(0, 8)) {
    const r = judgeScript(argv[k], argv.slice(k + 1), ctx, cwd, cwdKnown);
    if (r) return r;
  }
  return null;
}

function judgeScript(script, rest, ctx, cwd, cwdKnown) {
  if (!script) return null;
  if (isExpansion(script.replace(HOME_SPELLING, ""))) {
    // `node $(which ad) rules pause`: a script path built at run time, with ad's verbs after it.
    const c = verbClass("pkg", rest);
    return c.cls === "token" || c.cls === "variant" || c.cls === "nonliteral" ? { kind: "nonliteral" } : null;
  }
  const fold = foldFor(ctx);
  const relative = !ctx.pathMod.isAbsolute(script) && !HOME_SPELLING.test(script);
  // A relative script named like ad's entry files, after a `cd` the check can't follow.
  if (relative && !cwdKnown) return ENTRY_FILE.test(ctx.pathMod.basename(script)) ? { kind: "nonliteral" } : null;
  const abs = absolute(script, ctx, cwd);
  const inside = ctx.folders().some((f) => {
    const rel = ctx.pathMod.relative(fold(absolute(f, ctx)), fold(abs));
    return rel && !rel.startsWith("..") && !ctx.pathMod.isAbsolute(rel);
  });
  if (!inside) return null;
  const base = fold(ctx.pathMod.basename(abs));
  const parent = fold(ctx.pathMod.basename(ctx.pathMod.dirname(abs)));
  if (INTERNAL_FILES.has(base) || (base === "hook.mjs" && parent === "bin")) return { kind: "internal" };
  if (base === "run.mjs" && parent === "launch") return ["hook", "job"].includes(rest[0]) ? { kind: "internal" } : { kind: "pkg", args: rest };
  if (base === "cli.mjs" || base === "cli-full.mjs") return { kind: parent === "memory-install" || parent !== "src" ? "pkg" : "ad", args: rest };
  return null;
}

// ---- wrappers, terminals, remote input (D12b) -------------------------------------------

const REPARENTING = new Set(REPARENTING_LIST);
const TERMINALS = new Set(TERMINAL_LIST);
const DESKTOP = new Set(DESKTOP_LIST.filter((x) => x !== "open" && x !== "gio" && x !== "xdg-open"));

/**
 * Split a wrapper's argv into its options and the rest. valueShort: letters whose option
 * takes the next word (also as the last letter of a cluster, `-dmS name`); valueLong: long
 * options that take one.
 */
function afterOptions(args, valueShort = "", valueLong = []) {
  let i = 0;
  while (i < args.length && /^-./.test(args[i]) && args[i] !== "--") {
    const x = args[i];
    if (x.startsWith("--")) i += !x.includes("=") && valueLong.includes(x) ? 2 : 1;
    else i += valueShort.includes(x[x.length - 1]) ? 2 : 1;
  }
  if (args[i] === "--") i++;
  return args.slice(i);
}

const TMUX_START = new Set(["new", "new-session", "run-shell", "run", "respawn-pane", "respawnp", "respawn-window", "respawnw", "display-popup", "popup", "pipe-pane", "pipep"]);
const TMUX_INPUT = new Set(["send-keys", "send", "new-window", "neww", "split-window", "splitw", "paste-buffer", "pasteb"]);
const tmuxSub = (args) => afterOptions(args, "cfLST"); // tmux's own options before the subcommand
// Each subcommand's options that take a value (tmux's manual).
const TMUX_VALUES = new Map([["new", "cefFnstxy"], ["new-session", "cefFnstxy"], ["run-shell", "dt"], ["run", "dt"], ["respawn-pane", "cet"], ["respawnp", "cet"], ["respawn-window", "cet"], ["respawnw", "cet"], ["display-popup", "bcdehsStTwxy"], ["popup", "bcdehsStTwxy"], ["pipe-pane", "t"], ["pipep", "t"], ["send-keys", "Nt"], ["send", "Nt"], ["new-window", "cefFnt"], ["neww", "cefFnt"], ["split-window", "ceFlt"], ["splitw", "ceFlt"], ["paste-buffer", "bst"], ["pasteb", "bst"], ["set-buffer", "bnt"], ["setb", "bnt"]]);
/** The shell text a tmux start or input command carries (keys and options dropped). */
function tmuxText(sub, subArgs) {
  return afterOptions(subArgs, TMUX_VALUES.get(sub) ?? "t")
    .filter((x) => !/^(?:Enter|C-m|C-j|KPEnter|Escape|C-c|Space)$/.test(x))
    .join(" ");
}

const WT_SUBCOMMANDS = new Set(["new-tab", "nt", "split-pane", "sp", "focus-tab", "ft", "move-focus", "mf", "swap-pane", ";"]);
const WT_VALUES = new Set(["-p", "--profile", "-d", "--startingDirectory", "--title", "--tabColor", "-w", "--window", "--colorScheme", "--size", "--pos", "-s", "--target"]);
/** The command line Windows Terminal starts (its subcommands and options dropped). */
function wtText(args) {
  let i = 0;
  while (i < args.length && (WT_SUBCOMMANDS.has(args[i]) || args[i].startsWith("-"))) i += WT_VALUES.has(args[i]) ? 2 : 1;
  return args.slice(i).join(" ");
}

/** Strings a desktop launcher or remote-input command would type or run. */
function carried(prog, args) {
  const keys = (s) => String(s).replace(/(?:\\[nr]|\^M|\{ENTER\}|~)+$/i, "");
  switch (prog) {
    case "osascript":
      return args.filter((x, k) => args[k - 1] === "-e").map((s) => /do (?:shell )?script\s+"([^"]*)"/i.exec(s)?.[1] ?? s);
    case "xdotool":
    case "ydotool":
    case "wtype":
    case "dotool":
      return args.filter((x) => !/^-/.test(x) && !/^(?:type|key|keydown|keyup)$/.test(x)).map(keys);
    default:
      return args.map(keys);
  }
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "tcsh", "csh", "mksh", "ash"]);
const AWK = new Set(["awk", "gawk", "mawk", "nawk"]);
// Interpreters' inline-code flags, by the letter that takes the code (also last in a cluster: -pe, -Bc, -wle).
const INLINE_LETTERS = { node: "ep", nodejs: "ep", bun: "ep", python: "c", python3: "c", python2: "c", perl: "eE", ruby: "e", php: "r", lua: "e", fish: "c", tcsh: "c", csh: "c" };

// Interpreters' options that take the next word as a value (so it isn't the script).
const INTERP_VALUES = {
  node: ["-r", "--require", "--" + "import", "-C", "--conditions", "--loader", "--experimental-loader", "--input-type", "--env-file", "--title"],
  bun: ["-r", "--preload", "--cwd", "--env-file"],
  python: ["-W", "-X"],
  perl: ["-I", "-M", "-m"],
  ruby: ["-r", "-I", "-E", "-C"],
  php: ["-d", "-c", "-z"],
  lua: ["-l"],
};
INTERP_VALUES.nodejs = INTERP_VALUES.node;
INTERP_VALUES.python3 = INTERP_VALUES.python2 = INTERP_VALUES.python;
/** Does the interpreter read its code from stdin (no script file, or `-`)? */
function readsStdin(prog, argv) {
  const values = INTERP_VALUES[prog] ?? [];
  for (let k = 1; k < argv.length; k++) {
    const x = argv[k];
    if (x === "-") return true;
    if (values.includes(x)) k++;
    else if (x === "-m" && /^python/.test(prog)) return false; // a module runs
    else if (!x.startsWith("-")) return false; // a script file
  }
  return true;
}

/** The code an interpreter runs inline, or null (none, or a script file). */
function inlineCode(prog, argv) {
  if (prog === "deno") return argv[1] === "eval" ? argv.slice(2).join(" ") : null;
  const letters = INLINE_LETTERS[prog];
  if (!letters) return null;
  const values = INTERP_VALUES[prog] ?? [];
  for (let k = 1; k < argv.length; k++) {
    const x = argv[k];
    if (values.includes(x)) {
      k++;
      continue;
    }
    const eq = /^--(?:eval|print)=([\s\S]*)$/.exec(x);
    if (eq && letters.includes("e")) return eq[1];
    if ((x === "--eval" || x === "--print") && letters.includes("e")) return argv[k + 1] ?? "";
    if (/^-[A-Za-z]+$/.test(x) && letters.includes(x[x.length - 1])) return argv[k + 1] ?? "";
    if (!x.startsWith("-") || x === "-") return null; // a script (or stdin): no inline code
  }
  return null;
}

/** `$name` and `${name}` replaced by the line's literal assignments, where known. */
const substituteLiterals = (t, literals) => String(t).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => literals.get(a ?? b) ?? m);

// Variables that hold a command another program runs (git's pager and editors, ssh for git…).
const COMMAND_VARS = ["GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "EDITOR", "VISUAL", "PAGER"];

/** Command strings a program runs from its options or subcommands (git, nodemon, concurrently, entr, npm exec -c). */
function commandStrings(prog, argv) {
  const a = argv.slice(1);
  const out = [];
  const val = (flags) => {
    for (let k = 0; k < a.length; k++) {
      for (const f of flags) {
        if (a[k] === f) out.push(a[k + 1] ?? "");
        else if (a[k].startsWith(`${f}=`)) out.push(a[k].slice(f.length + 1));
      }
    }
  };
  switch (prog) {
    case "git": {
      for (let k = 0; k < a.length; k++) {
        if (a[k] !== "-c") continue;
        const m = /^(?:core\.(?:pager|editor|sshCommand|fsmonitor)|diff\.[\w.-]*(?:external|command|textconv)|alias\.[\w.-]+|sequence\.editor|gpg\.program|credential\.helper)=([\s\S]*)$/i.exec(a[k + 1] ?? "");
        if (m) out.push(m[1].replace(/^!/, ""));
      }
      if (a.includes("rebase")) val(["-x", "--exec"]);
      const run = a.indexOf("run");
      if (a.includes("bisect") && run >= 0) out.push(a.slice(run + 1).join(" "));
      const each = a.indexOf("foreach");
      if (a.includes("submodule") && each >= 0) out.push(a.slice(each + 1).filter((x) => !x.startsWith("-")).join(" "));
      if (a.includes("filter-branch")) val(["--tree-filter", "--index-filter", "--msg-filter", "--env-filter", "--commit-filter", "--parent-filter", "--tag-name-filter"]);
      break;
    }
    case "nodemon":
      val(["--exec", "-x"]);
      break;
    case "concurrently":
      out.push(...a.filter((x) => !x.startsWith("-")));
      break;
    case "entr": {
      const k = a.indexOf("-s");
      if (k >= 0) out.push(a[k + 1] ?? "");
      else if (a.some((x) => !x.startsWith("-"))) out.push(a.filter((x) => !x.startsWith("-")).join(" "));
      break;
    }
    case "npm":
    case "npx":
      val(["-c", "--call"]);
      break;
    default:
      break;
  }
  return out.filter(Boolean);
}

/** Does a single `&` background a segment holding an ad command? (one pass; quoted text blanked) */
const ENTRY_WORD = new RegExp(`(?<![\\w$-])(?:${ENTRY_RE})(?![\\w-])`, "i");
function backgroundsEntry(u, ps, word = ENTRY_WORD) {
  // `&` backgrounds the whole list before it (pipes, && and ||, a group): only a `;` or a
  // newline outside any group starts a new one.
  let start = 0;
  let depth = 0;
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (c === "(" || c === "{") depth++;
    else if ((c === ")" || c === "}") && depth > 0) depth--;
    if ((c === ";" || c === "\n") && depth === 0) {
      start = i + 1;
      continue;
    }
    if (c === "|" && u[i + 1] === "|") {
      i++;
      continue;
    }
    if (c !== "&") continue;
    if (u[i + 1] === "&") {
      i++;
      continue;
    }
    if (u[i - 1] === ">" || u[i + 1] === ">" || u[i - 1] === "|") continue; // >&, &>, |&: redirects
    if (ps && !/^\s*(?:$|[;\n])/.test(u.slice(i + 1, i + 4))) continue; // PowerShell: & is the call operator but at the end
    if (word.test(u.slice(start, i))) return true;
    start = i + 1;
  }
  return false;
}

/** PowerShell's `& (…) <verb>` and `. (…)`: the parser drops the group, so it is read from the text. */
function psCallGroups(text) {
  let out = null;
  const verb = new RegExp(`^(?:${VERB_RE})$`, "i");
  for (const m of joinConcat(text).matchAll(/[&.]\s*\(([^()]*)\)[ \t]*([^\s;|]*)((?:[ \t]+[^\s;|]+)*)/g)) {
    const inner = m[1].trim();
    const lit = /^(['"])([^'"]*)\1$/.exec(inner)?.[2];
    const words = [m[2], ...(m[3] ?? "").trim().split(/\s+/)].filter(Boolean);
    const kind = lit ? entryKind(lit) : null;
    if (kind) {
      const c = verbClass(kind, words, { ps: true });
      if (c.cls === "token") out = worst(out, deny("a", WORDS.token));
      else if (c.cls !== "read") out = worst(out, deny("a", WORDS.nonliteral)); // run through the call operator
    } else if (isExpansion(inner, true) && verb.test(words[0] ?? "")) out = worst(out, ask("h", WORDS.built));
  }
  return out;
}

// ---- the check --------------------------------------------------------------------------

/** The bodies of `$(…)` and backticks outside single quotes (at most 16, outermost first). */
function substitutions(text, ps) {
  const out = [];
  // (A quoted heredoc's body is text: nothing in it is substituted.)
  const src = String(text);
  const pieces = [];
  let from = 0;
  for (const h of heredocs(src)) {
    if (h.bodyStart < from) continue;
    const body = src.slice(h.bodyStart, h.bodyEnd);
    pieces.push(src.slice(from, h.bodyStart), h.quoted ? " ".repeat(body.length) : body.replace(/['"#]/g, " "));
    from = h.bodyEnd;
  }
  pieces.push(src.slice(from));
  const t = pieces.join("");
  let single = false;
  let double = false;
  let braces = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (single) {
      if (c === "'") single = false;
      continue;
    }
    if (c === (ps ? "`" : "\\")) {
      i++;
      continue;
    }
    if (c === "'" && !double) {
      single = true;
      continue;
    }
    if (c === '"') double = !double;
    // Inside ${…} a # isn't a comment (a substitution in it still runs).
    if (c === "$" && t[i + 1] === "{") {
      braces++;
      i++;
      continue;
    }
    if (c === "}" && braces > 0) braces--;
    // A comment runs to the line's end.
    if (c === "#" && !double && braces === 0 && (i === 0 || /\s/.test(t[i - 1]))) {
      const e = t.indexOf("\n", i);
      if (e < 0) break;
      i = e;
      continue;
    }
    let body = null;
    if (c === "$" && t[i + 1] === "(" && t[i + 2] !== "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < t.length; j++) {
        if (t[j] === "(") depth++;
        else if (t[j] === ")" && --depth === 0) break;
      }
      body = t.slice(i + 2, j);
      i = j;
    } else if (!ps && c === "`") {
      const j = t.indexOf("`", i + 1);
      if (j < 0) break;
      body = t.slice(i + 1, j);
      i = j;
    }
    if (body === null) continue;
    if (out.length >= 16) {
      out.over = true;
      break;
    }
    out.push(body);
  }
  return out;
}

/**
 * Judge one shell command line. via: the wrappers it sits inside (a token-variant verb
 * inside any of them is wrapped).
 */
function judgeText(text, ctx, via, depth, joined = false) {
  if (depth > 6) return deny("b", WORDS.nonliteral);
  const ps = ctx.dialect === "powershell";
  // Line continuations join the lines (as the shell does), except inside quotes and quoted
  // heredocs, which the check doesn't follow here: the text is judged both ways, the worse wins.
  const cont = ps ? /`\r?\n/g : /\\\r?\n/g;
  if (!joined && !ctx.joinedOnce && cont.test(text)) {
    cont.lastIndex = 0;
    // (Once: the texts nested in either form are judged in that form.)
    const once = { ...ctx, joinedOnce: true };
    return worst(judgeText(text, once, via, depth, true), judgeText(text.replace(cont, ""), { ...once, top: ctx.top ? ctx.top.replace(cont, "") : undefined }, via, depth, true));
  }
  const decoded = decodeAnsiCQuotes(text);
  // (PowerShell's `${env:X}` reads as a script block to the parser: it is `$env:X`.)
  const found = commandsIn(ps ? decoded.replace(/\$\{env:([A-Za-z_]\w*)\}/gi, "$$env:$1") : decoded, { dialect: ctx.dialect, os: ctx.os });
  // Part of the text wasn't read (too long, nested too deep) and it names ad itself: deny.
  if (found.incomplete && strongTrigger(decoded)) return deny("a", WORDS.nonliteral);
  // A work budget: a line too costly to look through is decided without the detail (a hook
  // that times out lets the call run).
  const overBudget = () => (strongTrigger(decoded) ? deny("a", WORDS.nonliteral) : ask("a", WORDS.nonliteral));
  if (found.length > 300 || Date.now() > ctx.deadline) return overBudget();
  const stripped = dataStripped(decoded, found, ps, ctx.deadline);

  // e: AD_TOOL_SHELL touched in any way but a read.
  if (touchesMarker(stripped, decoded)) return deny("e", WORDS.marker);

  const u = unquoted(stripped);
  // PowerShell drops a parenthesised argument from argv: after an ad verb, it is built at run time.
  if (ps) {
    if (PS_GROUP_OPTION.test(u)) return deny("a", WORDS.nonliteral);
    for (const m of u.matchAll(PS_GROUP_ARG)) {
      const before = m[0].replace(/\($/, "").trim().split(/\s+/).pop();
      if (!AD_VALUE_OPTIONS.has(lower(before)) && !SUB_VALUE_OPTIONS.has(lower(before))) return deny("a", WORDS.nonliteral);
    }
  }
  const vars = variablesSet(u);
  const literals = literalAssignments(decoded);
  const top = ctx.top ?? decoded;
  let mention;
  let agentMoved;
  const facts = {
    decoded,
    ps,
    vars,
    literals,
    mention: () => (mention ??= mentionsVerb(top)),
    agentMoved: () => (agentMoved ??= agentHomeMoved(stripped, vars)),
    encoded: /base64|frombase64|certutil|--decode|\s-d\b/i.test(decoded),
    // The line backgrounds something (a quoted script hides what): a shell's script counts as backgrounded.
    bgLine: backgroundsEntry(u, ps, SHELL_SCRIPT_WORD),
    evaluates: /\[scriptblock\]::Create|\.AddScript\(|Process\]::Start\s*\(/i.test(decoded),
  };
  const progOf = (argv) => lower(programName(argv[0]));
  // Wrapped: inside a wrapper, backgrounded, or the argument of a reparenting program on this line.
  // (PowerShell's jobs take a scriptblock the parser doesn't keep in their argv: the line counts.)
  const background = ctx.background || /\bcoproc\b/.test(decoded) || backgroundsEntry(u, ps) || (ps && /\b(?:Start-Job|Start-ThreadJob|sajb|Register-ScheduledJob)\b|-AsJob\b/i.test(decoded));
  const wrappers = found.filter((f) => isReparenting(progOf(f.argv), f.argv));
  // (A wrapper's argv holds the command whole, or its program with the arguments spread over options: Start-Process ad -ArgumentList …)
  const wrappedFor = (f) => via.length > 0 || background || wrappers.some((w) => {
    if (w === f) return false;
    const joined = w.argv.slice(1).join(" ");
    return joined.includes(f.argv.join(" ")) || (w.argv.slice(1).includes(f.argv[0]) && f.argv.slice(1).every((a) => joined.includes(a)));
  });
  const scratch = depth === 0 && via.length === 0 && found.length === 1 ? scratchRoot(decoded, ctx) : false;
  let out = ps ? psCallGroups(decoded) : null;
  let cwd = ctx.cwd;
  let cwdKnown = true;
  // Command substitutions: what runs inside one gets the line-level checks of its own (its
  // quotes hide it from them here).
  if (heredocs(decoded).over && strongTrigger(decoded)) return deny("a", WORDS.nonliteral);
  const subs = substitutions(decoded, ps);
  if (subs.over && strongTrigger(decoded)) return deny("a", WORDS.nonliteral);
  for (const body of subs) out = worst(out, judgeText(body, { ...ctx, top: body }, via, depth + 1));
  // A command held in a variable another program runs (GIT_PAGER, EDITOR…): judged as wrapped.
  for (const n of COMMAND_VARS) if (literals.has(n) && vars.set.has(n)) out = worst(out, judgeText(literals.get(n), ctx, [...via, n], depth + 1));

  for (const f of found) {
    if (Date.now() > ctx.deadline) return worst(out, overBudget());
    const argv = resolveProgram(f.argv, literals);
    const prog = progOf(argv);
    // `cd` earlier in the line moves where later relative scripts resolve; one the check
    // can't follow makes it unknown.
    if (["cd", "pushd", "chdir", "set-location", "sl", "push-location"].includes(prog)) {
      const target = argv.slice(1).find((x) => !/^-/.test(x));
      if (target !== undefined) {
        if (isExpansion(target.replace(HOME_SPELLING, ""), ps)) cwdKnown = false;
        else {
          cwd = absolute(target, ctx, cwd ?? ctx.homeDir);
          cwdKnown = true;
        }
      }
      continue;
    }
    // a: ad's commands.
    let entry = null;
    const kind = entryKind(argv[0]);
    if (kind) entry = { kind, args: argv.slice(1) };
    else {
      const ns = nodeScript(argv, ctx, cwd, cwdKnown);
      if (ns?.kind === "internal") {
        out = worst(out, deny("a", WORDS.internal));
        continue;
      }
      if (ns?.kind === "nonliteral") {
        out = worst(out, deny("a", WORDS.nonliteral));
        continue;
      }
      if (ns) entry = ns;
    }
    if (entry) {
      let c = verbClass(entry.kind, entry.args, { ps });
      const hostWriter = c.verb.split(" ").some((w) => HOST_WRITERS.has(w));
      if (scratch && c.cls !== "read" && !hostWriter) c = { ...c, cls: "read" };
      if (c.cls === "token") out = worst(out, deny("a", WORDS.token));
      else if (c.cls === "nonliteral") out = worst(out, deny("a", WORDS.nonliteral));
      else if (c.cls === "variant" && wrappedFor(f)) out = worst(out, deny("a", WORDS.variant));
      // e: injection and root variables for an ad command with a non-read verb (scratch
      // relaxes AD_ROOT only, and never for the host-config writers).
      if (c.cls !== "read" && ([...vars.set].some((n) => TAMPER.test(n) && !(scratch && !hostWriter && /^AD_ROOT$/i.test(n))) || vars.clears)) out = worst(out, deny("e", WORDS.env));
      // ad schedule|loop|run carrying a command: judged as wrapped.
      if (entry.kind === "ad" && ["schedule", "loop", "run"].includes(c.verb) && mentionsVerb(entry.args.slice(1).join(" "))) out = worst(out, deny("a", WORDS.variant));
      continue;
    }
    out = worst(out, otherRoutes(prog, argv, ctx, via, depth, facts));
  }
  return out;
}

/** Code that can start a process (an ad mention in code without one is text the code edits). */
const RUNS_PROCESS = /system|exec|spawn|popen|subprocess|child_process|\bpty\b|\bqx\b|`|%x|passthru|proc_open|Open3|readpipe|IPC::|getoutput|Deno\.(?:Command|run)|Bun\.\$|\$\(|\bos\.run/i;
/** The code a line feeds an interpreter on stdin: heredoc bodies as written, here-strings and piped words unquoted. */
function stdinCode(text, ps) {
  const parts = [];
  const src = String(text);
  let rest = "";
  let from = 0;
  for (const h of heredocs(src)) {
    if (h.bodyStart < from) continue;
    parts.push(src.slice(h.bodyStart, h.bodyEnd));
    rest += src.slice(from, h.bodyStart);
    from = h.end;
  }
  rest += src.slice(from);
  let n = 0;
  for (const m of rest.matchAll(/<<<\s*/g)) {
    if (++n > 8) break;
    const w = wordSpans(rest.slice(m.index + m[0].length, m.index + m[0].length + 65536), ps)[0];
    if (w) parts.push(w.v);
  }
  if (rest.includes("|")) parts.push(wordSpans(rest.replace(/<<</g, " "), ps).map((w) => w.v).join(" "));
  return parts.join("\n");
}

/** Code that reaches a process or code by a name it builds or looks up (strings blanked can't hide these). */
const DYNAMIC = /\b(?:eval|Function|runIn\w*Context|getattr|__import__|__dict__|import_module|importlib|globals|locals|send|public_send|__send__|instance_eval|call_user_func\w*|loadstring|dostring|dofile|Reflect|globalThis|constructor|_load|binding|dlopen|ctypes|Kernel|Open3)\b|\bload\s*\([^)]*\)\s*\(|\b(?:require|import)\s*\(\s*""\s*[+.]|\$\w+\s*\(|\[\s*""\s*[+.]|\.\s*""\s*\(/;

/** Does code (in the interpreter `prog`) start a process? Text it only edits doesn't count. */
function runsProcess(code, prog) {
  let c = String(code);
  // A pipe opened by perl's or ruby's open counts before anything is blanked.
  if (/^(?:perl|ruby)$/.test(prog) && /\bopen\b[^;\n]{0,200}?(?:\|\s*["']|["']\s*\||["']-\|["'])/.test(c)) return true;
  // perl: an s///, y/// or tr/// at a statement's start or after =~ is text the code edits
  // (unless its e flag runs it); its body stays on one line and holds no quote.
  if (prog === "perl") c = c.replace(/(^|[;{]|[=!]~)(\s*)(?:s|y|tr)([/|#!,])(?:\\.|(?!\3)[^\\\n'"])*\3(?:\\.|(?!\3)[^\\\n'"])*\3([a-z]*)/g, (m, a, b, d, flags) => (/e/.test(flags) || /\(\?\??\{/.test(m) ? m : a + b + " "));
  // Regex literals (only where one can start: after an operator or an opening bracket).
  if (/^(?:node|nodejs|bun|deno|ruby|perl)$/.test(prog)) c = c.replace(/(?<=[=(,:;!&|?{}[~]\s*)\/(?![/*])(?:\\.|[^/\\\n])+\/[a-z]*/g, " ");
  // Strings that name ad's entry point are the text being edited; other strings stay (a module
  // or method name in a string is how code reaches a process).
  c = c.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) => (ENTRY_IN_STRING.test(m) ? '""' : m));
  return RUNS_PROCESS.test(c) || DYNAMIC.test(c) || /\bProcess\b|Diagnostics/.test(c);
}
const ENTRY_IN_STRING = new RegExp(`(?<![\\w$-])(?:${ENTRY_RE})(?![\\w-])`, "i");

// A shell started with a -c script (its script is blanked in the unquoted text).
const SHELL_SCRIPT_WORD = /(?<![\w-])(?:bash|sh|zsh|dash|ksh|fish|tcsh|csh|mksh|ash|pwsh|powershell)(?:\.exe)?\s+(?:[-+][oO]\s+\S+\s+|[-+]\S+\s+)*-(?:[a-zA-Z]*c|command)\b/i;
const SHELL_PROGS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "tcsh", "csh", "mksh", "ash", "pwsh", "powershell"]);

/** A shell's script flag: -c (also in a cluster, -lc) or PowerShell's -Command (any prefix). */
const isScriptFlag = (w) => /^-[a-zA-Z]*c$/.test(w) || /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(w);

/** A word that is an expansion as a whole (a script built at run time). */
const WHOLE_EXPANSION = /^\s*(?:\$\w+|\$\{[^}]*\}|\$\([\s\S]*\)|`[\s\S]*`)\s*$/;

/** An ad entry point reached some other way than as the command itself. */
function otherRoutes(prog, argv, ctx, via, depth, facts) {
  const { decoded, ps, literals } = facts;
  const inner = (t, name) => judgeText(t, ctx, [...via, name], depth + 1);
  let out = null;
  // xargs and parallel append words or fill a placeholder: only a plain read verb stays a read.
  if (prog === "xargs" || prog === "parallel") {
    const k = argv.findIndex((x, i) => i > 0 && entryKind(x));
    if (k > 0) {
      const after = argv.slice(k + 1);
      const placeholder = argv.some((x) => /^(?:-I|-i|--replace)/.test(x)) || after.some((x) => /^:::+$/.test(x) || /\{\}/.test(x));
      if (placeholder || !READS.has(lower(after[0] ?? ""))) return deny("a", WORDS.nonliteral);
      return null;
    }
    if (facts.mention() && (prog === "parallel" || argv.some((x) => /\{\}/.test(x) || SHELLS.has(lower(programName(x)))))) return deny("a", WORDS.nonliteral);
  }
  // An entry word as an argument of another program, followed by a verb: run through it. A
  // package manager runs one only after its runner verb (`npm -w x exec <entry> …`, `yarn run`).
  const runners = ["exec", "x", "dlx", ...(prog === "yarn" || prog === "bun" ? ["run"] : [])];
  const runnerAt = ["npm", "pnpm", "yarn", "bun", "corepack"].includes(prog) ? argv.findIndex((x, i) => i > 0 && runners.includes(x)) : 0;
  if (!NOT_RUNNERS.has(prog) || runnerAt > 0) {
    for (let k = Math.max(1, runnerAt + 1); k < argv.length - 1; k++) {
      const kind = entryKind(argv[k]);
      if (!kind) continue;
      const c = verbClass(kind, argv.slice(k + 1), { ps });
      if (c.cls !== "read") out = worst(out, deny("a", c.cls === "token" ? WORDS.token : c.cls === "nonliteral" ? WORDS.nonliteral : WORDS.variant));
    }
  }
  // Inline code, and an interpreter fed code on stdin (a heredoc, here-string or pipe).
  const code = inlineCode(prog, argv);
  if (code !== null) {
    if (runsProcess(code, prog) && mentionsVerb(substituteLiterals(code, literals))) out = worst(out, deny("a", WORDS.variant));
  } else if ((INLINE_LETTERS[prog] || prog === "deno") && readsStdin(prog, argv) && new RegExp(`\\|\\s*${prog}\\b|\\b${prog}\\b[^;\\n|&]*<<`).test(decoded) && runsProcess(stdinCode(decoded, ps), prog) && facts.mention()) out = worst(out, deny("a", WORDS.variant));
  // Programs that run a command string from an option or subcommand: judged as wrapped.
  for (const t of commandStrings(prog, argv)) out = worst(out, inner(t, prog));
  if (((AWK.has(prog) && argv.slice(1).some((x) => /system\s*\(|(?<!\|)\|(?!\|)/.test(x))) || (prog === "sed" && sedRuns(argv))) && mentionsVerb(argv.slice(1).join(" "))) out = worst(out, deny("a", WORDS.variant));
  if ((prog === "vim" || prog === "nvim" || prog === "vi") && argv.some((x) => /^[+!-]/.test(x) || x.includes("!")) && mentionsVerb(argv.join(" "))) out = worst(out, deny("a", WORDS.variant));
  // A shell fed on stdin, a shell whose script is built at run time, eval or iex: the line's words decide.
  const scriptAt = argv.findIndex((x, i) => i > 0 && isScriptFlag(x));
  const firstArg = argv.slice(1).find((x) => !x.startsWith("-"));
  // A shell's script: its own line-level checks (variables, `&`, an agent's home) run on it too.
  if ((SHELLS.has(prog) || prog === "pwsh" || prog === "powershell") && scriptAt > 0 && argv[scriptAt + 1] && !WHOLE_EXPANSION.test(argv[scriptAt + 1])) out = worst(out, judgeText(argv[scriptAt + 1], { ...ctx, dialect: SHELLS.has(prog) ? "bash" : "powershell", top: argv[scriptAt + 1], background: ctx.background || facts.bgLine }, via, depth + 1));
  const stdinShell = SHELLS.has(prog) && scriptAt < 0 && (!firstArg || /^<\(|^\/dev\/(?:stdin|fd)/.test(firstArg) || argv.includes("-s"));
  // (Built: the script word is an expansion as a whole. A literal script is judged as itself above.)
  const builtScript = SHELLS.has(prog) && scriptAt > 0 && WHOLE_EXPANSION.test(argv[scriptAt + 1] ?? "");
  const evaluator = ["eval", "source", ".", "iex", "invoke-expression", "invoke-command", "icm"].includes(prog) || facts.evaluates;
  if (stdinShell || builtScript || evaluator) {
    if (facts.mention() || mentionsVerb(substituteLiterals(argv.slice(1).join(" "), literals))) out = worst(out, deny("a", WORDS.nonliteral));
    else if (facts.encoded) out = worst(out, ask("h", WORDS.built));
    else if (evaluator && new RegExp(`(?:\\$\\{?\\w+\\}?|\\$\\([^)]*\\)|\`[^\`]*\`)\\s+(?:${VERB_RE})(?![\\w-])`, "i").test(facts.evaluates ? decoded : argv.slice(1).join(" "))) out = worst(out, ask("h", WORDS.built));
  }
  // A program held in a variable or built at run time.
  if (isExpansion(argv[0], ps) || /^\[scriptblock\]/i.test(argv[0])) {
    if (facts.mention()) out = worst(out, deny("a", WORDS.nonliteral));
    else {
      let k = 1;
      while (k < argv.length && /^-/.test(argv[k])) k += AD_VALUE_OPTIONS.has(argv[k]) ? 2 : 1;
      if (/^(?:review|rules|learnings?|setup|install|repair|uninstall|held|consolidate|memory|config|forget|remember|restore)$/i.test(argv[k] ?? "")) out = worst(out, ask("h", WORDS.built));
    }
  }
  // PowerShell: `& (gcm <entry>) <verb>` runs what the lookup found.
  if ((prog === "gcm" || prog === "get-command") && argv.slice(1).some((x) => entryKind(x)) && /[&.]\s*\(/.test(facts.decoded) && facts.mention()) out = worst(out, deny("a", WORDS.nonliteral));
  // PowerShell aliases set to an entry point.
  if (["set-alias", "sal", "new-alias", "nal"].includes(prog) && argv.slice(1).some((x) => entryKind(x))) out = worst(out, deny("a", WORDS.nonliteral));
  // bash aliases (`alias x='ad rules pause'`): the value's first word is the entry point.
  if (prog === "alias") for (const x of argv.slice(1).filter((y) => y.includes("=")).slice(0, 32)) out = worst(out, inner(x.slice(x.indexOf("=") + 1), "alias"));
  // PowerShell's encoded commands: the decoded text is judged too (the parser runs it, but
  // the variable checks read the text).
  if (prog === "powershell" || prog === "pwsh") {
    const k = argv.findIndex((x) => /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/i.test(x));
    if (k > 0 && argv[k + 1]) {
      let t = "";
      try {
        t = Buffer.from(argv[k + 1], "base64").toString("utf16le");
      } catch {
        t = "";
      }
      if (t) out = worst(out, judgeText(t, { ...ctx, dialect: "powershell", top: t }, via, depth + 1));
    }
  }
  return worst(out, wrapperCheck(prog, argv, ctx, via, depth, decoded, facts));
}

function isReparenting(prog, argv) {
  if (prog === "tmux") return TMUX_START.has(tmuxSub(argv.slice(1))[0]);
  if (prog === "zellij") return argv.includes("run");
  if (prog === "schtasks") return argv.some((x) => /^\/create$/i.test(x));
  if (prog === "launchctl") return argv[1] === "submit";
  if (prog === "ad") return ["schedule", "loop", "run"].includes(argv[1]);
  if (prog === "python" || prog === "python3") return argv.some((x) => /pty\.spawn/.test(x));
  return REPARENTING.has(prog);
}

function wrapperCheck(prog, argv, ctx, via, depth, text, facts) {
  const inner = (t, name) => judgeText(t, ctx, [...via, name], depth + 1);
  const args = argv.slice(1);
  // Nested agents (b).
  const agent = prog === "claude" || /^@anthropic-ai\/claude-code/.test(lower(argv[0])) ? "claude" : prog === "codex" || /^@openai\/codex/.test(lower(argv[0])) ? "codex" : null;
  if (agent) {
    if (facts.agentMoved()) return deny("b", WORDS.agent);
    const val = (flag) => {
      const k = args.findIndex((x) => x === flag || x.startsWith(`${flag}=`));
      return k < 0 ? undefined : args[k].includes("=") ? args[k].slice(flag.length + 1) : (args[k + 1] ?? "");
    };
    if (agent === "claude") {
      const sources = val("--setting-sources");
      if (sources !== undefined && !/\buser\b/.test(sources)) return deny("b", WORDS.agent);
      const settings = val("--settings");
      if (settings !== undefined) return /hooks|disableAllHooks/i.test(settings) && /^\s*\{/.test(settings) ? deny("b", WORDS.agent) : ask("b", WORDS.agentAsk);
      if ((args[0] === "mcp" && /^(?:add|add-json|remove)$/.test(args[1] ?? "")) || (args[0] === "plugin" && /^(?:disable|uninstall|remove)$/.test(args[1] ?? ""))) return ask("b", WORDS.agentAsk);
      return null;
    }
    const configs = args.flatMap((x, k) => (x === "-c" || x === "--config" ? [args[k + 1] ?? ""] : /^--config=/.test(x) ? [x.slice(9)] : []));
    if (configs.some((c) => /^\s*(?:hooks|features\.hooks)\b/.test(c))) return deny("b", WORDS.agent);
    if (configs.some((c) => /^\s*features\./.test(c)) || args.some((x) => x === "--profile" || x === "-p" || /^--disable\b/.test(x)) || (args[0] === "mcp" && /^(?:add|remove)$/.test(args[1] ?? ""))) return ask("b", WORDS.agentAsk);
    return null;
  }
  switch (prog) {
    case "tmux": {
      const rest = tmuxSub(args);
      const sub = rest[0];
      // `tmux -c <command>` runs it as a shell command.
      const c = args.indexOf("-c");
      if (!sub && c >= 0) return inner(args[c + 1] ?? "", "tmux");
      // if-shell runs its first argument; hooks and key bindings that run a shell command.
      if (sub === "if-shell" || sub === "if") return inner(afterOptions(rest.slice(1), "t")[0] ?? "", "tmux");
      if (/^(?:set-hook|bind-key|bind|set-option|set|source-file|source)$/.test(sub ?? "") && mentionsVerb(rest.slice(1).join(" "))) return deny("a", WORDS.variant);
      if (TMUX_START.has(sub)) return inner(tmuxText(sub, rest.slice(1)), "tmux");
      if (TMUX_INPUT.has(sub) || sub === "set-buffer" || sub === "setb") return worst(ask("b", WORDS.desktop), inner(tmuxText(sub, rest.slice(1)), "tmux"));
      return null;
    }
    case "zellij": {
      const z = afterOptions(args, "slcd", ["--session", "--layout", "--config", "--config-dir", "--data-dir", "--max-panes"]);
      // A pane in the session the user is in, like tmux's new-window: ask, and judge what it runs.
      if (z[0] === "run") return worst(ask("b", WORDS.desktop), inner(afterOptions(z.slice(1), "dncf", ["--direction", "--name", "--cwd"]).join(" "), "zellij"));
      if (z[0] === "action" && /^(?:new-pane|new-tab)$/.test(z[1] ?? "")) {
        const dash = z.indexOf("--");
        return worst(ask("b", WORDS.desktop), dash >= 0 ? inner(z.slice(dash + 1).join(" "), "zellij") : null);
      }
      if (z[0] === "action" && /^(?:write-chars|write)$/.test(z[1] ?? "")) return worst(ask("b", WORDS.desktop), inner(z.slice(2).join(" "), "zellij"));
      return null;
    }
    case "screen": {
      const x = args.indexOf("-X");
      if (x >= 0 && args[x + 1] === "stuff") return worst(ask("b", WORDS.desktop), inner(carried("screen", [args[x + 2] ?? ""])[0], "screen"));
      const rest = afterOptions(args, "StcehpTX", ["-Logfile"]);
      return rest.length ? inner(rest.join(" "), "screen") : null;
    }
    case "ssh": {
      const rest = afterOptions(args, "bcDEeFIiJLlmOopQRSWwB");
      const remote = rest.slice(1).filter((x, k) => !(k === 0 && x === "--")).join(" ");
      // No remote command, or a remote shell: it runs what comes on stdin.
      const remoteShell = !remote || /^(?:bash|sh|zsh|dash)\b(?![^]*\s-c\b)/.test(remote);
      if (remoteShell && facts.mention()) return deny("a", WORDS.variant);
      return remote ? inner(remote, "ssh") : null;
    }
    case "script": {
      // script -c|-qc|-qec CMD, --command=CMD, --command CMD; BSD: script [-q] file cmd …
      let cmd = null;
      for (let k = 0; k < args.length; k++) {
        if (/^-[a-zA-Z]*c$/.test(args[k]) || args[k] === "--command") cmd = args[k + 1] ?? "";
        else if (args[k].startsWith("--command=")) cmd = args[k].slice(10);
      }
      if (cmd !== null) return inner(cmd, "script");
      const rest = afterOptions(args, "tTOIBEm");
      return rest.length > 1 ? inner(rest.slice(1).join(" "), "script") : null;
    }
    case "expect": {
      const k = args.indexOf("-c");
      const script = k >= 0 ? args[k + 1] ?? "" : "";
      let r = null;
      for (const m of script.matchAll(/\bspawn\s+(?:-\w+\s+)*([^;\n]+)/g)) r = worst(r, inner(m[1], "expect"));
      if (!r && mentionsVerb(text)) r = deny("a", WORDS.variant); // a script from a file or stdin
      return r;
    }
    case "socat": {
      let r = null;
      for (const x of args) {
        const m = /^(?:EXEC|SYSTEM):(.*?)(?:,|$)/i.exec(x);
        if (m) r = worst(r, inner(m[1], "socat"));
      }
      return r;
    }
    case "schtasks": {
      const k = args.findIndex((x) => /^\/tr$/i.test(x));
      return k >= 0 ? inner(args[k + 1] ?? "", "schtasks") : null;
    }
    case "launchctl": {
      const k = args.indexOf("--");
      return args[0] === "submit" && k >= 0 ? inner(args.slice(k + 1).join(" "), "launchctl") : null;
    }
    case "systemd-run": {
      const rest = afterOptions(args, "upEMHd", ["--unit", "--property", "--uid", "--gid", "--setenv", "--working-directory", "--description", "--slice", "--machine", "--host", "--nice", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-calendar", "--timer-property", "--path-property", "--socket-property", "--service-type", "--expand-environment"]);
      return rest.length ? inner(rest.join(" "), prog) : null;
    }
    case "daemonize": {
      const rest = afterOptions(args, "acEeoplu");
      return rest.length ? inner(rest.join(" "), prog) : null;
    }
    case "at":
    case "batch":
      // Commands from stdin or a file: judged from the whole line's words.
      return mentionsVerb(text) ? deny("a", WORDS.variant) : null;
    default:
      break;
  }
  // Desktop launchers, terminals, remote input: ask; a token or token-variant verb inside denies.
  const launches = TERMINALS.has(prog) || DESKTOP.has(prog) || (prog === "open" && args.some((x) => /^-[a-zA-Z]*[ab][a-zA-Z]*$/.test(x) || /\.command$/i.test(x))) || (prog === "gio" && args[0] === "launch") || (prog === "xdg-open" && args.some((x) => /\.desktop$/i.test(x)));
  if (launches) {
    // kitty's remote control (`kitty @` or `kitten @`, after @'s own options).
    const remote = args[0] === "@" ? afterOptions(args.slice(1), "", ["--to", "--password", "--password-file", "--password-env"]) : null;
    if (prog === "kitty" && (remote ? !/^(?:send-text|send-key|launch|run)$/.test(remote[0] ?? "") : /^\+/.test(args[0] ?? ""))) return null;
    if (prog === "kitten" && !(remote && /^(?:send-text|send-key|launch|run)$/.test(remote[0] ?? ""))) return null;
    if (prog === "uwsm" && args[0] !== "app") return null;
    if (prog === "uwsm-app" && !args.length) return null;
    if (prog === "wezterm" && args[0] === "cli" && !/^(?:send-text|spawn)$/.test(args[1] ?? "")) return null;
    // Compositors run a program from an `exec` anywhere in their (often quoted, batched) arguments.
    const execAt = /(?:^|[\s;,])(?:dispatch\s+(?:--\s+)?)?exec\s+([\s\S]*)$/.exec(args.join(" "));
    if (prog === "hyprctl" && !(execAt && /\bdispatch\s+(?:--\s+)?exec\b/.test(args.join(" ")))) return null;
    if ((prog === "swaymsg" || prog === "i3-msg") && !execAt) return null;
    if (prog === "dbus-send" && !args.some((x) => /org\.gnome\.Terminal/i.test(x))) return null;
    if (prog === "qdbus" && !args.some((x) => /sendText|runCommand/i.test(x))) return null;
    const dash = args.indexOf("--");
    let texts = dash >= 0 ? [args.slice(dash + 1).join(" ")] : carried(prog, args);
    if (texts.length > 64) texts = [texts.join(" ")]; // one pass over a long argument list
    let r = ask("b", WORDS.desktop);
    for (const t of texts) r = worst(r, inner(t, prog));
    if (execAt && ["hyprctl", "swaymsg", "i3-msg"].includes(prog)) r = worst(r, inner(execAt[1], prog));
    if (prog === "wt") r = worst(r, inner(wtText(args), prog));
    return r;
  }
  // PowerShell COM key senders: the parser reads `$w.SendKeys('…')` as a method call, so
  // the keys come from the line's own text.
  if (/SendKeys|WScript\.Shell|AppActivate|ShellWindows/i.test(argv.join(" "))) {
    let r = ask("b", WORDS.desktop);
    for (const m of String(text).matchAll(/SendKeys\s*\(\s*["']([^"']*)["']/gi)) r = worst(r, inner(m[1].replace(/\{ENTER\}|~/gi, ""), "sendkeys"));
    return r;
  }
  return null;
}

/**
 * AD_ROOT=<a literal path outside every protected root> in front of the line's only
 * command, an ad command: a scratch root. Nothing else on the line, no other variable.
 */
function scratchRoot(text, ctx) {
  const m = /^[ \t]*AD_ROOT=(?:"([^"$`\\\n]*)"|'([^'\n]*)'|([^\s;&|<>()$`'"#\\]+))[ \t]+([^\s;&|<>()$`'"#=]+)((?:[ \t]+[^\s;&|<>()$`#]+)*)[ \t]*$/.exec(String(text));
  if (!m || !entryKind(m[4])) return false;
  const value = m[1] ?? m[2] ?? m[3] ?? "";
  if (!value || /^~/.test(value)) return false;
  const p = ctx.pathMod;
  let v = value;
  if (p === path.win32 && /^\/[a-z](?:\/|$)/i.test(v)) v = `${v[1]}:\\${v.slice(3)}`;
  if (!p.isAbsolute(v)) return false;
  let real = p.resolve(v);
  try {
    if (p === (process.platform === "win32" ? path.win32 : path.posix)) real = fs.realpathSync.native(real);
  } catch {
    // not there yet: as written
  }
  const fold = foldFor(ctx);
  const within = (child, parent) => {
    const rel = p.relative(fold(parent), fold(child));
    return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
  };
  return !ctx.protectedRoots.some((r) => within(real, r) || within(r, real));
}

/** The command text of a shell call (Bash, PowerShell, Codex's shell). */
function commandText(call) {
  const c = call.input?.command ?? call.input?.cmd ?? call.input?.action?.command;
  // Codex's exec form: each argument quoted, so `bash -lc "ad review"` stays one script.
  return Array.isArray(c) ? c.map((x) => (/^[\w@%+=:,./-]+$/.test(String(x)) ? String(x) : `'${String(x).replace(/'/g, `'\\''`)}'`)).join(" ") : typeof c === "string" ? c : null;
}

const SHELL_TOOLS = /^(?:bash|powershell|shell)$/i;

/**
 * @param {object} input  the hook payload ({tool_name, tool_input, cwd, …})
 * @param {{host?: string, platform?: string, home?: string, root?: string, folders?: string[]}} [opts]
 */
export function selfProtect(input, { host = "claude", platform = process.platform, home = os.homedir(), root, folders } = {}) {
  const call = callOf(input, { host, platform });
  if (!SHELL_TOOLS.test(call.tool)) return null;
  const text = commandText(call);
  if (!text) return null;
  const windows = call.os === "windows";
  const pathMod = windows ? path.win32 : path.posix;
  const adRoot = root ?? (process.env.AD_ROOT && pathMod.isAbsolute(process.env.AD_ROOT) ? process.env.AD_ROOT : pathMod.join(home, ".agent-daemon"));
  let cached = folders ?? null;
  const ctx = {
    dialect: dialectOf(call),
    os: call.os,
    cwd: call.cwd,
    homeDir: home,
    pathMod,
    protectedRoots: [adRoot, pathMod.join(home, ".agent-daemon")],
    folders: () => (cached ??= adFolders({ root: adRoot, home })),
    // Claude Code's Bash tool runs it in the background: as a trailing `&` would.
    background: input?.tool_input?.run_in_background === true,
    // The work budget (well inside the hook's 5 s timeout).
    deadline: Date.now() + 1000,
  };
  // Codex's [shell, -lc, script]: the script is the command line itself.
  const c = call.input?.command;
  if (Array.isArray(c) && c.length >= 3 && SHELL_PROGS.has(lower(programName(String(c[0])))) && isScriptFlag(String(c.at(-2))) && c.slice(1, -2).every((x) => /^[-+]/.test(String(x)) || /^(?:pipefail|errexit|nounset)$/.test(String(x)))) {
    const pwsh = /^(?:pwsh|powershell)$/.test(lower(programName(String(c[0]))));
    return judgeText(String(c.at(-1)), { ...ctx, dialect: pwsh ? "powershell" : "bash" }, [], 0);
  }
  return judgeText(text, ctx, [], 0);
}
