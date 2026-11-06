// The hook configurations shipped for copying (hooks/*.json) and the adapters'
// hooks.json never answer allow. Claude Code reads `{"decision":"approve"}` on
// PreToolUse (and `permissionDecision: "allow"`) as allow, which skips the
// user's own permission prompt: a hook with no objection prints `{}`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function configFiles() {
  const files = readdirSync(join(REPO, "hooks"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(REPO, "hooks", f));
  for (const a of readdirSync(join(REPO, "adapters"))) {
    const p = join(REPO, "adapters", a, "hooks.json");
    if (existsSync(p)) files.push(p);
  }
  return files;
}

// Unescape the JSON string layers (a shell command inside a JSON string can
// hold `\\\"approve\\\"`), so the check sees the words the hook prints.
const flat = (text) => text.replace(/\\+"/g, '"');

test("no shipped hook configuration answers allow", () => {
  const files = configFiles();
  assert.ok(files.length >= 5, `found the hook configs (${files.length})`);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    JSON.parse(text); // still valid JSON
    const words = flat(text);
    assert.doesNotMatch(words, /"decision"\s*:\s*"approve"/, `${file} prints an allow`);
    assert.doesNotMatch(words, /"permissionDecision"\s*:\s*"allow"/, `${file} prints an allow`);
  }
});
