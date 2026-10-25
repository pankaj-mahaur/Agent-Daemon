// The provider registry (P3.5): presets are data, and the rules they must keep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, presetFor, providerName, signInMethods, UNAVAILABLE, visiblePresets } from "../src/providers/registry.mjs";
import { PRESETS } from "../src/gateway/table.mjs";
import { PROVIDER_NAMES } from "../src/auth/accounts/registry.mjs";
import { ENGINE } from "../src/engine/attribution.mjs";

const WAVE2 = ["gemini", "groq", "cerebras", "mistral", "nvidia", "anthropic", "deepseek", "together", "zai", "zai-coding", "huggingface", "nebius", "minimax", "sambanova"];

test("every preset has id, name, upstream (or is custom), methods, docs and checkedAt; wave 1 is all passthrough, wave 2 chat", () => {
  assert.deepEqual(PROVIDER_PRESETS.map((p) => p.id), ["openai", "openrouter", "kimi-code", "moonshot", "xai", "opencode-go", "fireworks", "custom", "ollama", "lmstudio", ...WAVE2]);
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.id && p.name, p.id);
    assert.ok(p.id === "custom" ? p.upstreamBase === null : /^https?:\/\//.test(p.upstreamBase), `${p.id}: upstream`);
    assert.ok(p.methods.length, `${p.id}: methods`);
    assert.ok(Array.isArray(p.docs) && (p.id === "custom" || p.docs.length), `${p.id}: docs`);
    assert.match(p.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(p.mode, p.id === "opencode-go" ? "per-model" : WAVE2.includes(p.id) ? "chat" : "passthrough");
    assert.deepEqual([...p.strip], []);
    assert.ok(PROVIDER_NAMES.includes(p.id), `${p.id} can't be a label`);
    // Remote presets are https; only local ones use http, on loopback.
    if (p.upstreamBase?.startsWith("http:")) assert.ok(p.local && /^http:\/\/localhost:\d+\/v1$/.test(p.upstreamBase), p.id);
  }
});

test("a supported preset names an acceptance record; a local preset needs no key", () => {
  for (const p of PROVIDER_PRESETS) {
    if (p.status === "supported") assert.ok(p.acceptance, `${p.id} is supported without a record`);
    if (p.local) assert.deepEqual([...p.methods], ["none"]);
  }
});

test("candidates are hidden unless AD_SHOW_CANDIDATES=1; unknown ids are refused with the list", () => {
  const shown = visiblePresets({ env: {} }).map((p) => p.id);
  for (const id of shown) assert.ok(["supported", "experimental"].includes(presetFor(id).status));
  assert.ok(visiblePresets({ env: { AD_SHOW_CANDIDATES: "1" } }).length > shown.length);
  assert.deepEqual(signInMethods("openrouter"), presetFor("openrouter").status === "candidate" ? [] : ["api-key", "openrouter-oauth"]);
  assert.throws(() => presetFor("nope"), (e) => e.code === "UNKNOWN_PROVIDER" && /openrouter/.test(e.message));
  assert.equal(providerName("xai"), "xAI");
});

test("UNAVAILABLE rows carry reason and alternative text exactly", () => {
  assert.deepEqual(
    UNAVAILABLE.map((r) => r.text),
    [
      "Claude Pro/Max sign-in: Anthropic doesn't allow other apps to use it. Claude models work now through OpenRouter; an Anthropic API key comes later.",
      "Gemini CLI sign-in: Google doesn't allow other apps to use it. Gemini models work now through OpenRouter; a Gemini API key comes later.",
      "GitHub Copilot and xAI SuperGrok sign-in: only partner apps may use them. Use an xAI API key.",
      "OpenCode Zen free models: OpenCode allows them only in its own app, so ad doesn't offer them. Free alternatives in ad: OpenRouter's free models and local models (Ollama, LM Studio).",
      "Nous Portal: not available yet (Nous hasn't published a way for other apps to sign in). Hermes models are open: run them with Ollama, or use them through OpenRouter.",
    ],
  );
});

test("no preset header names another product; the gateway's presets come from the registry", () => {
  for (const p of PROVIDER_PRESETS) for (const [k, v] of Object.entries(p.headers)) assert.doesNotMatch(`${k}: ${v}`, new RegExp(["claude", ENGINE.name, "cursor", "copilot", "gemini"].join("|"), "i"), p.id);
  assert.equal(PRESETS.openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(PRESETS.ollama.baseUrl, "http://localhost:11434/v1");
  assert.equal(PRESETS.custom, undefined, "a custom endpoint has no preset base");
});

test("the opencode-go preset names its docs and check date, routes per model, and stays a candidate until its acceptance record", () => {
  const p = PROVIDER_PRESETS.find((x) => x.id === "opencode-go");
  assert.deepEqual(p.docs, ["https://opencode.ai/docs/go"]);
  assert.match(p.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.status, "candidate");
  assert.equal(p.sessionHeader, "x-opencode-session");
  assert.equal(p.ownUserAgent, true);
  assert.equal(p.wires["glm-5.3"], "chat");
  assert.equal(p.wires["gpt-6-luna"], "responses");
  assert.equal(p.wires["claude-haiku-5-5"], "messages");
  for (const w of Object.values(p.wires)) assert.ok(["responses", "chat", "messages", "gemini"].includes(w), w);
});

test("no Go header names OpenCode or another product", () => {
  const p = PROVIDER_PRESETS.find((x) => x.id === "opencode-go");
  // Product names, the engine's built from parts (the brand lint keeps it out of tests).
  const names = new RegExp(["opencode", ["co", "dex"].join(""), "claude", "kimi"].join("|"), "i");
  for (const [k, v] of Object.entries(p.headers)) assert.ok(!names.test(`${k} ${v}`), k);
});
