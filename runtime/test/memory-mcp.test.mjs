// End-to-end JSON-RPC round-trip for the memory MCP server's new
// progressive-disclosure tools (memory_get / memory_timeline / memory_files).
//
// Spawns runtime/src/mcp/memory-server.mjs as a real subprocess against a tmp
// episodic DB (HOME/USERPROFILE overridden so it resolves there), sends
// newline-delimited JSON-RPC, and asserts the responses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "memory-server.mjs");

/**
 * Spawn the server with the given env, send each request line, and resolve once
 * a response for every request `id` has arrived (or on timeout). Returns a map
 * of id → response object.
 */
export function driveServer(env, requests, timeoutMs = 8000, { args = [], cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const wanted = new Set(requests.filter(r => r.id !== undefined).map(r => r.id));
    const responses = {};
    let buf = "";
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      err ? reject(err) : resolve(responses);
    };
    const timer = setTimeout(() => finish(new Error(`timeout; got ids ${Object.keys(responses).join(",")}`)), timeoutMs);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined) {
          responses[msg.id] = msg;
          wanted.delete(msg.id);
          if (wanted.size === 0) finish();
        }
      }
    });
    child.on("error", finish);

    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

function callText(resp) {
  return resp?.result?.content?.[0]?.text || "";
}

test("memory MCP: tools/list advertises the progressive-disclosure tools, and get/timeline/files work", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-mcp-"));
  const prevHome = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  let id1, id2, toolNames, getText, timelineText, filesText, missText, profileText;
  try {
    // Seed a tmp DB via episodic (same HOME the server will resolve).
    const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}-${Math.random()}`);
    const proj = path.join(dir, "mcpproj");
    await fs.mkdir(path.join(proj, ".git"), { recursive: true });
    const slug = mod.projectSlug(proj);
    await mod.upsertSession({ id: "sess-X", projectPath: proj, startedAt: "2026-06-10T09:00:00.000Z" });
    // A project row, and a 3.0-style NULL-project row from this project's session.
    id1 = await mod.insertLearning({ sessionId: "sess-X", projectSlug: slug, category: "gotcha", text: "mcp detail learning", evidence: "the evidence", tags: ["src/mcp/thing.ts"], confidence: 0.7 });
    id2 = await mod.insertLearning({ sessionId: "sess-X", category: "pattern", text: "mcp sibling learning", confidence: 0.6 });
    await mod.observeUserFact({ category: "tool", text: "prefers pnpm", confidence: 0.8, projectSlug: slug, origin: "user" });
    mod.closeDb();

    const env = { ...process.env, HOME: dir, USERPROFILE: dir, AD_ROOT: undefined, CLAUDE_PROJECT_DIR: undefined, AD_MEMORY_PROJECT: undefined };
    const responses = await driveServer(env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_get", arguments: { ids: [id1] } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_timeline", arguments: { id: id1 } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_files", arguments: { path: "thing.ts" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory_get", arguments: { ids: [987654] } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "memory_profile", arguments: {} } }
    ], 8000, { args: ["--project", proj] });

    toolNames = (responses[2]?.result?.tools || []).map(t => t.name);
    getText = callText(responses[3]);
    timelineText = callText(responses[4]);
    filesText = callText(responses[5]);
    missText = callText(responses[6]);
    profileText = callText(responses[7]);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // tools/list
  for (const name of ["memory_search", "memory_get", "memory_timeline", "memory_files", "memory_profile"]) {
    assert.ok(toolNames.includes(name), `tools/list missing ${name} (got ${toolNames})`);
  }
  // memory_get — full text + provenance
  assert.match(getText, /mcp detail learning/);
  assert.match(getText, /the evidence/);
  assert.match(getText, /from session sess-X/);
  // memory_timeline — session header + sibling
  assert.match(timelineText, /session sess-X/);
  assert.match(timelineText, /mcp sibling learning/);
  // memory_files — file-aware recall
  assert.match(filesText, /mcp detail learning/);
  // memory_get on a missing id — graceful
  assert.match(missText, /no learnings found/i);
  // memory_profile — deterministic representation rollup
  assert.match(profileText, /Tools|Prefers|Conventions|Watch out/, `profile had no buckets: ${profileText}`);
  assert.match(profileText, /pnpm/, "user fact surfaced in the representation");
  assert.match(profileText, /derived deterministically/);
});

// P5.1: a 2026-07-28 client (as the engine at 0.163 with mcp_2026_07_28: server/discover
// first, _meta on every request), and answers drained when stdin ends.
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };

async function modernHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-mcp-modern-"));
  const proj = path.join(dir, "proj");
  await fs.mkdir(path.join(proj, ".git"), { recursive: true });
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, AD_ROOT: undefined, CLAUDE_PROJECT_DIR: undefined, AD_MEMORY_PROJECT: undefined };
  return { dir, proj, env, done: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("memory MCP, modern: server/discover, tools/list and tools/call with _meta; annotations on every tool", async () => {
  const h = await modernHome();
  try {
    const r = await driveServer(h.env, [
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN_META } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: MODERN_META } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_stats", arguments: {}, _meta: MODERN_META } },
    ], 8000, { args: ["--project", h.proj] });
    assert.deepEqual(r[1].result.supportedVersions, ["2026-07-28"]);
    assert.equal(r[1].result.ttlMs, 3600000);
    assert.equal(r[1].result.cacheScope, "private");
    assert.equal(r[1].result._meta["io.modelcontextprotocol/serverInfo"].name, "agent-daemon-memory");
    const tools = r[2].result.tools;
    assert.equal(r[2].result.resultType, "complete");
    for (const t of tools) {
      assert.ok(t.title && t.annotations, t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
    }
    assert.equal(tools.find((t) => t.name === "memory_search").annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "memory_get").annotations.readOnlyHint, false, "it bumps retrieval counters");
    assert.equal(tools.find((t) => t.name === "memory_feedback").annotations.readOnlyHint, false);
    assert.equal(r[3].result.resultType, "complete");
    assert.match(r[3].result.content[0].text, /^scope: project \(arg\)/);
  } finally {
    await h.done();
  }
});

test("memory MCP: a call in flight when stdin ends is still answered", async () => {
  const h = await modernHome();
  try {
    const { spawn: sp } = await import("node:child_process");
    const child = sp(process.execPath, [SERVER, "--project", h.proj], { env: h.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    for (let i = 2; i <= 101; i++) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "memory_search", arguments: { query: `note ${i}` } } }) + "\n");
    child.stdin.end(); // with up to 100 calls still in flight
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    const ids = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
    assert.deepEqual(ids.sort((a, b) => a - b), Array.from({ length: 101 }, (_, i) => i + 1), "every call was answered before exit");
  } finally {
    await h.done();
  }
});
