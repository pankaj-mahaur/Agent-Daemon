// ad must never run Codex in the user's own Codex home (~/.codex, or a
// CODEX_HOME their shell sets for their own Codex).

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertIsolatedHome, defaultCodexHome, userCodexHomes } from "../src/engine/codex/home.mjs";

const userCodex = join(homedir(), ".codex");

test("~/.codex is always the user's", () => {
  assert.ok(userCodexHomes({}).includes(userCodex));
  assert.throws(() => assertIsolatedHome(userCodex, {}), /your own Codex home/);
  if (process.platform === "win32") assert.throws(() => assertIsolatedHome(userCodex.toUpperCase(), {}), /your own Codex home/);
});

test("a CODEX_HOME inherited from the user's shell is theirs too", () => {
  const env = { CODEX_HOME: join(homedir(), "work-codex") };
  assert.throws(() => assertIsolatedHome(join(homedir(), "work-codex"), env), /your own Codex home/);
  assert.doesNotThrow(() => assertIsolatedHome(defaultCodexHome(env), env));
});

test("hooks that Codex runs for ad inherit ad's CODEX_HOME and may start an engine", () => {
  const env = { CODEX_HOME: defaultCodexHome({}) };
  assert.deepEqual(userCodexHomes(env), [userCodex]);
  assert.doesNotThrow(() => assertIsolatedHome(defaultCodexHome(env), env));
  const custom = { AD_CODEX_HOME: join(homedir(), "ad-test-home"), CODEX_HOME: join(homedir(), "ad-test-home") };
  assert.doesNotThrow(() => assertIsolatedHome(defaultCodexHome(custom), custom));
});

test("no CODEX_HOME at all is refused", () => {
  assert.throws(() => assertIsolatedHome(undefined, {}), /without an explicit CODEX_HOME/);
  assert.throws(() => assertIsolatedHome("", {}), /without an explicit CODEX_HOME/);
});
