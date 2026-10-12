#!/usr/bin/env node
// Brand lint: the engine's name stays in its allowed zone.
//
// ad runs on a pinned third-party engine. The product, its screens, its docs
// and the files it writes say "the engine"; the engine's name appears only in
// the adapter (runtime/src/engine/codex/), the attribution module
// (runtime/src/engine/attribution.mjs) and the places listed with a written
// reason in runtime/scripts/brand-allowlist.json. Four rules:
//
//   A  the brand word (any case), in content or in a file name, outside the
//      allowed zone. Every tracked text file counts: source, tests, docs,
//      skills, workflows, package files.
//   B  a protocol method name (from the pinned snapshot) in a call shape —
//      `.request("…")`, `waitForNotification("…")`, `structuredRequest("…")`,
//      line breaks allowed, comments ignored — outside the adapter and the
//      façade (runtime/src/engine/index.mjs): only those two speak the protocol.
//   C  prose that names the engine, in runtime/src: a string or template
//      literal, or a JSON value (not a key), that matches the brand word and
//      has whitespace or sentence punctuation. Bare tokens (CODEX_HOME,
//      @openai/codex, .codex, codex-home, method names, paths) are API and
//      pass. Prose comes from the attribution module only; the adapter
//      returns codes and the façade owns the words. Thrown Error messages
//      are prose. Comments and regex literals never count; \x, \u and \u{…}
//      escapes are decoded first.
//   D  within runtime/src, engine/codex/* is imported only from engine/
//      (static imports, `import()`, `new URL()`; comments ignored). Tests,
//      the testkit and scripts may import it.
//
// Report mode (the default) prints counts and exits 0. `--strict` (every
// rule) or `--strict=B,D` exits 1 on a hit in those rules, or on an allowlist
// entry for them that matches nothing (so the allowlist can't rot).
// `--verbose` prints every hit; `--json` prints the result as JSON. Untracked
// files that git doesn't ignore are linted too (a new file is checked before
// it is committed); `--tracked` limits a run to tracked files, for a strict
// CI step that must not depend on what earlier steps left behind.
//
//   node runtime/scripts/check-brand.mjs [--strict[=A,B,C,D]] [--verbose] [--json]
//                                        [--tracked] [--root <dir>] [--allowlist <file>]
//   npm run lint:brand
//
// Known limit of the string scanner (rule C), by design: a regex literal
// right after `)` (`if (x) /re/.test(s)`) reads as a division, which only
// matters if the regex contains a quote; a file that doesn't parse is
// scanned as far as it goes.
//
// The rules are exported so test/check-brand.test.mjs can run them on a
// fixture tree; `--root` and `--allowlist` let the test run the script itself.

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const ALLOWLIST_PATH = path.join(HERE, "brand-allowlist.json");
const SNAPSHOT_PATH = path.join(REPO_ROOT, "runtime", "src", "engine", "codex", "protocol-snapshot.json");

export const BRAND = /codex/i;
export const RULES = {
  A: "brand word outside the allowed zone",
  B: "protocol method outside the adapter and the façade",
  C: "prose naming the engine in runtime/src",
  D: "adapter imported from outside engine/",
};
export const RULE_IDS = Object.keys(RULES);

const SRC_DIR = "runtime/src/";
const ENGINE_DIR = "runtime/src/engine/";
const ADAPTER_DIR = "runtime/src/engine/codex/";
const FACADE = "runtime/src/engine/index.mjs";
const ATTRIBUTION = "runtime/src/engine/attribution.mjs";
const RULE_B_DIRS = ["runtime/src/", "runtime/test/", "runtime/testkit/", "runtime/scripts/"];

