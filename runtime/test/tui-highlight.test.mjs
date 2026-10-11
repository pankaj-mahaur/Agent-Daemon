// Syntax highlighting (tui/view/highlight.mjs, codex-parity-2 Part 9, P7):
// token streams per language, state across lines (and across the chunks of a
// streaming block), the caps, hostile input staying linear, the speed budget,
// and a style-aware golden per theme (AD_UPDATE_GOLDEN=1 rewrites them).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "../testkit/golden.mjs";
import { highlightLines, languageFor, MAX_LINE, MAX_LINES, setSyntaxTheme, styleFor, SYNTAX_THEMES, syntaxTheme } from "../src/tui/view/highlight.mjs";
import { createMarkdownStream, renderMarkdown } from "../src/tui/view/markdown.mjs";
import { renderDiff } from "../src/tui/view/cells.mjs";

// "[cls:text]" per classed token, plain text as is.
const toks = (lang, src, state) => highlightLines(lang, src.split("\n"), state).lines.map((l) => l.map((t) => (t.cls ? `[${t.cls}:${t.text}]` : t.text)).join(""));
const classesOf = (lang, src) => {
  const out = {};
  for (const l of highlightLines(lang, src.split("\n")).lines) for (const t of l) if (t.cls) (out[t.cls] ??= []).push(t.text.trim());
  return out;
};

test("languageFor: fence info strings and file paths", () => {
  assert.equal(languageFor("ts"), "javascript");
  assert.equal(languageFor("TSX"), "javascript");
  assert.equal(languageFor("python3"), "python");
  assert.equal(languageFor("src/app.mjs"), "javascript");
  assert.equal(languageFor("C:\\work\\app\\main.rs"), "rust");
  assert.equal(languageFor("deploy.yml"), "yaml");
  assert.equal(languageFor("Cargo.toml"), "toml");
  assert.equal(languageFor("build.ps1"), "powershell");
  assert.equal(languageFor("x.patch"), "diff");
  assert.equal(languageFor(""), null);
  assert.equal(languageFor("brainfuck"), null);
  assert.equal(languageFor("Dockerfile"), null);
});

const CASES = {
  javascript: ["const x = await fetch(`a ${b}`); // hi", { keyword: ["const", "await"], function: ["fetch"], string: ["`a ${b}`"], comment: ["// hi"] }],
  python: ['def f(a: int) -> str:\n    return f"{a}"  # c', { keyword: ["def", "return"], function: ["f"], builtin: ["int", "str"], string: ['f"{a}"'], comment: ["# c"] }],
  rust: ["fn main<'a>(x: &'a str) { let c = 'z'; println!(\"hi\"); }", { keyword: ["fn", "let"], constant: ["'a", "'a"], string: ["'z'", '"hi"'], function: ["println"], type: ["str"] }],
  go: ['func main() { fmt.Println("hi", nil) }', { keyword: ["func"], function: ["main", "Println"], string: ['"hi"'], constant: ["nil"] }],
  c: ["#include <stdio.h>\nint main(void) { return 0; }", { attribute: ["#include"], string: ["<stdio.h>"], keyword: ["int", "void", "return"], number: ["0"] }],
  cpp: ["template <typename T> class Box { public: T v; };", { keyword: ["template", "typename", "class", "public"] }],
  java: ['@Override public String name() { return "x"; }', { attribute: ["@Override"], keyword: ["public", "return"], type: ["String"], string: ['"x"'] }],
  csharp: ['public async Task<int> Run() { var x = await Get(); }', { keyword: ["public", "async", "var", "await"], type: ["Task"] }],
  json: ['{"key": [1, true, null, "v"]}', { property: ['"key"'], number: ["1"], constant: ["true", "null"], string: ['"v"'] }],
  yaml: ["name: ad # c\nlist:\n  - x: 1\n    y: true", { property: ["name", "list", "x", "y"], number: ["1"], constant: ["true"], comment: ["# c"] }],
  toml: ['[tool.ad]\nname = "ad" # c\nn = 3', { tag: ["[tool.ad]"], property: ["name", "n"], string: ['"ad"'], number: ["3"], comment: ["# c"] }],
  shell: ['echo "$HOME" # comment\nif [ -f x ]; then ls; fi', { builtin: ["echo", "ls"], string: ['"$HOME"'], comment: ["# comment"], keyword: ["if", "then", "fi"] }],
  powershell: ["$x = Get-ChildItem -Path . # c\nif ($x -eq $null) { }", { variable: ["$x", "$x"], function: ["Get-ChildItem"], attribute: ["-Path"], operator: ["-eq"], comment: ["# c"] }],
  html: ['<div class="a"><!-- c --></div>', { tag: ["div", "div"], attribute: ["class"], string: ['"a"'], comment: ["<!-- c -->"] }],
  css: [".a > b { color: #fff; margin: 0 4px !important; }", { tag: [".a", "b"], property: ["color", "margin"], number: ["#fff", "0", "4px"], keyword: ["!important"] }],
  sql: ["SELECT name FROM users WHERE id = 1 -- c", { keyword: ["SELECT", "FROM", "WHERE"], number: ["1"], comment: ["-- c"] }],
  diff: ["@@ -1 +1 @@\n-old\n+new\n ctx", { meta: ["@@ -1 +1 @@"], deleted: ["-old"], inserted: ["+new"] }],
};

