// `ad web` — local web UI for the harness (zero-dep: node:http + SSE).
//
// Security: binds 127.0.0.1 only; every API call needs the random token
// printed in the start URL (header x-ad-token, or ?t= for the SSE stream,
// which EventSource can't set headers for); the Host header must be the
// loopback address (blocks DNS-rebinding from a web page). All data is
// rendered with textContent — never as HTML.
//
// One engine, one chat thread per server (/api/new starts another).
// Approvals are pushed to the page over SSE and answered with a POST;
// with no page connected they are declined.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseApprovalAnswer } from "./chat.mjs";
import { loadJobs } from "./schedule.mjs";
import { startHarnessEngine } from "./start.mjs";

const MAX_BODY = 64 * 1024;

export function isLoopbackHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(host ?? "").toLowerCase());
}

export function tokenOk(given, token) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function recentLoops(cwd, limit = 10) {
  const dir = path.join(cwd, ".agent-daemon", "loops");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const lines = readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean);
      const last = lines.length ? JSON.parse(lines.at(-1)) : null;
      return { threadId: f.replace(/\.jsonl$/, ""), iterations: lines.length, last: last && { ts: last.ts, turnStatus: last.turnStatus, progress: last.status?.progress ?? null } };
    })
    .sort((a, b) => String(b.last?.ts).localeCompare(String(a.last?.ts)))
    .slice(0, limit);
}

export async function startWebServer({ cwd = process.cwd(), port = 0, token = randomBytes(24).toString("hex"), engineFactory = startHarnessEngine, engineOpts = {}, userHome, err = process.stderr } = {}) {
  const started = await engineFactory({ cwd, err, ...engineOpts });
  if (!started.engine) throw new Error(started.error);
  const engine = started.engine;
  const clients = new Set();
  const approvals = new Map(); // id → resolve
  let threadId = null;
  let turn = null; // { turnId }

  const broadcast = (evt) => {
    const data = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of clients) res.write(data);
  };

  engine.onApproval = (req) => {
    if (!clients.size) return "decline";
    const id = randomBytes(6).toString("hex");
    const p = req.params ?? {};
    broadcast({ type: "approval", id, kind: req.kind, command: Array.isArray(p.command) ? p.command.join(" ") : p.command ?? null, reason: p.reason ?? null, cwd: p.cwd ?? null });
    return new Promise((resolve) => approvals.set(id, (answer) => resolve(parseApprovalAnswer(answer))));
  };

  async function chat(text) {
    if (turn) throw Object.assign(new Error("a turn is already running"), { status: 409 });
    if (!threadId) threadId = (await engine.startThread({ cwd })).threadId;
    turn = { turnId: null };
    broadcast({ type: "user", text });
    engine
      .turn({
        threadId,
        text,
        timeoutMs: 0,
        onEvent: (evt) => {
          if (evt.type === "turnStarted") turn.turnId = evt.turnId;
          else if (evt.type === "delta") broadcast({ type: "delta", itemId: evt.itemId, text: evt.text });
          else if (evt.type === "itemStarted" && evt.item?.type !== "agentMessage" && evt.item?.type !== "reasoning" && evt.item?.type !== "userMessage") {
            broadcast({ type: "activity", itemType: evt.item.type, command: evt.item.command ?? null, paths: (evt.item.changes ?? []).map((c) => c.path) });
          } else if (evt.type === "error") broadcast({ type: "error", message: evt.message, willRetry: evt.willRetry });
        },
      })
      .then((r) => broadcast({ type: "done", status: r.status, error: r.error?.message ?? null }))
      .catch((e) => broadcast({ type: "done", status: "failed", error: e.message }))
      .finally(() => {
        turn = null;
      });
    return { threadId };
  }

  const api = {
    "GET /api/overview": async () => {
      const [acct, config, threads] = await Promise.all([engine.account(), engine.readConfig(), engine.listThreads({ cwd, limit: 10, sourceKinds: ["cli", "vscode", "exec", "appServer"] }).catch(() => [])]);
      const a = acct.account;
      return {
        cwd,
        home: engine.home,
        login: a ? (a.type === "chatgpt" ? `ChatGPT ${a.planType ?? ""}`.trim() : a.type) : acct.requiresOpenaiAuth ? "not logged in" : "provider key",
        provider: config.model_provider ?? "openai",
        model: config.model ?? null,
        threadId,
        running: Boolean(turn),
        threads: threads.map((t) => ({ id: t.id, preview: String(t.name ?? t.preview ?? "").slice(0, 80) })),
        schedules: loadJobs(userHome).map((j) => ({ id: j.id, cron: j.cron, kind: j.kind, prompt: j.prompt, enabled: j.enabled, nextRun: j.nextRun, lastStatus: j.lastStatus })),
        loops: recentLoops(cwd),
      };
    },
    "POST /api/chat": async (body) => {
      if (typeof body.text !== "string" || !body.text.trim()) throw Object.assign(new Error("text required"), { status: 400 });
      return chat(body.text.trim());
    },
    "POST /api/approval": async (body) => {
      const resolve = approvals.get(body.id);
      if (!resolve) throw Object.assign(new Error("no such approval"), { status: 404 });
      approvals.delete(body.id);
      resolve(body.answer);
      return { ok: true };
    },
    "POST /api/interrupt": async () => {
      if (turn?.turnId) await engine.interrupt(threadId, turn.turnId);
      return { ok: true };
    },
    "POST /api/new": async () => {
      if (turn) throw Object.assign(new Error("a turn is running"), { status: 409 });
      threadId = null;
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, obj, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(type === "application/json" ? JSON.stringify(obj) : obj);
    };
    if (!isLoopbackHost(req.headers.host, server.address().port)) return send(421, { error: "bad host" });
    if (req.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      res.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      return send(200, PAGE.replace("<script>", `<script nonce="${nonce}">`), "text/html; charset=utf-8");
    }
    const given = url.pathname === "/api/events" ? url.searchParams.get("t") : req.headers["x-ad-token"];
    if (!tokenOk(given, token)) return send(401, { error: "token required" });
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const handler = api[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: "not found" });
    try {
      let body = {};
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) return send(413, { error: "body too large" });
        }
        body = raw ? JSON.parse(raw) : {};
      }
      send(200, await handler(body));
    } catch (e) {
      send(e.status ?? 500, { error: e.message });
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    token,
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    close: async () => {
      for (const res of clients) res.end();
      for (const r of approvals.values()) r("");
      await new Promise((r) => server.close(r));
      await engine.close();
    },
  };
}