const CALL_SHAPE = /(\.request|waitForNotification|structuredRequest)\(\s*["'`]([A-Za-z][\w/]*)["'`]/g;
// import x from "…" · import "…" · export { x } from "…" · import("…") · new URL("…", import.meta.url)
const IMPORT_SPEC = /(?:\bimport\s*(?:[^'"`;]*?\bfrom\s*)?|\bexport\s*[^'"`;]*?\bfrom\s*|\bimport\s*\(\s*|\bnew\s+URL\s*\(\s*)["']([^"']+)["']/g;
// Known text files are read whatever bytes they hold (a regex with a raw NUL is still source); other extensions are sniffed.
const TEXT_EXT = new Set([".mjs", ".cjs", ".js", ".ts", ".json", ".jsonl", ".md", ".mdc", ".yml", ".yaml", ".toml", ".txt", ".sh", ".ps1", ".html", ".css"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".db", ".sqlite", ".node", ".exe", ".zip", ".gz", ".tgz", ".pdf"]);

// ── files ──────────────────────────────────────────────────────────────────

const toPosix = (p) => p.split(path.sep).join("/");

/**
 * Tracked and untracked-but-not-ignored files (tracked only with `trackedOnly`),
 * relative posix paths; a plain walk where git isn't available.
 */
export function listFiles(root, { trackedOnly = false } = {}) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", ...(trackedOnly ? [] : ["--others", "--exclude-standard"])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...new Set(out.split("\0").filter(Boolean).map(toPosix))].sort();
  } catch {
    return walk(root, "").sort();
  }
}

function walk(root, rel) {
  const out = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

/** The file's text; null when it is binary; undefined when it is missing (deleted but still indexed) or not a regular file. */
function readText(root, file) {
  let stat;
  try {
    stat = lstatSync(path.join(root, file));
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const ext = path.extname(file).toLowerCase();
  if (BINARY_EXT.has(ext)) return null;
  const buf = readFileSync(path.join(root, file));
  if (!TEXT_EXT.has(ext) && buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString("utf8");
}

// ── allowlist ──────────────────────────────────────────────────────────────

/**
 * Entries: {path, rules, reason, match?}. `path` is an exact file, a folder
 * (trailing slash, globs allowed) or a glob (`*` within a segment, `**`
 * across segments). `match` is a regex: only hits whose text matches are
 * allowed, and for rules A and C the brand word must sit inside the matched
 * part (a line that names the engine next to the allowed phrase is still a
 * hit). A file-name hit is never allowed by a `match` entry. Every entry
 * needs a reason.
 */
export function compileAllowlist(json) {
  const list = Array.isArray(json) ? json : json.entries;
  if (!Array.isArray(list)) throw new Error("brand-allowlist: expected {entries: [...]}");
  return list.map((e, i) => {
    const where = `brand-allowlist entry ${i} (${e?.path ?? "?"})`;
    if (!e || typeof e.path !== "string" || !e.path) throw new Error(`${where}: needs a path`);
    if (!Array.isArray(e.rules) || !e.rules.length) throw new Error(`${where}: needs rules`);
    for (const r of e.rules) if (!RULES[r]) throw new Error(`${where}: unknown rule ${r}`);
    if (typeof e.reason !== "string" || !e.reason.trim()) throw new Error(`${where}: needs a reason`);
    return {
      path: e.path,
      rules: e.rules,
      reason: e.reason,
      re: globToRegExp(e.path),
      match: e.match ? new RegExp(e.match) : null,
      matchAll: e.match ? new RegExp(e.match, "g") : null,
      used: 0,
    };
  });
}

export function loadAllowlist(file = ALLOWLIST_PATH) {
  return compileAllowlist(JSON.parse(readFileSync(file, "utf8")));
}

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export function globToRegExp(glob) {
  const end = glob.endsWith("/") ? "" : "$"; // a folder matches everything under it
  if (!/[*?]/.test(glob)) return new RegExp("^" + escapeRe(glob) + end);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escapeRe(c);
  }
  return new RegExp("^" + re + end);
}

function allowedBy(entries, rule, file, text) {
  for (const e of entries) {
    if (!e.rules.includes(rule) || !e.re.test(file)) continue;
    if (e.match) {
      if (text == null || !e.match.test(text)) continue;
      if ((rule === "A" || rule === "C") && BRAND.test(text.replace(e.matchAll, ""))) continue;
    }
    e.used++;
    return e;
  }
  return null;
}

// ── rule A ─────────────────────────────────────────────────────────────────

function ruleA(file, text, out) {
  if (file.split("/").some((seg) => BRAND.test(seg))) out.push({ rule: "A", file, line: 0, text: "(file name)" });
  if (text == null) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (BRAND.test(lines[i])) out.push({ rule: "A", file, line: i + 1, text: lines[i].trim() });
}

// ── rule B ─────────────────────────────────────────────────────────────────

export function loadMethods(file = SNAPSHOT_PATH) {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  const names = new Set();
  for (const group of Object.values(snap.methods ?? {})) for (const name of Array.isArray(group) ? group : Object.keys(group)) names.add(name);
  return names;
}

const isJs = (file) => file.endsWith(".mjs") || file.endsWith(".js") || file.endsWith(".cjs");

function inRuleBScope(file) {
  if (!isJs(file)) return false;
  if (file.startsWith(ADAPTER_DIR) || file === FACADE) return false;
  return RULE_B_DIRS.some((d) => file.startsWith(d));
}

function ruleB(file, code, methods, out) {
  if (!inRuleBScope(file)) return;
  const re = new RegExp(CALL_SHAPE.source, "g");
  let m;
  while ((m = re.exec(code))) {
    if (!methods.has(m[2])) continue;
    out.push({ rule: "B", file, line: lineAt(code, m.index), text: m[0].replace(/\s+/g, " ") });
  }
}

// ── rule C ─────────────────────────────────────────────────────────────────

/** Prose: the brand word plus whitespace or sentence punctuation (a mark followed by space or the end). */
export function isProse(s) {
  return BRAND.test(s) && (/\s/.test(s) || /[.,;:!?](?=\s|$)/.test(s));
}

const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

function regexAllowed(prev) {
  if (prev === "") return true;
  if (REGEX_AFTER.has(prev)) return true;
  if (/^[\p{ID_Continue}$]+$/u.test(prev)) return false; // identifier, number or property name: a division
  if (prev === ")" || prev === "]" || prev === "'") return false; // after a call, an index, a string
  return true;
}

/** The escape at src[j] (a backslash): its text, the bytes consumed, the newlines it spans (a line continuation). */
function readEscape(src, j) {
  const e = src[j + 1];
  if (e === undefined) return { text: "", len: 1, newlines: 0 };
  if (e === "\n") return { text: "", len: 2, newlines: 1 };
  if (e === "\r") return src[j + 2] === "\n" ? { text: "", len: 3, newlines: 1 } : { text: "", len: 2, newlines: 0 }; // only "\n" counts as a line, as everywhere else
  if (e === "n") return { text: "\n", len: 2, newlines: 0 };
  if (e === "t") return { text: "\t", len: 2, newlines: 0 };
  if (e === "r") return { text: "\r", len: 2, newlines: 0 };
  if (e === "x" && /^[0-9a-f]{2}$/i.test(src.slice(j + 2, j + 4))) return { text: String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)), len: 4, newlines: 0 };
  if (e === "u") {
    if (src[j + 2] === "{") {
      const close = src.indexOf("}", j + 3);
      const hex = close === -1 ? "" : src.slice(j + 3, close);
      if (/^[0-9a-f]{1,6}$/i.test(hex)) return { text: String.fromCodePoint(parseInt(hex, 16)), len: close + 1 - j, newlines: 0 };
    } else if (/^[0-9a-f]{4}$/i.test(src.slice(j + 2, j + 6))) return { text: String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)), len: 6, newlines: 0 };
  }
  return { text: e, len: 2, newlines: 0 };
}

