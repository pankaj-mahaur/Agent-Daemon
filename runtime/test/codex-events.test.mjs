// Codex traffic → ad events (engine/codex/events.mjs, surface.mjs): the
// exhaustiveness contract against the pinned protocol, every handler, items,
// requests, approval options and elicitation forms.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  NOTIFICATION_HANDLERS,
  KNOWN_ITEM_TYPES,
  adaptNotification,
  normalizeItem,
  classifyRequest,
  defaultExecDecisions,
  elicitationResponse,
  SILENT_NOTIFICATIONS,
} from "../src/engine/codex/events.mjs";
import { EXPERIMENTAL_ALLOWLIST, experimentalCapabilities, IGNORED_NOTIFICATIONS, PINNED_NOTIFICATIONS } from "../src/engine/codex/surface.mjs";
import { approvalResponse } from "../src/engine/codex/approvals.mjs";
import { parseNotifications } from "../scripts/codex-notifications.mjs";

const require = createRequire(import.meta.url);

// Every event type a front end may receive (plan "Interfaces", v4.5 additions marked).
const EVENT_TYPES = new Set([
  "thread.started", "thread.status", "thread.name", "thread.goal", "thread.settings", "thread.tokens", "thread.compacted",
  "thread.closed", "thread.archived", "thread.unarchived", "thread.deleted", "thread.reverted",
  "turn.started", "turn.completed", "turn.plan", "turn.diff",
  "item.started", "item.completed", "item.delta",
  "request.opened", "request.resolved", "hook.started", "hook.completed",
  "account", "rateLimits", "mcp.status", "notice", "unknown",
]);
const DELTA_KINDS = new Set(["text", "reasoning", "reasoningPart", "reasoningRaw", "output", "patch", "progress", "terminal", "plan"]);

/* ------------------------------------------------------------------ */
/* Exhaustiveness                                                      */
/* ------------------------------------------------------------------ */

test("the vendored notification list is for the pinned Codex", () => {
  assert.equal(PINNED_NOTIFICATIONS.codexVersion, require("@openai/codex/package.json").version, "run: node scripts/codex-notifications.mjs");
  assert.ok(PINNED_NOTIFICATIONS.stable.length >= 50);
});

test("every stable notification is handled or ignored by name, never both", () => {
  const handled = Object.keys(NOTIFICATION_HANDLERS);
  const ignored = Object.keys(IGNORED_NOTIFICATIONS);
  const missing = PINNED_NOTIFICATIONS.stable.filter((m) => !handled.includes(m) && !ignored.includes(m));
  assert.deepEqual(missing, [], "decide each new notification: a handler in events.mjs or a reason in surface.mjs");
  assert.deepEqual(handled.filter((m) => ignored.includes(m)), []);
  assert.deepEqual(handled.filter((m) => !PINNED_NOTIFICATIONS.stable.includes(m) && !EXPERIMENTAL_ALLOWLIST.notifications.includes(m)), [], "no handler for a method the protocol doesn't have");
});

test("experimental notifications are ignored as experimental and opted out of, except the allowlisted ones, which are handled", () => {
  const { optOutNotificationMethods } = experimentalCapabilities();
  for (const m of PINNED_NOTIFICATIONS.experimental) {
    const allowed = EXPERIMENTAL_ALLOWLIST.notifications.includes(m);
    if (allowed) assert.equal(Object.hasOwn(IGNORED_NOTIFICATIONS, m), false, m);
    else assert.match(IGNORED_NOTIFICATIONS[m], /^experimental/, m);
    assert.equal(Object.hasOwn(NOTIFICATION_HANDLERS, m), allowed, m);
    assert.equal(optOutNotificationMethods.includes(m), !allowed, m);
  }
  for (const m of EXPERIMENTAL_ALLOWLIST.notifications) assert.ok(PINNED_NOTIFICATIONS.experimental.includes(m), `${m} is not an experimental notification of the pinned Codex`);
});

test("thread/settings/updated → thread.settings with the collaboration mode, never Codex's instructions", () => {
  const threadSettings = { model: "gpt-5.5", effort: "medium", collaborationMode: { mode: "plan", settings: { model: "gpt-5.5", reasoning_effort: "medium", developer_instructions: "# Plan Mode ..." } } };
  assert.deepEqual(adaptNotification("thread/settings/updated", { threadId: "t1", threadSettings }), [
    { type: "thread.settings", threadId: "t1", collaborationMode: { mode: "plan", model: "gpt-5.5", effort: "medium" }, model: "gpt-5.5", effort: "medium" },
  ]);
  assert.equal(adaptNotification("thread/settings/updated", { threadId: "t1", threadSettings: {} })[0].collaborationMode, null);
});

