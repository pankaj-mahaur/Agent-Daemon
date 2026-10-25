// P6.1b: the REAL pinned engine → ad's gateway (a "chat" route) → a scripted Chat provider
// (testkit/mock-chat.mjs). Asserts what ran and how many upstream calls were made, not
// event shapes: a tool runs once, an interrupt hangs up upstream, a used-up quota is asked
// once, a cut-off is retried exactly once, a too-long context ends the turn.
//
// Opt-in: AD_REAL_ENGINE=1. Throwaway home and folders; never the user's own engine home.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { TOKEN_HIDDEN_ARGS } from "../src/gateway/table.mjs";
import { chat, defaultChatScript, lastUserText, startMockChat } from "../testkit/mock-chat.mjs";
import { startMockOpencode } from "../testkit/mock-opencode.mjs";
import { gatewayTable, PRESETS } from "../src/gateway/table.mjs";

const PINNED = resolveCodexCommand({});
const wanted = process.env.AD_REAL_ENGINE === "1";
const skip = wanted ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TURN_MS = 90_000;
const TOKEN = ["gw", "token", "a".repeat(30)].join("-");
const KEY = ["gsk", "real", "engine", "4444555566667777"].join("_");
const ENTRY = "ad-groq-real";
const GO_ENTRY = "ad-opencode-go-real";
const GO_KEY = ["go", "real", "engine", "8888999900001111"].join("_");
const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello through the gateway\n*** End Patch";
const isWin = process.platform === "win32";

