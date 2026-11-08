#!/usr/bin/env node
// tools-list.json (MCP launch plan L3, Decision 24): what each shipped memory server
// lists, per host × capture mode, as the sha256 of its `tools/list` answer. A tool's
// name, description or schema changing between releases changes a hash, so the change
// is reviewed (the golden in runtime/test/fixtures/tools-list.golden.json) before it
// ships, and a user can compare what their host was shown with what was released.
//   node runtime/scripts/tools-list.mjs [--server <server.mjs>] [--out <file>] [--check <golden>]
// --server: a built copy's entry (the npm dist's memory-server, the plugin's server.mjs);
// default: this checkout's src/mcp/memory-server.mjs.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOST_IDS } from "../src/memory/host-ids.mjs";
import { CAPTURE_MODES } from "../src/mcp/tools.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The hosts a release ships to ("ad" is ad's own harness, not a product host).
export const LIST_HOSTS = Object.freeze(HOST_IDS.filter((h) => h !== "ad"));
export const LIST_CAPTURES = CAPTURE_MODES;

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** The hash of one tools/list answer: its tools, keys sorted, order kept. */
export const toolsHash = (tools) => crypto.createHash("sha256").update(JSON.stringify(sortKeys(tools))).digest("hex");

/** Start the server once, ask tools/list (legacy initialize), → the tools array. */
export function listTools(server, { host, capture, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, "serve", "--host", host, "--capture", capture], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${host}/${capture}: no tools/list answer in 20 s ${err.slice(-300)}`));
    }, 20_000);
    child.stderr.on("data", (d) => (err += d));
    let answered = false;
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${host}/${capture}: ${e.message}`));
    });
    child.on("exit", (code) => {
      if (answered) return;
      clearTimeout(timer);
      reject(new Error(`${host}/${capture}: the server exited (${code}) before answering ${err.slice(-300)}`));
    });
    child.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n").slice(0, -1)) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) {
            answered = true;
            clearTimeout(timer);
            child.kill();
            if (!Array.isArray(m.result?.tools)) reject(new Error(`${host}/${capture}: ${line.slice(0, 200)}`));
            else resolve(m.result.tools);
          }
        } catch {
          // not ours
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tools-list", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
}

/** → { schemaVersion: 1, hashes: { "<host>/<capture>": sha256 } } (keys sorted) */
export async function toolsList({ server = path.join(RUNTIME, "src", "mcp", "memory-server.mjs") } = {}) {
  // A throwaway home: the server opens a store wherever AD_ROOT points.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ad-tools-list-"));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, AD_ROOT: path.join(home, ".agent-daemon") };
  try {
    const pairs = LIST_HOSTS.flatMap((host) => LIST_CAPTURES.map((capture) => ({ host, capture })));
    const hashes = await Promise.all(pairs.map(async (p) => [`${p.host}/${p.capture}`, toolsHash(await listTools(server, { ...p, env }))]));
    return { schemaVersion: 1, hashes: Object.fromEntries(hashes.sort(([a], [b]) => (a < b ? -1 : 1))) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Differences from a golden list → lines (empty: the same). */
export function compareLists(got, golden) {
  const keys = [...new Set([...Object.keys(got.hashes), ...Object.keys(golden.hashes ?? {})])].sort();
  return keys.filter((k) => got.hashes[k] !== golden.hashes?.[k]).map((k) => `${k}: ${golden.hashes?.[k] ?? "(none)"} → ${got.hashes[k] ?? "(none)"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  try {
    const got = await toolsList({ server: arg("--server") ? path.resolve(arg("--server")) : undefined });
    const text = JSON.stringify(got, null, 2) + "\n";
    if (arg("--out")) fs.writeFileSync(arg("--out"), text);
    else process.stdout.write(text);
    if (arg("--check")) {
      const diff = compareLists(got, JSON.parse(fs.readFileSync(arg("--check"), "utf8")));
      if (diff.length) {
        console.error(`tools/list changed from the reviewed golden (${arg("--check")}):\n  ${diff.join("\n  ")}\nReview the tool text, then update the golden: node runtime/scripts/tools-list.mjs --out ${arg("--check")}`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
