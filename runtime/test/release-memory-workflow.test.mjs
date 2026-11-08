// P5.4 and L3 P5 (Decisions 24–26): release-memory.yml can't publish by accident (owner
// dispatch only, a dry run by default, the publish job behind a real run and the
// release-memory environment), refuses a real release under the old name unless
// legacy_name is set, passes dispatch inputs through env (never inline), and its one
// build script produces every artifact the release lists.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LEGACY_NAMES, nameGate } from "../scripts/release-name-gate.mjs";
import { artifactNames, packageSbom, releaseBuild, sha256sums } from "../scripts/release-memory-build.mjs";
import { PRODUCT } from "../src/product.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.resolve(RUNTIME, "..", ".github", "workflows", "release-memory.yml");
const text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const block = (name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};
// Each step of a job: { name, body }.
const steps = (job) => block(job).split(/\n {6}- name: /).slice(1).map((s) => ({ name: s.split("\n")[0], body: s }));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-release-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }));

test("release-memory runs only on dispatch, as a dry run unless told otherwise", () => {
  const on = /\non:\n([\s\S]*?)\n[a-z]/.exec(text)[1];
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(on, /^ {2}(push|pull_request|release|schedule|workflow_run)\b/m, "no automatic trigger");
  assert.match(on, /dry_run:\n(?: {8}.*\n)*? {8}default: true/);
  assert.match(on, /dist_tag:\n(?: {8}.*\n)*? {8}type: choice\n {8}options:\n {10}- beta\n {10}- latest\n {8}default: beta/, "beta by default (npx <pkg>@beta)");
  assert.match(on, /legacy_name:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false/);
  assert.match(text, /^permissions:\n {2}contents: read$/m, "read-only unless a job asks");
});

