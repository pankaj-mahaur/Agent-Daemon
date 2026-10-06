// Codex app-server traffic → ad's own event vocabulary (plan Part 3a,
// "Interfaces"). Front ends (the TUI, chat, web, ACP) consume AdEvents,
// ViewItems and PendingRequests and never parse protocol shapes themselves,
// so a Codex release changes this file, not the UIs.
//
//   adaptNotification(method, params) → AdEvent[]   ([] when ignored by name)
//   normalizeItem(item)               → ViewItem
//   classifyRequest(method, params, id) → PendingRequest
//
// Every stable notification is either handled here or listed in surface.mjs
// with the reason it is ignored; the exhaustiveness test checks both against
// protocol-notifications.json for the pinned Codex.

import { IGNORED_NOTIFICATIONS } from "./surface.mjs";

const base = (type, params, extra = {}) => {
  const ev = { type };
  if (params?.threadId) ev.threadId = params.threadId;
  if (params?.turnId) ev.turnId = params.turnId;
  return Object.assign(ev, extra);
};

const notice = (params, level, code, message, details) =>
  base("notice", params, { level, code, message: String(message ?? ""), ...(details === undefined ? {} : { details }) });

const delta = (params, kind, text) => {
  const ev = base("item.delta", params, { itemId: params.itemId, kind, delta: String(text ?? "") });
  if (params.summaryIndex != null) ev.index = params.summaryIndex;
  else if (params.contentIndex != null) ev.index = params.contentIndex;
  return ev;
};

function tokens(u) {
  const pick = (b) =>
    b
      ? {
          input: b.inputTokens ?? 0,
          cachedInput: b.cachedInputTokens ?? 0,
          output: b.outputTokens ?? 0,
          reasoning: b.reasoningOutputTokens ?? 0,
          total: b.totalTokens ?? 0,
        }
      : null;
  return { total: pick(u?.total), last: pick(u?.last), contextWindow: u?.modelContextWindow ?? null };
}

function turnError(e) {
  if (!e) return null;
  return { message: String(e.message ?? ""), details: e.additionalDetails ?? null, info: e.codexErrorInfo ?? null };
}

