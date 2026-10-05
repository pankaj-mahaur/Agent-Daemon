// Markdown rendering and streaming (tui/view/markdown.mjs), plan Part 5b.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarkdownStream, createPacer, inline, parseBlocks, renderMarkdown } from "../src/tui/view/markdown.mjs";
import { lineWidth, renderLine } from "../src/tui/terminal/text.mjs";

const text = (lines) => lines.map((l) => l.map((s) => s.text).join("")).join("\n");
const styleOf = (spans, t) => spans.find((s) => s.text === t)?.style;

test("blocks: headings, paragraphs, lists, quotes, fences, tables, rules", () => {
  const types = parseBlocks(
    ["# H", "para", "line", "", "- a", "- b", "", "> q", "", "```", "x", "```", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "***", "Setext", "==="],
  ).map((b) => b.type);
  assert.deepEqual(types, ["heading", "paragraph", "list", "quote", "code", "table", "rule", "heading"]);
});

test("paragraph text: soft breaks become spaces, two trailing spaces a hard break", () => {
  assert.equal(text(renderMarkdown("a\nb  \nc", { width: 40 })), "a b\nc");
  assert.equal(text(renderMarkdown("a\\\nb", { width: 40 })), "a\nb");
});

test("inline: bold, italic, code, strike, escapes, intraword underscores", () => {
  const spans = inline("**b** *i* `c` ~~s~~ \\*not\\* snake_case_name ***bi***");
  assert.deepEqual(styleOf(spans, "b"), { bold: true });
  assert.deepEqual(styleOf(spans, "i"), { italic: true });
  assert.deepEqual(styleOf(spans, "c"), { fg: "cyan" });
  assert.deepEqual(styleOf(spans, "s"), { strike: true });
  assert.deepEqual(styleOf(spans, "bi"), { bold: true, italic: true });
  assert.match(spans.map((s) => s.text).join(""), /\*not\* snake_case_name/);
  // Emphasis never closes inside a code span; an unclosed marker stays literal.
  assert.equal(inline("*a `b*` c").map((s) => s.text).join(""), "*a b* c");
  assert.equal(inline("2 * 3 * 4").map((s) => s.text).join(""), "2 * 3 * 4");
});

test("links show their URL when the text differs, so a link can't pose as another", () => {
  const spans = inline("[docs](https://evil.example/x) and [https://a.b](https://a.b) <https://c.d> https://e.f/g.");
  const all = spans.map((s) => s.text).join("");
  assert.equal(all, "docs (https://evil.example/x) and https://a.b https://c.d https://e.f/g.");
  assert.equal(styleOf(spans, "docs").link, "https://evil.example/x");
  assert.equal(styleOf(spans, "https://e.f/g").link, "https://e.f/g");
  // OSC 8 only for safe schemes, and only when enabled.
  const js = inline("[x](javascript:alert(1))");
  assert.equal(renderLine(js, 0, { hyperlinks: true }).includes("\x1b]8"), false);
  assert.ok(renderLine(spans, 0, { hyperlinks: true }).includes("\x1b]8;;https://evil.example/x\x1b\\"));
  assert.equal(renderLine(spans, 0).includes("\x1b]8"), false);
});

test("untrusted escapes in model output never reach the lines", () => {
  const out = text(renderMarkdown("hi \x1b]8;;https://x\x07there\x1b[2J\n\n```\n\x1b[31mred\n```", { width: 40 }));
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(out), JSON.stringify(out));
  assert.match(out, /hi there/);
});

test("lists: nesting, ordered start, hanging indent, lazy continuation", () => {
  const out = text(renderMarkdown("3. three\n4. four is a long item that wraps around\n   - sub\nlazy", { width: 24 }));
  assert.equal(out, "3. three\n4. four is a long item\n   that wraps around\n   \u{25e6} sub lazy");
  assert.equal(text(renderMarkdown("- a\n\n- b", { width: 20 })), "\u{2022} a\n\u{2022} b");
});

test("code blocks keep spaces, hard-wrap, and don't parse markdown", () => {
  const out = text(renderMarkdown("```py\n  if x:  # **no**\n\treturn 1\n```", { width: 14 }));
  assert.equal(out, "      if x:  #\n     **no**\n        return\n     1");
});

test("tables: alignment, shrink to fit, and a key/value fallback when too narrow", () => {
  const md = "| L | R | C |\n|:--|--:|:-:|\n| a | 1 | x |\n| bbb | 22 | yy |";
  assert.equal(text(renderMarkdown(md, { width: 40 })), "L   \u{2502}  R \u{2502} C\n\u{2500}\u{2500}\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\u{2500}\na   \u{2502}  1 \u{2502} x\nbbb \u{2502} 22 \u{2502} yy");
  const wide = "| a | b |\n|---|---|\n| " + "x".repeat(30) + " | " + "y".repeat(30) + " |";
  for (const l of renderMarkdown(wide, { width: 30 })) assert.ok(lineWidth(l) <= 30);
  assert.match(text(renderMarkdown(wide, { width: 30 })), /\u{2026}/u);
  const narrow = text(renderMarkdown("| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |", { width: 12 }));
  assert.equal(narrow, "a: 1\nb: 2\nc: 3\nd: 4");
});

test("every line fits the width (lists, quotes, code, tables)", () => {
  const md = "# A very long heading that must wrap somewhere\n\n> - quoted list item with a lot of words in it\n>   ```\n>   code inside\n>   ```\n\n" +
    "- " + "word ".repeat(30) + "\n\n```\n" + "z".repeat(100) + "\n```\n\n| a | b |\n|---|---|\n| " + "q ".repeat(40) + " | r |";
  for (const w of [10, 20, 40, 80]) for (const l of renderMarkdown(md, { width: w })) assert.ok(lineWidth(l) <= w, `${w}: ${JSON.stringify(l)}`);
});

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

