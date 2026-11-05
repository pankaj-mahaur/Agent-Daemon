// A scripted stand-in for the Anthropic Messages API, so the S-HOOKS spike can
// drive the real `claude` binary with a fake key, no login and no network.
//
// The reply is chosen from the request, never from request order:
//   - the last user block is a tool_result → text "done";
//   - otherwise the first rule whose `match` is a substring of the last user
//     text wins: {match, toolUse: {name, input}} or {match, text};
//   - otherwise text "ok".
// Rules are re-read from `rulesFile` on every request, so a scenario can
// change them between turns. Every request is summarised into `requests`.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function blocksOf(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
}

function lastUser(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return blocksOf(msgs[i].content);
  return [];
}

const textOf = (blocks) => blocks.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? JSON.stringify(b.content) : "")).join("\n");

function pick(body, rules) {
  const blocks = lastUser(body);
  const tools = (body.tools ?? []).map((t) => t.name);
  // Claude Code merges a tool_result, reminders and a new prompt into one
  // user message, so only text after the last tool_result counts as new.
  // A trigger counts only at the start of its own text block there (scenario
  // prompts start with it; reminders that quote it don't).
  const lastResult = blocks.findLastIndex((b) => b.type === "tool_result");
  const fresh = blocks.slice(lastResult + 1).filter((b) => b.type === "text");
  const hit = (r) => fresh.some((b) => b.text.trimStart().startsWith(r.match)) || (lastResult < 0 && r.anywhere && textOf(fresh).includes(r.match));
  if (lastResult >= 0 && !rules.some(hit)) {
    // {onResult, toolUse}: chain a second tool call after a result mentioning onResult.
    const resultText = JSON.stringify(blocks[lastResult].content ?? "");
    const next = rules.find((r) => r.onResult && resultText.includes(r.onResult));
    return next && tools.includes(next.toolUse.name) ? next : { text: "done" };
  }
  for (const r of rules) {
    if (!hit(r)) continue;
    if (r.toolUse && !tools.includes(r.toolUse.name)) return { text: `mock: tool ${r.toolUse.name} not offered` };
    return r;
  }
  return { text: "ok" };
}

function sseFor(reply, model) {
  const ev = [];
  const push = (type, data) => ev.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  push("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (reply.toolUse) {
    push("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_mock_${Date.now()}`, name: reply.toolUse.name, input: {} } });
    push("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input) } });
  } else {
    push("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    push("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text } });
  }
  push("content_block_stop", { index: 0 });
  push("message_delta", { delta: { stop_reason: reply.toolUse ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  push("message_stop", {});
  return ev.join("");
}

function jsonFor(reply, model) {
  const content = reply.toolUse ? [{ type: "tool_use", id: `toolu_mock_${Date.now()}`, name: reply.toolUse.name, input: reply.toolUse.input }] : [{ type: "text", text: reply.text }];
  return { id: "msg_mock", type: "message", role: "assistant", model, content, stop_reason: reply.toolUse ? "tool_use" : "end_turn", stop_sequence: null, usage };
}

export async function startMockAnthropic({ rulesFile }) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      const url = req.url ?? "";
      let rules = [];
      try {
        rules = JSON.parse(readFileSync(rulesFile, "utf8"));
      } catch {}
      const blocks = lastUser(body);
      const toolResults = blocks.filter((b) => b.type === "tool_result").map((b) => JSON.stringify(b.content).slice(0, 600));
      requests.push({ method: req.method, path: url, model: body.model, stream: body.stream, tools: (body.tools ?? []).map((t) => t.name), system: JSON.stringify(body.system ?? "").slice(0, 160), lastUserText: textOf(blocks.filter((b) => b.type === "text")).slice(0, 600), toolResults, messages: body.messages?.length });
      if (/count_tokens/.test(url)) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
      if (req.method === "GET" && /\/v1\/models/.test(url)) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ type: "model", id: body.model ?? "claude-sonnet-4-5", display_name: "mock" }], has_more: false }));
      if (!/\/v1\/messages/.test(url)) return void res.writeHead(404).end();
      const reply = pick(body, rules);
      const model = body.model ?? "mock";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sseFor(reply, model));
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jsonFor(reply, model)));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
