#!/usr/bin/env node
// S-BIND hello server: a minimal stdio MCP server that records how the host
// launched it (cwd, argv, CODEX_*/CLAUDE_* env names, the initialize params
// and any _meta on tool calls) into $SPIKE_BIND_LOG, so the spike can tell
// whether it could find the session's project.

import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = (what, data) => process.env.SPIKE_BIND_LOG && appendFileSync(process.env.SPIKE_BIND_LOG, JSON.stringify({ what, at: new Date().toISOString(), ...data }) + "\n");
log("start", { cwd: process.cwd(), argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => /^(CODEX|CLAUDE|PWD|INIT_CWD|SPIKE)/i.test(k)) });

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  log("message", { method: m.method, params: m.params });
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "spike-bind", version: "0.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "where_am_i", description: "Report the server's working directory.", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: process.cwd() }] } });
  else if (m.method === "roots/list" || m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
