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

// Review 3a M3: changes the old snapshot missed, and one it over-reported.
const snap = (defs) => ({ codexVersion: "x", methods: {}, definitions: Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, shapeOf(v)])) });

test("diffSnapshots: a field changing type inside a union variant is breaking", () => {
  const before = snap({ ThreadItem: { oneOf: [{ properties: { type: { enum: ["commandExecution"] }, command: { type: "string" } }, required: ["type"] }] } });
  const after = snap({ ThreadItem: { oneOf: [{ properties: { type: { enum: ["commandExecution"] }, command: { type: "array", items: { type: "string" } } }, required: ["type"] }] } });
  const d = diffSnapshots(before, after);
  assert.ok(d.breaking.some((x) => /ThreadItem\[commandExecution\]\.command: type string -> array<string>/.test(x)), JSON.stringify(d));
});

test("diffSnapshots: a renamed key inside an inline object is breaking", () => {
  const inner = (key) => ({ oneOf: [{ properties: { acceptWithExecpolicyAmendment: { type: "object", properties: { [key]: { type: "array", items: { type: "string" } } } } }, required: ["acceptWithExecpolicyAmendment"] }] });
  const d = diffSnapshots(snap({ Decision: inner("execpolicy_amendment") }), snap({ Decision: inner("execpolicyAmendment") }));
  assert.ok(d.breaking.length >= 1, JSON.stringify(d));
});

test("diffSnapshots: an inline enum losing a value is breaking", () => {
  const def = (values) => ({ properties: { mode: { type: "string", enum: values } }, required: [] });
  const d = diffSnapshots(snap({ P: def(["form", "url"]) }), snap({ P: def(["form"]) }));
  assert.ok(d.breaking.some((x) => /P\.mode: type enum\(form\|url\) -> enum\(form\)/.test(x)), JSON.stringify(d));
});

test("diffSnapshots: a field that only became nullable is info, not breaking", () => {
  const d = diffSnapshots(snap({ P: { properties: { cwd: { type: "string" } } } }), snap({ P: { properties: { cwd: { type: ["string", "null"] } } } }));
  assert.deepEqual(d.breaking, []);
  assert.ok(d.info.some((x) => /P\.cwd: now nullable/.test(x)), JSON.stringify(d));
});

test("SENT_METHODS lists exactly the methods ad's code sends, and each is on the pinned stable surface", async () => {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { SENT_METHODS } = await import("../src/engine/codex/protocol-snapshot.mjs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const sent = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) for (const m of readFileSync(p, "utf8").matchAll(/\.request\(\s*"([a-zA-Z]+(?:\/[a-zA-Z]+)*)"/g)) sent.add(m[1]);
    }
  };
  walk(root);
  assert.deepEqual([...sent].sort(), [...SENT_METHODS].sort(), "add a new request method to SENT_METHODS (and regenerate the snapshot)");
  for (const m of SENT_METHODS) assert.ok(committed.methods.clientRequests.includes(m), `${m} isn't on the pinned stable surface`);
});

test("checkRequest: stable methods and fields only, unless allowlisted; shapes checked", async () => {
  const { checkRequest } = await import("../testkit/protocol-check.mjs");
  assert.deepEqual(checkRequest({ method: "thread/list", params: { limit: 5, cwd: ["/a", "/b"] } }), []);
  assert.match(checkRequest({ method: "collaborationMode/list", params: {} })[0], /not a request the pinned Codex accepts/);
  assert.deepEqual(checkRequest({ method: "collaborationMode/list", params: {} }, { allow: { methods: ["collaborationMode/list"], fields: {} } }), []);
  assert.match(checkRequest({ method: "turn/start", params: { threadId: "t", input: [], collaborationMode: {} } }).join(), /collaborationMode is not a field of TurnStartParams/);
  assert.deepEqual(checkRequest({ method: "turn/start", params: { threadId: "t", input: [], collaborationMode: {} } }, { allow: { methods: [], fields: { "turn/start": ["collaborationMode"] } } }), []);
  assert.match(checkRequest({ method: "turn/start", params: { input: [] } }).join(), /missing required threadId/);
  // Union params are checked by their variant too.
  assert.deepEqual(checkRequest({ method: "account/login/start", params: { type: "apiKey", apiKey: "sk-test" } }), []);
  assert.match(checkRequest({ method: "account/login/start", params: { type: "password" } }).join(), /unknown variant/);
});
