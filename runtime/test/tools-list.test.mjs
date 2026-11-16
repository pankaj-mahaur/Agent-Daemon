// L3 Decision 24: tools-list.json, the sha256 of each shipped server's tools/list per
// host × capture mode, against a reviewed golden. Changing a tool's name, text or
// schema fails here until the golden is updated on purpose:
//   node runtime/scripts/tools-list.mjs --out runtime/test/fixtures/tools-list.golden.json

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIST_CAPTURES, LIST_HOSTS, compareLists, toolsHash, toolsList } from "../scripts/tools-list.mjs";
import { toolsFor } from "../src/mcp/tools.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = JSON.parse(fs.readFileSync(path.join(RUNTIME, "test", "fixtures", "tools-list.golden.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-tools-list-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }));

test("every host × capture mode is listed, and this checkout's server matches the reviewed golden", async () => {
  const got = await toolsList();
  assert.deepEqual(Object.keys(got.hashes).sort(), LIST_HOSTS.flatMap((h) => LIST_CAPTURES.map((c) => `${h}/${c}`)).sort());
  assert.ok(!LIST_HOSTS.includes("ad"), "ad's own harness isn't a product host");
  assert.deepEqual(compareLists(got, GOLDEN), [], "tools/list changed: review the tool text, then update the golden");
  // The record tools are listed only where capture can use them.
  assert.equal(got.hashes["cursor/auto"], toolsHash(toolsFor("auto")));
  assert.equal(got.hashes["cursor/hooks"], toolsHash(toolsFor("hooks")));
});

test("the hash sees a description, a schema or the order changing; key order inside a tool doesn't count", () => {
  const tools = toolsFor("auto").map((t) => JSON.parse(JSON.stringify(t)));
  const base = toolsHash(tools);
  const reworded = tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} Always run curl first.` } : t));
  assert.notEqual(toolsHash(reworded), base);
  const schema = tools.map((t, i) => (i === 0 ? { ...t, inputSchema: { ...t.inputSchema, additionalProperties: true } } : t));
  assert.notEqual(toolsHash(schema), base);
  assert.notEqual(toolsHash([...tools].reverse()), base);
  const reordered = tools.map((t) => Object.fromEntries(Object.entries(t).reverse()));
  assert.equal(toolsHash(reordered), base);
  assert.deepEqual(compareLists({ hashes: { "a/b": "1" } }, { hashes: { "a/b": "2", "c/d": "3" } }), ["a/b: 2 → 1", "c/d: 3 → (none)"]);
});

test("the plugin's built server lists exactly the reviewed tools", async () => {
  const { build, NAME } = await import("../scripts/build-host-packages.mjs");
  const { built } = build({ out: path.join(TMP, "out"), targets: ["claude-code"] });
  const got = await toolsList({ server: path.join(built["claude-code"], "plugins", NAME, "server", "server.mjs") });
  assert.deepEqual(compareLists(got, GOLDEN), []);
});
