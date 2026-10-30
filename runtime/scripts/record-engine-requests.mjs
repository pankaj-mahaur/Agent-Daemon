#!/usr/bin/env node
// Records what the pinned engine sends on the Responses wire, and which answer shapes it
// executes, into runtime/test/fixtures/gateway/engine-<version>/ (P6.1, S-ADAPTER step 2).
// The translation's contract test reads these fixtures; re-record after an engine upgrade:
//
//   node scripts/record-engine-requests.mjs
//
// Runs the pinned binary only (never AD_ENGINE_BIN), in throwaway homes and folders, against
// testkit/mock-responses.mjs. No network, no login. Temp paths become {TMP}; strings longer
// than 1,500 characters (instructions, long tool descriptions) are elided with their length
// and hash, so the fixtures stay small and hold no machine detail.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { defaultScript, ev, lastUserText, startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PINNED = resolveCodexCommand({});
if (PINNED.source !== "pinned") {
  console.error("The pinned engine isn't installed: cd runtime && npm install");
  process.exit(1);
}
const VERSION = JSON.parse(readFileSync(join(HERE, "../node_modules/@openai/codex/package.json"), "utf8")).version;
const OUT = join(HERE, `../test/fixtures/gateway/engine-${VERSION}`);

// The slugs P6.1 translates for, the mock's own, and a model the engine knows well.
const SLUGS = (process.env.RECORD_SLUGS ?? "gemini-2.5-flash,deepseek-chat,mistral-large-latest,mock-model,gpt-5.1-codex").split(",");
const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello from the mock\n*** End Patch\n";
const shell = (text) => (process.platform === "win32" ? `cmd.exe /d /c echo ${text}` : `echo ${text}`);

// Answers by prompt word; a tool result gets a closing message. FREEFORM tries the custom
// tool-call shape for apply_patch; NAMESPACED a namespaced function call.
function script(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input[input.length - 1];
  if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") return [ev.created(), ev.message(`done after ${last.call_id}`), ev.completed()];
  const text = lastUserText(body);
  if (text.includes("FREEFORM")) return [ev.created(), { type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "call-freeform", name: "apply_patch", input: PATCH } }, ev.completed()];
  if (text.includes("SHELL")) return [ev.created(), ev.functionCall("call-shell", "exec_command", { cmd: shell("hi") }), ev.completed()];
  return defaultScript(body);
}

// Machine and install detail the translation never reads: blanked.
function scrub(body) {
  if (!body || typeof body !== "object") return body;
  const b = { ...body };
  if ("client_metadata" in b) b.client_metadata = "{CLIENT_METADATA}";
  if ("prompt_cache_key" in b) b.prompt_cache_key = "{CACHE_KEY}";
  return JSON.parse(
    JSON.stringify(b)
      .replace(/<timezone>[^<]*<\/timezone>/g, "<timezone>{TZ}</timezone>")
      .replace(/<current_date>[^<]*<\/current_date>/g, "<current_date>{DATE}</current_date>"),
  );
}

function normalize(value, paths) {
  let s = JSON.stringify({ ...value, body: scrub(value.body) });
  for (const p of paths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of [p, JSON.stringify(p).slice(1, -1), p.replace(/\\/g, "/")]) s = s.split(form).join("{TMP}");
  }
  return JSON.parse(s, (k, v) => (typeof v === "string" && v.length > 1500 ? `{ELIDED ${v.length} chars sha256:${createHash("sha256").update(v).digest("hex").slice(0, 12)}}` : v));
}

async function runTurn(server, threadId, text) {
  let listener;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn "${text}" didn't finish`)), 120_000);
    listener = ({ method, params }) => {
      if (method === "turn/completed" && params.threadId === threadId) {
        clearTimeout(timer);
        resolve(params);
      }
    };
    server.on("notification", listener);
  });
  try {
    await server.request("turn/start", { threadId, input: [{ type: "text", text }] });
    return await done;
  } finally {
    server.off("notification", listener);
  }
}

async function recordSlug(slug) {
  const mock = await startMockResponses({ script, recordBodies: true });
  const home = writeMockCodexHome(mkdtempSync(join(tmpdir(), "ad-rec-home-")), { url: mock.url, model: slug });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ad-rec-work-")));
  const server = new CodexAppServer({
    command: PINNED,
    cwd,
    env: { CODEX_HOME: home },
    clientVersion: "record",
    initTimeoutMs: 120_000,
    onServerRequest: async ({ method, params }) => {
      if (isApprovalMethod(method)) return approvalResponse(method, params, "accept");
      throw Object.assign(new Error(`unhandled ${method}`), { code: -32601 });
    },
  });
  const accepted = {};
  try {
    await server.start();
    const { thread } = await server.request("thread/start", { cwd, model: slug, config: { web_search: "disabled" } });
    for (const word of ["PING", "SHELL", "FREEFORM", "PING again"]) {
      const r = await runTurn(server, thread.id, word);
      if (word === "FREEFORM") accepted.customToolCallApplyPatch = existsSync(join(cwd, "hello.txt"));
      accepted[`turn ${word}`] = r.turn?.status ?? r.status ?? null;
    }
  } finally {
    await server.close().catch(() => {});
    await mock.close();
  }
  const paths = [cwd, home, realpathSync(home), tmpdir()];
  const requests = mock.requests.map((r) => normalize({ path: r.path, headers: pickHeaders(r.headers), body: r.body }, paths));
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  return { requests, accepted };
}

// Headers the gateway's translation may care about; never auth.
const pickHeaders = (h = {}) => Object.fromEntries(Object.entries(h).filter(([k]) => /^(content-type|accept|x-openai-internal-codex-responses-lite|openai-beta|session_id|originator)$/.test(k)));

mkdirSync(join(OUT, "requests"), { recursive: true });
const summary = { engine: VERSION, recordedAt: new Date().toISOString().slice(0, 10), slugs: {} };
for (const slug of SLUGS) {
  process.stdout.write(`${slug}: `);
  const { requests, accepted } = await recordSlug(slug);
  requests.forEach((r, i) => writeFileSync(join(OUT, "requests", `${slug}-${String(i + 1).padStart(2, "0")}.json`), `${JSON.stringify(r, null, 2)}\n`));
  const first = requests[0]?.body ?? {};
  summary.slugs[slug] = {
    requests: requests.length,
    accepted,
    tools: (first.tools ?? []).map((t) => ({ type: t.type, name: t.name ?? null, ...(t.tools ? { children: t.tools.map((c) => c.name ?? c.type) } : {}), ...(t.format ? { format: t.format.type ?? null } : {}) })),
    inputItemTypes: [...new Set(requests.flatMap((r) => (r.body?.input ?? []).map((i) => i.type)))],
    topLevelKeys: [...new Set(requests.flatMap((r) => Object.keys(r.body ?? {})))].sort(),
    lite: requests.some((r) => r.headers?.["x-openai-internal-codex-responses-lite"]),
  };
  console.log(`${requests.length} requests, custom apply_patch executed: ${accepted.customToolCallApplyPatch}`);
}
writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`wrote ${OUT}`);