// One handler per stable notification ad uses. Keep in step with surface.mjs.
export const NOTIFICATION_HANDLERS = {
  error: (p) => [
    notice(p, p.willRetry ? "warn" : "error", p.willRetry ? "turn.retrying" : "turn.error", p.error?.message, {
      willRetry: Boolean(p.willRetry),
      error: turnError(p.error),
    }),
  ],
  "thread/started": (p) => [base("thread.started", { threadId: p.thread?.id }, { thread: p.thread ?? null })],
  "thread/status/changed": (p) => [base("thread.status", p, { status: p.status ?? null })],
  "thread/archived": (p) => [base("thread.archived", p)],
  "thread/unarchived": (p) => [base("thread.unarchived", p)],
  "thread/deleted": (p) => [base("thread.deleted", p)],
  "thread/closed": (p) => [base("thread.closed", p)],
  "thread/reverted": (p) => [base("thread.reverted", p)],
  "skills/changed": (p) => [notice(p, "info", "skills.changed", "Skills changed.")],
  "thread/name/updated": (p) => [base("thread.name", p, { name: p.threadName ?? null })],
  "thread/goal/updated": (p) => [base("thread.goal", p, { goal: p.goal ?? null })],
  "thread/goal/cleared": (p) => [base("thread.goal", p, { goal: null })],
  "thread/tokenUsage/updated": (p) => [base("thread.tokens", p, { usage: tokens(p.tokenUsage) })],
  "turn/started": (p) => [base("turn.started", { threadId: p.threadId, turnId: p.turn?.id }, { turn: p.turn ?? null })],
  "turn/completed": (p) => [
    base("turn.completed", { threadId: p.threadId, turnId: p.turn?.id }, { status: p.turn?.status ?? null, error: turnError(p.turn?.error) }),
  ],
  "turn/diff/updated": (p) => [base("turn.diff", p, { diff: String(p.diff ?? "") })],
  "turn/plan/updated": (p) => [
    base("turn.plan", p, {
      steps: (Array.isArray(p.plan) ? p.plan : []).map((s) => ({ step: String(s?.step ?? ""), status: s?.status ?? "pending" })),
      explanation: p.explanation ?? null,
    }),
  ],
  "hook/started": (p) => [base("hook.started", p, { run: hookRun(p.run) })],
  "hook/completed": (p) => [base("hook.completed", p, { run: hookRun(p.run) })],
  "item/started": (p) => [base("item.started", p, { itemId: p.item?.id, item: normalizeItem(p.item), at: p.startedAtMs ?? null })],
  "item/completed": (p) => [base("item.completed", p, { itemId: p.item?.id, item: normalizeItem(p.item), at: p.completedAtMs ?? null })],
  "item/agentMessage/delta": (p) => [delta(p, "text", p.delta)],
  "item/plan/delta": (p) => [delta(p, "plan", p.delta)],
  "item/reasoning/summaryTextDelta": (p) => [delta(p, "reasoning", p.delta)],
  "item/reasoning/summaryPartAdded": (p) => [delta(p, "reasoningPart", "")],
  "item/reasoning/textDelta": (p) => [delta(p, "reasoningRaw", p.delta)],
  "item/commandExecution/outputDelta": (p) => [delta(p, "output", p.delta)],
  "item/commandExecution/terminalInteraction": (p) => [delta(p, "terminal", p.stdin)],
  "item/fileChange/outputDelta": (p) => [delta(p, "output", p.delta)],
  "item/fileChange/patchUpdated": (p) => [
    base("item.delta", p, { itemId: p.itemId, kind: "patch", delta: "", changes: (Array.isArray(p.changes) ? p.changes : []).map(fileChange) }),
  ],
  "item/mcpToolCall/progress": (p) => [delta(p, "progress", p.message)],
  "serverRequest/resolved": (p) => [base("request.resolved", p, { requestId: p.requestId })],
  "mcpServer/startupStatus/updated": (p) => [
    base("mcp.status", p, { server: p.name, status: p.status ?? null, error: p.error ?? null, failureReason: p.failureReason ?? null }),
  ],
  "mcpServer/oauthLogin/completed": (p) =>
    [notice(p, p.success ? "info" : "warn", "mcp.oauth", p.success ? `MCP server ${p.name} signed in.` : `MCP server ${p.name} sign-in failed${p.error ? `: ${p.error}` : ""}.`, { server: p.name })],
  "account/updated": (p) => [base("account", p, { account: { authMode: p.authMode ?? null, planType: p.planType ?? null } })],
  "account/rateLimits/updated": (p) => [base("rateLimits", p, { limits: p.rateLimits ?? null })],
  "account/login/completed": (p) => [
    notice(p, p.success ? "info" : "error", "account.login", p.success ? "Signed in." : `Sign-in failed${p.error ? `: ${p.error}` : ""}.`, { loginId: p.loginId ?? null }),
  ],
  "thread/compacted": (p) => [base("thread.compacted", p)],
  "model/rerouted": (p) => [
    notice(p, "info", "model.rerouted", `OpenAI switched ${p.fromModel} \u{2192} ${p.toModel}`, { from: p.fromModel, to: p.toModel, reason: p.reason ?? null }),
  ],
  "model/verification": (p) => [notice(p, "info", "model.verification", "Model verification required.", { verifications: p.verifications ?? [] })],
  "model/safetyBuffering/updated": (p) => [
    notice(p, "info", "model.safetyBuffering", p.showBufferingUi ? "Response is being checked before it is shown." : "Response check finished.", {
      model: p.model ?? null,
      fasterModel: p.fasterModel ?? null,
      show: Boolean(p.showBufferingUi),
    }),
  ],
  "modelProvider/authRecoveryStarted": (p) => [notice(p, "warn", "provider.authRecovery", p.message ?? "Re-authenticating with the model provider.", { provider: p.provider ?? null, done: false })],
  "modelProvider/authRecoveryCompleted": (p) => [notice(p, "info", "provider.authRecovery", p.message ?? "Re-authenticated.", { provider: p.provider ?? null, done: true })],
  warning: (p) => [notice(p, "warn", "warning", p.message)],
  guardianWarning: (p) => [notice(p, "warn", "guardian", p.message)],
  // [UNSTABLE upstream] Codex's automatic approval reviewer. Its verdicts show
  // as notices; the start is silent (the completion says it all).
  "item/autoApprovalReview/started": () => [],
  "item/autoApprovalReview/completed": (p) => {
    const r = p.review ?? {};
    const what = autoReviewAction(p.action);
    if (r.status === "approved") return [notice(p, "info", "autoReview.approved", `Auto-review approved${what ? `: ${what}` : ""}.`)];
    if (r.status === "denied") return [notice(p, "warn", "autoReview.denied", `Auto-review denied${what ? ` ${what}` : ""}${r.rationale ? ` (${r.rationale})` : ""}. To allow it anyway, use /codex.`)];
    if (r.status === "timedOut" || r.status === "aborted") return [notice(p, "warn", `autoReview.${r.status}`, `Auto-review ${r.status === "timedOut" ? "timed out" : "was aborted"}${what ? ` for ${what}` : ""}.`)];
    return [notice(p, "info", "autoReview", `Auto-review finished${what ? ` for ${what}` : ""}.`)];
  },
  deprecationNotice: (p) => [notice(p, "info", "deprecation", p.summary, p.details ?? undefined)],
  configWarning: (p) => [notice(p, "warn", "config", p.summary, { path: p.path ?? null, details: p.details ?? null })],
  "windows/worldWritableWarning": (p) => [
    notice(p, "warn", "windows.worldWritable", "Some folders are writable by everyone, so the sandbox can't protect them.", {
      paths: p.samplePaths ?? [],
      more: p.extraCount ?? 0,
      failedScan: Boolean(p.failedScan),
    }),
  ],
  "windowsSandbox/setupCompleted": (p) => [
    notice(p, p.success ? "info" : "error", "windowsSandbox.setup", p.success ? `Windows sandbox ready (${p.mode}).` : `Windows sandbox setup failed${p.error ? `: ${p.error}` : ""}.`, { mode: p.mode ?? null, success: Boolean(p.success) }),
  ],
};