function streamed(md, chunks, width) {
  const s = createMarkdownStream({ width });
  const out = [];
  let i = 0;
  for (const n of chunks) {
    out.push(...s.push(md.slice(i, i + n)));
    i += n;
  }
  out.push(...s.push(md.slice(i)));
  out.push(...s.finish());
  return out;
}

const PIECES = [
  "# Heading", "## Sub *it*", "plain words and **bold** text", "more `code` here", "",
  "- item", "- item with [a link](https://x.y)", "  - nested", "  continued", "1. one", "2. two",
  "> quote", "> > deeper", "```", "```js", "let a = 1;", "~~~", "| a | b |", "|---|:-:|", "| 1 | 2 |",
  "---", "===", "***", "Setext", "text  ", "\\- not a list", "<https://q.r>", "    indented", "", "",
];

test("property: a chunked stream renders exactly like the full text", () => {
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let trial = 0; trial < 400; trial++) {
    const lines = [];
    for (let k = 1 + rand(14); k > 0; k--) lines.push(PIECES[rand(PIECES.length)]);
    const md = lines.join("\n") + (rand(2) ? "\n" : "");
    const width = 12 + rand(60);
    const chunks = [];
    for (let left = md.length; left > 0; ) {
      const n = 1 + rand(9);
      chunks.push(n);
      left -= n;
    }
    const full = text(renderMarkdown(md, { width }));
    assert.equal(text(streamed(md, chunks, width)), full, `trial ${trial} @${width}: ${JSON.stringify(md)}`);
  }
});

test("streaming commits finished blocks early and holds back what may still change", () => {
  const s = createMarkdownStream({ width: 40 });
  assert.deepEqual(s.push("First para"), [], "no newline yet");
  assert.equal(text(s.live()), "First para");
  assert.deepEqual(s.push("graph.\n"), [], "a paragraph's last line may become a heading");
  assert.equal(text(s.push("\nSecond\n")), "First paragraph.");
  assert.equal(text(s.push("===\n")), "\nSecond", "the setext heading is final at once");
  // A table holds back until it ends, but shows while streaming.
  assert.deepEqual(s.push("| a | b |\n|---|---|\n| 1 | 2 |\n"), []);
  assert.match(text(s.live()), /1 \u{2502} 2/u);
  assert.equal(text(s.push("\nafter\n")), "\na \u{2502} b\n\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\n1 \u{2502} 2");
  // An open fence commits its finished lines as they arrive.
  s.push("\n");
  const fenceStart = s.push("```\nline 1\n");
  assert.equal(text(fenceStart), "\nafter\n\n    line 1");
  assert.equal(text(s.push("line 2\n")), "    line 2");
  assert.deepEqual(s.push("```\n"), []);
  assert.deepEqual(s.finish(), []);
  assert.deepEqual(s.finish(), [], "finish twice is harmless");
});

test("an ATX heading or rule commits as soon as its line is complete", () => {
  const s = createMarkdownStream({ width: 30 });
  assert.equal(text(s.push("# Title\n")), "Title");
  assert.equal(text(s.push("---\n")), "\n" + "\u{2500}".repeat(30));
});

test("pacer: one line per tick; a backlog of 8 or a 120 ms wait goes at once", () => {
  let t = 0;
  const p = createPacer({ now: () => t });
  p.push([["a"], ["b"], ["c"]]);
  assert.deepEqual(p.tick(), [["a"]]);
  assert.deepEqual(p.tick(), [["b"]]);
  t = 200;
  p.push([["d"]]);
  assert.deepEqual(p.tick(), [["c"], ["d"]], "the oldest waited 200 ms");
  p.push(Array.from({ length: 8 }, (_, i) => [String(i)]));
  assert.equal(p.tick().length, 8);
  p.push([["x"]]);
  assert.deepEqual(p.flush(), [["x"]]);
  assert.equal(p.size, 0);
});

test("property: committed lines plus live() always show exactly the text received so far", () => {
  let seed = 9;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let trial = 0; trial < 200; trial++) {
    const lines = [];
    for (let k = 1 + rand(10); k > 0; k--) lines.push(PIECES[rand(PIECES.length)]);
    const md = lines.join("\n");
    const width = 12 + rand(50);
    const s = createMarkdownStream({ width });
    const committed = [];
    for (let i = 0; i < md.length; ) {
      const n = 1 + rand(7);
      committed.push(...s.push(md.slice(i, i + n)));
      i += n;
      assert.equal(text([...committed, ...s.live()]), text(renderMarkdown(md.slice(0, i), { width })), `trial ${trial}: ${JSON.stringify(md.slice(0, i))}`);
    }
  }
});

const SAMPLE = `# Fixing the flaky login test

The test used **fake timers**, so \`refresh()\` never ran. See [the docs](https://vitest.dev/api/vi.html) or https://vitest.dev.

1. Switch to real timers
2. Add a retry
   - only around the refresh call
   - keep the timeout at *5s*

> Note: the signup test has the same pattern.

\`\`\`ts
it("logs in", async () => {
  vi.useRealTimers();
  await login();
});
\`\`\`

| Test | Before | After |
|:-----|:------:|------:|
| login | flaky | green |
| signup | flaky | green |

---
Done.`;

for (const width of [40, 80, 120]) {
  test(`markdown golden at width ${width}`, async () => {
    const { assertGolden } = await import("../testkit/golden.mjs");
    assertGolden(`tui/markdown-${width}.txt`, text(renderMarkdown(SAMPLE, { width })));
  });
}
