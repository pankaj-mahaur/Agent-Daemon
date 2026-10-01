// Tests for harness/io.mjs readSecret: raw-mode TTY input and piped input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readSecret } from "../src/harness/io.mjs";

function fakeStdin(isTTY) {
  const s = new EventEmitter();
  s.isTTY = isTTY;
  s.rawModes = [];
  s.setRawMode = (on) => s.rawModes.push(on);
  s.setEncoding = () => {};
  s.resume = () => {};
  s.pause = () => {};
  return s;
}
const sink = () => ({ text: "", write(c) { this.text += c; return true; } });

test("TTY: echo off, escape sequences and backspace handled, raw mode restored", async () => {
  const stdin = fakeStdin(true);
  const stderr = sink();
  const p = readSecret("Key: ", { stdin, stderr });
  stdin.emit("data", "ab\u001b[A\u001b[3~cx\u007fd\r");
  assert.equal(await p, "abcd");
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.ok(!stderr.text.includes("abcd"), "the key is never echoed");
});

test("TTY: Ctrl+C rejects", async () => {
  const stdin = fakeStdin(true);
  const p = readSecret("Key: ", { stdin, stderr: sink() });
  stdin.emit("data", "ab\u0003");
  await assert.rejects(p, /cancelled/);
});

test("pipe: resolves on the first line without waiting for EOF", async () => {
  const stdin = fakeStdin(false);
  const stderr = sink();
  const p = readSecret("Key: ", { stdin, stderr });
  stdin.emit("data", "sk-123\r\nignored");
  assert.equal(await p, "sk-123");
  assert.match(stderr.text, /not hidden/);
});

test("pipe: times out instead of hanging forever", async () => {
  const stdin = fakeStdin(false);
  await assert.rejects(readSecret("Key: ", { stdin, stderr: sink(), timeoutMs: 50 }), /timed out/);
});
