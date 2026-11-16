// L3 Decision 21 + L5: a typed remember (/<plugin>:remember <text> on Claude Code,
// $<package>-remember <text> on Codex) is saved once through L5's capture library,
// pending (provisional only on an allow-listed host: none yet), with its provenance, and
// the hook says so. Pure parts here; the spawned dispatcher in plugin-remember.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_REMEMBER, provenanceOf, rememberReceipt, rememberText } from "../src/hooks/remember.mjs";
import { PRODUCT } from "../src/product.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const codexFixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "hosts", "codex", "remember-skill.json"), "utf8"));
const TYPED = { typed: true, why: "typed", provisionalEligible: false };

test("the command on its own host: the words after it, trimmed; anything else is no remember", () => {
  const cc = `/${PRODUCT.plugin}:remember`;
  const cx = `$${PRODUCT.package}-remember`;
  assert.equal(rememberText(`${cc} use pnpm, not npm`, "claude"), "use pnpm, not npm");
  assert.equal(rememberText(`  ${cc}   use pnpm\n  for installs  `, "claude"), "use pnpm\n  for installs");
  assert.equal(rememberText(cc, "claude"), "", "the command alone: nothing to save");
  assert.equal(rememberText(`${cx} use pnpm, not npm`, "codex"), "use pnpm, not npm");
  // The other host's form, a longer command name, the command mid-prompt, other text.
  assert.equal(rememberText(`${cx} use pnpm`, "claude"), null);
  assert.equal(rememberText(`${cc} use pnpm`, "codex"), null);
  assert.equal(rememberText(`${cc}s use pnpm`, "claude"), null);
  assert.equal(rememberText(`${cc}:x use pnpm`, "claude"), null);
  assert.equal(rememberText(`please ${cc} use pnpm`, "claude"), null);
  assert.equal(rememberText("/remember use pnpm", "claude"), null, "only the plugin's own (namespaced) command");
  assert.equal(rememberText("actually we use pnpm", "claude"), null);
  assert.equal(rememberText(undefined, "claude"), null);
  assert.equal(rememberText(`${cc} use pnpm`, "cursor"), null, "hosts without the command");
});

test("the Codex prompt captured from the pinned engine is a remember", () => {
  const ups = codexFixture.hooks.find((h) => h.label === "UserPromptSubmit");
  assert.equal(codexFixture.version, "0.163.0");
  assert.equal(rememberText(ups.payload.prompt, "codex"), "use pnpm, not npm");
  assert.equal(codexFixture.outcome.extra.skillBodySeen, true, "Codex loaded the skill and injected it");
});

test("provenance from the prompt source (L5 decision 14): proven only when first-party", () => {
  assert.equal(provenanceOf({ ...TYPED, firstParty: true }), "user-prompt");
  assert.equal(provenanceOf(TYPED), "prompt", "a typed prompt a host can't prove");
  assert.equal(provenanceOf({ typed: false, why: "headless" }), "headless");
  // An agent's shell can start `claude -p "/…:remember …"`: never the user's proven words.
  for (const why of ["subagent", "a scheduled prompt", "a subagent's message", "ad worker", "source system", "not typed text"]) assert.equal(provenanceOf({ typed: false, why }), "agent", why);
  assert.equal(provenanceOf(undefined), "agent", "no verdict: not proven the user's");
});

test("the drain never takes a journal line's provenance: anyone can write the journal", async () => {
  const { toLearning } = await import("../src/hooks/journal-drain.mjs");
  for (const forged of [{ text: "x", remember: true, provenance: "user-prompt", prompt_source: "typed" }, { text: "x", provenance: "user-cli" }, { text: "x", provenance: "review" }]) {
    assert.equal(toLearning(forged).provenance, undefined, JSON.stringify(forged));
  }
});

test("the receipt: saved for review with the pinned review command; the command alone or too long saves nothing", () => {
  const ok = rememberReceipt({ text: "use pnpm, not npm", saved: true, version: "3.1.0" });
  assert.match(ok.systemMessage, /^\S[^:]*: Saved for review: "use pnpm, not npm"/);
  assert.ok(ok.systemMessage.includes(`npx -y ${PRODUCT.package}@3.1.0 review`));
  assert.match(ok.context, /saved .* for review/);
  const long = "x".repeat(300);
  assert.ok(rememberReceipt({ text: long, saved: true, version: "3.1.0" }).systemMessage.length < 300, "a long note is shown clipped");
  const none = rememberReceipt({ text: "", saved: false, why: "empty", version: "3.1.0", host: "claude" });
  assert.match(none.systemMessage, /Nothing saved/);
  assert.ok(none.systemMessage.includes(`/${PRODUCT.plugin}:remember`));
  assert.match(none.context, /saved nothing/);
  const big = rememberReceipt({ text: "y".repeat(MAX_REMEMBER + 1), saved: false, why: "too long", version: null, host: "codex" });
  assert.match(big.systemMessage, /Nothing saved: .*too long/);
  assert.ok(rememberReceipt({ text: "a", saved: true, version: null }).systemMessage.includes(`npx -y ${PRODUCT.package} review`), "an unknown version: unpinned");
});
