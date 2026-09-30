// Tests for the LLM backend switch (llm.mjs): claude by default, Codex on
// request or when the claude binary is missing; schemas that OpenAI strict
// mode would reject are embedded in the prompt instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callLlm, isStrictSchema, llmBackend, parseJsonReply } from "../src/llm.mjs";
import { createEngine } from "../src/engine/index.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));

function fakeFactory(root, seen) {
  return async () => {
    const engine = await createEngine({ home: join(root, "home"), command: { cmd: process.execPath, prefix: [FAKE] } });
    const complete = engine.complete.bind(engine);
    engine.complete = async (o) => {
      const r = await complete(o);
      seen.push((await engine.server.request("debug/state")).lastParams["turn/start"]);
      return r;
    };
    return engine;
  };
}

test("llmBackend: default auto, env and opts override, unknown rejected", () => {
  assert.equal(llmBackend({}, {}), "auto");
  assert.equal(llmBackend({}, { AD_LLM_BACKEND: "codex" }), "codex");
  assert.equal(llmBackend({ backend: "claude" }, { AD_LLM_BACKEND: "codex" }), "claude");
  assert.throws(() => llmBackend({ backend: "gpt" }, {}), /unknown LLM backend/);
});

test("isStrictSchema", () => {
  const strict = { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "array", items: { type: "object", additionalProperties: false, required: ["x"], properties: { x: { type: "number" } } } } } };
  assert.equal(isStrictSchema(strict), true);
  assert.equal(isStrictSchema({ type: "object", properties: { a: {} } }), false, "additionalProperties must be false");
  assert.equal(isStrictSchema({ type: "object", additionalProperties: false, required: [], properties: { a: {} } }), false, "all props required");
  const nested = structuredClone(strict);
  delete nested.properties.b.items.additionalProperties;
  assert.equal(isStrictSchema(nested), false, "checked recursively");
});

test("parseJsonReply finds JSON in plain or fenced replies", () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure!\n```json\n{"learnings":[]}\n```\nDone.'), { learnings: [] });
  assert.equal(parseJsonReply("no json here"), null);
  assert.equal(parseJsonReply(undefined), null);
});

test("claude backend: JSON is parsed from text when no schema was given (digest fallback bug)", async () => {
  const r = await callLlm({ backend: "claude", userMessage: "x" }, { callClaude: async () => ({ ok: true, result: '{"learnings":[{"text":"t"}]}' }) });
  assert.deepEqual(r.parsedJson, { learnings: [{ text: "t" }] });
});

test("auto: a missing claude binary falls back to the Codex engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-llm-"));
  const seen = [];
  try {
    const strict = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "number" } } };
    const r = await callLlm(
      { userMessage: "q", jsonSchema: strict, model: "haiku" },
      { callClaude: async () => ({ ok: false, error: "spawn failed: spawn claude ENOENT" }), engineFactory: fakeFactory(root, seen) },
    );
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.parsedJson, { answer: 42 });
    assert.deepEqual(seen[0].outputSchema, strict, "strict schema goes to Codex as outputSchema");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex: a non-strict schema is embedded in the prompt, not sent as outputSchema", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-llm-"));
  const seen = [];
  try {
    await callLlm({ backend: "codex", userMessage: "q", jsonSchema: { type: "object", properties: { a: {} } } }, { engineFactory: fakeFactory(root, seen) });
    assert.equal(seen[0].outputSchema, undefined);
    assert.match(seen[0].input[0].text, /Respond with ONLY a JSON object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto does not fall back for ordinary claude failures", async () => {
  const r = await callLlm({ userMessage: "q" }, { callClaude: async () => ({ ok: false, error: "budget exceeded" }), engineFactory: async () => assert.fail("must not start codex") });
  assert.equal(r.error, "budget exceeded");
});