test("every ignored notification has a reason and adapts to no events", () => {
  for (const [m, why] of Object.entries(IGNORED_NOTIFICATIONS)) {
    assert.ok(why && why.length > 5, m);
    assert.deepEqual(adaptNotification(m, { threadId: "t" }), [], m);
  }
});

test("an unknown method becomes one 'unknown' event (a release added it; nothing crashes)", () => {
  assert.deepEqual(adaptNotification("thread/teleported", { threadId: "t1" }), [{ type: "unknown", threadId: "t1", method: "thread/teleported" }]);
});

test("every handler survives minimal and empty params and emits only known event types", () => {
  const minimal = { threadId: "t", turnId: "u", itemId: "i", item: { id: "i", type: "agentMessage", text: "x" }, turn: { id: "u", status: "completed" } };
  for (const m of Object.keys(NOTIFICATION_HANDLERS)) {
    for (const params of [minimal, {}]) {
      const events = adaptNotification(m, params);
      assert.ok(Array.isArray(events) && (events.length >= 1 || SILENT_NOTIFICATIONS.has(m)), m);
      for (const ev of events) {
        assert.ok(EVENT_TYPES.has(ev.type), `${m} → ${ev.type}`);
        if (ev.type === "item.delta") assert.ok(DELTA_KINDS.has(ev.kind), `${m} kind ${ev.kind}`);
        if (ev.type === "notice") assert.ok(["info", "warn", "error"].includes(ev.level) && typeof ev.message === "string", m);
        assert.equal(ev.raw, undefined, "raw only in debug mode");
      }
    }
  }
  assert.ok(adaptNotification("warning", { message: "m" }, { debug: true })[0].raw, "debug keeps the raw notification");
});

test("parseNotifications reads plain, renamed and experimental variants", () => {
  const src = `server_notification_definitions! {
    Error => "error" (v2::ErrorNotification),
    #[experimental("thread/queue/changed")]
    ThreadQueueChanged => "thread/queue/changed" (v2::ThreadQueueChangedNotification),
    // a comment
    #[serde(rename = "account/login/completed")]
    #[ts(rename = "account/login/completed")]
    AccountLoginCompleted(v2::AccountLoginCompletedNotification),
}
`;
  assert.deepEqual(parseNotifications(src), [
    { method: "error", variant: "Error", params: "ErrorNotification", experimental: false },
    { method: "thread/queue/changed", variant: "ThreadQueueChanged", params: "ThreadQueueChangedNotification", experimental: true },
    { method: "account/login/completed", variant: "AccountLoginCompleted", params: "AccountLoginCompletedNotification", experimental: false },
  ]);
});

/* ------------------------------------------------------------------ */
/* Notification mappings                                               */
/* ------------------------------------------------------------------ */

test("turn lifecycle, errors and retries", () => {
  assert.deepEqual(adaptNotification("turn/started", { threadId: "t", turn: { id: "u" } }), [{ type: "turn.started", threadId: "t", turnId: "u", turn: { id: "u" } }]);
  const [done] = adaptNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "failed", error: { message: "boom", additionalDetails: "d" } } });
  assert.deepEqual(done, { type: "turn.completed", threadId: "t", turnId: "u", status: "failed", error: { message: "boom", details: "d", info: null } });
  const [retry] = adaptNotification("error", { threadId: "t", turnId: "u", willRetry: true, error: { message: "Reconnecting 1/5" } });
  assert.equal(retry.level, "warn");
  assert.equal(retry.code, "turn.retrying");
  const [fatal] = adaptNotification("error", { threadId: "t", turnId: "u", willRetry: false, error: { message: "usage limit" } });
  assert.equal(fatal.level, "error");
  assert.equal(fatal.details.willRetry, false);
});

