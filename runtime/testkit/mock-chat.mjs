// A scripted Chat Completions provider (P6.1b): what a chat-only provider (Groq, Mistral,
// DeepSeek…) sends, with the faults the translation must survive. Answers are chosen from
// the request — the last user message, or the tool result being answered — never from
// request order, so retries can't shift the script.
//
//   startMockChat({ script }) → { url, requests, held(), release(), hangups, close(), setScript }
//   script(body, { count }) → one of
//     { chunks: [event objects | "[DONE]"], split?: n, destroy?: true }   a 200 stream (split:
//                     re-cut the bytes every n characters; destroy: drop the socket at the end)
//     { status, json?, text?, headers? }                                   an error or redirect
//     { hold: [events], after: [events] }                                  held until release()
// requests: { path, body, authorization, n } for every call (n: this script word's count).

import { createServer } from "node:http";

const frame = (e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`);
export const chat = {
  text: (content) => ({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }),
  reasoning: (content) => ({ choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }] }),
  call: (index, { id, name, args }) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...(id ? { id, type: "function" } : {}), function: { ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) } }] }, finish_reason: null }] }),
  finish: (reason, usage) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) }),
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
};

export function lastUserText(body) {
  for (const m of [...(body?.messages ?? [])].reverse()) if (m.role === "user") return typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("");
  return "";
}

const shell = (text) => (process.platform === "win32" ? `cmd.exe /d /c echo ${text}` : `echo ${text}`);

/** The default script: PING, SHELL (split arguments), a tool result → "done", else "ok". */
export function defaultChatScript(body) {
  const last = body?.messages?.at(-1);
  if (last?.role === "tool") return { chunks: [chat.text(`done after ${last.tool_call_id}`), chat.finish("stop", chat.usage), "[DONE]"] };
  const text = lastUserText(body);
  if (text.includes("SHELL")) {
    const args = JSON.stringify({ cmd: shell("hi") });
    return { chunks: [chat.call(0, { id: "call_0", name: "exec_" }), chat.call(0, { name: "command" }), chat.call(0, { args: args.slice(0, 5) }), chat.call(0, { args: args.slice(5) }), chat.finish("tool_calls", chat.usage), "[DONE]"] };
  }
  if (text.includes("PING")) return { chunks: [chat.reasoning("thinking"), chat.text("po"), chat.text("ng"), chat.finish("stop", chat.usage), "[DONE]"] };
  return { chunks: [chat.text("ok"), chat.finish("stop", chat.usage), "[DONE]"] };
}

export async function startMockChat({ script = defaultChatScript } = {}) {
  let current = script;
  const requests = [];
  const counts = new Map();
  const holds = [];
  const waiters = [];
  let hangups = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { invalid: raw.slice(0, 200) };
      }
      const word = lastUserText(body) || (body?.messages?.at(-1)?.role ?? "");
      counts.set(word, (counts.get(word) ?? 0) + 1);
      requests.push({ path: req.url, method: req.method, body, authorization: req.headers.authorization ?? null, n: counts.get(word) });
      const out = current(body, { count: counts.get(word) });
      if (out.status) {
        res.writeHead(out.status, { "content-type": out.json ? "application/json" : "text/plain", ...(out.headers ?? {}) });
        return void res.end(out.json ? JSON.stringify(out.json) : (out.text ?? ""));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (out.hold) {
        res.write(out.hold.map(frame).join(""));
        const h = { res, after: out.after, done: false, closed: false };
        res.on("close", () => {
          h.closed = true;
          if (!h.done) hangups++;
        });
        holds.push(h);
        for (const w of waiters.splice(0)) w();
        return;
      }
      const text = out.chunks.map(frame).join("");
      if (out.split) {
        for (let i = 0; i < text.length; i += out.split) {
          res.write(text.slice(i, i + out.split));
          await new Promise((r) => setImmediate(r));
        }
      } else res.write(text);
      if (out.destroy) return void res.socket?.destroy();
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setScript: (fn) => {
      current = fn;
    },
    held: () => (holds.some((h) => !h.closed && !h.done) ? Promise.resolve() : new Promise((r) => waiters.push(r))),
    release() {
      const h = holds.find((x) => !x.closed && !x.done);
      if (!h) return false;
      h.done = true;
      h.res.end(h.after.map(frame).join(""));
      return true;
    },
    get hangups() {
      return hangups;
    },
    close() {
      for (const h of holds) if (!h.closed) h.res.destroy();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
