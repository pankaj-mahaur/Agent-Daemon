// P4.1: the session ledger and its index, in a throwaway home.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-ledger-"));
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

const { openLedger, readLedger, compactFile } = await import("../src/sessions/ledger.mjs");
const { readIndex, updateIndex } = await import("../src/sessions/index.mjs");

test("seq grows by one, also across a reopen", () => {
  const a = openLedger({ sessionId: "ses_A" });
  a.append({ type: "created", cwd: "/w", origin: "tui" });
  a.append({ type: "turnStarted", turnId: "t1", trigger: "user" });
  a.close();
  const b = openLedger({ sessionId: "ses_A" });
  b.append({ type: "turnCompleted", turnId: "t1", status: "completed" });
  b.close();
  assert.deepEqual(readLedger("ses_A").map((e) => e.seq), [1, 2, 3]);
  for (const e of readLedger("ses_A")) assert.ok(e.eventId && e.at && e.v === 1 && e.sessionId === "ses_A");
});

test("a torn last line is repaired (once noticed) and seq continues", () => {
  const a = openLedger({ sessionId: "ses_T" });
  a.append({ type: "created", cwd: "/w", origin: "tui" });
  a.append({ type: "turnStarted", turnId: "t1", trigger: "user" });
  a.close();
  fs.appendFileSync(a.file, '{"v":1,"sessionId":"ses_T","seq":3,"type":"turnComp');
  const b = openLedger({ sessionId: "ses_T" });
  assert.equal(b.repaired, 1);
  b.append({ type: "turnCompleted", turnId: "t1", status: "completed" });
  b.close();
  assert.deepEqual(readLedger("ses_T").map((e) => e.seq), [1, 2, 3]);
});

test("a second window can't open the same session", () => {
  const a = openLedger({ sessionId: "ses_B" });
  try {
    assert.throws(() => openLedger({ sessionId: "ses_B" }), { code: "SESSION_LEDGER_BUSY" });
  } finally {
    a.close();
  }
});

test("a 40 KB prompt is cut and marked; a key is redacted; private prompts and reasoning never stored", () => {
  const KEY = ["sk", "test", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"].join("-");
  const a = openLedger({ sessionId: "ses_P" });
  a.append({ type: "userMessage", clientId: "c1", via: "submit", text: "x".repeat(40 * 1024) });
  a.append({ type: "userMessage", clientId: "c2", via: "submit", text: `use ${KEY} please` });
  a.append({ type: "toolIntent", turnId: "t", rootTurnId: "t", itemId: "i", key: "i@t", kind: "commandExecution", effect: "exec", summary: `curl -H "Authorization: Bearer ${KEY}"` });
  a.append({ type: "userMessage", clientId: "c3", via: "submit", text: null, private: true });
  a.append({ type: "turnCompleted", turnId: "t", status: "completed", reasoning: "secret thoughts", encrypted_content: "blob", summaryText: "s" });
  a.close();
  const raw = fs.readFileSync(a.file, "utf8");
  const ev = readLedger("ses_P");
  assert.ok(Buffer.byteLength(ev[0].text) <= 16 * 1024 && ev[0].truncated);
  assert.ok(!raw.includes(KEY), "redacted");
  assert.equal(ev[3].text, null);
  for (const k of ["secret thoughts", "encrypted_content", "summaryText"]) assert.ok(!raw.includes(k), k);
});

test("compaction keeps unknown tools, violations and bindings; seq continues after it", () => {
  const a = openLedger({ sessionId: "ses_C" });
  a.append({ type: "created", cwd: "/w", origin: "tui" });
  a.append({ type: "bindingStarted", binding: { gen: 1, home: "engine", threadId: "th1" } });
  a.append({ type: "toolIntent", turnId: "t0", rootTurnId: "t0", itemId: "u", key: "u@t0", effect: "exec" });
  a.append({ type: "toolResult", turnId: "t0", rootTurnId: "t0", itemId: "u", key: "u@t0", status: "unknown" });
  a.append({ type: "violation", gen: 1, threadId: "th1", turnId: "tx" });
  for (let i = 0; i < 2500; i++) a.append({ type: "turnStarted", turnId: `t${i + 1}`, trigger: "user" });
  const last = a.seq;
  a.close();
  const r = compactFile(a.file, "ses_C", { force: true });
  assert.equal(r.through, last);
  const ev = readLedger("ses_C");
  assert.equal(ev[0].type, "snapshot");
  for (const t of ["created", "bindingStarted", "violation"]) assert.ok(ev.some((e) => e.type === t), t);
  assert.ok(ev.some((e) => e.type === "toolResult" && e.status === "unknown"));
  assert.ok(ev.length < 2600);
  const b = openLedger({ sessionId: "ses_C" });
  b.append({ type: "turnStarted", turnId: "after", trigger: "user" });
  b.close();
  assert.equal(readLedger("ses_C").at(-1).seq, last + 1);
});

test("two processes × 50 index updates: nothing lost", async () => {
  const script = fileURLToPath(new URL("./fixtures/sessions-index-writer.mjs", import.meta.url));
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `import { updateIndex } from ${JSON.stringify(new URL("../src/sessions/index.mjs", import.meta.url).href)};\nconst tag = process.argv[2];\nfor (let i = 0; i < 50; i++) await updateIndex((ix) => { ix.sessions[tag + i] = { state: "open" }; }, { waitMs: 30000 });\n`);
  try {
    const run = (tag) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [script, tag], { env: process.env, stdio: "ignore" });
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${c}`))));
    });
    await Promise.all([run("a"), run("b")]);
    const ix = readIndex();
    assert.ok(ix.revision >= 100, String(ix.revision));
    for (const tag of ["a", "b"]) for (let i = 0; i < 50; i++) assert.ok(ix.sessions[tag + i], tag + i);
  } finally {
    fs.rmSync(script, { force: true });
  }
});

test("updateIndex re-reads: the latest copy is the one changed", async () => {
  await updateIndex((ix) => {
    ix.sessions.one = { state: "open" };
  });
  await updateIndex((ix) => {
    assert.ok(ix.sessions.one);
    ix.threads["engine|th"] = "one";
  });
  assert.equal(readIndex().threads["engine|th"], "one");
});

test("an open that fails after the lock lets the lock go (review P4.1)", () => {
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (String(p).endsWith("ses_F.jsonl")) throw Object.assign(new Error("disk said no"), { code: "EIO" });
    return real(p, ...rest);
  };
  try {
    assert.throws(() => openLedger({ sessionId: "ses_F" }), { code: "EIO" });
  } finally {
    fs.openSync = real;
  }
  const l = openLedger({ sessionId: "ses_F" });
  l.append({ type: "created", cwd: "/w", origin: "tui" });
  l.close();
  assert.equal(readLedger("ses_F").length, 1);
});

test("after compaction every seq in the file is unique and the snapshot names child turns", () => {
  const a = openLedger({ sessionId: "ses_U" });
  a.append({ type: "created", cwd: "/w", origin: "tui" });
  a.append({ type: "turnStarted", turnId: "kid-turn", thread: "kid", parentTurnId: "root-turn", trigger: "subagent" });
  for (let i = 0; i < 2100; i++) a.append({ type: "turnCompleted", turnId: `t${i}`, status: "completed" });
  a.close();
  compactFile(a.file, "ses_U", { force: true });
  const ev = readLedger("ses_U");
  const seqs = ev.map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(ev[0].childTurns, { "kid-turn": "root-turn" });
});
