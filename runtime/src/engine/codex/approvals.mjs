// Approval requests from codex app-server → reply payloads.
//
// Callers answer with one word — accept | acceptForSession | decline |
// cancel — and this file turns it into what each protocol message expects:
//   v2 command / fileChange  → {decision: "accept" | "acceptForSession" | "decline" | "cancel"}
//   v2 permissions           → the grant itself ({permissions: {}} = decline)
//   v1 exec / applyPatch     → {decision: ReviewDecision} ("approved", "denied", …)

export const APPROVAL_METHODS = {
  "item/commandExecution/requestApproval": { kind: "command" },
  "item/fileChange/requestApproval": { kind: "fileChange" },
  "item/permissions/requestApproval": { kind: "permissions" },
  execCommandApproval: { kind: "command", legacy: true },
  applyPatchApproval: { kind: "fileChange", legacy: true },
};

const LEGACY_DECISION = {
  accept: "approved",
  acceptForSession: "approved_for_session",
  decline: "denied",
  cancel: "abort",
};

export function isApprovalMethod(method) {
  return Object.hasOwn(APPROVAL_METHODS, method);
}

export function approvalResponse(method, params = {}, answer = "decline") {
  if (answer && typeof answer === "object") return answer;
  if (!isApprovalMethod(method)) throw new Error(`not an approval request: ${method}`);
  const spec = APPROVAL_METHODS[method];
  const word = Object.hasOwn(LEGACY_DECISION, answer) ? answer : "decline";
  if (spec.kind === "permissions") {
    if (word === "accept" || word === "acceptForSession") {
      return { permissions: params.permissions ?? {}, scope: word === "acceptForSession" ? "session" : "turn" };
    }
    return { permissions: {} };
  }
  if (spec.legacy) return { decision: LEGACY_DECISION[word] };
  return { decision: word };
}
