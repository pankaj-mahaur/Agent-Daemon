// Syntax highlighting for code blocks and diffs (codex-parity-2 Part 9, P7):
// no dependency, one table-driven lexer with per-line state (block comments,
// multi-line strings, an open tag), linear in the input (every step consumes
// at least one character; sticky regexes with no nested quantifiers), and caps
// above which code stays plain.
//
//   languageFor(fenceInfoOrPath) → language id | null
//   highlightLines(lang, lines, state?) → {lines: [[{text, cls}]], state}
//   setSyntaxTheme(name) → {theme, known}; syntaxTheme(); styleFor(cls)
//   SYNTAX_THEMES: the themes ad ships (Codex's names), "ansi" first
//
// Token classes: keyword string number comment function type constant
// operator punctuation property tag attribute variable builtin, and for diffs
// inserted deleted meta. `null` is plain text.

import { SYNTAX } from "./theme.mjs";

/* ------------------------------------------------------------------ */
/* Themes (their colours live in theme.mjs, with every other colour)   */
/* ------------------------------------------------------------------ */


const THEMES = SYNTAX;
export const SYNTAX_THEMES = Object.keys(THEMES);
let theme = "ansi";

/** Uses a theme by Codex's name; one ad doesn't ship falls back to "ansi" (known: false). */
export function setSyntaxTheme(name) {
  const known = !name || Object.hasOwn(THEMES, name);
  theme = name && known ? name : "ansi";
  return { theme, known };
}
export const syntaxTheme = () => theme;
/** The style of a token class in the current theme (null: the text's own). */
export const styleFor = (cls, name = theme) => (cls ? (THEMES[name] ?? THEMES.ansi)[cls] ?? null : null);

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = words(`break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof
  let new return super switch this throw try typeof var void while with yield async await of static get set as from type interface enum implements
  private protected public readonly declare namespace abstract keyof infer satisfies`);
const C_KEYWORDS = words(`auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short
  signed sizeof static struct switch typedef union unsigned void volatile while`);
const CPP_EXTRA = words(`class namespace template typename public private protected virtual override final new delete this using try catch throw constexpr
  noexcept explicit friend operator mutable decltype static_cast dynamic_cast reinterpret_cast const_cast co_await co_return co_yield concept requires`);