/**
 * The string and template literals of a JS source: [{text, line, kind}].
 * Comments and regex literals are skipped; a template's `${…}` expressions
 * become "${}" in its text (their own strings are extracted on their own).
 */
export function extractStrings(src) {
  const out = [];
  scan(src, 0, 1, false, out, null);
  return out;
}

/** The source with every comment blanked (newlines kept), so line numbers hold. */
export function stripComments(src) {
  const comments = [];
  scan(src, 0, 1, false, [], comments);
  if (!comments.length) return src;
  const parts = [];
  let at = 0;
  for (const [start, end] of comments) {
    parts.push(src.slice(at, start), src.slice(start, end).replace(/[^\n]/g, " "));
    at = end;
  }
  parts.push(src.slice(at));
  return parts.join("");
}

// Scans from i; when inTemplateExpr, stops at the `}` that closes the `${`.
// Returns [index after the stop, line]. `comments` collects [start, end) ranges.
function scan(src, i, line, inTemplateExpr, out, comments) {
  const n = src.length;
  let depth = 0;
  let prev = "";
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? n : e;
      comments?.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      comments?.push([i, end]);
      for (let k = i; k < end; k++) if (src[k] === "\n") line++;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1;
      let text = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          const esc = readEscape(src, j);
          text += esc.text;
          line += esc.newlines;
          j += esc.len;
        } else text += src[j++];
      }
      out.push({ text, line: startLine, kind: "string" });
      i = src[j] === c ? j + 1 : j; // an unterminated string leaves its newline to be counted
      prev = "'";
      continue;
    }
    if (c === "`") {
      const startLine = line;
      let j = i + 1;
      let text = "";
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") {
          const esc = readEscape(src, j);
          text += esc.text;
          line += esc.newlines;
          j += esc.len;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          text += "${}";
          [j, line] = scan(src, j + 2, line, true, out, comments);
          continue;
        }
        if (src[j] === "\n") line++;
        text += src[j++];
      }
      out.push({ text, line: startLine, kind: "template" });
      i = j + 1;
      prev = "'";
      continue;
    }
    if (inTemplateExpr) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) return [i + 1, line];
        depth--;
      }
    }
    if (c === "/" && regexAllowed(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== "\n") {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (ch === "]") inClass = false;
        } else if (ch === "[") inClass = true;
        else if (ch === "/") {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
      } else i = j; // not a regex after all: leave the newline to be counted
      prev = ")";
      continue;
    }
    if (/[\p{ID_Start}$_]/u.test(c)) {
      let j = i;
      while (j < n && /[\p{ID_Continue}$‌‍]/u.test(src[j])) j++;
      prev = prev === "." ? "0" : src.slice(i, j); // a property name is never a keyword
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = "0";
      i = j;
      continue;
    }
    if ((c === "+" && d === "+") || (c === "-" && d === "-")) {
      prev = "0"; // after a postfix ++/-- comes an operator, never a regex
      i += 2;
      continue;
    }
    prev = c;
    i++;
  }
  return [i, line];
}

