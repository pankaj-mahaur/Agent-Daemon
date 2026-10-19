// Driver for Claude Code, headless: `claude -p` per turn, `--resume <session id>`
// for the follow-up turn. The owner runs it locally (an API key in the
// environment); CI only checks it against a fake `claude`.
//
// Isolation: the episode process sets CLAUDE_CONFIG_DIR (and HOME) inside the
// episode's temp root (runner/run.mjs), so this driver writes its settings,
// hooks and MCP list there and never reads or changes the user's own Claude
// files. Flags are as Claude Code documents them for headless use; the
// auto-memory setting name is UNVERIFIED (PROTOCOL.md "Open checks").
//
// Conditions:
//   off, static-rules  no ad hooks, no MCP servers, auto memory off
//   native             auto memory on, ad off
//   on-hooks           ad's memory hooks (the developer profile's) + ad's memory server
//   on-tools           ad's memory server only
// Permissions, the same in every condition: --permission-mode acceptEdits (file
// edits accepted, commands are not pre-approved and nobody is there to approve them).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime");
const CLI = path.join(RUNTIME, "src", "cli.mjs");
const MEMORY_SERVER = path.join(RUNTIME, "src", "mcp", "memory-server.mjs");

export { captured, hookEvidence, sessionCount } from "./driver-ad.mjs";

export const name = "claude";
export const rulesFile = "CLAUDE.md";
export const AUTO_MEMORY_SETTING = "autoMemoryEnabled"; // UNVERIFIED name

export function settings(condition) {
  return {
    host: "Claude Code (claude -p, --resume for the follow-up turn)",
    adHooks: condition.adHooks,
    adTools: condition.adTools,
    autoMemory: { setting: AUTO_MEMORY_SETTING, value: condition.hostMemory, verified: false },
    rulesFile: condition.rulesFile ? rulesFile : null,
    permissions: "--permission-mode acceptEdits",
  };
}

const q = (s) => `"${String(s).replace(/\\/g, "/")}"`;

/** ad's memory hooks in Claude Code's settings shape, from ad's own developer profile. */
export function claudeHooks(defs, { node = process.execPath, cli = CLI } = {}) {
  const hooks = {};
  for (const d of defs) {
    if (!d.command.startsWith("ad ")) continue;
    const command = `${q(node)} ${q(cli)} ${d.command.slice(3)}`;
    (hooks[d.event] ??= []).push({ ...(d.matcher ? { matcher: d.matcher } : {}), hooks: [{ type: "command", command, timeout: Math.max(d.timeout ?? 5, 5) }] });
  }
  return hooks;
}

export async function prepare({ root, condition, hostCommand, log = () => {} }) {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir || !path.resolve(configDir).startsWith(path.resolve(root))) throw new Error("CLAUDE_CONFIG_DIR must be inside the episode's folder (run through runner/run.mjs)");
  fs.mkdirSync(configDir, { recursive: true });
  const { resolveProfile } = await import(pathToFileURL(path.join(RUNTIME, "src", "profiles.mjs")).href);
  const defs = condition.adHooks ? (await resolveProfile("developer")).hooks : [];
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ [AUTO_MEMORY_SETTING]: condition.hostMemory, hooks: claudeHooks(defs) }, null, 2) + "\n");
  const mcpFile = path.join(root, "mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: condition.adTools ? { "agent-daemon-memory": { command: process.execPath, args: [MEMORY_SERVER] } } : {} }, null, 2) + "\n");
  return { cmd: hostCommand?.length ? hostCommand : ["claude"], mcpFile, log };
}

/**
 * Did Claude Code write its own memory? Its auto memory lives in project folders
 * under the config folder (`projects/<project>/memory/`); the setting's name is
 * unverified, so every session checks what actually happened.
 */
export async function hostMemoryEvidence() {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? "", "projects");
  let present = false;
  try {
    for (const p of fs.readdirSync(projects)) {
      const dir = path.join(projects, p, "memory");
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) present = true;
    }
  } catch {
    // no projects folder: nothing written
  }
  return { present };
}

/** The argv of one headless turn. */
export function turnArgs({ text, mcpFile, model, sessionId }) {
  return ["-p", text, "--output-format", "json", "--permission-mode", "acceptEdits", "--mcp-config", mcpFile, "--strict-mcp-config", ...(model ? ["--model", model] : []), ...(sessionId ? ["--resume", sessionId] : [])];
}

export async function open(ctx, { cwd, model }) {
  let sessionId = null;
  return {
    async turn(text, { timeoutMs = 600_000 } = {}) {
      const [cmd, ...pre] = ctx.cmd;
      // Never through a shell: the prompt is data. On Windows pass --host-command
      // with node and Claude Code's script (a .cmd shim can't start without a shell).
      const r = spawnSync(cmd, [...pre, ...turnArgs({ text, mcpFile: ctx.mcpFile, model, sessionId })], { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
      if (r.error?.code === "ETIMEDOUT") return { status: "timeout", error: "the turn timed out" };
      let out = null;
      try {
        out = JSON.parse(String(r.stdout).trim().split("\n").at(-1));
      } catch {
        // not JSON: reported below
      }
      if (out?.session_id) sessionId = out.session_id;
      if (r.status !== 0 || !out || out.is_error) return { status: "crash", error: (out?.result ?? r.stderr ?? `exit ${r.status}`).toString().slice(0, 300) };
      return { status: "ok", error: null };
    },
    close: async () => {},
  };
}