test("token usage, plan, diff, goal, name", () => {
  const [tok] = adaptNotification("thread/tokenUsage/updated", {
    threadId: "t",
    tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 }, last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, modelContextWindow: 400000 },
  });
  assert.deepEqual(tok.usage.total, { input: 10, cachedInput: 2, output: 5, reasoning: 1, total: 15 });
  assert.equal(tok.usage.contextWindow, 400000);
  const [plan] = adaptNotification("turn/plan/updated", { threadId: "t", plan: [{ step: "a", status: "completed" }, { step: "b" }], explanation: "why" });
  assert.deepEqual(plan.steps, [{ step: "a", status: "completed" }, { step: "b", status: "pending" }]);
  assert.equal(plan.explanation, "why");
  assert.equal(adaptNotification("turn/diff/updated", { diff: "--- a\n+++ b" })[0].diff, "--- a\n+++ b");
  assert.equal(adaptNotification("thread/goal/cleared", { threadId: "t" })[0].goal, null);
  assert.deepEqual(adaptNotification("thread/goal/updated", { threadId: "t", goal: { objective: "x" } })[0].goal, { objective: "x" });
  assert.equal(adaptNotification("thread/name/updated", { threadId: "t", threadName: "n" })[0].name, "n");
});

test("deltas carry their kind", () => {
  const kinds = {
    "item/agentMessage/delta": "text",
    "item/plan/delta": "plan",
    "item/reasoning/summaryTextDelta": "reasoning",
    "item/reasoning/summaryPartAdded": "reasoningPart",
    "item/reasoning/textDelta": "reasoningRaw",
    "item/commandExecution/outputDelta": "output",
    "item/commandExecution/terminalInteraction": "terminal",
    "item/fileChange/outputDelta": "output",
    "item/fileChange/patchUpdated": "patch",
    "item/mcpToolCall/progress": "progress",
  };
  for (const [m, kind] of Object.entries(kinds)) {
    const [ev] = adaptNotification(m, { threadId: "t", turnId: "u", itemId: "i", delta: "d", stdin: "s", message: "p" });
    assert.equal(ev.type, "item.delta", m);
    assert.equal(ev.kind, kind, m);
    assert.equal(ev.itemId, "i", m);
  }
  const [patch] = adaptNotification("item/fileChange/patchUpdated", { itemId: "i", changes: [{ path: "a.js", kind: { type: "update", move_path: "b.js" }, diff: "@@" }] });
  assert.deepEqual(patch.changes, [{ path: "a.js", kind: "update", movePath: "b.js", diff: "@@" }]);
});

test("requests resolved, hooks, MCP status, account, notices", () => {
  assert.deepEqual(adaptNotification("serverRequest/resolved", { threadId: "t", requestId: 7 })[0], { type: "request.resolved", threadId: "t", requestId: 7 });
  const [hook] = adaptNotification("hook/completed", { threadId: "t", run: { id: "h", eventName: "stop", status: "completed", source: "user", sourcePath: "/x", entries: [{ kind: "feedback", text: "ok" }] } });
  assert.deepEqual(hook.run, { id: "h", event: "stop", status: "completed", source: "user", sourcePath: "/x", durationMs: null, entries: [{ kind: "feedback", text: "ok" }] });
  assert.deepEqual(adaptNotification("mcpServer/startupStatus/updated", { name: "memory", status: "failed", error: "spawn", failureReason: "reauthenticationRequired" })[0], {
    type: "mcp.status",
    server: "memory",
    status: "failed",
    error: "spawn",
    failureReason: "reauthenticationRequired",
  });
  assert.deepEqual(adaptNotification("account/updated", { authMode: "chatgpt", planType: "go" })[0].account, { authMode: "chatgpt", planType: "go" });
  const [rr] = adaptNotification("model/rerouted", { threadId: "t", fromModel: "a", toModel: "b", reason: "x" });
  assert.equal(rr.code, "model.rerouted");
  assert.match(rr.message, /a .* b/);
  assert.equal(adaptNotification("windowsSandbox/setupCompleted", { success: false, mode: "elevated", error: "denied" })[0].level, "error");
});

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

test("every ThreadItem type of the pinned protocol has a normalizer", () => {
  const schema = JSON.parse(readFileSync(new URL("../src/engine/codex/protocol-snapshot.json", import.meta.url), "utf8"));
  const tags = (schema.definitions.ThreadItem?.union ?? []).map((v) => String(v.tag));
  assert.ok(tags.length > 10);
  assert.deepEqual(tags.filter((t) => !KNOWN_ITEM_TYPES.includes(t)), [], "add a normalizer to events.mjs");
});

