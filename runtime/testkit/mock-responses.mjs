// A scripted stand-in for the OpenAI Responses API, so tests can drive the
// REAL pinned Codex binary with no login and no network. Responses are chosen
// from the request content — the last user message, or the call_id a tool
// result answers — never from request order, so retries and extra calls can't
// shift the script.
//
// Event shapes follow Codex's own test helpers
// (codex-rs/core/tests/common/responses.rs at rust-v0.160.0).

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 };

export const ev = {
  created: (id = "resp-1") => ({ type: "response.created", response: { id } }),
  completed: (id = "resp-1") => ({ type: "response.completed", response: { id, usage } }),
  failed: (id = "resp-1", message = "mock failure") => ({ type: "response.failed", response: { id, error: { code: "server_error", message } } }),
  textDelta: (delta) => ({ type: "response.output_text.delta", delta }),
  message: (text, id = "msg-1") => ({ type: "response.output_item.done", item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] } }),
  reasoning: (summary, id = "rs-1") => ({
    type: "response.output_item.done",
    item: { type: "reasoning", id, summary: [{ type: "summary_text", text: summary }], encrypted_content: Buffer.from("b".repeat(600)).toString("base64") },
  }),
  functionCall: (callId, name, args) => ({ type: "response.output_item.done", item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } }),
};

export const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

// The text of the last user message in a Responses request body.
export function lastUserText(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.type === "message" && item.role === "user") return (item.content ?? []).map((c) => c.text ?? "").join("");
  }
  return "";
}

const shellCommand = (text) => (process.platform === "win32" ? `cmd.exe /d /c echo ${text}` : `echo ${text}`);

// Default script, keyed by a word in the prompt:
//   PING      reasoning + streamed "pong"
//   SHELL     exec_command (prompts for approval when no sandbox is set up)
//   ESCALATE  exec_command asking for sandbox escalation
//   PATCH     apply_patch through exec_command, adding hello.txt
//   FAIL      response.failed
// A request answering a tool call gets a closing message naming that call.
export function defaultScript(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input[input.length - 1];
  if (last?.type === "function_call_output") return [ev.created(), ev.message(`done after ${last.call_id}`), ev.completed()];
  const text = lastUserText(body);
  if (text.includes("FAIL")) return [ev.created(), ev.failed()];
  if (text.includes("ESCALATE")) {
    return [ev.created(), ev.functionCall("call-escalate", "exec_command", { cmd: shellCommand("escalated"), sandbox_permissions: "require_escalated", justification: "mock escalation" }), ev.completed()];
  }
  if (text.includes("SHELL")) return [ev.created(), ev.functionCall("call-shell", "exec_command", { cmd: shellCommand("hi") }), ev.completed()];
  if (text.includes("PATCH")) {
    const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello from the mock\n*** End Patch";
    return [ev.created(), ev.functionCall("call-patch", "exec_command", { cmd: `apply_patch <<'EOF'\n${patch}\nEOF\n` }), ev.completed()];
  }
  return [ev.created(), ev.reasoning("**Thinking** about the reply"), ev.textDelta("po"), ev.textDelta("ng"), ev.message("pong"), ev.completed()];
}

// Start the mock on a random loopback port. `requests` records every call
// (path, model, tool names, last user text) for assertions.
export async function startMockResponses({ script = defaultScript } = {}) {
  const requests = [];
  let current = script;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // Non-JSON bodies are recorded and answered with the default reply.
      }
      requests.push({ path: req.url, model: body.model, tools: (body.tools ?? []).map((t) => t.name ?? t.type), text: lastUserText(body) });
      if (!/\/responses$/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(current(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setScript: (fn) => { current = fn; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// A CODEX_HOME whose only provider is the mock: no login, no plugins or apps,
// no update check. Never pass the user's own home here.
export function writeMockCodexHome(home, { url, approvalPolicy = "on-request", sandboxMode = "workspace-write", model = "mock-model" }) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), [
    `model = "${model}"`,
    `approval_policy = "${approvalPolicy}"`,
    `sandbox_mode = "${sandboxMode}"`,
    `model_provider = "mock"`,
    `check_for_update_on_startup = false`,
    ``,
    `[features]`,
    `plugins = false`,
    `apps = false`,
    `shell_snapshot = false`,
    ``,
    `[model_providers.mock]`,
    `name = "mock"`,
    `base_url = "${url}"`,
    `wire_api = "responses"`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    `supports_websockets = false`,
    ``,
  ].join("\n"));
  return home;
}
