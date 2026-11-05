// What each host can do with a hook's answer (plan 02 §3, from the L0 S-HOOKS
// captures: Claude Code 2.1.314, Codex 0.164.0).
//
//                      ask            deny          fail-closed on error   shows systemMessage
//   Claude Code        yes*           yes           onFailure:"block"      yes
//   Codex              no (fails open) yes (JSON)    no                     no (exec)
//   * in bypassPermissions and dontAsk a hook "ask" may be skipped, so it is sent as deny.
//
// The provisional allow-list (02 §2.1) is empty at launch: no host gives a
// positive signal for a typed prompt yet, so every capture waits for review.

export const HOSTS = Object.freeze({
  claude: {
    name: "Claude Code",
    ask: true,
    denyModes: new Set(["bypassPermissions", "dontAsk"]),
    failClosed: "onFailure",
    minFailClosedVersion: "2.1.295",
    systemMessage: true,
  },
  codex: {
    name: "Codex",
    ask: false,
    denyModes: new Set(),
    failClosed: null,
    minFailClosedVersion: null,
    systemMessage: false,
  },
});

/**
 * Hosts and versions whose typed prompts may become provisional notes. A host
 * joins only when it gives a documented signal for every non-typed source
 * (Claude Code: UserPromptSubmit `source: "user"`, not shipped in 2.1.314).
 * @type {{host:string, minVersion:string}[]}
 */
export const PROVISIONAL_ALLOW_LIST = Object.freeze([]);

/** Compare dotted versions ("2.1.314" vs "2.1.295"): negative, zero or positive. */
export const cmpVersion = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** Is this host and version on the provisional allow-list? */
export function allowListed(host, version, { list = PROVISIONAL_ALLOW_LIST } = {}) {
  return list.some((e) => e.host === host && version && cmpVersion(version, e.minVersion) >= 0);
}

/** Which host sent this payload: the --host flag, else Codex's turn_id (Claude Code sends prompt_id). */
export function hostOf(input, { flag = null, env = process.env } = {}) {
  const h = flag ?? env.AD_HOOK_HOST ?? null;
  if (h === "codex" || h === "claude") return h;
  if (h === "claude-code") return "claude"; // the plugin's spelling
  if (h === "ad") return "codex"; // ad's engine speaks Codex's hook protocol
  return input && typeof input === "object" && "turn_id" in input ? "codex" : "claude";
}

/**
 * The JSON a PreToolUse hook prints for a rule decision.
 * @param {"ask"|"deny"} decision  the rule's decision
 * @param {{host:string, permissionMode?:string, reason:string, notice?:string}} ctx
 *   reason: shown to the model; notice: the user's line (reason plus the allow-once and remove commands)
 */
export function toolDecision(decision, { host, permissionMode, reason, notice }) {
  const caps = HOSTS[host] ?? HOSTS.claude;
  // An ask the host can't show, or may skip in this mode, becomes a deny with the reason.
  const final = decision === "ask" && (!caps.ask || caps.denyModes.has(permissionMode)) ? "deny" : decision;
  const out = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: final, permissionDecisionReason: reason },
  };
  if (caps.systemMessage && notice) out.systemMessage = notice;
  return out;
}

/** A user-visible line with no decision (a warning). Null where the host can't show it. */
export function noticeOnly(host, message) {
  return (HOSTS[host] ?? HOSTS.claude).systemMessage && message ? { systemMessage: message } : null;
}
