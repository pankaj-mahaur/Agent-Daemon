// P5.6: listings and docs come from evidence. The MCP Registry entry validates and
// matches the package; every launch path pins the exact version; listing copy names
// only hosts the support matrix shows as tested live, and the claims rule catches
// hand-written hosts and unproven claims; the docs/memory pages exist, and the
// tools reference matches the server's own tool list.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validate } from "../testkit/json-schema-lite.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(RUNTIME, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "packages", "agent-daemon-memory", "package.json"), "utf8"));
const { build } = await import("../scripts/build-host-packages.mjs");
const deeplinks = await import("../scripts/memory-deeplinks.mjs");
const copy = await import("../scripts/render-copy.mjs");
const { renderToolsDoc, TOOLS_DOC } = await import("../scripts/render-tools-doc.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-listings-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("server.json: valid against the 2025-12-11 Registry schema, named by mcpName, pinned to the package version", () => {
  const { built } = build({ out: path.join(TMP, "out"), targets: ["registry"] });
  const server = JSON.parse(read(path.join(built.registry, "server.json")));
  const schema = JSON.parse(read(path.join(RUNTIME, "test", "fixtures", "schemas", "mcp-registry-2025-12-11", "server.schema.json")));
  assert.deepEqual(validate(schema, server), []);
  assert.equal(server.name, pkg.mcpName, "the Registry checks npm ownership through mcpName");
  assert.match(pkg.mcpName, /^io\.github\.[^/]+\/agent-daemon-memory$/);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version, "Registry clients start this exact version");
  const [serve, project] = server.packages[0].packageArguments;
  assert.deepEqual(serve, { type: "positional", value: "serve" });
  // Registry clients that know the open folder can bind the server to it.
  assert.deepEqual([project.type, project.name, project.format, project.isRequired], ["named", "--project", "filepath", false]);
  assert.match(server.packages[0].environmentVariables.find((v) => v.name === "AD_ROOT").description, /absolute path/);
  assert.equal(server.description, copy.renderAll()["short.txt"].trim(), "the description is the rendered, linted short copy");
  assert.ok(server.description.length <= 100, `${server.description.length} characters`);
  assert.equal(server._meta, undefined, "publisher metadata only under the publisher key, and none is set");
  assert.notDeepEqual(validate(schema, { ...server, name: "agent-daemon-memory" }), [], "the schema really checks the name");
});

test("pinned launches: the Cursor deeplink and the VS Code snippet start exactly this version", () => {
  const cursor = deeplinks.cursorDeeplink(pkg.name, pkg.version);
  const config = JSON.parse(Buffer.from(decodeURIComponent(new URL(cursor).searchParams.get("config")), "base64").toString("utf8"));
  assert.equal(new URL(cursor).searchParams.get("name"), pkg.name);
  assert.deepEqual(config.args.slice(0, 3), ["-y", `${pkg.name}@${pkg.version}`, "serve"]);
  // Cursor starts servers in its own folder: the link names the open project.
  assert.equal(config.args[config.args.indexOf("--project") + 1], "${workspaceFolder}");
  const vscode = JSON.parse(deeplinks.vscodeAddMcp(pkg.name, pkg.version));
  assert.equal(vscode.args[1], `${pkg.name}@${pkg.version}`);
  // The install guide carries the current block (regenerate with memory-deeplinks.mjs --write).
  const doc = read(deeplinks.INSTALL_DOC);
  assert.equal(doc, deeplinks.withQuickTry(doc, pkg), "docs/memory/install.md's quick-try block is stale: run node runtime/scripts/memory-deeplinks.mjs --write");
});

