// Accounts in the terminal UI (P3.8b): /model and /account with several accounts, the
// switch table, /logout, in-UI sign-in with a masked key field, the footer's account.
// UI flows run against a stub accounts layer; the glue (createTuiAccounts) runs against a
// real account list, the fake engine and a session, in a throwaway HOME / AD_ROOT.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-tui-acct-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { createEngine } = await import("../src/engine/index.mjs");
const { createSession } = await import("../src/harness/session.mjs");
const { createApp } = await import("../src/tui/app.mjs");
const { createHistory } = await import("../src/tui/history.mjs");
const { createRenderer } = await import("../src/tui/terminal/renderer.mjs");
const { createInputDecoder } = await import("../src/tui/terminal/input.mjs");
const { modelScreen } = await import("../testkit/screen.mjs");
const { statusSegments } = await import("../src/tui/status.mjs");
const { UNAVAILABLE } = await import("../src/providers/registry.mjs");

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

const acct = (o) => ({ id: `acct_${o.provider}_${o.label}`, owner: "", status: "ready", method: "api-key", keyHint: "1111", identity: null, credential: { kind: "secret", ref: `r-${o.label}` }, ...o });
const A = {
  personal: acct({ provider: "chatgpt", label: "personal", method: "engine-login", keyHint: null, credential: { kind: "engine-home", home: "@default" }, identity: { email: "sam@example.com", plan: "plus" } }),
  def: acct({ provider: "openrouter", label: "default", keyHint: "9f3c" }),
  client: acct({ provider: "openrouter", label: "client-a", owner: "Rahul's key", keyHint: "a1b2" }),
  work: acct({ provider: "chatgpt", label: "work", method: "engine-login", status: "needs-sign-in", keyHint: null, credential: { kind: "engine-home", home: "a/h1" } }),
};

// An OpenRouter sign-in address is long (callback and PKCE challenge): wider than the terminal.
const LONG_URL = `https://openrouter.ai/auth?callback_url=${"x".repeat(150)}`;

/** A stub accounts layer: records what the app asks for. */
function stubAccounts({ current = A.def, plans = {}, models = [], extra = [], rows = null } = {}) {
  const calls = [];
  let cur = current;
  return {
    calls,
    snapshot: () => ({ accounts: [...Object.values(A), ...extra], defaultId: A.def.id, current: cur, ready: 3 }),
    current: () => cur,
    label: () => `OpenRouter \u{b7} ${cur.label}`,
    plan: (a) => plans[a.id] ?? "new",
    models: async (a) => (a.method === "engine-login" ? null : models),
    switchTo: async (a, o) => {
      calls.push(["switchTo", a.id, o]);
      const kind = plans[a.id] === "continues" ? "continues" : "new";
      cur = a;
      return { kind };
    },
    setDefault: async (a, m) => calls.push(["setDefault", a.id, m]),
    logout: async (a) => {
      calls.push(["logout", a.id]);
      const wasCurrent = a.id === cur.id;
      return { wasCurrent, text: wasCurrent ? `Signed out of ${a.label}. Pick an account to keep working.` : `Signed out: ${a.label}. This window keeps ${cur.label}.` };
    },
    providers: () => ({ rows: rows ?? [{ id: "openrouter", name: "OpenRouter", method: "api-key", label: "OpenRouter" }, { id: "xai", name: "xAI", method: "api-key", label: "xAI" }], unavailable: UNAVAILABLE }),
    nextLabel: () => "work",
    reSignIn: async (a, o) => {
      const key = await o.readKey();
      calls.push(["reSignIn", a.id, key.length]);
      return { ...a, status: "ready", keyHint: key.slice(-4) };
    },
    signIn: async (o) => {
      if (o.method === "openrouter-oauth") {
        calls.push(["oauth", Boolean(o.signal)]);
        o.out.write(["Opening your browser. If it doesn't open, go to:", `  ${LONG_URL}`, ""].join("\n"));
        // Waits for the browser until cancelled.
        await new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "ABORTED" }))));
      }
      const key = await o.readKey();
      calls.push(["signIn", o.provider, o.label, o.owner, key.length]);
      return { ...acct({ provider: o.provider, label: o.label }), keyHint: key.slice(-4) };
    },
  };
}

