// A minimal MCP client for tests: spawn ad's memory server, send JSON-RPC
// lines, collect the responses by id.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEMORY_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "memory-server.mjs");

/** → {id: response} once every request with an id has an answer (or rejects on timeout). */
export function driveServer(env, requests, timeoutMs = 8000, { args = [], cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MEMORY_SERVER, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const wanted = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));
    const responses = {};
    let buf = "";
    let stderr = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // gone
      }
      if (err) reject(err);
      else resolve(Object.defineProperty(responses, "stderr", { value: stderr, enumerable: false }));
    };
    const timer = setTimeout(() => finish(new Error(`timeout; got ids ${Object.keys(responses).join(",")}; stderr: ${stderr.slice(-400)}`)), timeoutMs);
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined) {
          responses[msg.id] = msg;
          wanted.delete(msg.id);
          if (wanted.size === 0) finish();
        }
      }
    });
    child.on("error", finish);
    for (const r of requests) child.stdin.write((typeof r === "string" ? r : JSON.stringify(r)) + "\n");
  });
}

export const text = (resp) => resp?.result?.content?.[0]?.text ?? "";