// A short description of what an auto-review looked at.
function autoReviewAction(a) {
  if (!a || typeof a !== "object") return "";
  if (a.type === "command") return `\`${a.command ?? ""}\``;
  if (a.type === "execve") return `\`${[a.program, ...(a.argv ?? []).slice(1)].join(" ")}\``;
  if (a.type === "applyPatch") return `edits to ${(a.files ?? []).length} file(s)`;
  if (a.type === "networkAccess") return `network access to ${a.host ?? a.target ?? "a host"}`;
  if (a.type === "mcpToolCall") return `${a.server ?? "MCP"}.${a.toolName ?? "tool"}`;
  if (a.type === "writeStdin") return "input to a running command";
  if (a.type === "requestPermissions") return "extra permissions";
  return "";
}

/** Notifications handled on purpose with no event (the next one carries the news). */
export const SILENT_NOTIFICATIONS = new Set(["item/autoApprovalReview/started"]);

function hookRun(run) {
  const r = run ?? {};
  return {
    id: r.id ?? null,
    event: r.eventName ?? null,
    status: r.status ?? null,
    source: r.source ?? "unknown",
    sourcePath: r.sourcePath ?? null,
    durationMs: r.durationMs ?? null,
    entries: (Array.isArray(r.entries) ? r.entries : []).map((e) => ({ kind: e?.kind ?? "text", text: String(e?.text ?? "") })),
  };
}

