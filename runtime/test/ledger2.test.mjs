// The install ledger v2 (MCP launch plan L3, part 2): one record per item, found by
// content, hashed canonically; uninstall removes only ad's unchanged items. Temp roots only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const L = await import("../src/memory-install/ledger2.mjs");
const { readItems, itemsOf } = await import("../src/memory/ledger-read.mjs");
const { readLedger } = await import("../src/memory-install/ledger.mjs");
const { PRODUCT } = await import("../src/product.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-ledger2-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const root = () => fs.mkdtempSync(path.join(TMP, `r${n++}-`));

const LAUNCHER = path.join("/home", "dev", ".agent-daemon", "memory", "launch", "run.mjs");
const mcpEntry = { command: "node", args: [LAUNCHER, "serve", "--host", "codex"] };
const hookHandler = { type: "command", command: "node", args: [LAUNCHER, "hook", "tool.before", "--host", "claude-code"], onFailure: "continue", timeout: 10 };

test("canonical hashing: key order doesn't matter, array order does, ad-owned hook fields are left out", () => {
  assert.equal(L.canonicalSha256({ a: 1, b: { c: 2, d: 3 } }), L.canonicalSha256({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(L.canonicalSha256({ a: [1, 2] }), L.canonicalSha256({ a: [2, 1] }));
  // The review service flips onFailure and setup may raise the timeout: still ad's item.
  const flipped = { ...hookHandler, onFailure: "block", timeout: 30 };
  assert.equal(L.canonicalSha256(flipped, { kind: "hook" }), L.canonicalSha256(hookHandler, { kind: "hook" }));
  // …but only for hook handlers, and only those two fields.
  assert.notEqual(L.canonicalSha256(flipped), L.canonicalSha256(hookHandler));
  assert.notEqual(L.canonicalSha256({ ...hookHandler, args: [...hookHandler.args, "--x"] }, { kind: "hook" }), L.canonicalSha256(hookHandler, { kind: "hook" }));
});

test("items: the id is what the item is, not where it sits; a re-write keeps the first record's preExisted and date", () => {
  const led = L.emptyLedger();
  const a = L.upsertItem(led, { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: mcpEntry, preExisted: true, version: "1", now: new Date("2026-11-01T00:00:00Z") });
  const b = L.upsertItem(led, { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: { ...mcpEntry, args: [...mcpEntry.args, "--capture", "hooks"] }, preExisted: false, version: "2" });
  assert.equal(a.id, b.id);
  assert.equal(led.items.length, 1);
  assert.equal(b.preExisted, true, "the user's state before ad is what counts");
  assert.equal(b.installedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(b.version, "2");
  // ad's own later edit re-hashes.
  const edited = L.updateItem(led, a.id, { ...mcpEntry, env: { AD_ROOT: "/x" } });
  assert.equal(edited.canonicalSha256, L.canonicalSha256({ ...mcpEntry, env: { AD_ROOT: "/x" } }));
  L.dropItem(led, a.id);
  assert.deepEqual(led.items, []);
});

test("read and write: atomic JSON under memory/; the hook-side reader is tolerant", async () => {
  const r = root();
  assert.deepEqual(readItems(r), [], "missing");
  const led = L.emptyLedger();
  L.upsertItem(led, { host: "claude-code", kind: "env", file: "/s.json", locator: { path: ["env", "AD_TOOL_SHELL"] }, value: "1" });
  L.upsertItem(led, { host: "codex", kind: "hook", file: "/h.json", locator: { event: "PreToolUse", step: "tool.before", script: LAUNCHER }, value: hookHandler });
  await L.writeLedger2(r, led);
  assert.equal(readItems(r).length, 2);
  assert.equal(itemsOf(r, "codex", "hook").length, 1);
  assert.equal(itemsOf(r, "codex").length, 1);
  fs.writeFileSync(L.ledger2Path(r), "{ garbled");
  assert.deepEqual(readItems(r), [], "garbled");
  fs.writeFileSync(L.ledger2Path(r), JSON.stringify({ schemaVersion: 3, items: [{ id: "x" }] }));
  assert.deepEqual(readItems(r), [], "another version");
});

test("v1 is merged on every run and stays readable for 3.1.0", async () => {
  const r = root();
  const v1 = {
    schemaVersion: 1,
    hosts: {
      codex: { driver: "file", file: "/c/config.toml", realFile: "/c/config.toml", entryKey: PRODUCT.mcpServerKey, entry: mcpEntry, version: "3.1.0", installedAt: "2026-10-30T00:00:00Z", skills: { "my-skill": { version: 1, sha256: "abc", path: "/c/skills/my-skill" } } },
      "claude-code": { driver: "cli", command: "claude", scope: "user", entryKey: PRODUCT.mcpServerKey, entry: mcpEntry, version: "3.1.0", installedAt: "2026-10-30T00:00:00Z" },
    },
  };
  fs.mkdirSync(path.join(r, "memory"), { recursive: true });
  fs.writeFileSync(path.join(r, "memory", "install-ledger.json"), JSON.stringify(v1));
  const led = L.mergeV1(L.readLedger2(r), readLedger(r));
  assert.deepEqual(led.items.map((i) => `${i.host}:${i.kind}`).sort(), ["claude-code:mcp", "codex:mcp", "codex:skill-dir"]);
  assert.ok(led.items.every((i) => i.source === "v1" && i.preExisted === false));
  // Idempotent.
  const again = L.mergeV1(structuredClone(led), readLedger(r));
  assert.deepEqual(again.items.map((i) => i.canonicalSha256).sort(), led.items.map((i) => i.canonicalSha256).sort());
  // A newer v1 record (a 3.1.0 install ran since) replaces the item; an older one doesn't.
  const newer = structuredClone(v1);
  newer.hosts.codex.entry = { ...mcpEntry, args: [...mcpEntry.args, "--capture", "tools"] };
  newer.hosts.codex.installedAt = "2026-11-05T00:00:00Z";
  const led2 = L.mergeV1(structuredClone(led), newer);
  assert.equal(led2.items.find((i) => i.host === "codex" && i.kind === "mcp").canonicalSha256, L.canonicalSha256(newer.hosts.codex.entry));
  // …and an older v1 record never overwrites an item written to v2 directly since.
  const native = L.emptyLedger();
  const later = { ...mcpEntry, args: [...mcpEntry.args, "--capture", "auto"] };
  L.upsertItem(native, { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: later, now: new Date("2026-11-06T00:00:00Z") });
  L.mergeV1(native, v1);
  const kept = native.items.find((i) => i.host === "codex" && i.kind === "mcp");
  assert.equal(kept.canonicalSha256, L.canonicalSha256(later));
  assert.equal(kept.source, undefined);
  // The v1 file itself is untouched and still reads as v1.
  await L.writeLedger2(r, led2);
  assert.equal(readLedger(r).schemaVersion, 1);
  assert.deepEqual(Object.keys(readLedger(r).hosts).sort(), ["claude-code", "codex"]);
});

test("removal: only ad's unchanged, not-pre-existing items; a forged item can't delete the user's entry", () => {
  const led = L.emptyLedger();
  const mcp = L.upsertItem(led, { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: mcpEntry });
  assert.deepEqual(L.removalDecision(mcp, mcpEntry), { action: "remove" });
  assert.deepEqual(L.removalDecision(mcp, undefined), { action: "gone" });
  assert.equal(L.removalDecision(mcp, { ...mcpEntry, env: { X: "1" } }).why, "you changed it");
  const pre = L.upsertItem(L.emptyLedger(), { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: mcpEntry, preExisted: true });
  assert.equal(L.removalDecision(pre, mcpEntry).why, "you had it before");
  // A forged item: the hash of the user's own server entry, preExisted false, under our key.
  const users = { command: "uvx", args: ["their-memory-server"] };
  const forged = L.upsertItem(L.emptyLedger(), { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: users });
  assert.equal(L.removalDecision(forged, users).action, "keep");
  // …or under another server's key.
  const other = L.upsertItem(L.emptyLedger(), { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: "their-server" }, value: mcpEntry });
  assert.equal(L.removalDecision(other, mcpEntry).action, "keep");
  // A hook handler: ad's onFailure flip doesn't make it the user's; an edited command does.
  const hook = L.upsertItem(L.emptyLedger(), { host: "claude-code", kind: "hook", file: "/s.json", locator: { event: "PreToolUse", step: "tool.before", script: LAUNCHER }, value: hookHandler });
  assert.deepEqual(L.removalDecision(hook, { ...hookHandler, onFailure: "block" }), { action: "remove" });
  assert.equal(L.removalDecision(hook, { ...hookHandler, args: ["/their/script.mjs"] }).action, "keep");
  // The marker: only AD_TOOL_SHELL = "1".
  const env = L.upsertItem(L.emptyLedger(), { host: "claude-code", kind: "env", file: "/s.json", locator: { path: ["env", "AD_TOOL_SHELL"] }, value: "1" });
  assert.deepEqual(L.removalDecision(env, "1"), { action: "remove" });
  assert.equal(L.removalDecision(env, "0").action, "keep");
  const envOther = L.upsertItem(L.emptyLedger(), { host: "claude-code", kind: "env", file: "/s.json", locator: { path: ["env", "PATH"] }, value: "1" });
  assert.equal(L.removalDecision(envOther, "1").action, "keep", "never another variable");
});

test("removal: a skill folder only directly inside a host's skills folder, named as recorded, with ad's marker", () => {
  const skills = path.resolve("/c/skills");
  const live = { sha256: "abc", marker: true };
  const ok = L.upsertItem(L.emptyLedger(), { host: "codex", kind: "skill-dir", file: path.join(skills, "my-skill"), locator: { name: "my-skill" }, value: { sha256: "abc" } });
  assert.deepEqual(L.removalDecision(ok, live, { skillRoots: [skills] }), { action: "remove" });
  assert.equal(L.removalDecision(ok, { sha256: "abc", marker: false }, { skillRoots: [skills] }).action, "keep", "no publish marker: the user's own folder");
  assert.equal(L.removalDecision(ok, { sha256: "abd", marker: true }, { skillRoots: [skills] }).why, "you changed it");
  // A forged item naming the user's own skill folder, under another name.
  const forged = L.upsertItem(L.emptyLedger(), { host: "codex", kind: "skill-dir", file: path.join(skills, "their-skill"), locator: { name: "x" }, value: { sha256: "abc" } });
  assert.equal(L.removalDecision(forged, live, { skillRoots: [skills] }).action, "keep");
  for (const p of [path.resolve("/c"), path.join(skills, "a", "b"), path.resolve("/etc/passwd"), skills]) {
    const bad = L.upsertItem(L.emptyLedger(), { host: "codex", kind: "skill-dir", file: p, locator: { name: path.basename(p) }, value: { sha256: "abc" } });
    assert.equal(L.removalDecision(bad, live, { skillRoots: [skills] }).action, "keep", p);
  }
});

test("removal: ad's paths are anchored, so a user's look-alike hook or server is never ad's", () => {
  for (const script of ["/home/dev/my-server/server.mjs", "/home/dev/mcp-server/hook.mjs", "/home/dev/tools/runtime-bin-hook.mjs"]) {
    const v = { type: "command", command: "node", args: [script, "x"] };
    const item = L.upsertItem(L.emptyLedger(), { host: "claude-code", kind: "hook", file: "/s.json", locator: { event: "PreToolUse", step: "tool.before", script }, value: v });
    assert.equal(L.removalDecision(item, v).action, "keep", script);
  }
  for (const script of ["/home/dev/.agent-daemon/memory/launch/run.mjs", "/src/ad/runtime/bin/hook.mjs", `/home/dev/.claude/plugins/cache/agent-daemon/${PRODUCT.plugin}/3.2.0/server/hook.mjs`]) {
    const v = { type: "command", command: "node", args: [script, "x"] };
    const item = L.upsertItem(L.emptyLedger(), { host: "claude-code", kind: "hook", file: "/s.json", locator: { event: "PreToolUse", step: "tool.before", script }, value: v });
    assert.deepEqual(L.removalDecision(item, v), { action: "remove" }, script);
  }
});

test("writers: a garbled ledger is moved aside, a newer one is left alone, and v2-native items survive a v1 sync", async () => {
  const r = root();
  fs.mkdirSync(path.join(r, "memory"), { recursive: true });
  const v1 = { schemaVersion: 1, hosts: { codex: { driver: "file", file: "/c/config.toml", entryKey: PRODUCT.mcpServerKey, entry: mcpEntry, installedAt: "2026-10-30T00:00:00Z" } } };
  // Garbled: kept beside, then started again (v1 rebuilds its items).
  fs.writeFileSync(L.ledger2Path(r), "{ garbled");
  const note = await L.syncFromV1(r, v1);
  assert.match(note, /moved to .*ledger\.json\.bad-/);
  assert.equal(fs.readdirSync(path.join(r, "memory")).filter((f) => f.startsWith("ledger.json.bad-")).length, 1);
  assert.deepEqual(readItems(r).map((i) => i.kind), ["mcp"]);
  // A direct (v2-native) item survives every later sync; one v1 no longer has goes.
  const led = L.readLedger2(r);
  L.upsertItem(led, { host: "claude-code", kind: "env", file: "/s.json", locator: { path: ["env", "AD_TOOL_SHELL"] }, value: "1" });
  await L.writeLedger2(r, led);
  await L.syncFromV1(r, { schemaVersion: 1, hosts: {} });
  assert.deepEqual(readItems(r).map((i) => i.kind), ["env"]);
  // A newer version's file: untouched.
  const newer = JSON.stringify({ schemaVersion: 3, items: [{ id: "z", future: true }] });
  fs.writeFileSync(L.ledger2Path(r), newer);
  assert.match(await L.syncFromV1(r, v1), /newer version/);
  assert.equal(fs.readFileSync(L.ledger2Path(r), "utf8"), newer);
});

test("dates and sources: a direct write clears v1's tag; newer means last written; a bad v1 date doesn't throw", () => {
  const led = L.emptyLedger();
  const v1 = { schemaVersion: 1, hosts: { codex: { driver: "file", file: "/c/config.toml", entryKey: PRODUCT.mcpServerKey, entry: mcpEntry, installedAt: "2026-11-01T00:00:00Z" } } };
  L.mergeV1(led, v1);
  const moved = { ...mcpEntry, args: [LAUNCHER, "serve", "--host", "codex", "--moved"] };
  // ad moves the entry (3.1.0's launcher → the stable one) on 6 Nov: a direct write.
  const it = L.upsertItem(led, { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey }, value: moved, now: new Date("2026-11-06T00:00:00Z") });
  assert.equal(it.source, undefined);
  assert.equal(it.installedAt, "2026-11-01T00:00:00.000Z", "first install date kept");
  assert.equal(it.updatedAt, "2026-11-06T00:00:00.000Z");
  // The older v1 record doesn't put the old entry back.
  L.mergeV1(led, v1);
  assert.equal(led.items[0].canonicalSha256, L.canonicalSha256(moved));
  // updateItem also moves updatedAt and clears the tag.
  const u = L.updateItem(L.mergeV1(L.emptyLedger(), v1), led.items[0].id, moved, { now: new Date("2026-11-07T00:00:00Z") });
  assert.equal(u.updatedAt, "2026-11-07T00:00:00.000Z");
  assert.equal(u.source, undefined);
  // A garbled date in v1: the epoch, no RangeError.
  const bad = { schemaVersion: 1, hosts: { codex: { ...v1.hosts.codex, installedAt: "yesterday" } } };
  assert.doesNotThrow(() => L.mergeV1(L.emptyLedger(), bad));
});

test("ids don't depend on how a path is spelled", () => {
  const a = L.itemId({ host: "codex", kind: "hook", file: "C:\\x\\hooks.json", locator: { event: "PreToolUse", step: "tool.before", script: "C:\\x\\run.mjs" } });
  const b = L.itemId({ host: "codex", kind: "hook", file: "C:/x/hooks.json", locator: { event: "PreToolUse", step: "tool.before", script: "C:/x/run.mjs" } });
  if (process.platform === "win32") assert.equal(a, b);
  const c = L.itemId({ host: "codex", kind: "hook", file: "/x/hooks.json", locator: { step: "tool.before", event: "PreToolUse", script: "/x/run.mjs" } });
  const d = L.itemId({ host: "codex", kind: "hook", file: "/x/hooks.json", locator: { event: "PreToolUse", step: "tool.before", script: "/x/run.mjs" } });
  assert.equal(c, d, "locator key order");
});

test("uninstall's three lists, and the launcher-reference scan", () => {
  const item = { host: "codex", kind: "mcp", file: "/c/config.toml", locator: { key: PRODUCT.mcpServerKey } };
  const lines = L.uninstallReport({ removed: [item], kept: [{ item: { ...item, kind: "env", locator: { path: ["env", "AD_TOOL_SHELL"] } }, why: "you changed it", how: "delete the line" }], left: [{ path: "/r/memory/episodic.db", bytes: 4096, what: "your notes" }] });
  assert.deepEqual(lines, ["Removed:", `  - /c/config.toml · ${PRODUCT.mcpServerKey}`, "Kept:", "  - /c/config.toml · env.AD_TOOL_SHELL: you changed it. To remove it: delete the line", "Left on disk:", "  - /r/memory/episodic.db (4 KB): your notes"]);
  assert.deepEqual(L.uninstallReport({}), ["Removed: nothing"]);
  const win = "C:\\Users\\dev\\.agent-daemon\\memory\\launch\\run.mjs";
  assert.ok(L.referencesLauncher(JSON.stringify({ args: [win, "hook"] })), "JSON-escaped backslashes");
  for (const spelled of ['node "C:/Users/dev/.agent-daemon/memory/launch/run.mjs" hook x', "node ~/.agent-daemon/memory/launch/run.mjs hook x", 'node "%USERPROFILE%\\.agent-daemon\\memory\\launch\\run.mjs"', "node /c/Users/dev/.agent-daemon/memory/launch/run.mjs"]) {
    assert.ok(L.referencesLauncher(spelled), spelled);
  }
  assert.ok(!L.referencesLauncher('node "C:/Users/dev/.agent-daemon/memory/bin/launch.mjs"'));
});