async function withApp(fn, { accounts, actions = {}, historyFile = path.join(TMP, `history-${Math.random().toString(36).slice(2)}.jsonl`), cols = 100, rows = 30 } = {}) {
  const root = fs.mkdtempSync(path.join(TMP, "app-"));
  const engine = await createEngine({ home: path.join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: path.join(root, "locks"), modelProvider: accounts.current()?.id ?? null });
  const scr = modelScreen({ cols, rows });
  const listeners = new Set();
  const titles = [];
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)), setTitle: (t) => titles.push(t) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const type = (s) => decoder.feed(s);
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const scrollback = [];
  const commit = renderer.commit.bind(renderer);
  renderer.commit = (lines) => {
    for (const l of lines) scrollback.push((typeof l === "string" ? l : l.map((s) => s.text).join("")).replace(/ +$/, ""));
    return commit(lines);
  };
  const committed = () => scrollback.join("\n");
  const app = createApp({ io, renderer, session, cwd: root, header: [[{ text: "HEADER" }]], armMs: 0, history: createHistory({ file: historyFile }), actions: { accounts, bell: () => {}, ...actions } });
  const text = () => scr.lines().join("\n");
  const until = async (pred, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${what}\n--- screen ---\n${text()}\n--- scrollback ---\n${committed()}`);
  };
  try {
    await fn({ app, type, text, committed, until, session, titles, historyFile });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    await engine.close().catch(() => {});
  }
}

test("/model with several accounts groups them by provider and marks this window and the default; the unavailable ones only behind the why-row", async () => {
  const accounts = stubAccounts();
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/model\r");
      await until(() => /Account and model/.test(text()), "the account picker");
      const s = text();
      assert.match(s, /^ ChatGPT$/m);
      assert.match(s, /^ OpenRouter$/m);
      assert.match(s, /● default.*key …9f3c.*this window.*default for new sessions/);
      assert.match(s, /client-a {2}Rahul's key.*key …a1b2/);
      assert.match(s, /work.*needs sign-in/);
      assert.match(s, /\+ Add an account…/);
      assert.ok(!/Anthropic doesn't allow/.test(s), "no unavailable rows in the daily switcher");
      type("why");
      type("\r");
      await until(() => /Not offered in ad/.test(committed()), "the reasons");
      assert.match(committed(), /Claude models work now through OpenRouter/);
    },
    { accounts },
  );
});

test("an account change during a turn gets the wait text; a model change alone works", async () => {
  const accounts = stubAccounts({ plans: { [A.client.id]: "continues" }, models: [{ id: "m/x", name: "m/x", free: false }] });
  await withApp(
    async ({ type, text, until, committed, session }) => {
      session.submit("hang");
      await until(() => session.state.activeTurnId, "the turn");
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("client");
      await until(() => /client-a/.test(text()) && !/personal/.test(text()), "the filter");
      type("\r");
      await until(() => /Wait for the turn to finish \(or esc\), then switch accounts\. A model change alone works from\s+the\s+next\s+turn\./.test(committed()), "the wait text");
      assert.equal(accounts.calls.filter((c) => c[0] === "switchTo").length, 0);
      await session.interrupt();
    },
    { accounts },
  );
});

test("rows say before Enter whether the conversation continues or a new one starts, and that is what happens", async () => {
  const accounts = stubAccounts({ plans: { [A.client.id]: "continues", [A.personal.id]: "new" }, models: [{ id: "m/x", name: "m/x", free: false }] });
  await withApp(
    async ({ type, text, until, committed, session }) => {
      await session.submit("early-complete").done;
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      assert.match(text(), /client-a.*continues this conversation/);
      assert.match(text(), /personal.*starts a new conversation/);
      type("client");
      type("\r");
      await until(() => /Model · OpenRouter · client-a/.test(text()), "its models");
      assert.match(text(), /m\/x.*continues this conversation/);
      type("\r");
      await until(() => /Reasoning effort/.test(text()), "the effort step");
      type("\r"); // default: the model's own
      await until(() => /Now on OpenRouter · client-a; the conversation continues\./.test(committed()), "the continue text");
      assert.deepEqual(accounts.calls.find((c) => c[0] === "switchTo"), ["switchTo", A.client.id, { model: "m/x", effort: undefined }]);
      // Another provider: asked first, then a new conversation.
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker again");
      type("personal");
      type("\r");
      await until(() => /Start a new conversation on ChatGPT · personal\?/.test(text()), "the confirm");
      type("y");
      await until(() => /Switched to ChatGPT · personal \(new conversation\)\./.test(committed()), "the new-conversation text");
    },
    { accounts },
  );
});

test("free models show the tag with the price age and the data note", async () => {
  const accounts = stubAccounts({ models: [{ id: "q:free", name: "q:free", free: true, priceObservedAt: Date.now() - 2 * 3_600_000, dataNote: "Free models may log or train on prompts, depending on the provider behind them." }, { id: "paid", name: "paid", free: false }] });
  await withApp(
    async ({ type, text, until }) => {
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("client");
      type("\r");
      await until(() => /q:free/.test(text()), "the models");
      assert.match(text(), /q:free {2}free · checked 2h ago · Free models may log/);
      assert.ok(!/paid {2}free/.test(text()));
    },
    { accounts },
  );
});

test("/logout of this window's account opens /account; of another account leaves this window alone", async () => {
  const accounts = stubAccounts();
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/logout openrouter/client-a\r");
      await until(() => /Signed out: client-a\. This window keeps default\./.test(committed()), "the other-account text");
      assert.ok(!/Account and model/.test(text()));
      type("/logout openrouter/default\r");
      await until(() => /Signed out of default\. Pick an account to keep working\./.test(committed()), "this window's text");
      await until(() => /Account and model/.test(text()), "the picker opens");
    },
    { accounts },
  );
});

test("/login: the key goes through a masked field with no history; it never reaches the screen, the scrollback, history.jsonl or the title", async () => {
  const accounts = stubAccounts();
  const KEY = ["sk", "or", "v1", "zzzz9999zzzz9999zz77"].join("-");
  await withApp(
    async ({ type, text, until, committed, historyFile, titles }) => {
      type("/login\r");
      await until(() => /Add an account/.test(text()), "the provider list");
      assert.match(text(), /Not offered/);
      type("OpenRouter");
      type("\r");
      await until(() => /A label for this OpenRouter account/.test(text()), "the label");
      type("\r"); // keeps the suggested "work"
      await until(() => /Whose is it\?/.test(text()), "the owner");
      type("client:acme\r");
      await until(() => /OpenRouter API key/.test(text()), "the key field");
      type(KEY);
      await until(() => /•{10,}/.test(text()), "dots");
      assert.ok(!text().includes(KEY) && !text().includes("zz77"));
      type("\r");
      await until(() => /Signed in: OpenRouter · work\./.test(committed()), "signed in");
      assert.deepEqual(accounts.calls.find((c) => c[0] === "signIn"), ["signIn", "openrouter", "work", "client:acme", KEY.length]);
      const history = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, "utf8") : "";
      for (const where of [text(), committed(), history, titles.join("\n")]) assert.ok(!where.includes(KEY), "the key leaked");
      type("n");
    },
    { accounts },
  );
});

test("/model default makes this window's account the default", async () => {
  const accounts = stubAccounts({ current: A.client });
  await withApp(
    async ({ type, until, committed }) => {
      type("/model default\r");
      await until(() => /New sessions now use OpenRouter · client-a\./.test(committed()), "the default text");
      assert.equal(accounts.calls[0][1], A.client.id);
    },
    { accounts },
  );
});

test("the footer shows the account when more than one is ready", () => {
  assert.equal(statusSegments(["model-with-reasoning"], { model: "m", effort: "high", account: "OpenRouter · work" })[0].text, "m high · OpenRouter · work");
  assert.equal(statusSegments(["model"], { model: "m", account: null })[0].text, "m");
});

test("glue: createTuiAccounts switches between two keys of one provider by fork, and names this window's account", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
  const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
  fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
  const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
  const a = { ...reg.newAccount({ provider: "openrouter", label: "one", method: "api-key" }), status: "ready", keyHint: "1111" };
  const b = { ...reg.newAccount({ provider: "openrouter", label: "two", method: "api-key" }), status: "ready", keyHint: "2222" };
  await reg.transact((doc) => {
    doc.accounts.push(a, b);
    doc.engines.api.home = "api";
  });
  const root = fs.mkdtempSync(path.join(TMP, "glue-"));
  const engine = await createEngine({ home: path.join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: path.join(root, "locks"), modelProvider: a.providerEntry, homeKey: "api", provider: "openrouter" });
  try {
    const accounts = createTuiAccounts({ session, store, launch: async () => assert.fail("same home: no new engine") });
    assert.equal(accounts.current().id, a.id);
    assert.equal(accounts.label(), "OpenRouter · one");
    await session.submit("early-complete").done;
    assert.equal(accounts.plan(b), "continues");
    const r = await accounts.switchTo(b);
    assert.equal(r.kind, "continues");
    const { lastParams } = await engine.testRequest("debug/state", {});
    assert.equal(lastParams["thread/fork"].modelProvider, b.providerEntry);
    assert.ok(!lastParams["thread/resume"] || lastParams["thread/resume"].modelProvider === undefined, "never a resume with a new provider");
    assert.equal(accounts.current().id, b.id);
  } finally {
    session.close();
    await engine.close();
  }
});

test("a key account that needs sign-in takes a new key in a masked field, for the same account (never a second one)", async () => {
  const expired = acct({ provider: "xai", label: "old", status: "needs-sign-in", keyHint: "0000" });
  const accounts = stubAccounts({ extra: [expired], models: [{ id: "grok-x", name: "grok-x", free: false }] });
  const KEY = ["xai", "zzzz9999zzzz9999zz88"].join("-");
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("old");
      type("\r");
      await until(() => /API key/.test(text()), "the key field");
      type(KEY);
      await until(() => /•{10,}/.test(text()), "dots");
      assert.ok(!text().includes(KEY));
      type("\r");
      await until(() => /Signed in again: .*old\./.test(committed()), "signed in again");
      assert.deepEqual(accounts.calls.find((c) => c[0] === "reSignIn"), ["reSignIn", expired.id, KEY.length]);
      assert.ok(!accounts.calls.some((c) => c[0] === "signIn"), "no new account");
      await until(() => /grok-x/.test(text()), "its models next");
      assert.ok(!committed().includes(KEY));
    },
    { accounts },
  );
});

test("a ChatGPT account that needs sign-in hands off to the ChatGPT sign-in", async () => {
  const accounts = stubAccounts();
  const logins = [];
  const login = async (p) => {
    logins.push(p);
    return "Signed in through ad auth login.";
  };
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("work");
      type("\r");
      await until(() => /Signed in through ad auth login\./.test(committed()), "the hand-off");
      assert.deepEqual(logins, ["chatgpt"]);
      assert.ok(!accounts.calls.some((c) => c[0] === "signIn" || c[0] === "reSignIn"));
    },
    { accounts, actions: { login } },
  );
});

test("after the model, an effort step: its choice reaches the switch", async () => {
  const accounts = stubAccounts({ models: [{ id: "m/x", name: "m/x", free: false }] });
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("client");
      type("\r");
      await until(() => /Model · OpenRouter · client-a/.test(text()), "its models");
      type("\r");
      await until(() => /Reasoning effort/.test(text()), "the effort step");
      type("high");
      type("\r");
      await until(() => /Now on OpenRouter · client-a/.test(committed()), "the switch");
      assert.deepEqual(accounts.calls.find((c) => c[0] === "switchTo"), ["switchTo", A.client.id, { model: "m/x", effort: "high" }]);
    },
    { accounts },
  );
});

test("at 80 columns the row still says whether the conversation continues", async () => {
  const accounts = stubAccounts({ plans: { [A.client.id]: "continues" } });
  await withApp(
    async ({ type, text, until, session }) => {
      await session.submit("early-complete").done;
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      const row = text().split("\n").find((l) => /client-a/.test(l));
      assert.match(row, /continues this conversation/);
    },
    { accounts, cols: 80 },
  );
});

test("/login: Esc on the owner question adds nothing; a key typed as the label is refused and never kept", async () => {
  const accounts = stubAccounts();
  const KEY = ["sk", "or", "v1", "zzzz9999zzzz9999zz66"].join("-");
  await withApp(
    async ({ type, text, until, committed, historyFile }) => {
      type("/login openrouter\r");
      await until(() => /A label for this OpenRouter account/.test(text()), "the label");
      type("\r");
      await until(() => /Whose is it\?/.test(text()), "the owner");
      type("\x1b");
      await until(() => /Not added\./.test(committed()), "not added");
      type("/login openrouter\r");
      await until(() => /A label for this OpenRouter account/.test(text()), "the label again");
      type("\x7f\x7f\x7f\x7f");
      type(KEY);
      type("\r");
      await until(() => /looks like a key, not a label/.test(committed()), "the refusal");
      assert.ok(!accounts.calls.some((c) => c[0] === "signIn"), "nothing signed in");
      const history = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, "utf8") : "";
      for (const where of [committed(), history]) assert.ok(!where.includes(KEY), "the key leaked");
    },
    { accounts },
  );
});

test("/login with a provider ad doesn't offer says so before any question", async () => {
  const accounts = stubAccounts();
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/login nope\r");
      await until(() => /can't add "nope" here/.test(committed()), "the refusal");
      assert.ok(!/A label for/.test(text()));
    },
    { accounts },
  );
});

test("the OpenRouter browser sign-in can be cancelled while it waits", async () => {
  const accounts = stubAccounts({ rows: [{ id: "openrouter", name: "OpenRouter", method: "openrouter-oauth", label: "OpenRouter (sign in in the browser)" }] });
  const copied = [];
  await withApp(
    async ({ type, text, until, committed }) => {
      type("/login\r");
      await until(() => /Add an account/.test(text()), "the provider list");
      type("OpenRouter");
      type("\r");
      await until(() => /A label for this OpenRouter account/.test(text()), "the label");
      type("\r");
      await until(() => /Whose is it\?/.test(text()), "the owner");
      type("\r");
      await until(() => /Waiting for the OpenRouter sign-in/.test(text()), "the wait");
      assert.deepEqual(accounts.calls.find((c) => c[0] === "oauth"), ["oauth", true]);
      await until(() => /If no browser opened, open this address/.test(committed()), "the address");
      // Rows of its own with no indent: joined, they are the address exactly (a copy works).
      const lines = committed().split("\n");
      const from = lines.findIndex((l) => l.startsWith("https://openrouter.ai/"));
      assert.ok(from > 0, "the address starts a row of its own");
      assert.equal(lines.slice(from, from + Math.ceil(LONG_URL.length / 99)).join(""), LONG_URL);
      assert.deepEqual(copied, [LONG_URL]);
      type("\x1b");
      await until(() => /Sign-in cancelled\. Nothing was added\./.test(committed()), "cancelled");
      assert.ok(!/Waiting for the OpenRouter sign-in/.test(text()));
    },
    { accounts, actions: { copy: async (t) => (copied.push(t), { ok: true }) } },
  );
});

test("glue: a damaged account list leaves the UI working with no accounts", async () => {
  const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
  const prev = process.env.AD_ROOT;
  process.env.AD_ROOT = fs.mkdtempSync(path.join(TMP, "corrupt-"));
  try {
    fs.mkdirSync(path.join(process.env.AD_ROOT, "accounts"), { recursive: true });
    fs.writeFileSync(path.join(process.env.AD_ROOT, "accounts", "registry.json"), "{not json");
    const accounts = createTuiAccounts({ session: { state: { config: {}, thread: null } }, store: null });
    assert.deepEqual(accounts.snapshot().accounts, []);
    assert.equal(accounts.current(), null);
    assert.equal(accounts.label(), null);
  } finally {
    process.env.AD_ROOT = prev;
  }
});

test("glue: another engine home is always a new conversation, and its main sign-in can't be signed out from here", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
  const k = { ...reg.newAccount({ provider: "openrouter", label: "three", method: "api-key" }), status: "ready", keyHint: "3333" };
  const main = { ...reg.newAccount({ provider: "chatgpt", label: "main", method: "engine-login", credential: { kind: "engine-home", home: "@default" } }), status: "ready" };
  await reg.transact((doc) => {
    doc.accounts.push(k, main);
    doc.engines.api.home = "api";
  });
  const root = fs.mkdtempSync(path.join(TMP, "glue2-"));
  const engine = await createEngine({ home: path.join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: path.join(root, "locks"), modelProvider: k.providerEntry, homeKey: "api", provider: "openrouter" });
  try {
    const accounts = createTuiAccounts({ session, store: null, launch: async () => assert.fail("plan and logout start nothing") });
    await session.submit("early-complete").done;
    assert.equal(accounts.plan(main), "new");
    await assert.rejects(accounts.logout(main), { code: "LOGOUT_ELSEWHERE" });
    assert.equal(reg.readRegistry().accounts.find((x) => x.id === main.id).status, "ready", "not marked signed out");
  } finally {
    session.close();
    await engine.close();
  }
});

test("glue: two ChatGPT sign-ins in different engine homes never continue one conversation", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
  const team = { ...reg.newAccount({ provider: "chatgpt", label: "team", method: "engine-login", credential: { kind: "engine-home", home: "a/h1" } }), status: "ready" };
  await reg.transact((doc) => {
    doc.accounts.push(team);
  });
  const root = fs.mkdtempSync(path.join(TMP, "glue3-"));
  const engine = await createEngine({ home: path.join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: path.join(root, "locks"), modelProvider: "openai", homeKey: "@default", provider: "chatgpt" });
  try {
    const accounts = createTuiAccounts({ session, store: null, launch: async () => assert.fail("plan starts nothing") });
    await session.submit("early-complete").done;
    assert.equal(session.retarget.plan({ modelProvider: "openai", homeKey: "a/h1", provider: "chatgpt" }), "continues", "the session alone can't tell two homes apart");
    assert.equal(accounts.plan(team), "new");
  } finally {
    session.close();
    await engine.close();
  }
});

test("glue: the footer's account follows the window (a /resume or /new moves it), not only ad's own switches", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
  const [one, two] = ["one", "two"].map((l) => reg.readRegistry().accounts.find((x) => x.provider === "openrouter" && x.label === l));
  const session = { state: { config: { homeKey: "api", modelProvider: one.providerEntry }, thread: null } };
  const accounts = createTuiAccounts({ session, store: null });
  assert.equal(accounts.label(), "OpenRouter · one");
  session.state.thread = { modelProvider: two.providerEntry };
  assert.equal(accounts.label(), "OpenRouter · two");
});

/* ------------------------------------------------------------------ */
/* P4.2: moving the open conversation to another account               */
/* ------------------------------------------------------------------ */

function stubSwitching(hows = {}) {
  const calls = [];
  const ui = { notify: () => {}, ask: () => {} };
  return {
    calls,
    ui,
    runner: {
      how: (t) => hows[t.account?.id] ?? "continuation",
      request: (t, o) => calls.push(["request", t.account.id, o.mode]),
      answer: (v) => calls.push(["answer", v]),
    },
  };
}
const withTargets = (accounts) => ({ ...accounts, targetFor: (a, model) => ({ account: a, model: model ?? null, label: `${a.provider === "chatgpt" ? "ChatGPT" : "OpenRouter"} \u{b7} ${a.label}` }) });

test("switching on: rows say how the conversation continues; an idle switch asks first and runs the switch", async () => {
  const accounts = withTargets(stubAccounts({ models: [] }));
  const switching = stubSwitching({ [A.client.id]: "fork", [A.personal.id]: "continuation" });
  await withApp(
    async ({ type, text, until, committed, session }) => {
      await session.submit("early-complete").done;
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      assert.match(text(), /client-a.*continues this conversation/);
      assert.match(text(), /personal.*continues in a new conversation \(history carried over\)/);
      type("personal");
      type("\r");
      await until(() => /Switch this conversation to ChatGPT · personal\?/.test(text()), "the switch dialog");
      const s = text();
      assert.match(s, /It continues there with its history; files stay as they are\./);
      assert.match(s, /It moves to a new conversation on that account \(the old one stays in \/resume\)\./);
      assert.match(s, /Switch[\s\S]*Use it for new conversations only[\s\S]*Cancel/);
      type("\r");
      await until(() => switching.calls.length === 1, "the request");
      assert.deepEqual(switching.calls[0], ["request", A.personal.id, "wait"]);
      // The runner's lines show in the transcript.
      switching.ui.notify("info", "Switched to ChatGPT · personal (you asked). History carried over: 1 turn.", { line: true });
      await until(() => /── Switched to ChatGPT · personal \(you asked\)\. History carried over: 1 turn\. ──/.test(committed()), "the commit line");
      switching.ui.notify("warn", "Couldn't switch to X: that model isn't available on that account. Still on Y.");
      await until(() => /Couldn't switch to X: that model isn't available on that account\. Still on Y\./.test(committed()), "the abort line");
      assert.equal(accounts.calls.filter((c) => c[0] === "switchTo").length, 0, "the old switch table isn't used");
    },
    { accounts, actions: { switching } },
  );
});

test("switching during a turn: after this turn, now, or Cancel; the footer says a switch is pending while held", async () => {
  const accounts = withTargets(stubAccounts({ models: [] }));
  const switching = stubSwitching({ [A.personal.id]: "continuation" });
  await withApp(
    async ({ type, text, until, session }) => {
      session.submit("hang");
      await until(() => session.state.activeTurnId, "the turn");
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("personal");
      type("\r");
      await until(() => /Switch after this turn[\s\S]*Stop the turn and switch now[\s\S]*Cancel/.test(text()), "three choices");
      assert.match(text(), /Prompts you queue now run after the switch\./);
      type("\x1b[B\r");
      await until(() => switching.calls.length === 1, "the request");
      assert.deepEqual(switching.calls[0], ["request", A.personal.id, "now"]);
      session.hold(true);
      await until(() => /switch pending/.test(text()), "the footer");
      session.hold(false);
      await session.interrupt();
    },
    { accounts, actions: { switching } },
  );
});

test("'Not switched yet': Switch anyway and Cancel answer the runner", async () => {
  const accounts = withTargets(stubAccounts({ models: [] }));
  const switching = stubSwitching();
  await withApp(
    async ({ type, text, until }) => {
      switching.ui.ask("Not switched yet: `npm run deploy` may still be running from the last turn (ad can't tell whether it finished). Check it, then choose Switch anyway.", ["anyway", "cancel"]);
      await until(() => /npm run deploy[\s\S]*Switch anyway[\s\S]*Cancel/.test(text()), "the choice");
      type("\r");
      await until(() => switching.calls.length === 1, "the answer");
      assert.deepEqual(switching.calls[0], ["answer", "anyway"]);
      switching.ui.ask("the conversation didn't stop in time; stop it and try again", ["cancel"]);
      await until(() => /didn't stop in time/.test(text()), "the second");
      type("\x1b");
      await until(() => switching.calls.length === 2, "cancelled");
      assert.deepEqual(switching.calls[1], ["answer", "cancel"]);
    },
    { accounts, actions: { switching } },
  );
});

test("Use it for new conversations only: the default changes, this conversation stays", async () => {
  const accounts = withTargets(stubAccounts({ models: [] }));
  const switching = stubSwitching({ [A.personal.id]: "continuation" });
  await withApp(
    async ({ type, text, until, committed, session }) => {
      await session.submit("early-complete").done;
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("personal");
      type("\r");
      await until(() => /Use it for new conversations only/.test(text()), "the dialog");
      type("\x1b[B\r");
      await until(() => /New conversations use ChatGPT · personal; this one stays here\./.test(committed()), "the text");
      assert.deepEqual(accounts.calls.find((c) => c[0] === "setDefault"), ["setDefault", A.personal.id, null]);
      assert.equal(switching.calls.length, 0);
    },
    { accounts, actions: { switching } },
  );
});

test("/ps lists the terminals still running from before a switch, apart from this conversation's", async () => {
  const accounts = withTargets(stubAccounts({ models: [] }));
  await withApp(
    async ({ type, until, committed, session }) => {
      session.state.priorTerminals = [{ key: "bg@t", itemId: "bg", command: "npm run dev", lines: ["ready on :3000"] }];
      type("/ps\r");
      await until(() => /Still running from before the switch[\s\S]*npm run dev/.test(committed()), "the old terminals");
    },
    { accounts, actions: { switching: stubSwitching() } },
  );
});

test("glue: a switch's target is checked first: an account that needs sign-in, a model it doesn't list; another home starts its engine", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  const { createTuiAccounts } = await import("../src/tui/accounts.mjs");
  const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
  fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
  const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
  const a = { ...reg.newAccount({ provider: "openrouter", label: "prep-a", method: "api-key" }), status: "ready", keyHint: "1111" };
  store.set(a.credential.ref, ["sk", "or", "v1", "prep0000prep0000prep"].join("-"));
  const root = fs.mkdtempSync(path.join(TMP, "prep-"));
  const engine = await createEngine({ home: path.join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: path.join(root, "locks"), homeKey: "api", provider: "openrouter" });
  const fetch = async () => new Response(JSON.stringify({ data: [{ id: "or/listed", name: "Listed" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const launched = [];
  try {
    const accounts = createTuiAccounts({ session, store, fetch, launch: async (x) => (launched.push(x.id), { engine, release: async () => {} }) });
    await assert.rejects(accounts.prepare({ account: { ...a, status: "needs-sign-in" }, homeKey: "api" }), { reason: "signIn" });
    await assert.rejects(accounts.prepare({ account: a, model: "or/missing", homeKey: "api" }), { reason: "model" });
    assert.deepEqual(await accounts.prepare({ account: a, model: "or/listed", homeKey: "api" }), { sameEngine: true });
    const other = await accounts.prepare({ account: a, model: "or/listed", homeKey: "a/zzzz" });
    assert.equal(other.sameEngine, false);
    assert.deepEqual(launched, [a.id]);
  } finally {
    session.close();
    await engine.close();
  }
});

test("model rows show the catalog's price and 'no tools' (P4.3)", async () => {
  const accounts = stubAccounts({ models: [{ id: "m/paid", name: "m/paid", free: false, priceHint: "$1.00 in · $2.00 out per 1M tokens" }, { id: "m/plain", name: "m/plain", free: false, noTools: true }] });
  await withApp(
    async ({ type, text, until }) => {
      type("/account\r");
      await until(() => /Account and model/.test(text()), "the picker");
      type("client");
      type("\r");
      await until(() => /m\/paid/.test(text()), "its models");
      assert.match(text(), /m\/paid.*\$1\.00 in · \$2\.00 out per 1M tokens/);
      assert.match(text(), /m\/plain.*no tools/);
    },
    { accounts },
  );
});
