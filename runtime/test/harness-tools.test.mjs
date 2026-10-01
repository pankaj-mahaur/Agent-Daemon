// Tests for `ad tools` (harness/tools.mjs) against the fake app-server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdTools, npxCommand, PLAYWRIGHT_MCP } from "../src/harness/tools.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sink = () => ({ text: "", write(c) { this.text += c; return true; } });

test("enable/disable browser and web-search round-trip through config", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-tools-"));
  const home = join(root, "home");
  const run = async (...a) => {
    const out = sink();
    const code = await cmdTools(a[0], a[1], { home, command, stdout: out, stderr: sink() });
    return { code, out: out.text };
  };
  const cfg = () => JSON.parse(readFileSync(join(home, "fake-config.json"), "utf8"));
  try {
    assert.match((await run("list")).out, /off  browser/);
    assert.equal((await run("enable", "browser")).code, 0);
    assert.ok(cfg().mcp_servers.playwright.args.includes(PLAYWRIGHT_MCP), "version is pinned");
    assert.equal((await run("enable", "web-search")).code, 0);
    assert.equal(cfg().web_search, "live");
    assert.match((await run("list")).out, /on   browser[\s\S]*on   web-search/);
    await run("disable", "browser");
    await run("disable", "web-search");
    assert.equal(cfg().mcp_servers.playwright, undefined);
    assert.equal(cfg().web_search, undefined, "back to Codex's default");
    assert.equal((await run("enable", "nope")).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npxCommand prefers node's own npx-cli.js", () => {
  const r = npxCommand();
  if (r.command === process.execPath) assert.match(r.args[0], /npx-cli\.js$/);
  else assert.equal(r.command, "npx");
  assert.deepEqual(npxCommand("/nonexistent/bin/node"), { command: "npx", args: [] });
});