const JAVA_KEYWORDS = words(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto
  if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized
  this throw throws transient try void volatile while var record sealed permits yield`);
const CS_KEYWORDS = words(`abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit
  extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private
  protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe
  ushort using virtual void volatile while var async await record init get set`);

const LANGS = {
  javascript: {
    keywords: JS_KEYWORDS,
    constants: words("true false null undefined NaN Infinity"),
    types: words("string number boolean any unknown never object symbol bigint"),
    builtins: words("console window document globalThis process require module exports Promise Array Object String Number Boolean Map Set JSON Math Date Error RegExp Symbol"),
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [{ q: '"' }, { q: "'" }, { q: "`", multi: true }],
    capsTypes: true,
    jsx: true,
  },
  python: {
    keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    constants: words("True False None NotImplemented Ellipsis"),
    builtins: words("print len range str int float bool dict list set tuple open isinstance issubclass type super object enumerate zip map filter sorted reversed sum min max abs any all repr input iter next hasattr getattr setattr self cls"),
    line: ["#"],
    strings: [{ q: '"""', multi: true }, { q: "'''", multi: true }, { q: '"' }, { q: "'" }],
    prefixes: /[rRbBuUfF]{1,2}(?=["'])/y,
    decorators: true,
    capsTypes: true,
  },
  rust: {
    keywords: words("as break const continue crate else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while async await dyn"),
    constants: words("true false None Some Ok Err"),
    types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box"),
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [{ q: 'r#"', close: '"#', multi: true, raw: true }, { q: 'r"', close: '"', multi: true, raw: true }, { q: '"', multi: true }, { q: "'" }],
    macros: true,
    lifetimes: true,
    capsTypes: true,
  },
  go: {
    keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    constants: words("true false nil iota"),
    types: words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any"),
    builtins: words("append cap close copy delete len make new panic print println recover"),
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [{ q: "`", multi: true, raw: true }, { q: '"' }, { q: "'" }],
    capsTypes: false,
  },
  c: {
    keywords: C_KEYWORDS,
    constants: words("true false NULL nullptr"),
    types: words("bool size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE"),
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [{ q: '"' }, { q: "'" }],
    preprocessor: true,
    capsTypes: false,
  },
  cpp: { base: "c", keywords: new Set([...C_KEYWORDS, ...CPP_EXTRA]), types: words("bool string vector map set unique_ptr shared_ptr size_t auto std"), capsTypes: true },
  java: { base: "c", keywords: JAVA_KEYWORDS, constants: words("true false null"), types: words("String Integer Long Boolean Object List Map Set"), preprocessor: false, annotations: true, capsTypes: true },
  csharp: { base: "c", keywords: CS_KEYWORDS, constants: words("true false null"), types: words("String Int32 List Dictionary Task"), preprocessor: true, capsTypes: true },
  json: { constants: words("true false null"), strings: [{ q: '"' }], keyStrings: true },
  yaml: { mode: "yaml" },
  toml: { mode: "toml" },
  shell: {
    keywords: words("if then else elif fi for while until do done case esac function in select return export local readonly declare unset"),
    builtins: words("echo cd printf read test exit source alias shift set eval exec trap pwd mkdir rm cp mv ls cat grep sed awk"),
    constants: words("true false"),
    line: ["#"],
    strings: [{ q: '"', multi: true }, { q: "'", multi: true, raw: true }],
    variables: /\$(?:\{[^}\n]*\}|[A-Za-z_][\w]*|[0-9@#?$!*-])/y,
    hashNeedsSpace: true,
  },
  powershell: {
    keywords: words("begin break catch class continue data define do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while"),
    constants: words("$true $false $null"),
    line: ["#"],
    block: [["<#", "#>"]],
    strings: [{ q: '@"', close: '"@', multi: true }, { q: "@'", close: "'@", multi: true, raw: true }, { q: '"' }, { q: "'", raw: true }],
    variables: /\$(?:\{[^}\n]*\}|[A-Za-z_][\w:]*)/y,
    cmdlets: /[A-Z][a-z]+-[A-Z][A-Za-z]+/y,
    params: /-[A-Za-z][\w]*/y,
    caseInsensitive: true,
  },
  html: { mode: "markup" },
  css: { mode: "css" },
  sql: {
    keywords: words(`select from where insert into values update set delete create table alter drop index join left right inner outer full cross on group by
      order having limit offset as and or not null is in like between case when then else end distinct union all exists primary key foreign references
      default begin commit rollback transaction view with returning asc desc count sum avg min max`),
    constants: words("true false null"),
    line: ["--"],
    block: [["/*", "*/"]],
    strings: [{ q: "'" }, { q: '"', cls: "property" }],
    caseInsensitive: true,
  },
  diff: { mode: "diff" },
};
// C-family languages inherit what they don't set.
for (const l of Object.values(LANGS)) if (l.base) Object.setPrototypeOf(l, LANGS[l.base]);

const ALIASES = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript", ts: "javascript", tsx: "javascript", mts: "javascript", cts: "javascript", typescript: "javascript", node: "javascript",
  py: "python", python: "python", python3: "python", pyw: "python",
  rs: "rust", rust: "rust",
  go: "go", golang: "go",
  c: "c", h: "c",
  cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  java: "java", cs: "csharp", csharp: "csharp", "c#": "csharp",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", shellscript: "shell", ksh: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell", powershell: "powershell", pwsh: "powershell",
  html: "html", htm: "html", xml: "html", svg: "html", xhtml: "html", vue: "html",
  css: "css", scss: "css", less: "css",
  sql: "sql",
  diff: "diff", patch: "diff",
};

