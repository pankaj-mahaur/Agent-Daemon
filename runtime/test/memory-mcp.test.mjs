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
function driveServer(env, requests, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
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

  let id1, id2, toolNames, getText, timelineText, filesText, missText;
  try {
    // Seed a tmp DB via episodic (same HOME the server will resolve).
    const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}-${Math.random()}`);
    await mod.upsertSession({ id: "sess-X", projectPath: "/tmp/mcpproj", startedAt: "2026-06-10T09:00:00.000Z" });
    id1 = await mod.insertLearning({ sessionId: "sess-X", category: "gotcha", text: "mcp detail learning", evidence: "the evidence", tags: ["src/mcp/thing.ts"], confidence: 0.7 });
    id2 = await mod.insertLearning({ sessionId: "sess-X", category: "pattern", text: "mcp sibling learning", confidence: 0.6 });
    mod.closeDb();

    const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_PROJECT_DIR: "/tmp/mcpproj" };
    const responses = await driveServer(env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_get", arguments: { ids: [id1] } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_timeline", arguments: { id: id1 } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_files", arguments: { path: "thing.ts" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory_get", arguments: { ids: [987654] } } }
    ]);

    toolNames = (responses[2]?.result?.tools || []).map(t => t.name);
    getText = callText(responses[3]);
    timelineText = callText(responses[4]);
    filesText = callText(responses[5]);
    missText = callText(responses[6]);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // tools/list
  for (const name of ["memory_search", "memory_get", "memory_timeline", "memory_files"]) {
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
});
