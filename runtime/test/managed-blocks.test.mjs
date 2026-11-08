// L4b gate: the managed-block skip. ad's own text in a user's instruction file
// (`ad init`'s block and 3.x's learnings mirror) is never imported or counted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripManaged, hasManaged } from "../src/memory/managed-blocks.mjs";

const INIT = ["<!-- agent-daemon:start -->", "## agent-daemon", "- AD-ONLY-INIT read AD-INSTRUCTIONS.md first", "<!-- agent-daemon:end -->"];
const MIRROR = ["<!-- agent-daemon:learnings:start -->", "## Recent learnings (agent-daemon, 2026-10-01)", "- **correction**: AD-ONLY-MIRROR use the pnpm store", "<!-- agent-daemon:learnings:end -->"];

const has = (s, word) => s.includes(word);

test("both blocks go, the user's text around them stays", () => {
  const text = ["# Rules", "- user rule one", ...INIT, "- user rule two", ...MIRROR, "- user rule three", ""].join("\n");
  const out = stripManaged(text);
  assert.ok(!has(out, "AD-ONLY") && !hasManaged(out), out);
  for (const r of ["user rule one", "user rule two", "user rule three", "# Rules"]) assert.ok(has(out, r), r);
});

test("CRLF files: the blocks go and the line endings stay", () => {
  const text = ["- user rule one", ...MIRROR, "- user rule two", ""].join("\r\n");
  const out = stripManaged(text);
  assert.ok(!has(out, "AD-ONLY"));
  assert.equal(out, "- user rule one\r\n\r\n- user rule two\r\n");
});

test("markers with other case and spacing, or inside a line, still count", () => {
  const text = "keep A <!--Agent-Daemon:Learnings:Start-->AD-ONLY-X<!--   agent-daemon:learnings:end   --> keep B\n<!-- AGENT-DAEMON:START -->AD-ONLY-Y\n<!-- agent-daemon:END -->\nkeep C";
  const out = stripManaged(text);
  assert.ok(!has(out, "AD-ONLY"), out);
  for (const k of ["keep A", "keep B", "keep C"]) assert.ok(has(out, k), k);
});

test("a block that is never closed runs to the end of the file (fail closed)", () => {
  const text = ["- user rule one", INIT[0], INIT[1], INIT[2], "- AD-ONLY-TAIL looks like a user rule but sits inside ad's block"].join("\n");
  const out = stripManaged(text);
  assert.ok(has(out, "user rule one"));
  assert.ok(!has(out, "AD-ONLY"), out);
  const mirrorOnly = ["- user rule one", MIRROR[0], "- AD-ONLY-TAIL2"].join("\n");
  assert.ok(!has(stripManaged(mirrorOnly), "AD-ONLY"));
});

test("a second start inside a block is part of the block; overlapping blocks end when both are closed", () => {
  const nested = ["- keep 1", "<!-- agent-daemon:start -->", "AD-ONLY-1", "<!-- agent-daemon:start -->", "AD-ONLY-2", "<!-- agent-daemon:end -->", "- keep 2"].join("\n");
  const out = stripManaged(nested);
  assert.ok(!has(out, "AD-ONLY") && has(out, "keep 1") && has(out, "keep 2"), out);
  // Mirror opened, init opened inside it, mirror closed, then init closed: all of it is ad's.
  const overlap = ["- keep 1", MIRROR[0], "AD-ONLY-3", INIT[0], "AD-ONLY-4", MIRROR[3], "AD-ONLY-5", INIT[3], "- keep 2"].join("\n");
  const o2 = stripManaged(overlap);
  assert.ok(!has(o2, "AD-ONLY") && has(o2, "keep 1") && has(o2, "keep 2"), o2);
  // An end of the other kind doesn't close a block.
  const wrongEnd = ["- keep 1", INIT[0], "AD-ONLY-6", MIRROR[3], "AD-ONLY-7"].join("\n");
  assert.ok(!has(stripManaged(wrongEnd), "AD-ONLY"));
});

test("a stray end marker is dropped and the text around it stays", () => {
  const text = ["- keep 1", "<!-- agent-daemon:end -->", "- keep 2", "<!-- agent-daemon:learnings:end -->", "- keep 3"].join("\n");
  const out = stripManaged(text);
  assert.ok(!hasManaged(out));
  for (const k of ["keep 1", "keep 2", "keep 3"]) assert.ok(has(out, k), k);
});

test("text without markers is unchanged; other ad comments are left to the parser", () => {
  const text = "# Rules\r\n- one\n<!-- agent-daemon: digested 2026-10-01 -->\n";
  assert.equal(stripManaged(text), text);
  assert.equal(stripManaged(""), "");
  assert.equal(stripManaged(undefined), "");
});