test("normalizeItem keeps ids and maps fields; unknown types stay visible as unknown", () => {
  assert.deepEqual(normalizeItem({ id: "1", type: "agentMessage", text: "hi", phase: "final" }), { id: "1", kind: "agentMessage", text: "hi", phase: "final" });
  assert.deepEqual(normalizeItem({ id: "2", type: "userMessage", content: [{ type: "text", text: "a" }, { type: "localImage", path: "/i.png" }] }), {
    id: "2",
    kind: "userMessage",
    text: "a\n[image /i.png]",
    clientId: null,
  });
  const cmd = normalizeItem({ id: "3", type: "commandExecution", command: "ls", cwd: "/w", status: "completed", exitCode: 0, aggregatedOutput: "x", commandActions: [] });
  assert.equal(cmd.command, "ls");
  assert.equal(cmd.output, "x");
  assert.equal(cmd.exitCode, 0);
  assert.deepEqual(normalizeItem({ id: "4", type: "fileChange", changes: [{ path: "a", kind: { type: "add" }, diff: "+x" }], status: "completed" }).changes, [
    { path: "a", kind: "add", movePath: null, diff: "+x" },
  ]);
  assert.deepEqual(normalizeItem({ id: "5", type: "hologram" }), { id: "5", kind: "unknown", type: "hologram" });
  assert.deepEqual(normalizeItem(null), { id: null, kind: "unknown", type: null });
  for (const type of KNOWN_ITEM_TYPES) assert.equal(normalizeItem({ id: "x", type }).kind, type, type);
});

/* ------------------------------------------------------------------ */
/* Requests and approval options                                       */
/* ------------------------------------------------------------------ */

test("exec approval: availableDecisions are used verbatim when the request carries them", () => {
  const decisions = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }, "cancel"];
  const req = classifyRequest("item/commandExecution/requestApproval", { threadId: "t", turnId: "u", itemId: "i", command: "npm test", cwd: "/w", availableDecisions: decisions }, 9);
  assert.equal(req.kind, "approval-exec");
  assert.equal(req.id, 9);
  assert.deepEqual(req.options, decisions, "snake_case inner keys untouched");
  assert.deepEqual(req.display, { title: "Run command?", command: "npm test", detail: null, cwd: "/w", reason: null });
});

test("exec approval: without availableDecisions, Codex's default_available_decisions()", () => {
  assert.deepEqual(defaultExecDecisions({}), ["accept", "cancel"]);
  assert.deepEqual(defaultExecDecisions({ proposedExecpolicyAmendment: ["git", "status"] }), [
    "accept",
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } },
    "cancel",
  ]);
  const net = { networkApprovalContext: { host: "pypi.org", protocol: "https" }, proposedNetworkPolicyAmendments: [{ host: "x", action: "deny" }, { host: "pypi.org", action: "allow" }] };
  assert.deepEqual(defaultExecDecisions(net), [
    "accept",
    "acceptForSession",
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "pypi.org", action: "allow" } } },
    "cancel",
  ]);
  assert.deepEqual(defaultExecDecisions({ networkApprovalContext: { host: "h", protocol: "http" } }), ["accept", "acceptForSession", "cancel"]);
});

test("exec approval: a 'don't ask again for this prefix' whose prefix has a line break is dropped", () => {
  const evil = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "ok\nrm -rf /"] } };
  const fromServer = classifyRequest("item/commandExecution/requestApproval", { availableDecisions: ["accept", evil, "cancel"] });
  assert.deepEqual(fromServer.options, ["accept", "cancel"]);
  const fallback = classifyRequest("item/commandExecution/requestApproval", { proposedExecpolicyAmendment: ["a\rb"] });
  assert.deepEqual(fallback.options, ["accept", "cancel"]);
});

test("exec approval displays: network host; writeStdin shows the input escaped", () => {
  const net = classifyRequest("item/commandExecution/requestApproval", { networkApprovalContext: { host: "pypi.org", protocol: "https" }, command: null, cwd: null });
  assert.match(net.display.title, /network access to pypi\.org/);
  const stdin = classifyRequest("item/commandExecution/requestApproval", { kind: "writeStdin", command: "yes\n\x1b[2J" });
  assert.equal(stdin.display.command, JSON.stringify("yes\n\x1b[2J"));
  assert.match(stdin.display.title, /input/);
});