test("every language: its keywords, strings, numbers, comments and names in the right classes", () => {
  for (const [lang, [src, want]] of Object.entries(CASES)) {
    const got = classesOf(lang, src);
    for (const [cls, texts] of Object.entries(want)) for (const t of texts) assert.ok(got[cls]?.includes(t), `${lang}: "${t}" should be ${cls}; got ${JSON.stringify(got)}`);
  }
});

test("state across lines: block comments, multi-line strings, an open tag, YAML block scalars", () => {
  assert.deepEqual(toks("c", "a /* one\ntwo */ b"), ["a [comment:/* one]", "[comment:two */] b"]);
  assert.deepEqual(toks("python", 's = """one\ntwo""" + x'), ["s [operator:=] [string:\"\"\"one]", "[string:two\"\"\"] [operator:+] x"]);
  assert.deepEqual(toks("javascript", "const t = `a\nb` + 1"), ["[keyword:const] t [operator:=] [string:`a]", "[string:b`] [operator:+] [number:1]"]);
  assert.deepEqual(toks("html", '<a\n  href="x">y'), ["[punctuation:<][tag:a]", '  [attribute:href][operator:=][string:"x"][punctuation:>]y']);
  assert.deepEqual(toks("yaml", "run: |\n  echo hi\n  # not a comment\nnext: 1"), ["[property:run][punctuation::] [punctuation:|]", "[string:  echo hi]", "[string:  # not a comment]", "[property:next][punctuation::] [number:1]"]);
  assert.deepEqual(toks("css", "/* a\nb */ .x { }"), ["[comment:/* a]", "[comment:b */] [tag:.x] [punctuation:{] [punctuation:}]"]);
  // The state goes out, for the next chunk of a streaming block.
  const first = highlightLines("c", ["/* open"]);
  assert.deepEqual(toks("c", "still */ x", first.state), ["[comment:still */] x"]);
});

test("a streaming fence keeps its state between the chunks it commits in", () => {
  const md = createMarkdownStream({ width: 60 });
  const shown = [];
  for (const piece of ["```c\n/* a long\n", "comment */ int x;\n", "```\n"]) shown.push(...md.push(piece));
  shown.push(...md.finish());
  const line = shown.find((l) => l.some((s) => s.text.includes("comment */")));
  const comment = styleFor("comment");
  assert.ok(line.some((s) => s.text.includes("comment */") && JSON.stringify(s.style) === JSON.stringify(comment)), JSON.stringify(line));
  assert.ok(line.some((s) => s.text === "int" && JSON.stringify(s.style) === JSON.stringify(styleFor("keyword"))), "the code after the comment is code again");
});

test("caps: a block over MAX_LINES or a line over MAX_LINE stays plain; an unknown language too", () => {
  const big = highlightLines("javascript", Array.from({ length: MAX_LINES + 1 }, () => "const a = 1;"));
  assert.equal(big.plain, true);
  const long = highlightLines("javascript", [`const s = "${"x".repeat(MAX_LINE)}"`, "let b = 2"]);
  assert.deepEqual(long.lines[0], [{ text: `const s = "${"x".repeat(MAX_LINE)}"`, cls: null }]);
  assert.equal(long.lines[1][0].cls, "keyword");
  assert.equal(highlightLines("cobol", ["MOVE 1 TO X"]).plain, true);
});

