// P6.1: the byte-safe SSE parser and writer, the ids and the reasoning envelope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSseParser, sseEvent } from "../src/gateway/translate/sse.mjs";
import { mintId, mistralIds } from "../src/gateway/translate/ids.mjs";
import { open, seal } from "../src/gateway/translate/seal.mjs";

const parse = (chunks) => {
  const out = [];
  const p = createSseParser({ onEvent: (e) => out.push(e) });
  for (const c of chunks) p.push(c);
  p.end();
  return out;
};

test("an event split mid-line and mid-character comes out whole", () => {
  const text = 'data: {"t":"hi 😀"}\n\n';
  const bytes = Buffer.from(text, "utf8");
  const at = bytes.indexOf(0xf0) + 2; // inside the 4-byte emoji
  const out = parse([bytes.subarray(0, 7), bytes.subarray(7, at), bytes.subarray(at)]);
  assert.deepEqual(out.map((e) => e.data), ['{"t":"hi 😀"}']);
});

test("CRLF, LF and CR line ends, comments, multi-line data, event names", () => {
  const out = parse([": keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: x\n\ndata: y\r\r", "data: [DONE]\n\n"]);
  assert.deepEqual(out, [
    { event: "a", data: "one\ntwo", id: null },
    { event: "message", data: "x", id: null },
    { event: "message", data: "y", id: null },
    { event: "message", data: "[DONE]", id: null },
  ]);
});

test("a CRLF split between chunks is one line end", () => {
  const out = parse(["data: a\r", "\ndata: b\r", "\n\r", "\n"]);
  assert.deepEqual(out.map((e) => e.data), ["a\nb"]);
});

test("the last event at EOF without its blank line is kept", () => {
  assert.deepEqual(parse(["data: last"]).map((e) => e.data), ["last"]);
});

test("an event past the cap is refused", () => {
  const p = createSseParser({ onEvent: () => {}, maxEventBytes: 10 });
  assert.throws(() => p.push("data: 0123456789abc\n\n"), { code: "SSE_EVENT_TOO_LARGE" });
});

test("the writer's form", () => {
  assert.equal(sseEvent({ type: "response.created", response: { id: "r" } }), 'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n');
});

test("minted ids: prefix + 24 base62, distinct", () => {
  const a = mintId("call_");
  assert.match(a, /^call_[0-9A-Za-z]{24}$/);
  assert.notEqual(a, mintId("call_"));
});

test("Mistral ids: 9 characters, stable per call, distinct, reversible", () => {
  const m = mistralIds("salt");
  const ids = Array.from({ length: 500 }, (_, i) => m.toUpstream(`call_${i}`));
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{9}$/);
  assert.equal(new Set(ids).size, 500);
  assert.equal(m.toUpstream("call_7"), ids[7]);
  assert.equal(m.fromUpstream(ids[7]), "call_7");
  assert.equal(mistralIds("salt").toUpstream("call_7"), ids[7], "deterministic for the same salt");
});

test("the envelope opens only for its own provider and model, and hides the text", () => {
  const key = randomBytes(32);
  const blob = seal(key, { provider: "deepseek", model: "deepseek-chat" }, "secret thoughts");
  assert.match(blob, /^adg1\./);
  assert.ok(!blob.includes("secret") && !Buffer.from(blob.slice(5), "base64url").toString("latin1").includes("secret"));
  assert.equal(open(key, { provider: "deepseek", model: "deepseek-chat" }, blob), "secret thoughts");
  assert.equal(open(key, { provider: "deepseek", model: "deepseek-reasoner" }, blob), null);
  assert.equal(open(key, { provider: "mistral", model: "deepseek-chat" }, blob), null);
  assert.equal(open(randomBytes(32), { provider: "deepseek", model: "deepseek-chat" }, blob), null);
  const raw = Buffer.from(blob.slice(5), "base64url");
  raw[20] ^= 1;
  assert.equal(open(key, { provider: "deepseek", model: "deepseek-chat" }, `adg1.${raw.toString("base64url")}`), null, "a flipped byte");
  assert.equal(open(key, { provider: "deepseek", model: "deepseek-chat" }, "gAAAAA-foreign"), null);
});
