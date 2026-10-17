// Engine-originated text: ad's words on screen, raw diagnostics on request.
import { EventEmitter } from "node:events";
import { ensureHarnessSetup } from "../src/harness/setup.mjs";
import { createChatSession } from "../src/harness/chat.mjs";
import { setupWindowsSandbox } from "../src/harness/sandbox.mjs";
import { NOT_LOGGED_IN } from "../src/harness/start.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, engineErrorText, engineErrorDetail, engineNoticeText, isEngineError } from "../src/engine/index.mjs";
import { ENGINE, LEGACY } from "../src/engine/attribution.mjs";
import { createSession } from "../src/harness/session.mjs";
import { cliErrorLines } from "../src/harness/io.mjs";

const BRAND = new RegExp(ENGINE.name, "i");
const command = { cmd: process.execPath, prefix: [fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url))] };
const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

test("error mapping preserves raw diagnostics and leaves local errors alone", () => {
  const cases = [
    [error(-32600, "request failed", { raw: "Invalid request: unknown variant `x`" }), /The engine refused a request/, "Invalid request: unknown variant `x`"],
    [error(-32601, "unknown method"), /The engine refused a request/, "unknown method"],
    [error(-32000, `${LEGACY.productValue} is unhappy`), /The engine reported a problem/, `${LEGACY.productValue} is unhappy`],
    [error("ENGINE_EXITED", "stopped", { exitCode: 3, stderr: `${LEGACY.productValue}: panicked at core` }), /The engine stopped \(exit 3\)/, `${LEGACY.productValue}: panicked at core`],
    [error("ENGINE_SPAWN_FAILED", `${LEGACY.productValue} failed`), /The engine could not start/, `${LEGACY.productValue} failed`],
    [error("ENGINE_TIMEOUT", "timeout"), /The engine didn't answer in time/, "timeout"],
    [error("ENGINE_NOT_STARTED", "not started"), /The engine isn't running/, "not started"],
  ];
  for (const [err, expected, raw] of cases) {
    assert.equal(isEngineError(err), true);
    assert.match(engineErrorText(err), expected);
    assert.doesNotMatch(engineErrorText(err), BRAND);
    assert.equal(engineErrorDetail(err), raw);
    assert.doesNotMatch(engineErrorText(err, { details: null }), /\/warnings/);
  }
  assert.equal(engineErrorText(cases[4][0], { details: null }), "The engine could not start. Run: ad doctor");
  for (const err of [error("HOME_TWO_FOLDERS", "choose a folder"), new Error("x")]) {
    assert.equal(isEngineError(err), false);
    assert.equal(engineErrorText(err), err.message);
    assert.equal(engineErrorDetail(err), null);
  }
});

test("notice mapping names the warning kind and points to the raw details", () => {
  for (const code of ["warning", "deprecation", "config", "future-kind"]) {
    const message = engineNoticeText({ code, message: `${LEGACY.productValue} detail` });
    assert.doesNotMatch(message, BRAND);
    assert.match(message, /Details: \/warnings/);
  }
  assert.match(engineNoticeText({ code: "warning" }), /sent a warning/);
  assert.match(engineNoticeText({ code: "deprecation" }), /going away/);
  assert.match(engineNoticeText({ code: "config" }), /settings file/);
});

test("global and thread engine notices keep their unmodified raw text", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-text-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks") });
  try {
    await session.submit("fail-turn").done;
    for (const threadId of [undefined, session.state.thread.id]) {
      for (const [method, code, body] of [
        ["warning", "warning", { message: `${LEGACY.productValue} is unhappy` }],
        ["deprecationNotice", "deprecation", { summary: `${LEGACY.productValue} is old`, details: "raw details" }],
        ["configWarning", "config", { summary: `${LEGACY.productValue} config issue`, path: "/fake/config.toml", details: "raw config details" }],
      ]) {
        const before = session.state.notices.length;
        engine.testNotify(method, { ...body, ...(threadId ? { threadId } : {}) });
        const end = Date.now() + 3000;
        while (session.state.notices.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
        const notice = session.state.notices.at(-1);
        assert.equal(notice.code, code);
        assert.equal(notice.message, engineNoticeText({ code }));
        assert.equal(notice.detail.split("\n")[0], body.message ?? body.summary);
        if (body.details) assert.ok(notice.detail.includes(body.details));
      }
    }
  } finally {
    session.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash keeps stderr outside the engine error message", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-crash-text-"));
  const raw = `${LEGACY.productValue}: panicked at core`;
  const engine = await createEngine({ home: join(root, "home"), command, env: { FAKE_CRASH_STDERR: raw } });
  try {
    await assert.rejects(engine.testRequest("test/crash"), (err) => {
      assert.equal(err.code, "ENGINE_EXITED");
      assert.doesNotMatch(err.message, BRAND);
      assert.equal(err.stderr, raw);
      return true;
    });
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI errors put original engine text only on labelled details lines", () => {
  const raw = `${LEGACY.productValue} refused\nsecond line`;
  assert.equal(cliErrorLines("run", error(-32000, raw)), `ad run: The engine reported a problem.\n  details: ${LEGACY.productValue} refused\n  details: second line\n`);
  assert.equal(cliErrorLines("run", new Error("x")), "ad run: x\n");
  assert.equal(cliErrorLines("run", error(-32000, Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n"))).split("\n").length, 10, "at most eight detail lines and one final newline");
});


test("review: chat interrupt maps the exact engine rejection", async () => {
  const raw = `${LEGACY.productValue} refused interrupt`;
  const engine = new EventEmitter();
  engine.interrupt = async () => { throw error(-32000, raw, { raw }); };
  let printed = "";
  const chat = createChatSession({ engine, cwd: tmpdir(), out: { write() {} }, err: { write(s) { printed += s; } }, ask: async () => "n" });
  chat.state.turn = { threadId: "thread-1", turnId: "turn-1" };
  await chat.interrupt();
  assert.match(printed, /The engine reported a problem/);
  assert.ok(printed.includes(`  details: ${raw}\n`));
  assert.doesNotMatch(printed.split("\n")[0], BRAND);
});

test("review: setup and recap preserve classification and original diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-text-wrappers-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  try {
    const raw = `${LEGACY.productValue} hook trust failure`;
    engine.listHooks = async () => { throw error(-32000, raw); };
    const report = await ensureHarnessSetup(engine, { cwd: root, roots: [], profile: "developer" });
    assert.doesNotMatch(report.warnings.join("\n"), BRAND);
    assert.ok(report.details.some((d) => d.detail === raw));
    const recapRaw = `${LEGACY.productValue} recap failed`;
    engine.turn = async () => ({ status: "failed", error: { message: recapRaw } });
    await assert.rejects(engine.structuredRequest({ cwd: root, text: "recap", outputSchema: { type: "object" } }), (err) => {
      assert.equal(isEngineError(err), true);
      assert.equal(engineErrorDetail(err), recapRaw);
      assert.doesNotMatch(engineErrorText(err), BRAND);
      return true;
    });
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the signed-out prerequisite leads with API routes", () => {
  assert.ok(NOT_LOGGED_IN.indexOf("openai") < NOT_LOGGED_IN.indexOf("chatgpt"));
  assert.ok(NOT_LOGGED_IN.indexOf("openrouter") < NOT_LOGGED_IN.indexOf("chatgpt"));
});

test("sandbox setup keeps a failed result classified as an engine error", async () => {
  const raw = `${LEGACY.productValue} sandbox setup failed`;
  await assert.rejects(setupWindowsSandbox({ sandbox: { setup: async () => ({ success: false, error: raw }) } }), (err) => {
    assert.equal(isEngineError(err), true);
    assert.equal(engineErrorDetail(err), raw);
    assert.equal(cliErrorLines("sandbox", err), `ad sandbox: The engine reported a problem.\n  details: ${raw}\n`);
    return true;
  });
});