test("patch, permissions and legacy approvals have fixed options", () => {
  assert.deepEqual(classifyRequest("item/fileChange/requestApproval", { itemId: "i" }).options, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.deepEqual(classifyRequest("item/permissions/requestApproval", { permissions: {} }).options, ["turn", "session", "decline"]);
  assert.deepEqual(classifyRequest("execCommandApproval", { conversationId: "c", command: ["ls"] }).options, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.equal(classifyRequest("execCommandApproval", { conversationId: "c" }).threadId, "c");
  assert.equal(classifyRequest("account/chatgptAuthTokens/refresh", {}).kind, "unknown");
});

test("approvalResponse: a decision object is sent only when the request offered exactly it", () => {
  const E = "item/commandExecution/requestApproval";
  const amend = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } };
  assert.deepEqual(approvalResponse(E, { proposedExecpolicyAmendment: ["npm", "test"] }, amend), { decision: amend }, "offered by the fallback");
  assert.deepEqual(approvalResponse(E, { availableDecisions: ["accept", amend, "cancel"] }, amend), { decision: amend }, "offered by availableDecisions");
  const rm = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] } };
  assert.deepEqual(approvalResponse(E, { availableDecisions: ["accept", "cancel"] }, rm), { decision: "decline" }, "a rule nobody offered");
  const evil = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "ok\nrm -rf /"] } };
  assert.deepEqual(approvalResponse(E, { availableDecisions: ["accept", evil] }, evil), { decision: "decline" }, "a prefix the options filtered out");
  const net = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "h", action: "allow" } } };
  const netParams = { networkApprovalContext: { host: "h", protocol: "https" }, proposedNetworkPolicyAmendments: [{ host: "h", action: "allow" }] };
  assert.deepEqual(approvalResponse(E, netParams, net), { decision: net });
  assert.deepEqual(approvalResponse("item/fileChange/requestApproval", {}, amend), { decision: "decline" }, "not for patches");
  assert.deepEqual(approvalResponse("execCommandApproval", {}, amend), { decision: { denied: { rejection: "declined by the user" } } }, "not for v1");
  assert.deepEqual(approvalResponse(E, {}, { decision: "accept" }), { decision: "decline" }, "no whole-response passthrough");
});

test("approvalResponse: permission grants round-trip for turn and session", () => {
  const P = "item/permissions/requestApproval";
  const perms = { network: { enabled: true } };
  for (const option of classifyRequest(P, { permissions: perms }).options) {
    const r = approvalResponse(P, { permissions: perms }, option);
    if (option === "decline") assert.deepEqual(r, { permissions: {} });
    else assert.deepEqual(r, { permissions: perms, scope: option }, option);
  }
});

test("user input requests: questions normalized", () => {
  const req = classifyRequest("item/tool/requestUserInput", {
    threadId: "t",
    turnId: "u",
    itemId: "i",
    isBlocking: true,
    questions: [{ id: "q", header: "H", question: "Pick?", isSecret: true, options: [{ label: "A", description: "first" }] }],
  });
  assert.equal(req.kind, "user-input");
  assert.equal(req.blocking, true);
  assert.deepEqual(req.questions, [{ id: "q", header: "H", question: "Pick?", secret: true, other: false, options: [{ label: "A", description: "first" }] }]);
});

