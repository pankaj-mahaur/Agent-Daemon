// The provider registry (P3.5): presets are data, and the rules they must keep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, presetFor, providerName, signInMethods, UNAVAILABLE, visiblePresets } from "../src/providers/registry.mjs";
import { PRESETS } from "../src/gateway/table.mjs";
import { PROVIDER_NAMES } from "../src/auth/accounts/registry.mjs";
import { ENGINE } from "../src/engine/attribution.mjs";

test("every preset has id, name, upstream (or is custom), methods, docs and checkedAt; wave 1 is all passthrough", () => {
  assert.deepEqual(PROVIDER_PRESETS.map((p) => p.id), ["openai", "openrouter", "kimi-code", "moonshot", "xai", "fireworks", "custom", "ollama", "lmstudio"]);
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.id && p.name, p.id);
    assert.ok(p.id === "custom" ? p.upstreamBase === null : /^https?:\/\//.test(p.upstreamBase), `${p.id}: upstream`);
    assert.ok(p.methods.length, `${p.id}: methods`);
    assert.ok(Array.isArray(p.docs) && (p.id === "custom" || p.docs.length), `${p.id}: docs`);
    assert.match(p.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(p.mode, "passthrough");
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
