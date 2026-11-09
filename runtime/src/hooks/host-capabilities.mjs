// What each host can do with a hook's answer (plan 02 §3, from the L0 S-HOOKS
// captures: Claude Code 2.1.314, Codex 0.164.0).
//
//                      ask            deny          fail-closed on error   shows systemMessage
//   Claude Code        yes*           yes           onFailure:"block"      yes
//   Codex              no (fails open) yes (JSON)    no                     yes (a warning entry; never the model)
//   * in bypassPermissions and dontAsk a hook "ask" may be skipped, so it is sent as deny.
//
// The provisional allow-list (02 §2.1, L5 decision 4) is empty at launch: no host gives a
// positive signal for a typed prompt yet, so every capture waits for review.

export const HOSTS = Object.freeze({
  claude: {
    name: "Claude Code",
    ask: true,
    // The modes where a hook's ask reaches the user (S-HOOKS; auto reports default).
    askModes: new Set(["default", "acceptEdits", "plan", "auto"]),
    denyModes: new Set(["bypassPermissions", "dontAsk"]),
    failClosed: "onFailure",
    minFailClosedVersion: "2.1.295",
    systemMessage: true,
  },
  codex: {
    name: "Codex",
    ask: false,
    askModes: new Set(),
    denyModes: new Set(),
    failClosed: null,
    minFailClosedVersion: null,
    // L7 P0: Codex shows a hook's systemMessage to the user (a warning entry) and doesn't send it to the model.
    systemMessage: true,
  },
});

/**
 * Hosts whose typed prompts may become provisional notes (L5 design decision 4). An entry
 * names a POSITIVE signal (a missing field is never enough), the first host version that
 * sends it, and where the host's own executable lives (the hook's parent must be it). It
 * stays empty until L6 serves provisional notes, L7's self-protection is live and the
 * S-L5-PARENT spike shows a difference the agent can't fake between a hook and the
 * agent's own Bash tool (both are children of the host).
 * @type {{host:string, signal:string, minVersion:string, parentExe:RegExp}[]}
 */
export const PROVISIONAL_ALLOW_LIST = Object.freeze([]);

/** Positive signals an allow-list entry may name: each must hold on the payload itself. */
export const SIGNALS = Object.freeze({
  // Claude Code's UserPromptSubmit `source` field (rolling out; absent in 2.1.314).
  "source-user": (input) => input?.source === "user",
});

/** The allow-list entry this payload's host and signal match, or null. */
export function allowEntry(input, host, { list = PROVISIONAL_ALLOW_LIST } = {}) {
  return list.find((e) => e.host === host && typeof SIGNALS[e.signal] === "function" && SIGNALS[e.signal](input)) ?? null;
}

/** Compare dotted versions ("2.1.314" vs "2.1.295"): negative, zero or positive. */
export const cmpVersion = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** Is this version at or above the entry's floor? An unknown version never is. */
export function versionOk(entry, version) {
  return Boolean(entry && version && cmpVersion(version, entry.minVersion) >= 0);
}

/** Which host sent this payload: the --host flag, else Codex's turn_id (Claude Code sends prompt_id). */
export function hostOf(input, { flag = null, env = process.env } = {}) {
  const h = flag ?? env.AD_HOOK_HOST ?? null;
  if (h === "codex" || h === "claude") return h;
  if (h === "claude-code") return "claude"; // the plugin's spelling
  if (h === "ad") return "codex"; // ad's engine speaks Codex's hook protocol
  return input && typeof input === "object" && "turn_id" in input ? "codex" : "claude";
}

// Claude Code's hook events (code.claude.com hooks reference).
const CLAUDE_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "SubagentStart", "Notification", "PreCompact", "PermissionRequest"]);

/**
 * The host whose context recall may write into (plan L6, design decision 11), from a
 * positive signal only: the --host flag (codex, ad, claude), the plugin's own hook, a
 * Codex payload (turn_id), or a Claude Code payload (its exact event name and a session
 * id) inside a Claude Code hook (CLAUDE_PROJECT_DIR set). Anything else — a host that
 * merely reads Claude Code's hook files — is "unknown" and gets no recalled context.
 * @returns {"claude"|"codex"|"unknown"}
 */
export function contextHost(input, { flag = null, plugin = false, env = process.env } = {}) {
  const h = flag ?? env.AD_HOOK_HOST ?? null;
  if (h === "codex" || h === "ad") return "codex";
  if (h === "claude" || h === "claude-code" || plugin) return "claude";
  if (input && typeof input === "object" && "turn_id" in input) return "codex";
  if (input && typeof input === "object" && CLAUDE_EVENTS.has(input.hook_event_name) && typeof input.session_id === "string" && input.session_id && env.CLAUDE_PROJECT_DIR) return "claude";
  return "unknown";
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
  // Only the modes known to show an ask ask; anything else — a bypass mode, a missing or
  // garbled one, one a later version adds — denies (L7 D7).
  const final = decision === "ask" && (!caps.ask || !caps.askModes.has(permissionMode)) ? "deny" : decision;
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