function script(body, { count }) {
  const last = body?.messages?.at(-1);
  const text = lastUserText(body);
  if (last?.role === "tool") return { chunks: [chat.text(`done after ${last.tool_call_id}`), chat.finish("stop", chat.usage), "[DONE]"] };
  if (text.includes("PATCHIT")) return { chunks: [chat.call(0, { id: "p", name: "exec_command", args: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${PATCH}\nEOF\n` }) }), chat.finish("tool_calls", chat.usage), "[DONE]"] };
  if (text.includes("NSCALL")) return { chunks: [chat.call(0, { id: "n", name: "multi_agent_v1__close_agent", args: JSON.stringify({ target: "no-such-agent" }) }), chat.finish("tool_calls", chat.usage), "[DONE]"] };
  if (text.includes("ENVDUMP")) return { chunks: [chat.call(0, { id: "e", name: "exec_command", args: JSON.stringify({ cmd: isWin ? "cmd.exe /d /c set" : "env" }) }), chat.finish("tool_calls", chat.usage), "[DONE]"] };
  if (text.includes("HOLD")) return { hold: [chat.text("waiting")], after: [chat.finish("stop"), "[DONE]"] };
  if (text.includes("QUOTA")) return { chunks: [chat.text("par"), { error: { message: "You have used up today's free tokens (tokens per day)", code: "rate_limit_exceeded" } }] };
  if (text.includes("NOUSAGE")) return { chunks: [chat.text("no usage here"), chat.finish("stop"), "[DONE]"] };
  if (text.includes("RATE")) return { status: 429, json: { error: { message: "Rate limit reached on requests per minute (RPM). Please try again in 1s." } }, headers: { "retry-after": "1" } };
  if (text.includes("CUTOFF")) return count === 1 ? { chunks: [chat.text("half")], destroy: true } : { chunks: [chat.text("whole"), chat.finish("stop", chat.usage), "[DONE]"] };
  if (text.includes("TOOLONG")) return { status: 400, json: { error: { message: "This model's maximum context length is 8192 tokens. Please reduce the length of the messages." } } };
  return defaultChatScript(body);
}

let mock;
let goMock;
let gw;
let server;
let home;
let cwd;
const events = [];

before(async () => {
  if (!wanted) return;
  mock = await startMockChat({ script });
  goMock = await startMockOpencode({ keys: [GO_KEY] });
  const goRoutes = gatewayTable({ accounts: [{ id: "acct_go", provider: "opencode-go", label: "go", method: "api-key", status: "ready", providerEntry: GO_ENTRY }] }, { presets: { ...PRESETS, "opencode-go": { ...PRESETS["opencode-go"], baseUrl: goMock.base } } });
  for (const r of goRoutes.values()) r.allowHttp = true;
  const table = new Map([...goRoutes, [ENTRY, { accountId: "acct_real", provider: "groq", upstreamBase: mock.url, mode: "chat", upstreamPath: "/chat/completions", quirks: [], model: {}, auth: { kind: "static-key", scheme: "bearer" }, headers: {}, allowHttp: true, label: "Groq" }]]);
  gw = createGatewayServer({ token: TOKEN, table, keys: { acct_real: KEY, acct_go: GO_KEY }, onUpstream: (e) => events.push(e) });
  const port = await gw.listen();
  home = mkdtempSync(join(tmpdir(), "ad-tr-home-"));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "ad-tr-work-")));
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "llama-x"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_provider = "trans"',
      "check_for_update_on_startup = false",
      'cli_auth_credentials_store = "file"',
      "",
      "[features]",
      "plugins = false",
      "apps = false",
      "shell_snapshot = false",
      "unbounded_connection_retries = false",
      "",
      "[model_providers.trans]",
      'name = "Groq · test"',
      `base_url = "http://127.0.0.1:${port}/p/${ENTRY}/v1"`,
      'env_key = "AD_GATEWAY_TOKEN"',
      'wire_api = "responses"',
      "request_max_retries = 1",
      "stream_max_retries = 1",
      "supports_websockets = false",
      "",
      "[model_providers.go]",
      'name = "OpenCode Go · go"',
      `base_url = "http://127.0.0.1:${port}/p/${GO_ENTRY}/v1"`,
      'env_key = "AD_GATEWAY_TOKEN"',
      'wire_api = "responses"',
      "request_max_retries = 1",
      "stream_max_retries = 1",
      "supports_websockets = false",
      "",
    ].join("\n"),
  );
  server = new CodexAppServer({
    command: PINNED,
    cwd,
    env: { CODEX_HOME: home, AD_GATEWAY_TOKEN: TOKEN },
    codexArgs: [...TOKEN_HIDDEN_ARGS], // as startHarnessEngine passes them with the token
    clientVersion: "test",
    initTimeoutMs: 120_000,
    onServerRequest: async ({ method, params }) => {
      if (isApprovalMethod(method)) return approvalResponse(method, params, "accept");
      throw Object.assign(new Error(`unhandled ${method}`), { code: -32601 });
    },
  });
  await server.start();
});

after(async () => {
  if (!wanted) return;
  await server?.close().catch(() => {});
  await gw?.close();
  await mock?.close();
  await goMock?.close();
  for (const d of [home, cwd]) for (let i = 0; i < 20; i++) {
    try {
      rmSync(d, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

async function turn(text, { interruptWhenHeld = false, thread: threadParams = {} } = {}) {
  const { thread } = await server.request("thread/start", { cwd, ...threadParams });
  const notes = [];
  const on = (n) => n.params?.threadId === thread.id && notes.push(n);
  server.on("notification", on);
  try {
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`turn ${text} didn't finish`)), TURN_MS);
      server.on("notification", function f({ method, params }) {
        if (method === "turn/completed" && params.threadId === thread.id) {
          clearTimeout(t);
          server.off("notification", f);
          resolve(params);
        }
      });
    });
    const { turn: started } = await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
    if (interruptWhenHeld) {
      await mock.held();
      await server.request("turn/interrupt", { threadId: thread.id, turnId: started.id });
    }
    const completed = await done;
    return { threadId: thread.id, completed, notes, items: notes.filter((n) => n.method === "item/completed").map((n) => n.params.item), errors: notes.filter((n) => n.method === "error").map((n) => n.params) };
  } finally {
    server.off("notification", on);
  }
}

const upstream = (word) => mock.requests.filter((r) => lastUserText(r.body).includes(word));
const status = (c) => c.turn?.status ?? c.status;
const errInfo = (r) => JSON.stringify([r.completed.turn?.error ?? null, r.errors]);
const opts = { skip, timeout: 240_000 };

test("PING: reasoning and text arrive through the translation", opts, async () => {
  const r = await turn("PING");
  assert.equal(status(r.completed), "completed", errInfo(r));
  assert.equal(r.items.find((i) => i.type === "agentMessage")?.text, "pong");
  assert.equal(upstream("PING")[0].authorization, `Bearer ${KEY}`);
});

test("SHELL: a tool call split across chunks runs exactly once", opts, async () => {
  const before = mock.requests.length;
  const r = await turn("SHELL");
  assert.equal(status(r.completed), "completed", errInfo(r));
  const results = mock.requests.slice(before).filter((q) => q.body?.messages?.at(-1)?.role === "tool");
  assert.equal(results.length, 1, "one tool result went back");
  assert.match(String(results[0].body.messages.at(-1).content), /hi/);
});

test("PATCH through exec_command applies once", opts, async () => {
  const r = await turn("PATCHIT");
  assert.equal(status(r.completed), "completed", errInfo(r));
  assert.ok(existsSync(join(cwd, "hello.txt")), "the patch ran");
  assert.match(readFileSync(join(cwd, "hello.txt"), "utf8"), /through the gateway/);
});

test("a namespaced tool goes back to its namespace and runs once", opts, async () => {
  const before = mock.requests.length;
  const r = await turn("NSCALL");
  assert.equal(status(r.completed), "completed", errInfo(r));
  const results = mock.requests.slice(before).filter((q) => q.body?.messages?.at(-1)?.role === "tool");
  assert.equal(results.length, 1, `the engine ran it and answered: ${JSON.stringify(results.map((q) => q.body.messages.at(-1).content))}`);
  assert.doesNotMatch(String(results[0].body.messages.at(-1).content), /unsupported|unknown tool|not found: multi_agent_v1__/i);
});

test("HOLD + interrupt: the gateway hangs up upstream", opts, async () => {
  await turn("HOLD", { interruptWhenHeld: true });
  for (let i = 0; i < 40 && mock.hangups < 1; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(mock.hangups, 1);
});

test("a used-up daily quota mid-stream ends the turn after exactly one upstream call", opts, async () => {
  const r = await turn("QUOTA");
  assert.notEqual(status(r.completed), "completed");
  assert.match(errInfo(r), /usageLimitExceeded|usage_limit|quota/i, errInfo(r));
  assert.equal(upstream("QUOTA").length, 1);
  // The gateway knows which conversation it was, so ad shows its own reason there.
  const ev = events.findLast((e) => e.translate?.kind === "quotaExhausted");
  assert.equal(ev?.threadId, r.threadId, "the engine sends its thread id in client_metadata");
  const { gatewayReason } = await import("../src/harness/gateway-runtime.mjs");
  const source = { lastForThread: (id) => events.findLast((e) => e.threadId === id) ?? null };
  assert.match(gatewayReason({ threadId: r.threadId, sinceMs: Date.now() - 60_000, source }) ?? "", /daily limit is used up/);
});

test("a provider without usage: exactly one upstream call", opts, async () => {
  const r = await turn("NOUSAGE");
  assert.equal(status(r.completed), "completed", errInfo(r));
  assert.equal(upstream("NOUSAGE").length, 1);
});

test("a per-minute 429: at most two upstream calls", opts, async () => {
  await turn("RATE");
  assert.ok(upstream("RATE").length <= 2, `${upstream("RATE").length} calls`);
});

test("a cut-off stream: exactly one retry, which completes the turn", opts, async () => {
  const r = await turn("CUTOFF");
  assert.equal(upstream("CUTOFF").length, 2);
  assert.equal(status(r.completed), "completed", errInfo(r));
  assert.equal(r.items.filter((i) => i.type === "agentMessage").at(-1)?.text, "whole");
});

test("context too long: the turn ends with a context error after one upstream call", opts, async () => {
  const r = await turn("TOOLONG");
  assert.notEqual(status(r.completed), "completed");
  assert.match(errInfo(r), /contextWindowExceeded|context/i, errInfo(r));
  assert.equal(upstream("TOOLONG").length, 1);
});

test("a tool printing its environment shows no key and no token", opts, async () => {
  const before = mock.requests.length;
  await turn("ENVDUMP");
  const out = JSON.stringify(mock.requests.slice(before).map((q) => q.body));
  assert.match(out, /PATH=|Path=/, "the dump really went back to the model");
  assert.ok(!out.includes(KEY), "the provider key");
  assert.ok(!out.includes(TOKEN), "the gateway token");
  assert.ok(!JSON.stringify(events).includes(KEY) && !JSON.stringify(events).includes(TOKEN));
});

test("OpenCode Go: a chat-routed model completes a tool turn; ad's User-Agent and the conversation's session id reach Go", opts, async () => {
  const before = goMock.requests.length;
  const r = await turn("SHELL", { thread: { model: "glm-5.3", modelProvider: "go" } });
  assert.equal(status(r.completed), "completed", errInfo(r));
  const sent = goMock.requests.slice(before);
  assert.ok(sent.length >= 2, `a call and its result: ${sent.length}`);
  for (const q of sent) {
    assert.equal(q.path, "/inference/go/openai/v1/chat/completions");
    assert.equal(q.session, r.threadId, "the conversation's id");
    assert.match(q.userAgent, /^ad\/\d/);
    assert.doesNotMatch(q.userAgent, /opencode/i);
    assert.ok(q.keyOk, "the account's key, added by the gateway");
  }
});