/** A language id for a fence's info string ("ts", "python") or a file's path ("src/app.mjs"), else null. */
export function languageFor(infoOrPath) {
  const s = String(infoOrPath ?? "").trim().toLowerCase();
  if (!s) return null;
  if (ALIASES[s]) return ALIASES[s];
  const base = s.split(/[\\/]/).pop();
  if (base === "dockerfile" || base === "makefile") return null;
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return ALIASES[ext] ?? null;
}

/* ------------------------------------------------------------------ */
/* The lexer                                                           */
/* ------------------------------------------------------------------ */

// Caps: above them a block (or a line) stays plain text.
export const MAX_LINES = 2000;
export const MAX_LINE = 2000;

const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const OPERATOR = /[+\-*/%=&|^!<>?:~]+/y;
const PUNCT = /[()[\]{},;.@]/y;
const SPACE = /\s+/y;

const at = (re, s, i) => {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
};

// One token per call to push(); adjacent tokens of a class merge.
function emitter() {
  const out = [];
  return {
    out,
    push(text, cls = null) {
      if (!text) return;
      const last = out.at(-1);
      if (last && last.cls === cls) last.text += text;
      else out.push({ text, cls });
    },
  };
}

// Scans a string body from i to its closing quote (escapes unless raw); → [end, closed].
function scanString(s, i, close, raw) {
  while (i < s.length) {
    if (!raw && s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s.startsWith(close, i)) return [i + close.length, true];
    i++;
  }
  return [s.length, false];
}

