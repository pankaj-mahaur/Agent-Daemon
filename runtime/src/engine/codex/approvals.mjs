// Approval requests from codex app-server → reply payloads.
//
// Callers answer with one word — accept | acceptForSession | decline |
// cancel (permissions also: turn | session) — and this file turns it into
// what each protocol message expects:
//   v2 command / fileChange  → {decision: "accept" | "acceptForSession" | "decline" | "cancel"}
//   v2 permissions           → the grant itself ({permissions: {}} = decline)
//   v1 exec / applyPatch     → {decision: ReviewDecision} ("approved", {denied: …}, …)
// A v2 command approval may also be answered with a decision object
// ({acceptWithExecpolicyAmendment} / {applyNetworkPolicyAmendment}). It is
// sent only if it is exactly one of the options the request offered
// (events.mjs classifyRequest): never a rule the user wasn't shown.

import { classifyRequest } from "./events.mjs";

export const APPROVAL_METHODS = {
  "item/commandExecution/requestApproval": { kind: "command" },
  "item/fileChange/requestApproval": { kind: "fileChange" },
  "item/permissions/requestApproval": { kind: "permissions" },
  execCommandApproval: { kind: "command", legacy: true },
  applyPatchApproval: { kind: "fileChange", legacy: true },
};

// codex-rs ReviewDecision (v1) at the pinned tag.
const LEGACY_DECISION = {
  accept: "approved",
  acceptForSession: "approved_for_session",
  decline: { denied: { rejection: "declined by the user" } },
  cancel: "abort",
};

const WORDS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

export function isApprovalMethod(method) {
  return Object.hasOwn(APPROVAL_METHODS, method);
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function approvalResponse(method, params = {}, answer = "decline") {
  if (!isApprovalMethod(method)) throw new Error(`not an approval request: ${method}`);
  const spec = APPROVAL_METHODS[method];
  if (answer && typeof answer === "object") {
    // Only a v2 command approval takes object decisions, and only one it offered.
    const offered = spec.kind === "command" && !spec.legacy && classifyRequest(method, params).options.some((o) => sameValue(o, answer));
    return offered ? { decision: answer } : approvalResponse(method, params, "decline");
  }
  let word = answer;
  if (spec.kind === "permissions") word = answer === "turn" ? "accept" : answer === "session" ? "acceptForSession" : answer;
  if (!WORDS.has(word)) word = "decline";
  if (spec.kind === "permissions") {
    if (word === "accept" || word === "acceptForSession") {
      return { permissions: params.permissions ?? {}, scope: word === "acceptForSession" ? "session" : "turn" };
    }
    return { permissions: {} };
  }
  if (spec.legacy) return { decision: LEGACY_DECISION[word] };
  return { decision: word };
}