export async function cmdWeb(opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  let web;
  try {
    web = await startWebServer({ cwd: opts.cwd, port: opts.port ?? 0, engineOpts: { clientVersion: opts.clientVersion }, err });
  } catch (e) {
    err.write(`ad web: ${e.message}\n`);
    return /logged in/i.test(e.message) ? 2 : 1;
  }
  out.write(`Agent Daemon web UI: ${web.url}\n(local only; the link carries the access token — don't share it. Ctrl+C to stop.)\n`);
  return new Promise((resolve) => {
    const stop = async () => {
      await web.close();
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Daemon</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#2563eb;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#f59e0b;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;display:grid;grid-template-columns:300px 1fr;height:100vh}
aside{border-right:1px solid var(--line);padding:16px;overflow:auto}main{display:flex;flex-direction:column;min-width:0}
h1{font-size:16px;margin:0 0 12px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 6px}
.kv{color:var(--muted)}.kv b{color:var(--fg);font-weight:600}.item{padding:6px 0;border-bottom:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
#log{flex:1;overflow:auto;padding:16px 24px}.msg{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.user{color:var(--accent);font-weight:600}
.act{color:var(--muted);font-family:ui-monospace,monospace;font-size:12px}.err{color:var(--bad)}.warn{color:var(--warn)}
.ap{border:1px solid var(--warn);border-radius:8px;padding:10px;background:var(--card);margin:10px 0}.ap button{margin-right:6px}
form{display:flex;gap:8px;padding:12px 24px;border-top:1px solid var(--line)}textarea{flex:1;resize:vertical;min-height:44px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
@media (max-width:760px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr}aside{max-height:35vh;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body>
<aside><h1>Agent Daemon</h1><div id="ov" class="kv">loading…</div>
<h2>Threads</h2><div id="threads"></div><h2>Loops</h2><div id="loops"></div><h2>Schedules</h2><div id="sched"></div></aside>
<main><div id="log"></div>
<form id="f"><textarea id="t" placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)"></textarea>
<div style="display:flex;flex-direction:column;gap:6px"><button class="primary" type="submit">Send</button><button type="button" id="stop">Stop</button><button type="button" id="new">New</button></div></form></main>
<script>
const token = new URLSearchParams(location.search).get("t") || sessionStorage.getItem("adt") || "";
try { sessionStorage.setItem("adt", token); } catch {}
history.replaceState(null, "", "/");
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = (method, p, body) => fetch(p, { method, headers: { "x-ad-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; });
let current = null, lastItem = null;
const log = $("log");
const add = (node) => { log.appendChild(node); log.scrollTop = log.scrollHeight; return node; };
async function refresh() {
  try {
    const o = await api("GET", "/api/overview");
    const ov = $("ov"); ov.replaceChildren();
    for (const [k, v] of [["login", o.login], ["provider", o.provider], ["model", o.model || "(default)"], ["folder", o.cwd]]) { const d = el("div"); d.append(k + ": ", el("b", null, v)); ov.appendChild(d); }
    const list = (id, rows, fmt) => { const box = $(id); box.replaceChildren(); if (!rows.length) box.appendChild(el("div", "kv", "none")); for (const r of rows) box.appendChild(el("div", "item", fmt(r))); };
    list("threads", o.threads, (t) => t.preview || t.id);
    list("loops", o.loops, (l) => l.iterations + " iter · " + (l.last?.turnStatus || "") + (l.last?.progress ? " · " + l.last.progress : ""));
    list("sched", o.schedules, (s) => (s.enabled ? "" : "(off) ") + s.cron + " · " + s.kind + " · " + s.prompt);
  } catch (e) { $("ov").textContent = "error: " + e.message; }
}
function onEvent(ev) {
  if (ev.type === "user") { add(el("div", "msg user", ev.text)); current = null; lastItem = null; }
  else if (ev.type === "delta") { if (!current || lastItem !== ev.itemId) { current = add(el("div", "msg")); lastItem = ev.itemId; } current.textContent += ev.text; log.scrollTop = log.scrollHeight; }
  else if (ev.type === "activity") { add(el("div", "act", ev.itemType === "commandExecution" ? "$ " + ev.command : ev.itemType === "fileChange" ? "~ " + ev.paths.join(", ") : "⚙ " + ev.itemType)); current = null; }
  else if (ev.type === "error") add(el("div", ev.willRetry ? "act warn" : "msg err", ev.message));
  else if (ev.type === "done") { if (ev.status !== "completed") add(el("div", "msg err", "[turn " + ev.status + (ev.error ? ": " + ev.error : "") + "]")); refresh(); }
  else if (ev.type === "approval") {
    const box = add(el("div", "ap"));
    box.appendChild(el("div", null, ev.kind === "command" ? "Run command?  $ " + ev.command : ev.kind === "fileChange" ? "Apply file changes?" : "Grant extra permissions?"));
    if (ev.reason) box.appendChild(el("div", "kv", "reason: " + ev.reason));
    for (const [label, answer] of [["Allow", "y"], ["Always (session)", "a"], ["Deny", "n"]]) {
      const b = el("button", null, label);
      b.onclick = async () => { box.querySelectorAll("button").forEach((x) => (x.disabled = true)); await api("POST", "/api/approval", { id: ev.id, answer }).catch(() => {}); box.appendChild(el("span", "kv", " → " + label)); };
      box.appendChild(b);
    }
  }
}
const es = new EventSource("/api/events?t=" + encodeURIComponent(token));
es.onmessage = (m) => onEvent(JSON.parse(m.data));
$("f").onsubmit = async (e) => { e.preventDefault(); const text = $("t").value.trim(); if (!text) return; $("t").value = ""; try { await api("POST", "/api/chat", { text }); } catch (err) { add(el("div", "msg err", err.message)); } };
$("t").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("f").requestSubmit(); } };
$("stop").onclick = () => api("POST", "/api/interrupt").catch(() => {});
$("new").onclick = () => api("POST", "/api/new").then(() => { log.replaceChildren(); refresh(); }).catch((e) => add(el("div", "msg err", e.message)));
refresh(); setInterval(refresh, 15000);
</script></body></html>`;