test("elicitation: form fields from requestedSchema", () => {
  const req = classifyRequest("mcpServer/elicitation/request", {
    serverName: "jira",
    threadId: "t",
    mode: "form",
    message: "Details?",
    requestedSchema: {
      type: "object",
      required: ["title", "count"],
      properties: {
        title: { type: "string", title: "Title", maxLength: 80 },
        count: { type: "integer", minimum: 1, maximum: 5 },
        urgent: { type: "boolean", default: false },
        level: { type: "string", enum: ["low", "high"], enumNames: ["Low", "High"] },
        team: { type: "string", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
        tags: { type: "array", items: { enum: ["x", "y"] }, maxItems: 2 },
      },
    },
  });
  assert.equal(req.kind, "elicitation");
  assert.equal(req.form.mode, "form");
  const byName = Object.fromEntries(req.form.fields.map((f) => [f.name, f]));
  assert.equal(byName.title.type, "string");
  assert.equal(byName.title.required, true);
  assert.equal(byName.title.maxLength, 80);
  assert.deepEqual([byName.count.type, byName.count.min, byName.count.max], ["integer", 1, 5]);
  assert.equal(byName.urgent.type, "boolean");
  assert.deepEqual(byName.level.options, [{ value: "low", label: "Low" }, { value: "high", label: "High" }]);
  assert.deepEqual(byName.team.options, [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]);
  assert.deepEqual([byName.tags.type, byName.tags.max], ["multiselect", 2]);
});

test("elicitation: openai/form and openaiForm are one mode; url mode keeps the url", () => {
  for (const mode of ["openai/form", "openaiForm"]) {
    const r = classifyRequest("mcpServer/elicitation/request", { serverName: "s", threadId: "t", mode, message: "m", requestedSchema: { x: 1 } });
    assert.equal(r.form.mode, "openaiForm");
    assert.deepEqual(r.form.schema, { x: 1 });
  }
  const u = classifyRequest("mcpServer/elicitation/request", { serverName: "s", threadId: "t", mode: "url", message: "Sign in", url: "https://x", elicitationId: "e" });
  assert.deepEqual([u.form.mode, u.form.url, u.form.elicitationId], ["url", "https://x", "e"]);
});

test("elicitationResponse: {action, content, _meta}, content only on accept, unknown actions decline", () => {
  assert.deepEqual(elicitationResponse("accept", { a: 1 }), { action: "accept", content: { a: 1 } });
  assert.deepEqual(elicitationResponse("decline", { a: 1 }), { action: "decline" });
  assert.deepEqual(elicitationResponse("bogus"), { action: "decline" });
  assert.deepEqual(elicitationResponse("cancel", null, { k: 1 }), { action: "cancel", _meta: { k: 1 } });
});

test("prefix options hiding characters, or malformed, are dropped; words and real objects stay", () => {
  const E = "item/commandExecution/requestApproval";
  const amend = (prefix) => ({ acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } });
  for (const bad of [["a\u{2028}b"], ["a\u{85}b"], ["a\x0bb"], ["a\x1b[2Kb"], ["ls\u{202e}"], ["rm\u{200b}"], [], "rm", null]) {
    const r = classifyRequest(E, { availableDecisions: ["accept", amend(bad), "cancel"] });
    assert.deepEqual(r.options, ["accept", "cancel"], JSON.stringify(bad));
  }
  const ok = classifyRequest(E, { availableDecisions: ["accept", amend(["npm", "test"]), 42, null, "cancel"] });
  assert.deepEqual(ok.options, ["accept", amend(["npm", "test"]), "cancel"]);
});

test("defaultExecDecisions: additional permissions get accept / cancel only", () => {
  assert.deepEqual(defaultExecDecisions({ additionalPermissions: { network: {} }, proposedExecpolicyAmendment: ["x"] }), ["accept", "cancel"]);
});

test("malformed elicitation schemas don't throw", () => {
  const r = classifyRequest("mcpServer/elicitation/request", {
    serverName: "s",
    threadId: "t",
    mode: "form",
    message: "m",
    requestedSchema: { properties: { a: { type: "string", oneOf: ["x", 3, null] }, b: { type: "array", items: { anyOf: "nope" } }, c: { enum: "no" } } },
  });
  assert.deepEqual(r.form.fields.map((f) => [f.name, f.type, f.options?.length ?? null]), [["a", "select", 0], ["b", "multiselect", 0], ["c", "string", null]]);
});

test("item events carry their timestamps; reasoning deltas their index; audio and image urls are shown", () => {
  assert.equal(adaptNotification("item/started", { item: { id: "i", type: "plan", text: "x" }, startedAtMs: 5 })[0].at, 5);
  assert.equal(adaptNotification("item/completed", { item: { id: "i", type: "plan", text: "x" }, completedAtMs: 9 })[0].at, 9);
  assert.equal(adaptNotification("item/reasoning/summaryTextDelta", { itemId: "r", delta: "d", summaryIndex: 2 })[0].index, 2);
  assert.equal(adaptNotification("item/reasoning/textDelta", { itemId: "r", delta: "d", contentIndex: 1 })[0].index, 1);
  assert.equal(normalizeItem({ id: "u", type: "userMessage", content: [{ type: "image", url: "https://x/i.png" }, { type: "audio" }] }).text, "[image https://x/i.png]\n[audio]");
  assert.equal(adaptNotification("thread/reverted", { threadId: "t" })[0].thread, undefined, "the notification carries no thread");
  assert.ok(adaptNotification("model/safetyBuffering/updated", { showBufferingUi: false })[0].message.length > 0);
});
