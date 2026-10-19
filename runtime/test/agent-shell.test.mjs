// Tests for runtime/src/security/agent-shell.mjs (D49): commands that accept
// or promote memory refuse inside an agent's tool shell and without a TTY.
// The TTY check is injected here; there is no environment override for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmTyped, refuseInAgentShell } from "../src/security/agent-shell.mjs";

const tty = () => true;
const noTty = () => false;
const REFUSAL = "ad memory held accept only runs in your own terminal, not from an agent's shell.";

test("the agent-shell marker refuses, even with a TTY", () => {
  assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: { AD_TOOL_SHELL: "1" }, isTTY: tty }), REFUSAL);
});

test("no TTY refuses", () => {
  assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: {}, isTTY: noTty }), REFUSAL);
});

test("a TTY and no marker may run", () => {
  assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: {}, isTTY: tty }), null);
  assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: { AD_TOOL_SHELL: "0" }, isTTY: tty }), null);
});

test("needTty: false still refuses under the marker", () => {
  assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: { AD_TOOL_SHELL: "1" }, isTTY: noTty, needTty: false }), REFUSAL);
  assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: {}, isTTY: noTty, needTty: false }), null);
});

test("no environment variable skips the TTY half", () => {
  for (const k of ["AD_INTERNAL_TEST_TTY", "AD_FORCE_TTY", "FORCE_TTY", "CI"]) {
    assert.equal(refuseInAgentShell({ cmd: "memory held accept", env: { [k]: "1" }, isTTY: noTty }), REFUSAL, k);
  }
});

test("the default TTY check reads the real streams (not a TTY under node --test)", () => {
  assert.equal(refuseInAgentShell({ cmd: "x", env: {} }), "ad x only runs in your own terminal, not from an agent's shell.");
});

test("confirmTyped needs the exact id typed", async () => {
  const io = (answer) => ({ ask: async (q) => { io.asked = q; return answer; } });
  const a = io("42");
  assert.equal(await confirmTyped({ expected: "42", io: a }), true);
  assert.equal(io.asked, "Type 42 to confirm: ");
  assert.equal(await confirmTyped({ expected: "42", io: io(" 42 \n") }), true);
  assert.equal(await confirmTyped({ expected: "42", io: io("y") }), false);
  assert.equal(await confirmTyped({ expected: "42", io: io("") }), false);
  assert.equal(await confirmTyped({ expected: "42", io: io("420") }), false);
});
