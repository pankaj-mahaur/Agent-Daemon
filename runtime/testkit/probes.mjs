// Probes for key-isolation spikes and tests (P3.1 S-GATEWAY G7): places a secret must
// never reach (a hook's environment, an MCP server's, a tool shell's), with helpers to
// look there and to say which fake secret, if any, showed up. Never print a value:
// scanForSecrets reports indexes.
//
//   writeEnvDumpScript(dir)            → a node script: `node <it> <outFile> [--mcp]` writes its
//                                        environment as JSON; with --mcp it also answers as a
//                                        minimal stdio MCP server (initialize, tools/list)
//   envDumpHooks({ node, script, outFile, events }) → a hooks.json object (the engine's format)
//   probeShellCommands({ platform, paths })  → commands a scripted model turn runs in a tool
//                                        shell: the environment, then each path's content
//   probeTurnScript(commands)          → a mock-responses script that runs them one by one
//   scanForSecrets(text, secrets)      → indexes of the secrets found in text

import fs from "node:fs";
import path from "node:path";
import { ev } from "./mock-responses.mjs";

const DUMP = `// written by runtime/testkit/probes.mjs: dump this process's environment
import fs from "node:fs";
import readline from "node:readline";
const [out, mode] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify(process.env));
if (mode === "--mcp") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    const result = m.method === "initialize"
      ? { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "env-probe", version: "1" } }
      : m.method === "tools/list" ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  });
} else {
  // A hook: answer nothing, read and drop stdin.
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}
`;

export function writeEnvDumpScript(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "env-dump.mjs");
  fs.writeFileSync(file, DUMP);
  return file;
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** A hooks.json whose hooks dump their environment to outFile (one file per event). */
export function envDumpHooks({ node = process.execPath, script, outFile, events = ["SessionStart", "UserPromptSubmit"] }) {
  const hooks = {};
  for (const event of events) {
    const out = `${outFile}.${event}.json`;
    hooks[event] = [{ hooks: [{ type: "command", command: [sh(node), sh(script), sh(out)].join(" "), commandWindows: ["&", ps(node), ps(script), ps(out)].join(" "), timeout: 20 }] }];
  }
  return { description: "env probe (P3.1)", hooks };
}

/** Commands a tool shell runs: its environment, then the content of each path. */
export function probeShellCommands({ platform = process.platform, paths = [] } = {}) {
  if (platform === "win32") return ["cmd.exe /d /c set", ...paths.map((p) => `cmd.exe /d /c type "${p}"`)];
  return ["env", ...paths.map((p) => `cat ${sh(p)}`)];
}

/** A mock script that runs `commands` in a tool shell one by one, then closes. */
export function probeTurnScript(commands) {
  return (body) => {
    const input = Array.isArray(body?.input) ? body.input : [];
    const done = input.filter((i) => i?.type === "function_call_output").length;
    if (done < commands.length) return [ev.created(`resp-probe-${done}`), ev.functionCall(`call-probe-${done}`, "exec_command", { cmd: commands[done] }), ev.completed(`resp-probe-${done}`)];
    return [ev.created("resp-probe-end"), ev.message("probes done"), ev.completed("resp-probe-end")];
  };
}

/** Which of `secrets` appear in `text` (indexes; values are never returned). */
export function scanForSecrets(text, secrets) {
  const s = String(text ?? "");
  return secrets.map((x, i) => (x && s.includes(x) ? i : -1)).filter((i) => i >= 0);
}
