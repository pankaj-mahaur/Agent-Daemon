// Tests for `ad auth` (harness/auth.mjs) + providers (auth/providers.mjs),
// against the fake app-server with an in-memory config and a file secret
// store in a temp dir. Properties: logins go through Codex, provider keys
// reach the Codex process as env (never config), no secret is printed, and
// a CODEX_HOME not created by ad is never modified without --force.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdAuth, describeAccount, maskEmail } from "../src/harness/auth.mjs";
import { providerEnv, useProviderEdits } from "../src/auth/providers.mjs";
import { createSecretStore, fileBackend } from "../src/auth/secrets.mjs";
import { createEngine } from "../src/engine/index.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const KEY = "sk-or-v1-secret-value-xyz";

function sink() {
  const s = { text: "", write: (c) => ((s.text += c), true) };
  return s;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ad-auth-"));
  const home = join(root, "codex-home"); // fresh → managed
  const store = createSecretStore(fileBackend(join(root, "secrets")));
  const auth = async (sub, args = [], extra = {}) => {
    const stdout = sink();
    const stderr = sink();
    const code = await cmdAuth(sub, args, { home, command, store, stdout, stderr, ...extra });
    return { code, out: stdout.text, err: stderr.text };
  };
  return { root, home, store, auth, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("status shows plan and masked email, never secrets", async () => {
  const t = setup();
  try {
    t.store.set("openrouter", KEY);
    const r = await t.auth("status");
    assert.equal(r.code, 0);
    assert.match(r.out, /ChatGPT plus plan \(so\*+@example\.com\)/);
    assert.match(r.out, /openrouter key:\s+stored \(file\)/);
    assert.ok(!r.out.includes(KEY));
    assert.ok(!r.out.includes("someone@"));
  } finally {
    t.cleanup();
  }
});

test("login chatgpt opens the browser and waits for completion", async () => {
  const t = setup();
  const opened = [];
  try {
    const r = await t.auth("login", ["chatgpt"], { openBrowser: async (url) => (opened.push(url), true), env: { FAKE_LOGGED_OUT: "1" } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(opened, ["https://auth.example/authorize?x=1&y=2"]);
    assert.match(r.out, /Opened your browser/);
    assert.match(r.out, /logged in: ChatGPT pro plan/);
  } finally {
    t.cleanup();
  }
});

test("login chatgpt --device prints the code instead of opening a browser", async () => {
  const t = setup();
  try {
    const r = await t.auth("login", ["chatgpt"], { device: true, openBrowser: async () => assert.fail("must not open a browser") });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /https:\/\/auth\.example\/device and enter code: ABCD-1234/);
  } finally {
    t.cleanup();
  }
});

test("a failed ChatGPT sign-in exits 1 with the reason", async () => {
  const t = setup();
  try {
    const r = await t.auth("login", ["chatgpt"], { openBrowser: async () => true, env: { FAKE_LOGIN_FAIL: "1" } });
    assert.equal(r.code, 1);
    assert.match(r.err, /sign-in failed: denied/);
  } finally {
    t.cleanup();
  }
});

test("login openai passes the key to Codex, not to our store or output", async () => {
  const t = setup();
  try {
    const r = await t.auth("login", ["openai"], { readKey: async () => "sk-openai-test" });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /OpenAI API key/);
    assert.ok(!r.out.includes("sk-openai-test"));
    assert.equal(t.store.has("openrouter"), false);
  } finally {
    t.cleanup();
  }
});

test("login openrouter requires --model before asking for a key", async () => {
  const t = setup();
  try {
    const r = await t.auth("login", ["openrouter"], { readKey: async () => assert.fail("must not prompt without --model") });
    assert.equal(r.code, 1);
    assert.match(r.err, /needs --model/);
  } finally {
    t.cleanup();
  }
});

test("openrouter: key → store, provider active, key reaches Codex as env; logout reverts", async () => {
  const t = setup();
  try {
    const r = await t.auth("login", ["openrouter"], { model: "anthropic/some-model", readKey: async () => KEY });
    assert.equal(r.code, 0, r.err);
    assert.equal(t.store.get("openrouter"), KEY);
    assert.ok(!r.out.includes(KEY));

    const engine = await createEngine({ home: t.home, command, env: providerEnv(t.store) });
    try {
      const { env } = await engine.server.request("debug/state");
      assert.equal(env.hasOpenRouterKey, true);
    } finally {
      await engine.close();
    }

    const logout = await t.auth("logout", ["openrouter"]);
    assert.equal(logout.code, 0);
    assert.equal(t.store.has("openrouter"), false);
  } finally {
    t.cleanup();
  }
});

test("use openrouter without a stored key explains how to add one", async () => {
  const t = setup();
  try {
    const r = await t.auth("use", ["openrouter"], { model: "x/y" });
    assert.equal(r.code, 1);
    assert.match(r.err, /ad auth login openrouter/);
  } finally {
    t.cleanup();
  }
});

test("mutations are refused on a CODEX_HOME that ad did not create", async () => {
  const t = setup();
  try {
    const foreign = join(t.root, "users-codex");
    rmSync(foreign, { recursive: true, force: true });
    await import("node:fs").then((fs) => fs.mkdirSync(foreign));
    writeFileSync(join(foreign, "auth.json"), "{}");
    const r = await cmdAuth("logout", [], { home: foreign, command, store: t.store, stdout: sink(), stderr: sink() });
    assert.equal(r, 2);
    const status = await cmdAuth("status", [], { home: foreign, command, store: t.store, stdout: sink(), stderr: sink() });
    assert.equal(status, 0, "read-only status is allowed");
    assert.equal(readFileSync(join(foreign, "auth.json"), "utf8"), "{}");
  } finally {
    t.cleanup();
  }
});

test("unknown subcommand prints usage", async () => {
  const t = setup();
  try {
    const r = await t.auth("nope");
    assert.equal(r.code, 1);
    assert.match(r.err, /Usage: ad auth/);
  } finally {
    t.cleanup();
  }
});

test("useProviderEdits clears a stale model when switching back to openai", () => {
  assert.deepEqual(useProviderEdits("openai"), [["model_provider", "openai"], ["model", null]]);
  const or = useProviderEdits("openrouter", { model: "m" });
  assert.equal(or[0][0], "model_providers.openrouter");
  assert.equal(or[0][1].env_key, "OPENROUTER_API_KEY");
  assert.equal(or[0][1].wire_api, "responses");
  assert.ok(!JSON.stringify(or).includes("sk-"), "config never carries the key");
  assert.throws(() => useProviderEdits("nope"), /unknown provider/);
});

test("maskEmail and describeAccount", () => {
  assert.equal(maskEmail("someone@example.com"), "so*****@example.com");
  assert.equal(maskEmail("a@b.c"), "a*@b.c");
  assert.equal(describeAccount({ account: null }, {}), "not logged in");
  assert.equal(describeAccount({}, { model_provider: "openrouter", model: "m" }), "provider openrouter, model m");
});

test("a damaged stored key blocks neither status nor logout, and providerEnv only warns", async () => {
  const t = setup();
  try {
    const broken = createSecretStore({
      name: "broken",
      get: () => { throw new Error("Command failed: powershell.exe ConvertTo-SecureString"); },
      has: () => true,
      set: () => {},
      delete: () => {},
    });
    const status = await cmdAuth("status", [], { home: t.home, command, store: broken, stdout: sink(), stderr: sink() });
    assert.equal(status, 0);
    const logout = await cmdAuth("logout", ["openrouter"], { home: t.home, command, store: broken, stdout: sink(), stderr: sink() });
    assert.equal(logout, 0);
    const warnings = [];
    assert.deepEqual(providerEnv(broken, (m) => warnings.push(m)), {});
    assert.match(warnings[0], /could not read stored openrouter key/);
  } finally {
    t.cleanup();
  }
});

test("logout with a typo does not log out of ChatGPT", async () => {
  const t = setup();
  try {
    const r = await t.auth("logout", ["openruoter"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Unknown provider "openruoter"/);
    assert.match((await t.auth("status")).out, /ChatGPT plus plan/);
  } finally {
    t.cleanup();
  }
});

test("openrouter login excludes the key from agent shells; logout restores openai across commands", async () => {
  const t = setup();
  try {
    await t.auth("login", ["openrouter"], { model: "anthropic/some-model", readKey: async () => KEY });
    const cfg = JSON.parse(readFileSync(join(t.home, "fake-config.json"), "utf8"));
    assert.equal(cfg.model_provider, "openrouter");
    assert.equal(cfg.model, "anthropic/some-model");
    assert.equal(cfg.shell_environment_policy.filters.OPENROUTER_API_KEY, "exclude");
    assert.ok(!JSON.stringify(cfg).includes(KEY), "config never carries the key");
    assert.match((await t.auth("status")).out, /provider openrouter, model anthropic\/some-model/);

    await t.auth("logout", ["openrouter"]);
    const after = JSON.parse(readFileSync(join(t.home, "fake-config.json"), "utf8"));
    assert.equal(after.model_provider, "openai");
    assert.equal(after.model, undefined, "stale openrouter model cleared");
    assert.match((await t.auth("status")).out, /ChatGPT plus plan/);
  } finally {
    t.cleanup();
  }
});

test("login chatgpt always prints the sign-in URL", async () => {
  const t = setup();
  try {
    const r = await t.auth("login", ["chatgpt"], { openBrowser: async () => true });
    assert.match(r.out, /https:\/\/auth\.example\/authorize\?x=1&y=2/);
  } finally {
    t.cleanup();
  }
});
