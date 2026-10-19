// The agent-shell guard (D49). Commands that accept, release or promote
// memory, and later account and import approvals, must be typed by the user,
// not run by an agent on their behalf.
//
// Two signals:
//   - AD_TOOL_SHELL=1, which harness setup puts into every tool shell of ad's
//     own engine (shell_environment_policy.set). No override.
//   - a TTY on stdin and stdout. Other hosts' tool shells have none. Tests
//     inject isTTY; there is deliberately no environment variable that skips
//     it, since an agent could set that too. An agent with a PTY-backed shell
//     in another host is outside this gate (SECURITY.md says so).

const realTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** @returns {string|null} the refusal text, or null when the command may run */
export function refuseInAgentShell({ cmd, env = process.env, isTTY = realTTY, needTty = true }) {
  const text = `ad ${cmd} only runs in your own terminal, not from an agent's shell.`;
  if (env.AD_TOOL_SHELL === "1") return text;
  if (needTty && !isTTY()) return text;
  return null;
}

/**
 * Ask the user to type `expected` (an id). Only a TTY caller should get here.
 * @param {{expected:string, prompt?:string, io:{ask:(q:string)=>Promise<string>}}} opts
 */
export async function confirmTyped({ expected, prompt, io }) {
  const answer = await io.ask(prompt ?? `Type ${expected} to confirm: `);
  return String(answer ?? "").trim() === String(expected);
}
