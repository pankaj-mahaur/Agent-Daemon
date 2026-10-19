// The hooks a host plugin runs (P5.4): `node <plugin>/server/hook.mjs <name> --host <id>`.
//
//   user-prompt-extract  UserPromptSubmit: the user's corrections → the capture journal
//   query-retrieve       UserPromptSubmit: notes relevant to the prompt → added context
//   session-start        SessionStart: drain the journal, show this project's notes
//
// Memory only: SessionStart gets no constitution (the plugin has none) and never
// starts ad's digest sweep (ad's full CLI isn't in a plugin). Capture files go to
// projectDataDir (P5.2), so a repo without `ad init` gets no folder.
//
// Duplicate guard: when ad's own hooks for the same step are in Claude Code's
// settings (`ad init`), the plugin's hook passes through, so nothing is captured
// or injected twice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_HOOKS = Object.freeze(["user-prompt-extract", "query-retrieve", "session-start"]);

// What ad init writes for each step: ad's own command (`ad …`, `agent-daemon …`, or
// node with ad's cli.mjs) followed by the step. Another tool's
// `~/.claude/hooks/session-start.sh` never counts.
const adCommand = (step) => new RegExp(String.raw`(?:(?:^|[\s"'/\\])(?:ad|agent-daemon)(?:\.cmd|\.ps1|\.exe)?["']?|[\\/]cli\.mjs["']?)\s+${step}(?:\s|$|["'])`);
const AD_HOOK = {
  "user-prompt-extract": ["UserPromptSubmit", adCommand(String.raw`hook\s+user-prompt-extract`)],
  "query-retrieve": ["UserPromptSubmit", adCommand("query-retrieve")],
  "session-start": ["SessionStart", adCommand("session-start")],
};

/**
 * ad's own hook for `name` runs in Claude Code: in the user's settings, or the
 * project's (.claude/settings.json, settings.local.json). A hook with an `if`
 * condition doesn't count: it may not fire, and the step must not be lost.
 */
export function adHookInClaudeSettings(name, { env = process.env, home = os.homedir(), cwd = env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const [event, re] = AD_HOOK[name] ?? [];
  if (!event) return false;
  const userDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  const files = [path.join(userDir, "settings.json"), path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")];
  return files.some((file) => {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return (j?.hooks?.[event] ?? []).some((g) => (g?.hooks ?? []).some((h) => re.test(String(h?.command ?? "")) && h?.if === undefined));
    } catch {
      return false;
    }
  });
}

const argValue = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function readPayload() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * Run one plugin hook. → exit code (always 0: a hook never blocks the host).
 * @param {string[]} argv  [name, "--host", id]
 */
export async function runPluginHook(argv, { env = process.env, home = os.homedir(), stdout = process.stdout } = {}) {
  const name = argv[0];
  const host = argValue(argv, "--host") ?? "claude-code";
  if (!PLUGIN_HOOKS.includes(name)) {
    process.stderr.write(`agent-daemon-memory hook: unknown hook "${name}" (${PLUGIN_HOOKS.join(", ")})\n`);
    return 0;
  }
  if (host === "claude-code" && adHookInClaudeSettings(name, { env, home })) {
    stdout.write("{}"); // ad's own hook does this step
    return 0;
  }
  try {
    if (name === "user-prompt-extract") return (await import("../hooks/user-prompt-extract.mjs")).userPromptExtract();
    if (name === "query-retrieve") return (await import("../query-retrieve.mjs")).runQueryRetrieve({ outputJson: true });
    const payload = await readPayload();
    const cwd = String(payload.cwd || env.CLAUDE_PROJECT_DIR || env.GEMINI_PROJECT_DIR || process.cwd());
    return (await import("../session-start.mjs")).runSessionStart({ cwd, sessionId: payload.session_id ? String(payload.session_id) : undefined, outputJson: true, memoryOnly: true });
  } catch (err) {
    process.stderr.write(`agent-daemon-memory hook ${name}: ${err?.message ?? err}\n`);
    stdout.write("{}");
    return 0;
  }
}