test("hostile input stays fast (no regex backtracking blow-up)", () => {
  const hostile = [
    "\"\\".repeat(MAX_LINE / 2),
    "/*".repeat(MAX_LINE / 2),
    "<".repeat(MAX_LINE),
    "a.".repeat(MAX_LINE / 2),
    " ".repeat(MAX_LINE - 1) + ":",
    "- ".repeat(MAX_LINE / 2),
    "'".repeat(MAX_LINE),
    "$".repeat(MAX_LINE),
  ];
  for (const lang of ["javascript", "python", "rust", "yaml", "toml", "html", "css", "shell", "powershell", "sql", "json", "c"]) {
    const t0 = performance.now();
    highlightLines(lang, hostile);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${lang}: ${ms.toFixed(0)} ms on hostile lines`);
  }
});

test("speed: a 1,000-line block highlights in under 20 ms here (CI: 10x)", () => {
  const src = [
    "import { readFileSync } from \"node:fs\";",
    "// read the config and count its entries",
    "export function count(path, { strict = false } = {}) {",
    "  const text = readFileSync(path, \"utf8\");",
    "  return text.split(\"\\n\").filter((l) => l && !l.startsWith(\"#\")).length + 0x10;",
    "}",
  ];
  const lines = Array.from({ length: 1000 }, (_, i) => src[i % src.length]);
  highlightLines("javascript", lines); // warm up
  const runs = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    highlightLines("javascript", lines);
    runs.push(performance.now() - t0);
  }
  const best = Math.min(...runs);
  const budget = process.env.CI ? 200 : 20;
  assert.ok(best < budget, `best of 5: ${best.toFixed(1)} ms (budget ${budget} ms)`);
});

test("themes: ad ships ansi and Codex's two adaptive defaults; another name falls back to ansi", () => {
  assert.deepEqual(SYNTAX_THEMES, ["ansi", "catppuccin-mocha", "catppuccin-latte"]);
  try {
    assert.deepEqual(setSyntaxTheme("catppuccin-latte"), { theme: "catppuccin-latte", known: true });
    assert.equal(styleFor("keyword").fg, "#8839ef");
    assert.deepEqual(setSyntaxTheme("dracula"), { theme: "ansi", known: false });
    assert.equal(syntaxTheme(), "ansi");
    assert.deepEqual(setSyntaxTheme(undefined), { theme: "ansi", known: true }, "unset is ansi");
    // Every theme styles every class ansi styles (none left in the terminal's default by accident).
    const classes = ["keyword", "string", "number", "comment", "function", "type", "constant", "property", "tag", "attribute", "variable", "builtin", "inserted", "deleted", "meta"];
    for (const name of SYNTAX_THEMES) for (const cls of classes) assert.ok(styleFor(cls, name)?.fg, `${name}.${cls}`);
  } finally {
    setSyntaxTheme("ansi");
  }
});

// The golden per theme: what a code block and a diff look like, with every span's style.
const styled = (lines) =>
  lines
    .map((l) =>
      l
        .map((s) => {
          const st = Object.entries(s.style ?? {}).filter(([k, v]) => v !== undefined && v !== false && k !== "link").sort(([a], [b]) => a.localeCompare(b));
          return st.length ? `\u{27e6}${st.map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(",")}\u{27e7}${s.text}` : s.text;
        })
        .join("")
        .replace(/ +$/, ""),
    )
    .join("\n");
const SAMPLE = [
  "```ts",
  "// count the entries",
  "export async function count(path: string): Promise<number> {",
  "  const text = await read(path, `utf8`);",
  "  return text.split(\"\\n\").length + 0x10; /* done */",
  "}",
  "```",
  "",
  "```python",
  "@cache",
  "def greet(name: str) -> str:",
  "    return f\"Hello, {name}!\"  # say hi",
  "```",
  "",
  "```yaml",
  "on:",
  "  push: { branches: [main] }",
  "env: { CI: true }",
  "```",
].join("\n");
const DIFF = [{ path: "src/greet.rs", kind: "update", diff: ["@@ -12,3 +12,3 @@", " fn greet(name: &str) -> String {", '-    format!("Hello, {}!", name)', '+    format!("Hello, {name}!")', " }"].join("\n") }];

test("golden per theme: code blocks and a diff, with every span's style", () => {
  try {
    for (const name of SYNTAX_THEMES) {
      setSyntaxTheme(name);
      assertGolden(`tui/syntax-${name}.txt`, `${styled(renderMarkdown(SAMPLE, { width: 80 }))}\n\n${styled(renderDiff(DIFF, { width: 80 }))}`);
    }
  } finally {
    setSyntaxTheme("ansi");
  }
});
