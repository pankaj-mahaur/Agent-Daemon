// `ad init` from the agent's shell scaffolds only (MCP launch plan L7, D10, S2): it writes
// no hook entry and changes none. Hooks run outside the host's sandbox, so an agent that
// could run `ad init` from a tree of its own would point them at its own code; the user
// sets hooks up from their own terminal.
//
//   initFromAgentShell() → why ("AD_TOOL_SHELL", "no terminal", "<agent> runs it") | null
//
// The signals: the marker setup writes into Claude Code's env (AD_TOOL_SHELL=1), no
// terminal on stdin and stdout (an agent's shell tool has none), or an agent among this
// process's ancestors (the review gate's own probe).

import { probeAncestry } from "./memory/ancestry.mjs";

export function initFromAgentShell({ env = process.env, isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY), probe = probeAncestry } = {}) {
  if (env.AD_TOOL_SHELL === "1") return "AD_TOOL_SHELL";
  if (!isTTY()) return "no terminal";
  const v = probe();
  return v?.verdict === "agent" ? `${v.agent ?? "an agent"} runs it` : null;
}
