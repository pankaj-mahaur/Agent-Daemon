// P5.3 gate (b), Codex: the real host loads the installer's entry. The pinned
// engine binary is the Codex CLI; the installer writes its config.toml in a fake
// home, the binary starts (directly, not through ad's guarded engine façade),
// and a mock model calls memory_stats, which must answer for the thread's project.
// Opt-in like engine-real: AD_REAL_ENGINE=1.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { defaultScript, ev, lastUserText, startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";

const PINNED = resolveCodexCommand({});
const wanted = process.env.AD_REAL_ENGINE === "1";
const skip = wanted ? false : "set AD_REAL_ENGINE=1 to run the real Codex binary";

const script = (body) => {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input[input.length - 1];
  if (last?.type === "function_call_output") return [ev.created(), ev.message(`tool said: ${typeof last.output === "string" ? last.output : JSON.stringify(last.output)}`), ev.completed()];
  if (lastUserText(body).includes("STATS")) return [ev.created(), ev.functionCall("call-stats", "memory_stats", {}, "mcp__agent_daemon_memory"), ev.completed()];
  return defaultScript(body);
};

test("Codex loads the installer's entry and its memory_stats answers for the thread's project", { skip, timeout: 240_000 }, async () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "ad-host-codex-"));
  const proj = path.join(fake, "work", "shop-app");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const mock = await startMockResponses({ script });
  const codexHome = writeMockCodexHome(path.join(fake, ".codex"), { url: mock.url });
  const env = { HOME: fake, USERPROFILE: fake, CODEX_HOME: codexHome, AD_ROOT: path.join(fake, ".agent-daemon"), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const { makeContext, install } = await import("../src/memory-install/install.mjs");
  const ctx = makeContext({ env, home: fake, root: env.AD_ROOT, resolve: () => null, out: (l) => lines.push(l), ask: async () => "" });
  assert.equal(await install({ ctx, hosts: ["codex"], yes: true, noSetup: true }), 0, lines.join("\n"));
  const server = new CodexAppServer({
    command: PINNED,
    cwd: proj,
    env: { CODEX_HOME: codexHome, HOME: fake, USERPROFILE: fake },
    clientVersion: "test",
    initTimeoutMs: 120_000,
    onServerRequest: async ({ method, params }) => {
      if (isApprovalMethod(method)) return approvalResponse(method, params, "accept");
      const err = new Error(`unhandled ${method}`);
      err.code = -32601;
      throw err;
    },
  });
  const notes = [];
  server.on("notification", (n) => notes.push(n));
  try {
    await server.start();
    const { thread } = await server.request("thread/start", { cwd: proj });
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("turn didn't complete")), 120_000);
      server.on("notification", ({ method, params }) => {
        if (method === "turn/completed" && params.threadId === thread.id) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "STATS" }] });
    await done;
    const said = notes.filter((n) => n.method === "item/completed").map((n) => n.params.item).find((i) => i.type === "agentMessage")?.text ?? "";
    assert.match(said, /scope: project \(cwd\)/, said);
    assert.ok(fs.existsSync(path.join(env.AD_ROOT, "episodic.db")), "the server used the fake ad root (the entry's env), not the real one");
  } finally {
    await server.close().catch(() => {});
    await mock.close();
    for (let i = 0; i < 40; i++) {
      try {
        fs.rmSync(fake, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});

// L3 part 3d, golden (D16): Codex's own hooks/list for the hooks setup wrote gives the
// keys and hashes ad's trust doctor computes, and a trust it records reads as
// trusted; `codex mcp add` keeps ad's inline entry, and uninstall gives the files back.
test("golden: the trust doctor agrees with Codex's hooks/list; codex mcp add keeps ad's entry", { skip, timeout: 240_000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "ad-host-codex-golden-"));
  const proj = path.join(fake, "work", "shop-app");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const mock = await startMockResponses({ script: defaultScript });
  const codexHome = writeMockCodexHome(path.join(fake, ".codex"), { url: mock.url });
  const before = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const env = { HOME: fake, USERPROFILE: fake, CODEX_HOME: codexHome, AD_ROOT: path.join(fake, ".agent-daemon"), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const { makeContext, install, uninstall } = await import("../src/memory-install/install.mjs");
  const S = await import("../src/memory-install/setup.mjs");
  const ctx = makeContext({ env, home: fake, root: env.AD_ROOT, resolve: () => null, out: (l) => lines.push(l), ask: async () => "", isTTY: () => true });
  assert.equal(await install({ ctx, hosts: ["codex"], yes: true }), 0, lines.join("\n"));
  const list = async () => {
    const server = new CodexAppServer({ command: PINNED, cwd: proj, env: { CODEX_HOME: codexHome, HOME: fake, USERPROFILE: fake }, clientVersion: "test", initTimeoutMs: 120_000 });
    try {
      await server.start();
      const r = await server.request("hooks/list", { cwds: [proj] });
      return (r.data ?? []).flatMap((d) => d.hooks ?? []);
    } finally {
      await server.close().catch(() => {});
    }
  };
  try {
    const ours = S.codexTrust(ctx);
    assert.ok(ours.length >= 2, "setup wrote Codex hooks");
    const rows = await list();
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8")).hooks;
    for (const x of ours) {
      const row = rows.find((r) => r.key === x.key);
      assert.ok(row, `Codex lists ${x.key} (it lists ${rows.map((r) => r.key).join(", ")})`);
      const group = hooksJson[x.item.locator.hostEvent].find((g) => g.hooks.some((h) => h.command === x.item.value.command));
      assert.equal(row.currentHash, S.codexTrustHash(x.item.locator.hostEvent, group.matcher ?? null, group.hooks[0]), x.item.locator.event);
      assert.equal(x.state, "pending");
    }
    // Trust one the way Codex records it: Codex then runs it, and the doctor says trusted.
    const first = ours[0];
    fs.appendFileSync(path.join(codexHome, "config.toml"), `\n[hooks.state.${JSON.stringify(first.key)}]\ntrusted_hash = "${rows.find((r) => r.key === first.key).currentHash}"\n`);
    assert.equal((await list()).find((r) => r.key === first.key).trustStatus, "trusted");
    assert.equal(S.codexTrust(ctx).find((x) => x.key === first.key).state, "trusted");
    // `codex mcp add` re-serialises table-form entries; ad's inline one stays as written.
    const T = await import("../src/memory-install/edit-toml.mjs");
    const entry = (await import("../src/memory-install/ledger.mjs")).readLedger(env.AD_ROOT).hosts.codex.entry;
    const add = spawnSync(PINNED.cmd, [...(PINNED.prefix ?? []), "mcp", "add", "other", "--", "echo", "hi"], { env: { ...env, PATH: process.env.PATH }, encoding: "utf8", timeout: 60_000 });
    assert.equal(add.status, 0, add.stderr);
    const after = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.equal(T.planTomlAdd(after, entry).action, "same", after);
    assert.match(after, /\[mcp_servers\.other\]/);
    // Uninstall takes out only ad's items (the trust line Codex owns, and its other server, stay).
    lines.length = 0;
    assert.equal(await uninstall({ ctx, hosts: ["codex"] }), 0, lines.join("\n"));
    const left = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.ok(!left.includes("run.mjs") && !left.includes("AD_TOOL_SHELL"), left);
    assert.ok(left.startsWith(before.trimEnd()), "the user's config is still there");
    assert.match(left, /\[mcp_servers\.other\]/);
  } finally {
    await mock.close();
    fs.rmSync(fake, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});
