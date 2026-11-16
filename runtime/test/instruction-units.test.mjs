// L4b: the instructions in an agent instruction file, as units (one list item or one
// paragraph each), with ad's own blocks, front matter, code, comments, tables and
// headings left out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { instructionUnits, plainText } from "../src/memory/instruction-units.mjs";

const texts = (r) => r.units.map((u) => u.text);

test("list items and paragraphs are units; headings name them; code, tables and comments aren't units", () => {
  const md = [
    "# Project rules",
    "",
    "This service is a REST API for the sample shop.",
    "It runs on Node 22.",
    "",
    "## Testing",
    "- Run `npm test` before every commit",
    "- Use **vitest**, not jest",
    "  because the config is shared",
    "* [x] Keep fixtures small and generic",
    "1. Prefer [the docs](https://example.test/docs) over guessing",
    "- Commands:",
    "  - `npm run lint`",
    "- [Contributing](CONTRIBUTING.md)",
    "",
    "```sh",
    "- not a rule inside a fence",
    "```",
    "",
    "| column | value |",
    "|---|---|",
    "| not | a rule |",
    "",
    "<!-- a comment",
    "- not a rule inside a comment -->",
    "",
    "Style",
    "-----",
    "> Quoted lines are a paragraph too.",
    "",
    "ok",
  ].join("\n");
  const r = instructionUnits(md);
  assert.deepEqual(texts(r), [
    "This service is a REST API for the sample shop. It runs on Node 22.",
    "Run `npm test` before every commit",
    "Use vitest, not jest because the config is shared",
    "Keep fixtures small and generic",
    "Prefer the docs over guessing",
    "Quoted lines are a paragraph too.",
  ]);
  assert.deepEqual(r.units.map((u) => u.heading), ["Project rules", "Testing", "Testing", "Testing", "Testing", "Style"]);
  assert.deepEqual(r.units.map((u) => u.kind), ["paragraph", "item", "item", "item", "item", "paragraph"]);
  assert.equal(r.scope, null);
});

test("ad's blocks, CRLF, a BOM and an open comment are handled", () => {
  const md = "\u{FEFF}# Rules\r\n- user rule one\r\n<!-- agent-daemon:start -->\r\n- AD-ONLY ad init text\r\n<!-- agent-daemon:end -->\r\n<!-- agent-daemon:learnings:start -->\r\n- **correction**: AD-ONLY mirror text\r\n<!-- agent-daemon:learnings:end -->\r\n- user rule two\r\n<!-- an open comment\r\n- AD-ONLY hidden by the open comment\r\n";
  const r = instructionUnits(md);
  assert.deepEqual(texts(r), ["user rule one", "user rule two"]);
  // A block ad never closed hides the rest of the file.
  assert.deepEqual(texts(instructionUnits("- user rule one\n<!-- agent-daemon:learnings:start -->\n- AD-ONLY tail rule\n")), ["user rule one"]);
});

test("front matter gives the scope (Cursor globs and alwaysApply, Copilot applyTo) and is no unit", () => {
  const mdc = ["---", "description: React components", 'globs: "src/**/*.tsx, src/**/*.jsx"', "alwaysApply: false", "---", "- Use function components with hooks"].join("\n");
  const r = instructionUnits(mdc);
  assert.deepEqual(texts(r), ["Use function components with hooks"]);
  assert.deepEqual(r.scope, { globs: ["src/**/*.tsx", "src/**/*.jsx"], alwaysApply: false });
  const copilot = ["---", "applyTo: '**/*.py'", "---", "Use type hints on every public function."].join("\n");
  assert.deepEqual(instructionUnits(copilot).scope, { globs: ["**/*.py"] });
  // A dash rule that is never closed isn't front matter.
  assert.deepEqual(texts(instructionUnits("---\n- keep this rule please\n")), ["keep this rule please"]);
});

test("units shorter than 8 or longer than 1,000 characters are left out (the long ones counted)", () => {
  const r = instructionUnits(`- short\n- ${"x".repeat(1001)}\n- exactly ok\n`);
  assert.deepEqual(texts(r), ["exactly ok"]);
  assert.equal(r.tooLong, 1);
});

test("plainText keeps code spans and snake_case, drops emphasis, links' targets and tags", () => {
  assert.equal(plainText("**Never** use *var*; keep `snake_case` and my_var as is, see [x](http://h/y) <br>"), "Never use var; keep `snake_case` and my_var as is, see x");
});