/** One notification → zero or more AdEvents. Unknown methods become {type:"unknown"}. */
export function adaptNotification(method, params = {}, { debug = false } = {}) {
  const handler = Object.hasOwn(NOTIFICATION_HANDLERS, method) ? NOTIFICATION_HANDLERS[method] : null;
  if (!handler) {
    if (Object.hasOwn(IGNORED_NOTIFICATIONS, method)) return [];
    return [base("unknown", params, { method })];
  }
  const events = handler(params ?? {});
  if (debug) for (const ev of events) ev.raw = { method, params };
  return events;
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

const KIND_NAMES = { add: "add", delete: "delete", update: "update" };

function fileChange(change) {
  const c = change ?? {};
  const k = c.kind?.type ?? c.kind;
  return { path: c.path ?? "", kind: KIND_NAMES[k] ?? "update", movePath: c.kind?.move_path ?? null, diff: String(c.diff ?? "") };
}

function userText(content) {
  return (Array.isArray(content) ? content : [])
    .map((c) => {
      if (c?.type === "text") return c.text ?? "";
      if (c?.type === "localImage") return `[image ${c.path}]`;
      if (c?.type === "image") return c.url ? `[image ${c.url}]` : "[image]";
      if (c?.type === "audio" || c?.type === "localAudio") return "[audio]";
      if (c?.type === "skill" || c?.type === "mention") return `@${c.name ?? c.path ?? ""}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const ITEM_NORMALIZERS = {
  userMessage: (i) => ({ text: userText(i.content), clientId: i.clientId ?? null }),
  hookPrompt: (i) => ({ text: (i.fragments ?? []).map((f) => f.text ?? "").join("\n") }),
  agentMessage: (i) => ({ text: String(i.text ?? ""), phase: i.phase ?? null }),
  functionCallOutput: (i) => ({ name: i.name ?? null, namespace: i.namespace ?? null, output: i.output ?? null }),
  plan: (i) => ({ text: String(i.text ?? "") }),
  reasoning: (i) => ({ summary: (i.summary ?? []).map(String), content: (i.content ?? []).map(String) }),
  commandExecution: (i) => ({
    command: String(i.command ?? ""),
    cwd: i.cwd ?? null,
    status: i.status ?? null,
    exitCode: i.exitCode ?? null,
    durationMs: i.durationMs ?? null,
    output: i.aggregatedOutput ?? null,
    actions: i.commandActions ?? [],
    source: i.source ?? null,
  }),
  fileChange: (i) => ({ changes: (i.changes ?? []).map(fileChange), status: i.status ?? null }),
  mcpToolCall: (i) => ({
    server: i.server ?? null,
    tool: i.tool ?? null,
    status: i.status ?? null,
    arguments: i.arguments ?? null,
    result: i.result ?? null,
    error: i.error ?? null,
    durationMs: i.durationMs ?? null,
  }),
  dynamicToolCall: (i) => ({
    namespace: i.namespace ?? null,
    tool: i.tool ?? null,
    status: i.status ?? null,
    arguments: i.arguments ?? null,
    success: i.success ?? null,
    durationMs: i.durationMs ?? null,
  }),
  collabAgentToolCall: (i) => ({
    tool: i.tool ?? null,
    status: i.status ?? null,
    prompt: i.prompt ?? null,
    model: i.model ?? null,
    senderThreadId: i.senderThreadId ?? null,
    receiverThreadIds: i.receiverThreadIds ?? [],
    agents: i.agentsStates ?? null,
  }),
  subAgentActivity: (i) => ({ agentPath: i.agentPath ?? null, agentThreadId: i.agentThreadId ?? null, activity: i.kind ?? null }),
  webSearch: (i) => ({ query: i.query ?? null, action: i.action ?? null }),
  imageView: (i) => ({ path: i.path ?? null }),
  sleep: (i) => ({ durationMs: i.durationMs ?? null }),
  imageGeneration: (i) => ({ status: i.status ?? null, savedPath: i.savedPath ?? null, revisedPrompt: i.revisedPrompt ?? null, failure: i.failure ?? null }),
  enteredReviewMode: (i) => ({ review: i.review ?? null }),
  exitedReviewMode: (i) => ({ review: i.review ?? null }),
  contextCompaction: () => ({}),
};

export const KNOWN_ITEM_TYPES = Object.keys(ITEM_NORMALIZERS);

/** ThreadItem → ViewItem {id, kind, ...fields}. Unknown types keep kind "unknown". */
export function normalizeItem(item) {
  if (!item || typeof item !== "object") return { id: null, kind: "unknown", type: null };
  const n = Object.hasOwn(ITEM_NORMALIZERS, item.type) ? ITEM_NORMALIZERS[item.type] : null;
  if (!n) return { id: item.id ?? null, kind: "unknown", type: item.type ?? null };
  return { id: item.id ?? null, kind: item.type, ...n(item) };
}

/* ------------------------------------------------------------------ */
/* Server requests                                                     */
/* ------------------------------------------------------------------ */

const REQUEST_KINDS = {
  "item/commandExecution/requestApproval": "approval-exec",
  execCommandApproval: "approval-exec",
  "item/fileChange/requestApproval": "approval-patch",
  applyPatchApproval: "approval-patch",
  "item/permissions/requestApproval": "approval-permissions",
  "item/tool/requestUserInput": "user-input",
  "mcpServer/elicitation/request": "elicitation",
  "item/tool/call": "tool-call",
};

export const PATCH_OPTIONS = ["accept", "acceptForSession", "decline", "cancel"];
export const PERMISSION_OPTIONS = ["turn", "session", "decline"];
const LEGACY_EXEC_OPTIONS = ["accept", "acceptForSession", "decline", "cancel"];

// Controls, format characters (bidi, zero-width) and line/paragraph separators
// could make a "don't ask again" prefix read differently from what it is.
const hasHiddenChars = (parts) => parts.some((p) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(String(p)));

/**
 * Codex's default_available_decisions() (codex-rs/protocol/src/approvals.rs at
 * the pinned tag), in v2 decision values, for when the request doesn't carry
 * the (experimental) availableDecisions field.
 */
export function defaultExecDecisions(p = {}) {
  if (p.networkApprovalContext) {
    const out = ["accept", "acceptForSession"];
    const allow = (p.proposedNetworkPolicyAmendments ?? []).find((a) => a?.action === "allow");
    if (allow) out.push({ applyNetworkPolicyAmendment: { network_policy_amendment: allow } });
    out.push("cancel");
    return out;
  }
  if (p.additionalPermissions) return ["accept", "cancel"];
  const out = ["accept"];
  if (Array.isArray(p.proposedExecpolicyAmendment) && p.proposedExecpolicyAmendment.length) {
    out.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment } });
  }
  out.push("cancel");
  return out;
}

/**
 * "Don't ask again for this prefix" is dropped when the prefix is malformed or
 * hides characters; options that are neither words nor objects are dropped.
 */
function safeExecOptions(options) {
  return options.filter((o) => {
    if (typeof o === "string") return true;
    if (!o || typeof o !== "object") return false;
    if (!Object.hasOwn(o, "acceptWithExecpolicyAmendment")) return true;
    const prefix = o.acceptWithExecpolicyAmendment?.execpolicy_amendment;
    return Array.isArray(prefix) && prefix.length > 0 && !hasHiddenChars(prefix);
  });
}

export function execDisplay(p = {}) {
  if (p.networkApprovalContext) {
    const n = p.networkApprovalContext;
    return { title: `Allow network access to ${n.host}?`, command: null, detail: `${n.protocol ?? "network"} ${n.host}` };
  }
  const command = Array.isArray(p.command) ? p.command.join(" ") : (p.command ?? "");
  if (p.kind === "writeStdin") return { title: "Send input to the running command?", command: JSON.stringify(command), detail: null };
  return { title: "Run command?", command, detail: null };
}

function elicitationFields(schema) {
  const props = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(props).map(([name, s = {}]) => {
    const f = { name, title: s.title ?? name, description: s.description ?? null, required: required.has(name), default: s.default ?? null };
    const choices = (list, labels) => (Array.isArray(list) ? list : []).map((v, i) => ({ value: v, label: Array.isArray(labels) && labels[i] != null ? String(labels[i]) : String(v) }));
    const titled = (list) => (Array.isArray(list) ? list : []).filter((o) => o && typeof o === "object" && "const" in o).map((o) => ({ value: o.const, label: o.title ?? String(o.const) }));
    if (s.type === "array") {
      const it = s.items ?? {};
      return { ...f, type: "multiselect", options: it.enum ? choices(it.enum, it.enumNames) : titled(it.anyOf ?? it.oneOf), min: s.minItems ?? null, max: s.maxItems ?? null };
    }
    if (Array.isArray(s.enum)) return { ...f, type: "select", options: choices(s.enum, s.enumNames) };
    if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return { ...f, type: "select", options: titled(s.oneOf ?? s.anyOf) };
    if (s.type === "boolean") return { ...f, type: "boolean" };
    if (s.type === "number" || s.type === "integer") return { ...f, type: s.type, min: s.minimum ?? null, max: s.maximum ?? null };
    return { ...f, type: "string", format: s.format ?? null, minLength: s.minLength ?? null, maxLength: s.maxLength ?? null };
  });
}

/**
 * A server request → PendingRequest {id, kind, threadId, turnId, itemId,
 * agentLabel, params, options, display?, questions?, form?}.
 */
export function classifyRequest(method, params = {}, id = null, { agentLabel = null } = {}) {
  const p = params ?? {};
  const kind = Object.hasOwn(REQUEST_KINDS, method) ? REQUEST_KINDS[method] : "unknown";
  const req = {
    id,
    method,
    kind,
    threadId: p.threadId ?? p.conversationId ?? null,
    turnId: p.turnId ?? null,
    itemId: p.itemId ?? p.callId ?? null,
    agentLabel,
    params: p,
    options: [],
  };
  if (kind === "approval-exec") {
    const legacy = method === "execCommandApproval";
    // availableDecisions is experimental but sent today: use it verbatim when present.
    const raw = legacy ? LEGACY_EXEC_OPTIONS : Array.isArray(p.availableDecisions) ? p.availableDecisions : defaultExecDecisions(p);
    req.options = safeExecOptions(raw);
    req.display = { ...execDisplay(p), cwd: p.cwd ?? null, reason: p.reason ?? null };
  } else if (kind === "approval-patch") {
    req.options = PATCH_OPTIONS;
    req.display = { title: "Apply file changes?", grantRoot: p.grantRoot ?? null, reason: p.reason ?? null };
  } else if (kind === "approval-permissions") {
    req.options = PERMISSION_OPTIONS;
    req.display = { title: "Grant extra permissions?", permissions: p.permissions ?? null, cwd: p.cwd ?? null, reason: p.reason ?? null };
  } else if (kind === "user-input") {
    req.questions = (p.questions ?? []).map((q) => ({
      id: q.id,
      header: q.header ?? "",
      question: q.question ?? "",
      secret: Boolean(q.isSecret),
      other: Boolean(q.isOther),
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? null })),
    }));
    req.blocking = p.isBlocking !== false;
  } else if (kind === "elicitation") {
    const mode = p.mode === "openai/form" || p.mode === "openaiForm" ? "openaiForm" : p.mode;
    req.form = {
      mode,
      server: p.serverName ?? null,
      message: String(p.message ?? ""),
      url: mode === "url" ? (p.url ?? null) : null,
      elicitationId: p.elicitationId ?? null,
      fields: mode === "form" ? elicitationFields(p.requestedSchema) : [],
      schema: mode === "openaiForm" ? (p.requestedSchema ?? null) : null,
    };
    req.options = ["accept", "decline", "cancel"];
  }
  return req;
}

/** The JSON-RPC result for an elicitation answer. */
export function elicitationResponse(action, content = null, meta = undefined) {
  const out = { action: ["accept", "decline", "cancel"].includes(action) ? action : "decline" };
  if (out.action === "accept" && content != null) out.content = content;
  if (meta !== undefined) out._meta = meta;
  return out;
}
