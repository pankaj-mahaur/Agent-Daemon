// P5.2: the memory server's record tools over the wire. --capture decides
// whether they're listed; legacy (initialize) and 2026-07-28 (_meta) clients
// both record; what they record is pending, served back as unreviewed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveServer } from "../testkit/mcp-client.mjs";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-mcp-capture-"));
const PROJ = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ad-mcp-capture-work-")), "proj");
await fs.mkdir(path.join(PROJ, ".git"), { recursive: true });
const ENV = { ...process.env, HOME, USERPROFILE: HOME, AD_ROOT: path.join(HOME, ".agent-daemon"), AD_MEMORY_DB: undefined, AD_MEMORY_PROJECT: undefined, CLAUDE_PROJECT_DIR: undefined };
after(async () => {
  for (const d of [HOME, path.dirname(PROJ)]) await fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const RECORD = ["memory_record_correction", "memory_record_learning"];
const names = (r) => (r.result?.tools ?? []).map((t) => t.name);
const text = (r) => r?.result?.content?.[0]?.text ?? "";

test("--capture hooks and off: no record tools, and a call is an unknown tool", async () => {
  for (const mode of ["hooks", "off"]) {
    const r = await driveServer(ENV, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_record_learning", arguments: { text: "a lesson that must not be recorded", kind: "tool" } } }], 8000, { args: ["--project", PROJ, "--capture", mode] });
    for (const t of RECORD) assert.ok(!names(r[2]).includes(t), `${mode}: ${t} listed`);
    assert.ok(names(r[2]).includes("memory_search"));
    assert.equal(r[3].error.code, -32602);
  }
});

test("--capture tools (and auto, the default) list both record tools with closed schemas", async () => {
  for (const args of [["--capture", "tools"], []]) {
    const r = await driveServer(ENV, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }], 8000, { args: ["--project", PROJ, ...args] });
    const tools = r[2].result.tools;
    for (const t of RECORD) {
      const tool = tools.find((x) => x.name === t);
      assert.ok(tool, t);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.idempotentHint, true);
    }
  }
});

test("legacy and 2026-07-28 clients both record; the note comes back unreviewed in search only here", async () => {
  const legacy = await driveServer(ENV, [
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_record_correction", arguments: { wrong: "npm test", right: "run the suite with pnpm test -- --runInBand", user_words: "no, use pnpm test with runInBand" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_record_correction", arguments: { wrong: "npm test", right: "run the suite with pnpm test -- --runInBand" } } },
  ], 8000, { args: ["--project", PROJ, "--capture", "tools", "--host", "cursor"] });
  assert.match(text(legacy[2]), /^Saved for review: "run the suite with pnpm test -- --runInBand \(not: npm test\)"/);
  assert.match(text(legacy[3]), /^Already known: /);
  assert.equal(legacy[2].result.isError, undefined);
  const modern = await driveServer(ENV, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_record_learning", arguments: { text: "the e2e suite needs the docker daemon running", kind: "gotcha" }, _meta: META } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query: "docker daemon e2e" }, _meta: META } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_record_learning", arguments: { text: "short", kind: "gotcha" }, _meta: META } },
  ], 8000, { args: ["--project", PROJ, "--capture", "tools"] });
  assert.equal(modern[1].result.resultType, "complete");
  assert.match(text(modern[1]), /^Saved for review: /);
  assert.match(text(modern[2]), /\(unreviewed\)/);
  assert.match(text(modern[2]), /docker daemon running/);
  assert.equal(modern[3].result.isError, true, "bad input is the tool's error");
  // Another project's server doesn't see it.
  const other = path.join(path.dirname(PROJ), "other");
  await fs.mkdir(path.join(other, ".git"), { recursive: true });
  const elsewhere = await driveServer(ENV, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query: "docker daemon e2e" } } }], 8000, { args: ["--project", other] });
  assert.equal(text(elsewhere[2]), "(no results)");
});

test("an unbound server records nothing", async () => {
  const r = await driveServer(ENV, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_record_learning", arguments: { text: "an unbound server never keeps this", kind: "tool", scope: "global" } } }], 8000, { args: ["--capture", "tools"], cwd: HOME });
  assert.match(text(r[2]), /^Not saved: this memory server isn't bound to a project/);
});