test("no doc launches an unpinned npx agent-daemon-memory", () => {
  const tracked = execFileSync("git", ["ls-files", "*.md", "*.json", "*.yml"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  // A server launch (serve), on a command line or as a JSON args list. The installer
  // commands may float: the entries they write start a pinned copy.
  const unpinned = [/npx\s+(?:-y\s+)?agent-daemon-memory(?!@)\s+serve\b/, /"agent-daemon-memory"\s*,\s*"serve"/];
  const isUnpinned = (t) => unpinned.some((re) => re.test(t));
  const hits = tracked.filter((f) => fs.existsSync(path.join(REPO, f)) && isUnpinned(read(path.join(REPO, f))));
  assert.deepEqual(hits, []);
  for (const t of ["npx -y agent-daemon-memory serve", "npx agent-daemon-memory serve", '"args": ["-y", "agent-daemon-memory", "serve"]']) assert.ok(isUnpinned(t), t);
  for (const t of ["npx -y agent-daemon-memory@3.0.0 serve", '"args": ["-y", "agent-daemon-memory@3.0.0", "serve"]', "npx agent-daemon-memory install"]) assert.ok(!isUnpinned(t), t);
});

test("copy from evidence: only tested-live hosts are named; the matrix decides, not a list in code", () => {
  const matrix = path.join(TMP, "matrix.md");
  fs.writeFileSync(matrix, "# x\n\n## Hosts\n\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n| Claude Code | plugin | tested live | record |\n| Cursor | installer | built | tests |\n| VS Code (Copilot) | installer | tested live | record |\n| Claude Code | installer | tested live | record |\n\n## Other\n\n| Host | x |\n|---|---|\n| Windsurf | tested live |\n");
  const files = copy.renderAll({ matrix });
  assert.match(files["long.md"], /in Claude Code and VS Code \(Copilot\)\./);
  assert.doesNotMatch(files["long.md"], /Cursor|Windsurf/);
  // Nothing tested live: copy that names hosts isn't rendered at all.
  fs.writeFileSync(matrix, "## Hosts\n\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n| Cursor | installer | built | tests |\n");
  assert.throws(() => copy.renderAll({ matrix }), /no host is tested live/);
  // The real matrix renders, and every host it names is tested live there.
  const real = copy.renderAll();
  const tested = copy.testedHosts(copy.parseSupportMatrix(read(copy.MATRIX)));
  const named = (text, h) => new RegExp(String.raw`\b${h.replace(/ /g, String.raw`\s*`)}\b`, "i").test(text);
  for (const f of Object.keys(real)) for (const h of copy.HOST_NAMES) if (named(real[f], h)) assert.ok(tested.some((t) => named(t, h)), `${f}: ${h} named without evidence`);
});

test("the matrix parser: one table, one host per row, known statuses only", () => {
  const head = "## Hosts\n\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n";
  const parse = (rows, tail = "") => copy.parseSupportMatrix(head + rows + tail);
  // Bold is stripped; the status is case-insensitive.
  assert.deepEqual(parse("| **Zed** | installer | **Tested live** | ci |\n").map((r) => [r.host, r.status]), [["Zed", "tested live"]]);
  // A typo or a new word fails, instead of dropping or adding a host.
  assert.throws(() => parse("| Zed | installer | tested-live | ci |\n"), /unknown status "tested-live"/);
  assert.throws(() => parse("| Zed | installer | works | ci |\n"), /unknown status/);
  // One host per row.
  for (const host of ["Kiro, OpenHands", "Kiro and OpenHands", "Kiro / OpenHands", "Kiro; OpenHands"]) assert.throws(() => parse(`| ${host} | Agent Plugins | tested live | x |\n`), /one host per row/, host);
  // A table under a subheading, or a second table, is not the Hosts table.
  assert.deepEqual(copy.testedHosts(parse("| Zed | installer | tested live | ci |\n", "\n### Planned\n\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n| Windsurf | plugin | tested live | none |\n")), ["Zed"]);
  assert.deepEqual(copy.testedHosts(parse("| Zed | installer | tested live | ci |\n", "\nSome text.\n\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n| Windsurf | plugin | tested live | none |\n")), ["Zed"]);
  assert.deepEqual(copy.testedHosts(parse("| Zed | installer | tested live | ci |\n", "### Planned\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n| Windsurf | plugin | tested live | none |\n")), ["Zed"], "a heading right under the table ends it");
  assert.deepEqual(copy.testedHosts(parse("| Zed | installer | tested live | ci |\n", "Note.\n| Windsurf | plugin | tested live | none |\n")), ["Zed"], "any line that isn't a row ends the table");
  assert.throws(() => copy.parseSupportMatrix("## Hosts\n\n### Planned\n\n| Host | Route | Status | Evidence |\n|---|---|---|---|\n| Windsurf | plugin | tested live | none |\n"), /no table under "## Hosts"/, "a subsection's table isn't the Hosts table");
  // The header is checked.
  assert.throws(() => copy.parseSupportMatrix("## Hosts\n\n| Name | Status |\n|---|---|\n| Zed | tested live |\n"), /must start with Host \| Route \| Status/);
  assert.throws(() => copy.parseSupportMatrix("# Nothing\n"), /no "## Hosts" section/);
});

test("the claims rule: templates name no host by hand and make no unproven claim", () => {
  for (const f of fs.readdirSync(copy.TEMPLATES)) assert.deepEqual(copy.lintCopy(read(path.join(copy.TEMPLATES, f))), [], f);
  const bad = [
    ["Works in Windsurf and {{hosts}}.", /names a host by hand: Windsurf/],
    ["Cuts repeated mistakes by 40%.", /percentage/],
    ["The #1 memory for agents.", /ranking/],
    ["State-of-the-art recall.", /ranking/],
    ["Only reviewed lessons are served.", /reviewed/],
    ["It never reads another project.", /precise sentence/],
    ["Built for claude users.", /names a host by hand: Claude/],
    ["Install it from the vscode marketplace.", /names a host by hand: VSCode/],
    ["Forty per cent fewer repeats.", /percentage/],
    ["Ten percent fewer repeats.", /percentage/],
    ["Recall is 10x faster.", /multiplier/],
    ["The leading memory server.", /ranking/],
    ["Unmatched recall.", /ranking/],
    ["The best memory for agents.", /ranking/],
    ["Your own corrections apply right away.", /only where ad's hooks/],
    ["Corrections are applied immediately.", /only where ad's hooks/],
  ];
  for (const [text, re] of bad) assert.match(copy.lintCopy(text).join("\n"), re, text);
  // Words that only look like claims pass.
  for (const ok of ["Search is best-effort when the store is busy.", "Where ad's hooks capture what you say, your corrections apply right away.","Recorded notes wait for your review.", "Runs on Node 22.16 or newer."]) assert.deepEqual(copy.lintCopy(ok), [], ok);
});

test("docs/memory: every page exists with its title, linked from the root README; no percentage outside metrics", () => {
  const pages = { "README.md": /^# Agent Daemon memory$/m, "install.md": /^# Memory in other agents: the installer$/m, "hosts.md": /^# Memory as host plugins$/m, "tools.md": /^# Memory tools$/m, "security.md": /^# Memory security$/m, "metrics.md": /^# /m, "faq.md": /^# Memory FAQ$/m };
  for (const [f, title] of Object.entries(pages)) assert.match(read(path.join(REPO, "docs", "memory", f)), title, f);
  assert.match(read(path.join(REPO, "README.md")), /\]\(docs\/memory\/README\.md\)/);
  for (const f of Object.keys(pages).filter((f) => f !== "metrics.md")) assert.doesNotMatch(read(path.join(REPO, "docs", "memory", f)), /\d\s*%/, f);
});

test("docs/memory/tools.md matches the server's tool list (regenerate with render-tools-doc.mjs --write)", () => {
  assert.equal(read(TOOLS_DOC), renderToolsDoc().replace(/\r\n/g, "\n"));
});

test("Claude Code directory fields (privacy, terms, support URLs)", { skip: "they arrive with P8.4a's pages; the community directory submission waits on them" }, () => {});
