#!/usr/bin/env node
// P5.3 release gate (a): the installer's config matrix, in fake homes only.
// For each host × config shape: install, doctor (both MCP handshakes against the
// installed entry), reinstall (must be "already set up"), uninstall (an
// untouched config must come back byte for byte). Passes at ≥ 95% of triples
// and zero uninstall-integrity failures.
//   node runtime/scripts/memory-install-matrix.mjs [--json]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = path.join(RUNTIME, "testkit", "fake-claude.mjs");
const { makeContext, install, uninstall } = await import("../src/memory-install/install.mjs");
const { doctor } = await import("../src/memory-install/doctor.mjs");

const SHAPES = {
  codex: {
    missing: null,
    empty: "",
    others: '# mine\nmodel = "o5"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n',
    crlf: 'model = "o5"\r\n',
  },
  cursor: {
    missing: null,
    empty: "{}",
    others: '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n',
    jsonc: '{\n  // mine\n  "mcpServers": {}\n}\n',
  },
  vscode: {
    missing: null,
    empty: "{}",
    others: '{\n  "mcpServers": {\n    "github": { "type": "stdio", "command": "gh-mcp" }\n  }\n}\n',
    jsonc: '{\n  // personal servers\n  "mcpServers": {}\n}\n',
  },
  gemini: {
    missing: null,
    empty: "{}",
    others: '{\n  "theme": "Dracula",\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n',
    crlf: '{\r\n  "theme": "Dracula"\r\n}\r\n',
  },
  "claude-code": { cli: null },
};
// The host's settings file in a fake home (its folder makes the host "found").
const FILES = { codex: [".codex", "config.toml"], cursor: [".cursor", "mcp.json"], vscode: [".copilot", "mcp-config.json"], gemini: [".gemini", "settings.json"] };

function world(host, text) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-matrix-"));
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: path.join(h, ".codex"), AD_ROOT: path.join(h, ".agent-daemon"), FAKE_CLAUDE_STATE: path.join(h, "claude.json"), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const file = FILES[host] ? path.join(h, ...FILES[host]) : null;
  fs.mkdirSync(path.join(h, FILES[host]?.[0] ?? ".claude"), { recursive: true });
  if (file && text !== null) fs.writeFileSync(file, text);
  const out = [];
  const ctx = makeContext({ env, home: h, root: env.AD_ROOT, resolve: (n) => (n === "claude" && host === "claude-code" ? { cmd: process.execPath, prefix: [SHIM], via: "env", file: SHIM } : null), out: (l) => out.push(l), ask: async () => "" });
  return { h, ctx, file, out, before: file && fs.existsSync(file) ? fs.readFileSync(file) : null };
}

const results = [];
for (const [host, shapes] of Object.entries(SHAPES)) {
  for (const [shape, text] of Object.entries(shapes)) {
    const w = world(host, text);
    const r = { host, shape, install: false, doctor: false, reinstall: false, uninstall: false, integrity: true };
    try {
      r.install = (await install({ ctx: w.ctx, hosts: [host], yes: true })) === 0;
      w.out.length = 0;
      await doctor({ ctx: w.ctx, json: true, cwd: w.h });
      const checks = JSON.parse(w.out.at(-1));
      r.doctor = checks.filter((c) => c.host === host).every((c) => c.ok) && checks.some((c) => c.code === "smoke.modern" && c.host === host && c.ok);
      w.out.length = 0;
      r.reinstall = (await install({ ctx: w.ctx, hosts: [host], yes: true })) === 0 && w.out.some((l) => /already set up/.test(l));
      r.uninstall = (await uninstall({ ctx: w.ctx, hosts: [host] })) === 0;
      if (w.file) {
        const after = fs.existsSync(w.file) ? fs.readFileSync(w.file) : null;
        r.integrity = w.before === null ? after === null : Boolean(after && after.equals(w.before));
      }
    } catch (e) {
      r.error = e.message;
    } finally {
      fs.rmSync(w.h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    results.push(r);
  }
}

const triples = results.flatMap((r) => [r.install, r.doctor, r.reinstall]);
const rate = triples.filter(Boolean).length / triples.length;
const integrityFails = results.filter((r) => !r.integrity || !r.uninstall).length;
const pass = rate >= 0.95 && integrityFails === 0;
if (process.argv.includes("--json")) console.log(JSON.stringify({ rate, integrityFails, pass, results }));
else {
  for (const r of results) console.log(`${r.install && r.doctor && r.reinstall && r.uninstall && r.integrity ? "✓" : "✗"} ${r.host.padEnd(12)} ${r.shape.padEnd(8)} install ${r.install} doctor ${r.doctor} reinstall ${r.reinstall} uninstall ${r.uninstall} integrity ${r.integrity}${r.error ? ` (${r.error})` : ""}`);
  console.log(`${(rate * 100).toFixed(0)}% of checks passed; ${integrityFails} uninstall-integrity failure(s): ${pass ? "PASS" : "FAIL"}`);
}
process.exitCode = pass ? 0 : 1;