function lexGeneric(L, s, state, e) {
  let i = 0;
  // Carried over from the line before: a block comment or a multi-line string.
  if (state.comment) {
    const end = s.indexOf(state.comment, i);
    if (end < 0) return e.push(s, "comment"), state;
    e.push(s.slice(0, end + state.comment.length), "comment");
    i = end + state.comment.length;
    state = {};
  } else if (state.string) {
    const { close, raw, cls } = state.string;
    const [end, closed] = scanString(s, 0, close, raw);
    e.push(s.slice(0, end), cls ?? "string");
    if (!closed) return state;
    i = end;
    state = {};
  }
  let prevSignificant = "";
  while (i < s.length) {
    const c = s[i];
    let m;
    if ((m = at(SPACE, s, i))) {
      e.push(m);
      i += m.length;
      continue;
    }
    // Comments.
    const line = (L.line ?? []).find((t) => s.startsWith(t, i) && (!L.hashNeedsSpace || i === 0 || /\s/.test(s[i - 1])));
    if (line) {
      e.push(s.slice(i), "comment");
      return state;
    }
    const block = (L.block ?? []).find(([open]) => s.startsWith(open, i));
    if (block) {
      const end = s.indexOf(block[1], i + block[0].length);
      if (end < 0) {
        e.push(s.slice(i), "comment");
        return { comment: block[1] };
      }
      e.push(s.slice(i, end + block[1].length), "comment");
      i = end + block[1].length;
      continue;
    }
    // C preprocessor, Java annotations, Python decorators.
    if ((L.preprocessor && c === "#" && !s.slice(0, i).trim()) || ((L.annotations || L.decorators) && c === "@" && (m = at(IDENT, s, i + 1)))) {
      const end = L.preprocessor && c === "#" ? (at(/#\s*\w+/y, s, i) ?? "#").length + i : i + 1 + m.length;
      e.push(s.slice(i, end), "attribute");
      i = end;
      // #include <stdio.h>: the path is a string.
      const path = /include/.test(s.slice(0, end)) ? at(/\s*<[^>\n]*>/y, s, i) : null;
      if (path) {
        e.push(path, "string");
        i += path.length;
      }
      continue;
    }
    // Rust's lifetimes ('a) before its character literals ('a').
    if (L.lifetimes && c === "'" && (m = at(/'[A-Za-z_]\w*(?!')/y, s, i))) {
      e.push(m, "constant");
      i += m.length;
      continue;
    }
    // Strings (with Python's prefixes and Rust's raw strings).
    const prefix = L.prefixes ? at(L.prefixes, s, i) : null;
    const from = i + (prefix?.length ?? 0);
    const str = (L.strings ?? []).find((d) => s.startsWith(d.q, from));
    if (str) {
      const close = str.close ?? str.q;
      const [end, closed] = scanString(s, from + str.q.length, close, str.raw);
      const cls = str.cls ?? (L.keyStrings && at(/\s*:/y, s, end) ? "property" : "string");
      e.push(s.slice(i, end), cls);
      i = end;
      prevSignificant = '"';
      if (!closed && str.multi) return { string: { close, raw: str.raw, cls } };
      continue;
    }
    if (L.variables && c === "$" && (m = at(L.variables, s, i))) {
      e.push(m, "variable");
      i += m.length;
      continue;
    }
    if (L.cmdlets && (m = at(L.cmdlets, s, i))) {
      e.push(m, "function");
      i += m.length;
      prevSignificant = "a";
      continue;
    }
    if (L.params && c === "-" && /[\s(]/.test(s[i - 1] ?? " ") && (m = at(L.params, s, i))) {
      e.push(m, /^-(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|and|or|not|xor|is|isnot|as|replace|split|join|f)$/i.test(m) ? "operator" : "attribute");
      i += m.length;
      continue;
    }
    // JSX: a tag where an expression starts.
    if (L.jsx && c === "<" && (m = at(/<\/?[A-Za-z][\w.:-]*/y, s, i)) && (prevSignificant === "" || /[(,=:?&|{}>;]|return/.test(prevSignificant))) {
      e.push("<", "punctuation");
      e.push(m.slice(1), "tag");
      i += m.length;
      prevSignificant = "a";
      continue;
    }
    if (/\d/.test(c) && (m = at(NUMBER, s, i))) {
      e.push(m, "number");
      i += m.length;
      prevSignificant = "1";
      continue;
    }
    if ((m = at(IDENT, s, i))) {
      const key = L.caseInsensitive ? m.toLowerCase() : m;
      const next = at(/\s*\S/y, s, i + m.length)?.at(-1);
      let cls = null;
      if (L.macros && s[i + m.length] === "!" && s[i + m.length + 1] !== "=") cls = "function";
      else if (L.keywords?.has(key)) cls = "keyword";
      else if (L.constants?.has(key) || L.constants?.has(`$${key}`)) cls = "constant";
      else if (L.types?.has(m)) cls = "type";
      else if (prevSignificant === ".") cls = next === "(" ? "function" : "property";
      else if (next === "(") cls = L.builtins?.has(m) ? "builtin" : "function";
      else if (L.builtins?.has(m)) cls = "builtin";
      else if (/^[A-Z][A-Z\d_]+$/.test(m) && m.length > 1) cls = "constant";
      else if (L.capsTypes && /^[A-Z]/.test(m)) cls = "type";
      e.push(m, cls);
      i += m.length;
      prevSignificant = cls === "keyword" ? m : "a";
      continue;
    }
    if ((m = at(OPERATOR, s, i))) {
      e.push(m, "operator");
      i += m.length;
      prevSignificant = m;
      continue;
    }
    if ((m = at(PUNCT, s, i))) {
      e.push(m, "punctuation");
      i += m.length;
      prevSignificant = m;
      continue;
    }
    e.push(c);
    i++;
  }
  return state;
}

// YAML: comments, keys, then a scalar value (or a flow collection) after them.
function lexYaml(s, state, e) {
  if (state.block !== undefined) {
    const indent = /^\s*/.exec(s)[0].length;
    if (s.trim() && indent > state.block) return e.push(s, "string"), state;
    if (s.trim()) state = {};
    else return e.push(s), state;
  }
  if (/^(---|\.\.\.)\s*$/.test(s)) return e.push(s, "meta"), state;
  const m = /^(\s*(?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s#:"'][^#:]*?))(\s*:)(?=\s|$)/.exec(s);
  let rest = s;
  if (m) {
    e.push(m[1], "punctuation");
    e.push(m[2], "property");
    e.push(m[3], "punctuation");
    rest = s.slice(m[0].length);
  } else {
    const dash = /^\s*(?:-\s+)+/.exec(s);
    if (dash) {
      e.push(dash[0], "punctuation");
      rest = s.slice(dash[0].length);
    }
  }
  const value = rest.match(/^(\s*)(.*?)(\s+#.*|\s*)$/);
  e.push(value[1]);
  const v = value[2];
  if (/^[|>][-+]?\d*$/.test(v)) {
    e.push(v, "punctuation");
    e.push(value[3], "comment");
    return { block: /^\s*/.exec(s)[0].length };
  }
  if (/^["']/.test(v)) e.push(v, "string");
  else if (/^(true|false|yes|no|on|off|null|~)$/i.test(v)) e.push(v, "constant");
  else if (/^[-+]?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/i.test(v)) e.push(v, "number");
  else if (/^[&*][\w-]+/.test(v)) e.push(v, "variable");
  else if (v) e.push(v, "string");
  e.push(value[3], value[3].trim() ? "comment" : null);
  return state;
}

// TOML: [tables], keys, values (via the generic lexer for the value part).
const TOML_VALUES = { constants: words("true false inf nan"), strings: [{ q: '"""', multi: true }, { q: "'''", multi: true, raw: true }, { q: '"' }, { q: "'", raw: true }], line: ["#"] };
function lexToml(s, state, e) {
  if (state.string) return lexGeneric(TOML_VALUES, s, state, e);
  const table = /^(\s*)(\[\[?[^\]#]*\]\]?)/.exec(s);
  if (table) {
    e.push(table[1]);
    e.push(table[2], "tag");
    return lexGeneric(TOML_VALUES, s.slice(table[0].length), state, e);
  }
  const key = /^(\s*)([\w.-]+|"[^"]*"|'[^']*')(\s*=)/.exec(s);
  if (key) {
    e.push(key[1]);
    e.push(key[2], "property");
    e.push(key[3], "operator");
    return lexGeneric(TOML_VALUES, s.slice(key[0].length), state, e);
  }
  return lexGeneric(TOML_VALUES, s, state, e);
}

// HTML and XML: comments, tags, attributes and their values; text stays plain.
function lexMarkup(s, state, e) {
  let i = 0;
  while (i < s.length) {
    if (state.comment) {
      const end = s.indexOf("-->", i);
      if (end < 0) return e.push(s.slice(i), "comment"), state;
      e.push(s.slice(i, end + 3), "comment");
      i = end + 3;
      state = {};
      continue;
    }
    if (state.tag) {
      let m;
      if ((m = at(SPACE, s, i))) {
        e.push(m);
        i += m.length;
      } else if (s.startsWith("/>", i) || s[i] === ">") {
        const t = s[i] === ">" ? ">" : "/>";
        e.push(t, "punctuation");
        i += t.length;
        state = {};
      } else if (s[i] === '"' || s[i] === "'") {
        const end = s.indexOf(s[i], i + 1);
        const stop = end < 0 ? s.length : end + 1;
        e.push(s.slice(i, stop), "string");
        i = stop;
      } else if (s[i] === "=") {
        e.push("=", "operator");
        i++;
      } else if ((m = at(/[^\s=>/"']+/y, s, i))) {
        e.push(m, "attribute");
        i += m.length;
      } else {
        e.push(s[i]);
        i++;
      }
      continue;
    }
    if (s.startsWith("<!--", i)) {
      state = { comment: true };
      continue;
    }
    const m = at(/<[/!?]?[A-Za-z][\w:.-]*/y, s, i);
    if (m) {
      const sigil = /^<[/!?]?/.exec(m)[0];
      e.push(sigil, "punctuation");
      e.push(m.slice(sigil.length), "tag");
      i += m.length;
      state = { tag: true };
      continue;
    }
    const text = at(/[^<]+|</y, s, i);
    e.push(text);
    i += text.length;
  }
  return state;
}

// CSS: comments, at-rules, selectors, properties and values (by brace depth).
const CSS_VALUES = { strings: [{ q: '"' }, { q: "'" }], constants: words("important inherit initial unset auto none") };
function lexCss(s, state, e) {
  let depth = state.depth ?? 0;
  let i = 0;
  if (state.comment) {
    const end = s.indexOf("*/");
    if (end < 0) return e.push(s, "comment"), state;
    e.push(s.slice(0, end + 2), "comment");
    i = end + 2;
  }
  let property = depth > 0;
  while (i < s.length) {
    let m;
    if ((m = at(SPACE, s, i))) {
      e.push(m);
      i += m.length;
    } else if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) return e.push(s.slice(i), "comment"), { depth, comment: true };
      e.push(s.slice(i, end + 2), "comment");
      i = end + 2;
    } else if (s[i] === "{" || s[i] === "}") {
      depth = Math.max(0, depth + (s[i] === "{" ? 1 : -1));
      property = depth > 0;
      e.push(s[i], "punctuation");
      i++;
    } else if (s[i] === ";") {
      property = depth > 0;
      e.push(";", "punctuation");
      i++;
    } else if ((m = at(/@[\w-]+/y, s, i))) {
      e.push(m, "keyword");
      i += m.length;
    } else if (depth > 0 && property && (m = at(/[\w-]+(?=\s*:)/y, s, i))) {
      e.push(m, "property");
      i += m.length;
      property = false;
    } else if (depth > 0 && s[i] === ":") {
      e.push(":", "punctuation");
      i++;
    } else if (depth > 0 && (m = at(/#[\da-fA-F]{3,8}\b|[-+]?\d*\.?\d+(?:%|[a-zA-Z]+)?/y, s, i))) {
      e.push(m, "number");
      i += m.length;
    } else if (depth > 0 && (m = at(/!important/y, s, i))) {
      e.push(m, "keyword");
      i += m.length;
    } else if (depth > 0 && (m = at(/[\w-]+(?=\()/y, s, i))) {
      e.push(m, "function");
      i += m.length;
    } else if (depth > 0 && (s[i] === '"' || s[i] === "'")) {
      const [end] = scanString(s, i + 1, s[i], false);
      e.push(s.slice(i, end), "string");
      i = end;
    } else if (depth > 0 && (m = at(/[\w-]+/y, s, i))) {
      e.push(m, CSS_VALUES.constants.has(m) ? "constant" : null);
      i += m.length;
    } else if (depth === 0 && (m = at(/[.#]?[\w-]+|::?[\w-]+|\*|[>+~,]/y, s, i))) {
      e.push(m, /^[>+~,]$/.test(m) ? "operator" : /^:/.test(m) ? "keyword" : "tag");
      i += m.length;
    } else {
      e.push(s[i]);
      i++;
    }
  }
  return depth ? { depth } : {};
}

function lexDiff(s, state, e) {
  if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(s)) e.push(s, "meta");
  else if (s.startsWith("@@")) e.push(s, "meta");
  else if (s.startsWith("+")) e.push(s, "inserted");
  else if (s.startsWith("-")) e.push(s, "deleted");
  else e.push(s);
  return state;
}

const MODES = { yaml: lexYaml, toml: lexToml, markup: lexMarkup, css: lexCss, diff: lexDiff };

/**
 * Tokens for each line of `lines` in `lang`, with the state carried from line
 * to line (and out, for the next chunk of a streaming block). Past the caps,
 * or for an unknown language, every line is one plain token.
 */
export function highlightLines(lang, lines, state = {}) {
  const L = LANGS[lang];
  if (!L || lines.length > MAX_LINES) return { lines: lines.map((l) => [{ text: l, cls: null }]), state, plain: true };
  const lex = L.mode ? MODES[L.mode] : (s, st, e) => lexGeneric(L, s, st, e);
  const out = [];
  for (const line of lines) {
    if (line.length > MAX_LINE) {
      out.push([{ text: line, cls: null }]);
      continue;
    }
    const e = emitter();
    state = lex(line, state, e) ?? {};
    out.push(e.out.length ? e.out : []);
  }
  return { lines: out, state, plain: false };
}
