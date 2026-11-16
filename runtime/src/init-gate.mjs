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
import { ourHandlers } from "./hooks/routes.mjs";

export function initFromAgentShell({ env = process.env, isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY), probe = probeAncestry } = {}) {
  if (env.AD_TOOL_SHELL === "1") return "AD_TOOL_SHELL";
  if (!isTTY()) return "no terminal";
  const v = probe();
  return v?.verdict === "agent" ? `${v.agent ?? "an agent"} runs it` : null;
}

/** Does the plan change or remove ad init's own tool.before entries (the launcher's stays as it is)? */
export function rulesCheckChanged(before, after) {
  const tb = (hooks) => ourHandlers(hooks && typeof hooks === "object" ? hooks : {}).filter((o) => !o.info.launcher && !o.info.plugin && o.info.event === "tool.before").map((o) => JSON.stringify([o.hostEvent, o.matcher ?? null, o.handler])).sort().join("\n");
  const was = tb(before);
  return was !== "" && was !== tb(after);
}

/** ad init's gate for rewriting the rules-check entry while rules exist (L7 D16). → { ok } | { ok: false, why } */
export async function initRulesCheckGate({ root, token, tty } = {}) {
  const G = await import("./hooks/guards.mjs");
  const at = root ?? (await import("./ad-root.mjs")).adRoot();
  const rules = G.readActive({ root: at }) !== null || (G.loadGuards({ root: at }).snapshot?.ruleCount ?? 0) > 0;
  if (!rules) return { ok: true };
  const { confirmTypedCode, openTty } = await import("./memory/typed-code.mjs");
  const svc = await import("./memory/review-service.mjs");
  const term = tty === undefined ? openTty() : tty;
  try {
    const ask = term ? (q) => term.ask(q) : async () => "";
    const t = await (token ?? (() => svc.reviewToken({ ask, out: (l) => console.log(l) })))();
    if (!t?.token || !svc.isReviewToken(t.token)) return { ok: false, why: `your rules check stays as it is: changing it while rules exist needs your own terminal (${t?.refused ?? "not your own terminal"})` };
    const c = await confirmTypedCode({ what: "Rewrite ad's rules check in Claude Code while rules exist", proven: t.dialogProven === true, tty: term });
    return c.ok ? { ok: true } : { ok: false, why: `your rules check stays as it is: ${c.text}` };
  } finally {
    if (tty === undefined) term?.close?.();
  }
}
