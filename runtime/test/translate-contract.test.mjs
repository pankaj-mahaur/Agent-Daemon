// P6.1 contract: every request the pinned engine was recorded sending
// (test/fixtures/gateway/engine-<version>/, scripts/record-engine-requests.mjs) translates
// to a Chat body without a refusal, and the result's shape matches the golden. An engine
// upgrade that changes what it sends fails here first: re-record, read the diff, update.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { prepare } from "../src/gateway/translate/index.mjs";
import { seal } from "../src/gateway/translate/seal.mjs";
import { assertGolden } from "../testkit/golden.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "../node_modules/@openai/codex/package.json"), "utf8")).version;
const DIR = path.join(HERE, "fixtures/gateway", `engine-${VERSION}`, "requests");
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];
const route = { mode: "chat", provider: "groq", label: "Groq", model: { vision: true } };

const short = (s) => (typeof s === "string" ? s.slice(0, 60) : Array.isArray(s) ? s.map((p) => p.type) : s);
const shape = (b) => ({
  keys: Object.keys(b).sort(),
  tools: (b.tools ?? []).map((t) => t.function.name),
  messages: b.messages.map((m) => ({ role: m.role, ...(m.content !== null ? { content: short(m.content) } : {}), ...(m.tool_calls ? { calls: m.tool_calls.map((c) => `${c.id} ${c.function.name} ${c.function.arguments.slice(0, 60)}`) } : {}), ...(m.tool_call_id ? { for: m.tool_call_id } : {}) })),
});

test(`the recorded engine ${VERSION} requests exist`, () => {
  assert.ok(files.length >= 20, `found ${files.length} fixtures in ${DIR}; run scripts/record-engine-requests.mjs`);
});

test("every recorded request translates to Chat, and its shape matches the golden", () => {
  const out = {};
  for (const f of files) {
    const { body } = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const chat = JSON.parse(prepare(Buffer.from(JSON.stringify(body)), route).body.toString());
    // Nothing the engine sent is lost: every tool call has its result, every tool its function.
    const callIds = chat.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
    const answered = chat.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    assert.deepEqual(answered.filter((id) => !callIds.includes(id)), [], `${f}: a result without its call`);
    assert.equal(chat.tools.length, body.tools.reduce((n, t) => n + (t.type === "namespace" ? t.tools.length : 1), 0), `${f}: tools`);
    out[f] = shape(chat);
  }
  assertGolden(`translate/engine-${VERSION}-chat.json`, JSON.stringify(out, null, 2));
});

test("DeepSeek: the recorded tool loop goes when nothing reasoned before; with reasoning ad can't open in it, it is refused", () => {
  const f = files.find((x) => x.startsWith("deepseek-chat-") && JSON.parse(fs.readFileSync(path.join(DIR, x), "utf8")).body.input.at(-1)?.type === "function_call_output");
  assert.ok(f, "a recorded tool-result request");
  const recorded = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")).body;
  // The mock's own reasoning (an earlier turn) isn't DeepSeek's: a model that never reasoned has none.
  const body = { ...recorded, input: recorded.input.filter((i) => i.type !== "reasoning") };
  const rt = { ...route, provider: "deepseek", quirks: ["deepseek"] };
  assert.doesNotThrow(() => prepare(Buffer.from(JSON.stringify(body)), rt, { sealKey: randomBytes(32) }));
  // The mock's reasoning (another provider's, as after a switch) is absent, not lost.
  assert.doesNotThrow(() => prepare(Buffer.from(JSON.stringify(recorded)), rt, { sealKey: randomBytes(32) }), "an earlier turn's foreign reasoning");
  // Ad's own envelope for this model under a key it no longer has: refused.
  const at = body.input.findLastIndex((i) => i.type === "function_call");
  const mine = seal(randomBytes(32), { provider: "deepseek", model: body.model }, "old");
  const lost = { ...body, input: [...body.input.slice(0, at), { type: "reasoning", summary: [], encrypted_content: mine }, ...body.input.slice(at)] };
  assert.throws(() => prepare(Buffer.from(JSON.stringify(lost)), rt, { sealKey: randomBytes(32) }), /can't read this chat's earlier reasoning/);
});