test("dispatch inputs reach scripts only through env, never inline in a run script", () => {
  const runs = [...text.matchAll(/\n( *)run: ([|>][^\n]*\n(?:\1 {2}.*\n|\s*\n)*|[^\n]*\n)/g)];
  assert.ok(runs.length > 5);
  for (const m of runs) assert.doesNotMatch(m[2], /\$\{\{\s*(inputs|github\.event)\./, m[2]);
});

test("the build job: the name gate first, then the tests, then one build script; it publishes nothing", () => {
  const s = steps("build");
  const gate = s.findIndex((x) => /release-name-gate\.mjs/.test(x.body));
  const build = s.findIndex((x) => /release-memory-build\.mjs --out "\$RUNNER_TEMP\/out"/.test(x.body));
  assert.ok(gate >= 0 && build > gate, "the gate runs before anything is built");
  assert.match(s[gate].body, /DRY_RUN: \$\{\{ inputs\.dry_run \}\}/);
  assert.match(s[gate].body, /LEGACY_NAME: \$\{\{ inputs\.legacy_name \}\}/);
  const tests = s.find((x) => /node --test/.test(x.body)).body;
  for (const f of ["host-packages", "memory-package", "listings", "tools-list", "release-memory-workflow"]) assert.match(tests, new RegExp(`test/${f}\\.test\\.mjs`));
  assert.match(s[build].body, /id: build/);
  assert.match(s[build].body, /PRODUCT_REPO: \$\{\{ vars\.PRODUCT_REPO \}\}/, "the product README's copyable command");
  const upload = s.find((x) => /upload-artifact/.test(x.body)).body;
  for (const d of ["dist", "hosts", "hosts-legacy", "listing"]) assert.match(upload, new RegExp(`/out/${d}\\n`));
  assert.doesNotMatch(block("build"), /npm publish|gh release|git push|contents: write/);
});

test("the publish job needs a real run and the owner's environment; it checks, tags and pushes each tree to its repository", () => {
  const publish = block("publish");
  assert.match(publish, /if: \$\{\{ !inputs\.dry_run \}\}/);
  assert.match(publish, /environment: release-memory/);
  assert.match(publish, /^ {6}id-token: write$/m, "npm's trusted publisher signs in with the run's OIDC token");
  assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN/, "no stored npm token");
  assert.match(publish, /node-version: "24"/, "npm 11.5.1+ for trusted publishing");
  assert.match(publish, /sha256sum --check --strict SHA256SUMS/, "the downloads are what the build listed");
  assert.match(publish, /DIST_TAG: \$\{\{ inputs\.dist_tag \}\}/);
  assert.match(publish, /case "\$DIST_TAG" in beta\|latest\)/, "a tag outside the list is refused");
  assert.match(publish, /npm publish .* --provenance --access public --tag "\$DIST_TAG"/);
  const push = (key, repo, tree) => assert.match(publish, new RegExp(`KEY: \\$\\{\\{ secrets\\.${key} \\}\\}\\n {10}REPO: \\$\\{\\{ vars\\.${repo} \\}\\}\\n {8}run: bash -c "\\$PUSH_TREE" -- ${tree.replace(/\//g, "\\/")}\\n`), `${tree} → ${repo}`);
  push("PRODUCT_DEPLOY_KEY", "PRODUCT_REPO", "out/hosts/product-repo");
  push("MARKETPLACE_DEPLOY_KEY", "MEMORY_MARKETPLACE_REPO", "out/hosts-legacy/claude-code");
  push("GEMINI_DEPLOY_KEY", "MEMORY_GEMINI_REPO", "out/hosts/gemini");
  assert.match(publish, /gh release create "memory-v\$V" out\/dist\/\* .*--latest=false/, "every artifact; the Latest badge stays on ad's own release");
  assert.match(text, /PUSH_TREE: \|\n[\s\S]*if \[ -z "\$\{KEY:-\}" \] \|\| \[ -z "\$\{REPO:-\}" \]; then echo "::notice::/, "an unconfigured target is skipped");
});

test("the name gate: a real release under the old name needs legacy_name; a dry run or the launch name passes", () => {
  assert.ok(LEGACY_NAMES.includes(PRODUCT.package), "L3 keeps the old name (C-L3-NAME)");
  assert.equal(nameGate({ dryRun: true, legacyName: false }).ok, true);
  assert.equal(nameGate({ dryRun: false, legacyName: true }).ok, true);
  const refused = nameGate({ dryRun: false, legacyName: false });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /legacy_name: true/);
  assert.equal(nameGate({ dryRun: false, legacyName: false, product: { package: "teachonce", plugin: "teachonce", mcpServerKey: "teachonce" } }).ok, true, "the launch name needs no flag");
  assert.equal(nameGate({ dryRun: false, legacyName: false, product: { package: "teachonce", plugin: "teachonce", mcpServerKey: "agent-daemon-memory" } }).ok, false, "any old name left counts");
  // The script as the workflow runs it: env strings from the dispatch inputs.
  const run = (env) => spawnSync(process.execPath, [path.join(RUNTIME, "scripts", "release-name-gate.mjs")], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }).status;
  assert.equal(run({ DRY_RUN: "false", LEGACY_NAME: "false" }), 1);
  assert.equal(run({ DRY_RUN: "false", LEGACY_NAME: "true" }), 0);
  assert.equal(run({ DRY_RUN: "true", LEGACY_NAME: "false" }), 0);
  assert.equal(run({ DRY_RUN: "", LEGACY_NAME: "" }), 1, "dry_run must be said: the publish job reads a missing one as a real run");
  assert.equal(run({ LEGACY_NAME: "true" }), 1);
  assert.equal(run({ DRY_RUN: "yes", LEGACY_NAME: "true" }), 1);
  assert.equal(run({ DRY_RUN: "false", LEGACY_NAME: "yes" }), 1, "only the literal true sets the flag");
});

test("SHA256SUMS lists every file but itself, sorted, in sha256sum's format", () => {
  const d = path.join(TMP, "sums");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "b.zip"), "b");
  fs.writeFileSync(path.join(d, "a.tgz"), "a");
  fs.writeFileSync(path.join(d, "SHA256SUMS"), "old");
  assert.equal(sha256sums(d), "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.tgz\n3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.zip\n");
});

