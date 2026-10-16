// Syntax highlighting (tui/view/highlight.mjs, terminal UI plan Part 9, P7):
// token streams per language, state across lines (and across the chunks of a
// streaming block), the caps, hostile input staying linear, the speed budget,
// and a style-aware golden per theme (AD_UPDATE_GOLDEN=1 rewrites them).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "../testkit/golden.mjs";
import { highlightLines, languageFor, MAX_CHARS, MAX_LINE, MAX_LINES, setSyntaxTheme, styleFor, SYNTAX_THEMES, syntaxTheme, withSyntaxTheme } from "../src/tui/view/highlight.mjs";
import { codeTokenLines, createMarkdownStream, renderMarkdown } from "../src/tui/view/markdown.mjs";
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

const LANGUAGES = ["javascript", "python", "rust", "go", "c", "cpp", "java", "csharp", "json", "jsonc", "yaml", "toml", "shell", "console", "powershell", "html", "css", "sql", "diff"];

test("hostile input stays linear, at full size (every line MAX_LINE long, MAX_CHARS in all)", () => {
  // Patterns that make a backtracking regex, or a rescan per character, quadratic.
  const units = ['"\\', "/*", "<", "a.", " ", "- ", "'", "$", "#", "${", "/[", "(/", "a ", "a{", "<a ", "'''", "'a", "--", "<<", "a#", "a:", '"#', "`", "1", "#a"];
  const lines = [" ".repeat(MAX_LINE - 1) + ":"];
  // Up to the cap, so it is lexed.
  for (let k = 0; lines.length < MAX_CHARS / MAX_LINE; k++) {
    const u = units[k % units.length];
    lines.push(u.repeat(Math.floor(MAX_LINE / u.length)));
  }
  const budget = process.env.CI ? 6000 : 1500;
  for (const lang of LANGUAGES) {
    const t0 = performance.now();
    const r = highlightLines(lang, lines);
    const ms = performance.now() - t0;
    assert.equal(r.plain, false, `${lang}: lexed, not left plain`);
    assert.ok(ms < budget, `${lang}: ${ms.toFixed(0)} ms on ${MAX_CHARS} hostile characters`);
  }
  // Long runs of spaces inside lines: the quadratic case for a backtracking
  // regex (YAML's took a second on these 100 lines; linear takes a few ms).
  const runs = ["a: b", "a", "- a", "#", "x = 1", '"a', "k: 'v"].map((p) => p + " ".repeat(MAX_LINE - p.length - 1) + "z");
  const spaced = Array.from({ length: MAX_CHARS / MAX_LINE }, (_, k) => runs[k % runs.length]);
  for (const lang of LANGUAGES) {
    const t0 = performance.now();
    highlightLines(lang, spaced);
    const ms = performance.now() - t0;
    assert.ok(ms < budget / 6, `${lang}: ${ms.toFixed(0)} ms on lines with long runs of spaces`);
  }
  // Over the cap: plain at once.
  assert.equal(highlightLines("javascript", [...lines, "x".repeat(MAX_LINE)]).plain, true);
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

test("themes: ad ships ansi and the engine's two adaptive defaults; another name falls back to ansi", () => {
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

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const spanIs = (line, text, cls) => line?.some((s) => s.text === text && same(s.style, styleFor(cls)));

test("YAML: comment lines, a quoted value with a # in it, U+2028, a colon in a value", () => {
  assert.deepEqual(toks("yaml", '# a comment\n  # indented one\nkey: "a #b" # real\nurl: http://x\n- item # c'), [
    "[comment:# a comment]",
    "[comment:  # indented one]",
    '[property:key][punctuation::] [string:"a #b"][comment: # real]',
    "[property:url][punctuation::] [string:http://x]",
    "[punctuation:- ][string:item][comment: # c]",
  ]);
  // U+2028 and U+2029 are whitespace to the lexer (once a crash in every .yml diff).
  assert.deepEqual(toks("yaml", "b: \u{2028}x\u{2029}"), ["[property:b][punctuation::] \u{2028}[string:x]\u{2029}"]);
  for (const lang of LANGUAGES) {
    const line = "a: b\u{2028}c # d\u{2029}e";
    assert.equal(highlightLines(lang, [line]).lines[0].map((t) => t.text).join(""), line, lang);
  }
});

test("shell: an apostrophe inside a word, here-documents (not here-strings), console sessions", () => {
  assert.deepEqual(toks("shell", "echo don't stop\nls"), ["[builtin:echo] don't stop", "[builtin:ls]"]);
  const heredoc = toks("shell", "cat <<'EOF' > out\nit's $HOME\n\tEOF\necho ok");
  assert.deepEqual(heredoc.slice(1), ["[string:it's $HOME]", "[constant:\tEOF]", "[builtin:echo] ok"]);
  assert.deepEqual(toks("shell", "cat <<<'x'\necho ok").at(-1), "[builtin:echo] ok", "<<< is a here-string");
  assert.deepEqual(toks("shell", "# cat <<EOF\necho ok").at(-1), "[builtin:echo] ok", "not in a comment");
  assert.deepEqual(toks("console", "$ git status\nYour branch isn't up to date.\n$ echo 'hi'"), [
    "[punctuation:$ ]git status",
    "Your branch isn't up to date.",
    "[punctuation:$ ][builtin:echo] [string:'hi']",
  ]);
  assert.equal(languageFor("console"), "console");
});

test("JavaScript: regex literals (a backtick in one opens no template string); division stays division", () => {
  assert.deepEqual(toks("javascript", "const re = /`[/]/g;\nlet x = a / b / 2;\nreturn <Foo />;"), [
    "[keyword:const] re [operator:=] [string:/`[/]/g][punctuation:;]",
    "[keyword:let] x [operator:=] a [operator:/] b [operator:/] [number:2][punctuation:;]",
    "[keyword:return] [punctuation:<][tag:Foo] [operator:/>][punctuation:;]",
  ]);
});

test("jsonc/json5 have comments; a .h header is C++; a fence's language is its info's first word", () => {
  assert.equal(languageFor("tsconfig.jsonc"), "jsonc");
  assert.equal(languageFor("json5"), "jsonc");
  assert.deepEqual(toks("jsonc", '{ "a": 1 // c\n}'), ['[punctuation:{] [property:"a"][operator::] [number:1] [comment:// c]', "[punctuation:}]"]);
  assert.equal(languageFor("include/app.h"), "cpp");
  for (const info of ["ts {1,3}", "ts,linenos", "{ts}", "{.ts}", "ts:src/app.ts"]) {
    const lines = renderMarkdown(`\`\`\`${info}\nconst x = 1;\n\`\`\``, { width: 40 });
    assert.ok(lines.some((l) => spanIs(l, "const", "keyword")), info);
  }
});

test("a diff's unchanged lines are lexed as the new file reads them, each hunk afresh", () => {
  const row = (diff, text) => renderDiff([{ path: "a.c", kind: "update", diff }], { width: 80 }).find((l) => l.map((s) => s.text).join("").includes(text));
  // A comment opened in an added line goes on in the unchanged lines after it...
  const inside = row("@@ -1,1 +1,2 @@\n+/* added\n inside */ int y;", "inside");
  assert.ok(inside.some((s) => s.text.startsWith("inside") && same(s.style, styleFor("comment"))), JSON.stringify(inside));
  // ...one opened in a removed line doesn't...
  const still = row("@@ -1,2 +1,1 @@\n-/* removed\n still */ int y;", "still");
  assert.ok(spanIs(still, "int", "keyword"), JSON.stringify(still));
  // ...and the next hunk starts afresh.
  const next = row("@@ -1,1 +1,2 @@\n ctx0\n+/* open\n@@ -20,1 +21,1 @@\n int z;", "int z");
  assert.ok(spanIs(next, "int", "keyword"), JSON.stringify(next));
});

test("the live line of a streaming fence goes on from its committed lines' state", () => {
  const md = createMarkdownStream({ width: 60 });
  md.push("```c\n/* a long\n");
  md.push("comment */ int x;");
  const live = md.live();
  const line = live.find((l) => l.some((s) => s.text.includes("comment */")));
  assert.ok(line.some((s) => s.text.includes("comment */") && same(s.style, styleFor("comment"))), JSON.stringify(live));
  assert.ok(spanIs(line, "int", "keyword"));
});

test("a grapheme split across tokens (a keycap's digit and its marks) is measured whole", () => {
  const out = codeTokenLines([{ text: "a", cls: null }, { text: "1", cls: "number" }, { text: "\u{fe0f}\u{20e3}", cls: null }], 2);
  assert.deepEqual(out.map((l) => l.map((s) => s.text).join("")), ["a", "1\u{fe0f}\u{20e3}"]);
});

test("withSyntaxTheme: a preview drawn in another theme leaves the current one alone", () => {
  const lines = withSyntaxTheme("catppuccin-mocha", () => renderMarkdown("```rust\nfn x() {}\n```", { width: 40 }));
  assert.ok(lines.some((l) => l.some((s) => s.text === "fn" && s.style?.fg === "#cba6f7")));
  assert.equal(syntaxTheme(), "ansi");
  assert.ok(renderMarkdown("```rust\nfn x() {}\n```", { width: 40 }).some((l) => spanIs(l, "fn", "keyword")));
});
