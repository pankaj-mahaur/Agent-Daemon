// Tests for the LLM backend switch (llm.mjs): claude by default, engine on
// request or when the claude binary is missing; schemas that OpenAI strict
// mode would reject are embedded in the prompt instead.

import { LEGACY } from "../src/engine/attribution.mjs";
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
      seen.push((await engine.testRequest("debug/state")).lastParams["turn/start"]);
      return r;
    };
    return engine;
  };
}

test("llmBackend: default auto, env and opts override, unknown rejected", () => {
  assert.equal(llmBackend({}, {}), "auto");
  assert.equal(llmBackend({}, { AD_LLM_BACKEND: LEGACY.productValue }), "ad", "the old value still works");
  assert.equal(llmBackend({}, { AD_LLM_BACKEND: "ad" }), "ad");
  assert.equal(llmBackend({ backend: "claude" }, { AD_LLM_BACKEND: LEGACY.productValue }), "claude");
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

test("auto: a missing claude binary falls back to the engine", async () => {
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
    assert.deepEqual(seen[0].outputSchema, strict, "strict schema goes to the engine as outputSchema");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy backend: a non-strict schema is embedded in the prompt, not sent as outputSchema", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-llm-"));
  const seen = [];
  try {
    await callLlm({ backend: LEGACY.productValue, userMessage: "q", jsonSchema: { type: "object", properties: { a: {} } } }, { engineFactory: fakeFactory(root, seen) });
    assert.equal(seen[0].outputSchema, undefined);
    assert.match(seen[0].input[0].text, /Respond with ONLY a JSON object/);
    await callLlm({ backend: "ad", userMessage: "q", jsonSchema: { type: "object", properties: { a: {} } } }, { engineFactory: fakeFactory(root, seen) });
    assert.equal(seen[1].outputSchema, undefined, "the new value reaches the engine too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto: the fallback note names ad's engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-llm-"));
  const seen = [];
  const lines = [];
  const err = process.stderr;
  const write = err.write.bind(err);
  err.write = (s) => (lines.push(String(s)), true);
  try {
    await callLlm(
      { userMessage: "q", verbose: true },
      { callClaude: async () => ({ ok: false, error: "spawn failed: spawn claude ENOENT" }), engineFactory: fakeFactory(root, seen) },
    );
    assert.ok(lines.some((l) => l.includes("using ad's engine")), JSON.stringify(lines));
  } finally {
    err.write = write;
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto does not fall back for ordinary claude failures", async () => {
  const r = await callLlm({ userMessage: "q" }, { callClaude: async () => ({ ok: false, error: "budget exceeded" }), engineFactory: async () => assert.fail("must not start the engine") });
  assert.equal(r.error, "budget exceeded");
});

test("parseJsonReply: stray braces in prose, several objects, arrays", () => {
  assert.deepEqual(parseJsonReply('Here {is} my answer: {"a": {"b": "}"}} and a {note}.'), { a: { b: "}" } });
  assert.deepEqual(parseJsonReply('{"first":1} {"second":2}'), { first: 1 });
  assert.deepEqual(parseJsonReply('prefix { not json\n```json\n{"x":1}\n```'), { x: 1 });
  assert.equal(parseJsonReply('[{"a":1}]').a, 1, "an object inside an array is still found");
});

test("a schema'd call whose reply has no JSON fails with a reason", async () => {
  const r = await callLlm({ backend: "claude", userMessage: "q", jsonSchema: { type: "object" } }, { callClaude: async () => ({ ok: true, result: "sorry, no" }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no JSON object/);
});

test("engineModelFor maps Claude aliases to AD_ENGINE_MODEL", async () => {
  const { engineModelFor } = await import("../src/llm.mjs");
  assert.equal(engineModelFor("haiku", {}), undefined);
  assert.equal(engineModelFor("haiku", { AD_CODEX_LLM_MODEL: "gpt-mini" }), "gpt-mini");
  assert.equal(engineModelFor("gpt-x", { AD_CODEX_LLM_MODEL: "gpt-mini" }), "gpt-x");
  assert.equal(engineModelFor("haiku", { AD_ENGINE_MODEL: "gpt-new" }), "gpt-new", "the new name works");
  assert.equal(engineModelFor("haiku", { AD_ENGINE_MODEL: "gpt-new", AD_CODEX_LLM_MODEL: "gpt-mini" }), "gpt-new", "the new name wins");
});