test("the SBOM is the released package's: metadata names it, the scratch project and local paths are gone, its dependencies are listed", () => {
  // The shape npm 10/11 writes for a scratch project with the tarball installed.
  const raw = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: { tools: [{ vendor: "npm", name: "cli" }], component: { "bom-ref": "x-sbom@3.1.0", type: "library", name: "sbom-scratch", version: "3.1.0", purl: "pkg:npm/x-sbom@3.1.0" } },
    components: [
      { "bom-ref": "x@3.1.0", type: "library", name: "x", version: "3.1.0", purl: "pkg:npm/x@3.1.0", properties: [{ name: "cdx:npm:package:path", value: "node_modules/x" }], externalReferences: [{ type: "distribution", url: "file:/tmp/build/dist/x-3.1.0.tgz" }] },
      { "bom-ref": "dep@1.0.0", type: "library", name: "dep", version: "1.0.0", purl: "pkg:npm/dep@1.0.0" },
    ],
    dependencies: [{ ref: "x-sbom@3.1.0", dependsOn: ["x@3.1.0"] }, { ref: "x@3.1.0", dependsOn: ["dep@1.0.0"] }],
  };
  const s = packageSbom(raw, { name: "x", version: "3.1.0", dependencies: { dep: "1.0.0" } });
  assert.equal(s.metadata.component.purl, "pkg:npm/x@3.1.0");
  assert.equal(s.metadata.component.type, "application");
  assert.deepEqual(s.metadata.component.externalReferences, [{ type: "distribution", url: "https://registry.npmjs.org/x/-/x-3.1.0.tgz" }], "not the local tarball npm installed it from");
  assert.deepEqual(s.components.map((c) => c.name), ["dep"]);
  assert.deepEqual(s.dependencies.map((d) => d.ref), ["x@3.1.0"]);
  assert.doesNotMatch(JSON.stringify(s), /sbom-scratch|node_modules\/x/);
  assert.throws(() => packageSbom({ ...raw, bomFormat: "SPDX" }, { name: "x", version: "3.1.0" }), /isn't CycloneDX/);
  assert.throws(() => packageSbom(raw, { name: "x", version: "3.2.0" }), /doesn't list x@3\.2\.0/);
  assert.throws(() => packageSbom(raw, { name: "x", version: "3.1.0", dependencies: { other: "2.0.0" } }), /doesn't list other@2\.0\.0/);
  assert.throws(() => packageSbom(raw, { name: "x", version: "3.1.0", dependencies: { dep: "^1.0.0" } }), /dep is "\^1\.0\.0": pin an exact version/);
  const fileRef = structuredClone(raw);
  fileRef.components[1].externalReferences = [{ type: "distribution", url: "file:../vendor/dep-1.0.0.tgz" }];
  assert.throws(() => packageSbom(fileRef, { name: "x", version: "3.1.0" }), /local path/, "a dependency installed from a file");
  const mac = structuredClone(raw);
  mac.components[1].properties = [{ name: "cdx:npm:package:path", value: "/private/var/folders/x/T/node_modules/dep" }];
  assert.throws(() => packageSbom(mac, { name: "x", version: "3.1.0" }), /local path/);
  const leaky = structuredClone(raw);
  leaky.components[1].properties = [{ name: "cdx:npm:package:path", value: "/home/sam/build/node_modules/dep" }];
  assert.throws(() => packageSbom(leaky, { name: "x", version: "3.1.0" }), /local path/);
});

test("the product README carries the repository's owner/name when the release knows it, else the placeholder", async () => {
  const { build } = await import("../scripts/build-host-packages.mjs");
  const read = (repo) => {
    const out = fs.mkdtempSync(path.join(TMP, "pr-"));
    fs.rmSync(out, { recursive: true });
    return fs.readFileSync(path.join(build({ out, targets: ["product-repo"], productRepo: repo }).built["product-repo"], "README.md"), "utf8");
  };
  assert.match(read("acme/memory"), /\/plugin marketplace add acme\/memory\n/);
  assert.match(read("not a repo; rm -rf"), /\/plugin marketplace add <this repository>\n/);
  assert.match(read(undefined), /<this repository>/);
});

const hasZip = spawnSync("zip", ["-v"], { encoding: "utf8" }).status === 0;
test("the build script produces every artifact the release lists (SBOM aside: it needs the registry)", { skip: hasZip ? false : "zip isn't installed here", timeout: 300_000 }, async () => {
  const out = path.join(TMP, "release");
  const r = await releaseBuild({ out, sbom: false, log: () => {} });
  const names = artifactNames(r.version);
  assert.deepEqual(names.filter((n) => !n.endsWith(".cdx.json")).sort(), fs.readdirSync(r.dist).sort());
  const p = PRODUCT.package;
  const v = r.version;
  assert.deepEqual(names, [`${p}-${v}.tgz`, `${p}-${v}.cdx.json`, "tools-list.json", `${p}-claude-code-marketplace-${v}.zip`, `${p}-claude-code-marketplace-legacy-${v}.zip`, `${p}-product-repo-${v}.zip`, `${p}-agent-plugin-${v}.zip`, `${p}-cursor-${v}.zip`, `${p}-gemini-extension-${v}.zip`, "server.json", "SHA256SUMS"]);
  assert.equal(fs.readFileSync(path.join(r.dist, "SHA256SUMS"), "utf8"), sha256sums(r.dist));
  const hook = (root) => JSON.parse(fs.readFileSync(path.join(root, "claude-code", "plugins", PRODUCT.plugin, "hooks", "hooks.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook(r.hosts).command, "node", "the product's marketplace: exec form");
  assert.match(hook(r.legacy).command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/server\/hook\.mjs" prompt\.submit --host claude-code --plugin$/, "the old marketplace: shell form");
  assert.equal(hook(r.legacy).args, undefined);
  const product = path.join(r.hosts, "product-repo");
  assert.ok(fs.existsSync(path.join(product, ".claude-plugin", "marketplace.json")) && fs.existsSync(path.join(product, "plugins", PRODUCT.plugin, ".claude-plugin", "icon.png")));
  assert.match(fs.readFileSync(path.join(product, "README.md"), "utf8"), /## Claude Code[\s\S]*## Every other agent: the npm package/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dist, "tools-list.json"), "utf8")).schemaVersion, 1);
  await assert.rejects(releaseBuild({ out, sbom: false, log: () => {} }), /pick an empty folder/, "never over an earlier build");
  // Each zip's top folder is what its host unpacks.
  if (spawnSync("unzip", ["-v"]).status === 0) {
    const top = (zip) => [...new Set(spawnSync("unzip", ["-Z1", path.join(r.dist, zip)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((l) => l.split("/")[0]))];
    assert.deepEqual(top(`${p}-claude-code-marketplace-${v}.zip`), ["claude-code"]);
    assert.deepEqual(top(`${p}-claude-code-marketplace-legacy-${v}.zip`), ["claude-code"]);
    assert.deepEqual(top(`${p}-product-repo-${v}.zip`), ["product-repo"]);
    assert.deepEqual(top(`${p}-agent-plugin-${v}.zip`), [p]);
    assert.deepEqual(top(`${p}-cursor-${v}.zip`), [p]);
    assert.deepEqual(top(`${p}-gemini-extension-${v}.zip`), ["gemini"]);
  }
});

test("the build refuses a package whose tools/list isn't the reviewed one", { skip: hasZip ? false : "zip isn't installed here", timeout: 300_000 }, async () => {
  const golden = path.join(TMP, "skewed-golden.json");
  const real = JSON.parse(fs.readFileSync(path.join(RUNTIME, "test", "fixtures", "tools-list.golden.json"), "utf8"));
  fs.writeFileSync(golden, JSON.stringify({ ...real, hashes: { ...real.hashes, "cursor/auto": "0".repeat(64) } }));
  await assert.rejects(releaseBuild({ out: path.join(TMP, "skewed"), sbom: false, golden, log: () => {} }), /the package's tools\/list isn't the reviewed one:\n {2}cursor\/auto/);
});