function walkJson(value, fn) {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) for (const v of value) walkJson(v, fn);
  else if (value && typeof value === "object") for (const v of Object.values(value)) walkJson(v, fn);
}

function ruleC(file, text, out) {
  if (!file.startsWith(SRC_DIR) || file === ATTRIBUTION) return;
  if (file.endsWith(".json")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    walkJson(data, (value) => {
      if (!isProse(value)) return;
      const idx = text.indexOf(JSON.stringify(value));
      out.push({ rule: "C", file, line: idx === -1 ? 0 : lineAt(text, idx), text: value });
    });
    return;
  }
  if (!isJs(file)) return;
  for (const s of extractStrings(text)) if (isProse(s.text)) out.push({ rule: "C", file, line: s.line, text: s.text });
}

// ── rule D ─────────────────────────────────────────────────────────────────

function ruleD(file, code, out) {
  if (!file.startsWith(SRC_DIR) || file.startsWith(ENGINE_DIR) || !isJs(file)) return;
  const re = new RegExp(IMPORT_SPEC.source, "g");
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (resolved.startsWith(ADAPTER_DIR)) out.push({ rule: "D", file, line: lineAt(code, m.index), text: spec });
  }
}

// ── the run ────────────────────────────────────────────────────────────────

function lineAt(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/**
 * Runs the four rules. {hits: {A: [...], …}, allowed: {A: n, …}, stale: [entries
 * that matched nothing], scanned}. Each hit: {rule, file, line, text}; line 0 is
 * a file-name hit.
 */
export function lint({ root = REPO_ROOT, files, allowlist, methods, trackedOnly = false } = {}) {
  files ??= listFiles(root, { trackedOnly });
  allowlist ??= loadAllowlist();
  methods ??= loadMethods();
  const hits = { A: [], B: [], C: [], D: [] };
  const allowed = { A: 0, B: 0, C: 0, D: 0 };
  let scanned = 0;
  for (const file of files) {
    const text = readText(root, file);
    if (text === undefined) continue;
    scanned++;
    const raw = [];
    ruleA(file, text, raw);
    if (text != null) {
      const code = isJs(file) && (inRuleBScope(file) || file.startsWith(SRC_DIR)) ? stripComments(text) : text;
      ruleB(file, code, methods, raw);
      ruleC(file, text, raw);
      ruleD(file, code, raw);
    }
    for (const h of raw) {
      if (allowedBy(allowlist, h.rule, file, h.line === 0 ? null : h.text)) allowed[h.rule]++;
      else hits[h.rule].push(h);
    }
  }
  const stale = allowlist.filter((e) => e.used === 0).map(({ path: p, rules, reason }) => ({ path: p, rules, reason }));
  return { hits, allowed, stale, scanned };
}

// ── the live brand test's assertion (spike S5) ─────────────────────────────

/** Model ids that carry the brand word: gpt-*-codex* and codex-mini/-latest. */
export const MODEL_NAME = /\bgpt-[\w.-]*codex[\w.-]*|\bcodex-(?:mini|latest)[\w.-]*/gi;

/**
 * Lines of a screen, a refusal or a file ad wrote that still name the engine
 * after the attribution module's patterns (attribution.mjs brandPatterns())
 * and model names are taken out: the only allowed matches. `allow` holds
 * RegExps or literal strings. [{line, text}].
 */
export function screenHits(text, { allow = [] } = {}) {
  let cleaned = text;
  for (const a of allow) {
    if (a instanceof RegExp) cleaned = cleaned.replace(new RegExp(a.source, a.flags.includes("g") ? a.flags : a.flags + "g"), "");
    else if (a) cleaned = cleaned.split(a).join("");
  }
  cleaned = cleaned.replace(MODEL_NAME, "");
  return cleaned
    .split("\n")
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((l) => BRAND.test(l.text));
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { strict: [], verbose: false, json: false, tracked: false, root: REPO_ROOT, allowlist: ALLOWLIST_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") opts.strict = [...RULE_IDS];
    else if (a === "--tracked") opts.tracked = true;
    else if (a.startsWith("--strict=")) {
      opts.strict = a.slice("--strict=".length).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      const bad = opts.strict.filter((r) => !RULES[r]);
      if (bad.length) throw new Error(`unknown rule(s) ${bad.join(", ")}; rules are ${RULE_IDS.join(", ")}`);
    } else if (a === "--verbose") opts.verbose = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--root") opts.root = path.resolve(argv[++i] ?? "");
    else if (a === "--allowlist") opts.allowlist = path.resolve(argv[++i] ?? "");
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function byFile(hits) {
  const counts = new Map();
  for (const h of hits) counts.set(h.file, (counts.get(h.file) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

function print(result, opts) {
  const mode = opts.strict.length ? `strict: ${opts.strict.join(",")}` : "report mode";
  console.log(`Brand lint (${mode}): ${result.scanned} files, allowlist ${toPosix(path.relative(opts.root, opts.allowlist))}`);
  for (const r of RULE_IDS) {
    const files = byFile(result.hits[r]).length;
    console.log(`  ${r}  ${RULES[r].padEnd(52)} ${String(result.hits[r].length).padStart(5)} hits in ${String(files).padStart(3)} files   (allowed ${result.allowed[r]})`);
  }
  for (const r of RULE_IDS) {
    if (!result.hits[r].length) continue;
    console.log(`\nRule ${r}: ${RULES[r]}`);
    if (opts.verbose) {
      for (const h of result.hits[r]) console.log(`  ${h.file}:${h.line}: ${h.text.length > 120 ? h.text.slice(0, 117) + "..." : h.text}`);
    } else {
      const files = byFile(result.hits[r]);
      for (const [file, n] of files.slice(0, 30)) console.log(`  ${String(n).padStart(5)}  ${file}`);
      if (files.length > 30) console.log(`         … and ${files.length - 30} more files (--verbose lists every hit)`);
    }
  }
  if (result.stale.length) {
    console.log("\nAllowlist entries that match nothing (remove or fix them):");
    for (const e of result.stale) console.log(`  ${e.path} [${e.rules.join(",")}]`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = lint({ root: opts.root, allowlist: loadAllowlist(opts.allowlist), trackedOnly: opts.tracked });
  if (opts.json) console.log(JSON.stringify({ ...result, strict: opts.strict }, null, 2));
  else print(result, opts);
  const failing = opts.strict.filter((r) => result.hits[r].length || result.stale.some((e) => e.rules.includes(r)));
  if (failing.length) {
    if (!opts.json) console.log(`\nFAIL: rule(s) ${failing.join(", ")} have hits or stale allowlist entries`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
