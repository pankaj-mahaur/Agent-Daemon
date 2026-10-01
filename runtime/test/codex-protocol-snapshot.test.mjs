// Tests for the codex protocol snapshot (engine/codex/protocol-snapshot.mjs).
//
// Two jobs: (1) the committed snapshot must match what the PINNED codex
// generates — if someone bumps the pin without regenerating, this fails;
// (2) the diff must call removals breaking, so upgrade PRs flag them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pinnedCodexVersion, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { diffSnapshots, diffToMarkdown, generateSnapshot, shapeOf, TRACKED_DEFINITIONS } from "../src/engine/codex/protocol-snapshot.mjs";

const committed = JSON.parse(readFileSync(new URL("../src/engine/codex/protocol-snapshot.json", import.meta.url), "utf8"));
const pinned = resolveCodexCommand({}).source === "pinned";

test("committed snapshot is for the pinned codex version", () => {
  assert.equal(committed.codexVersion, pinnedCodexVersion());
});

test("committed snapshot tracks every definition the engine depends on", () => {
  for (const name of TRACKED_DEFINITIONS) assert.ok(committed.definitions[name], `${name} missing from snapshot`);
  for (const m of ["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt", "turn/steer", "account/read"]) {
    assert.ok(committed.methods.clientRequests.includes(m), `${m} missing`);
  }
  assert.ok(committed.methods.serverNotifications.includes("turn/completed"));
});

test("pinned codex still generates exactly the committed snapshot", { skip: !pinned && "pinned @openai/codex not installed" }, () => {
  const fresh = generateSnapshot({ codexVersion: pinnedCodexVersion() });
  const d = diffSnapshots(committed, fresh);
  assert.deepEqual(d, { breaking: [], info: [] }, diffToMarkdown(d, "committed", "generated"));
});

const base = {
  codexVersion: "1.0.0",
  methods: { clientRequests: ["a", "b"], serverNotifications: ["n"] },
  definitions: {
    P: { required: ["x"], props: ["x", "y"] },
    E: { enum: ["one", "two"] },
    U: { union: [{ tag: "text", props: ["text", "type"] }, { tag: "image", props: ["type", "url"] }] },
  },
};

test("diffSnapshots: removals and newly-required fields are breaking; additions are info", () => {
  const next = structuredClone(base);
  next.methods.clientRequests = ["a", "c"];
  next.definitions.P = { required: ["x", "y"], props: ["x", "y", "z"] };
  next.definitions.E = { enum: ["one", "three"] };
  next.definitions.U = { union: [{ tag: "text", props: ["text", "type", "spans"] }] };
  const d = diffSnapshots(base, next);
  assert.deepEqual(d.breaking.sort(), [
    "E.enum: removed two",
    "P: y is now required",
    "U: variant image removed",
    "clientRequests: removed b",
  ].sort());
  assert.ok(d.info.includes("clientRequests: added c"));
  assert.ok(d.info.includes("P.props: added z"));
  assert.ok(d.info.includes("U[text]: added spans"));
});

test("diffSnapshots: identical snapshots produce no diff", () => {
  assert.deepEqual(diffSnapshots(base, structuredClone(base)), { breaking: [], info: [] });
  assert.match(diffToMarkdown({ breaking: [], info: [] }, "1", "1"), /No changes/);
});

test("shapeOf names untagged union variants stably and uniquely", () => {
  const s = shapeOf({
    oneOf: [
      { type: "object", properties: { handlerType: { enum: ["command"] }, command: {} } },
      { type: "object", properties: { handlerType: { enum: ["mcp"] }, server: {} } },
      { type: "object", required: ["accept"], properties: { accept: {} } },
      { type: "object", properties: { a: {}, b: {} } },
      { type: "object", properties: { c: {} } },
    ],
  });
  const tags = s.union.map((v) => v.tag);
  assert.ok(tags.includes("handlerType=command"));
  assert.ok(tags.includes("handlerType=mcp"));
  assert.ok(tags.includes("accept"));
  assert.equal(new Set(tags).size, tags.length, "tags must be unique");
});
