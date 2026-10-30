// P5.4: release-memory.yml can't publish by accident: it runs only when the owner
// dispatches it, a dry run (build, check, upload, publish nothing) is the default,
// and the publish job needs a real run and the release-memory environment's approval.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "release-memory.yml");
const text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const block = (name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

test("release-memory runs only on dispatch, as a dry run unless told otherwise", () => {
  const on = /\non:\n([\s\S]*?)\n[a-z]/.exec(text)[1];
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(on, /^ {2}(push|pull_request|release|schedule|workflow_run)\b/m, "no automatic trigger");
  assert.match(on, /dry_run:\n(?: {8}.*\n)*? {8}default: true/);
  assert.match(text, /^permissions:\n {2}contents: read$/m, "read-only unless a job asks");
});

test("the publish job needs a real run and the owner's environment; the build job writes nothing", () => {
  const publish = block("publish");
  assert.match(publish, /if: \$\{\{ !inputs\.dry_run \}\}/);
  assert.match(publish, /environment: release-memory/);
  assert.match(publish, /npm publish .* --provenance --access public/);
  assert.match(publish, /^ {6}id-token: write$/m, "npm's trusted publisher signs in with the run's OIDC token");
  assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN/, "no stored npm token: publishing goes through the trusted publisher");
  assert.match(publish, /node-version: "24"/, "npm 11.5.1+ for trusted publishing");
  assert.match(publish, /gh release create "memory-v\$V" .*--latest=false/, "the Latest badge stays on ad's own release");
  const build = block("build");
  assert.doesNotMatch(build, /npm publish|gh release|git push|contents: write/);
  assert.match(build, /SHA256SUMS/);
  assert.match(build, /test\/host-packages\.test\.mjs/);
});
