// P5.3: the config editors (memory-install/edit-json.mjs, edit-toml.mjs).
// Fixtures are inline strings (CRLF and comments survive exactly; git would
// normalize fixture files). The rule: ad changes only its own entry, refuses
// anything it can't edit safely, and round trips leave other content intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";
import { planJsonAdd, planJsonRemove } from "../src/memory-install/edit-json.mjs";
import { planTomlAdd, planTomlRemove, tomlBlock, tomlString, BEGIN } from "../src/memory-install/edit-toml.mjs";

const ENTRY = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["--disable-warning=ExperimentalWarning", "C:\\Users\\sam\\.agent-daemon\\memory\\bin\\launch.mjs", "serve", "--host", "codex", "--capture", "tools"] };
const ENTRY2 = { ...ENTRY, args: [...ENTRY.args.slice(0, -1), "hooks"] };
const JENTRY = { type: "stdio", command: "/usr/bin/node", args: ["/home/sam/.agent-daemon/memory/bin/launch.mjs", "serve", "--host", "cursor", "--capture", "tools", "--project", "${workspaceFolder}"] };

// ---------------- JSON / JSONC (Cursor) ----------------

const JSON_FIXTURES = {
  missing: "",
  empty: "{}",
  others: '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  },\n  "theme": "dark"\n}\n',
  jsonc: '{\n  // my servers\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }, // keep me\n  },\n}\n',
  crlf: '{\r\n    "mcpServers": {\r\n        "a": { "command": "x" }\r\n    }\r\n}\r\n',
  tabs: '{\n\t"other": 1\n}\n',
};

for (const [name, text] of Object.entries(JSON_FIXTURES)) {
  test(`json ${name}: add then remove leaves the rest as it was`, () => {
    const add = planJsonAdd(text, JENTRY);
    assert.ok(["add"].includes(add.action), `${name}: ${add.action} ${add.reason ?? ""}`);
    assert.deepEqual(parseJsonc(add.text).mcpServers["agent-daemon-memory"], JENTRY);
    if (text.includes("// keep me")) {
      assert.ok(add.text.includes("// my servers") && add.text.includes("// keep me"), "comments kept");
    }
    // A neighbour's one-line entry stays exactly as written (no re-layout).
    if (text.includes('"github": { "command": "gh-mcp" }')) assert.ok(add.text.includes('"github": { "command": "gh-mcp" }'), add.text);
    if (text.includes("\r\n")) assert.ok(!/[^\r]\n/.test(add.text), "CRLF kept");
    // Adding again: nothing to do.
    assert.equal(planJsonAdd(add.text, JENTRY).action, "same");
    const rm = planJsonRemove(add.text, { entry: JENTRY });
    assert.equal(rm.action, "remove");
    const back = parseJsonc(rm.text) ?? {};
    const orig = parseJsonc(text || "{}") ?? {};
    assert.deepEqual(back.mcpServers?.["agent-daemon-memory"], undefined);
    assert.deepEqual({ ...back, mcpServers: undefined }, { ...orig, mcpServers: undefined });
    for (const k of Object.keys(orig.mcpServers ?? {})) assert.deepEqual(back.mcpServers[k], orig.mcpServers[k]);
    if (text.includes("// keep me")) assert.ok(rm.text.includes("// keep me"));
  });
}

test("json: refuses a file it can't parse, a non-object, and an entry someone else wrote", () => {
  assert.equal(planJsonAdd('{ "mcpServers": { ', JENTRY).action, "refuse");
  assert.equal(planJsonAdd("[1, 2]", JENTRY).action, "refuse");
  assert.equal(planJsonAdd('{ "mcpServers": [] }', JENTRY).action, "refuse");
  const theirs = '{ "mcpServers": { "agent-daemon-memory": { "command": "node", "args": ["mine.mjs"] } } }';
  const r = planJsonAdd(theirs, JENTRY);
  assert.equal(r.action, "refuse");
  assert.match(r.reason, /already defines agent-daemon-memory/);
  assert.equal(planJsonAdd(theirs, JENTRY, { owned: true }).action, "update", "ad's own older entry is updated");
});

test("json: a byte order mark (Windows PowerShell 5) is read past and kept", () => {
  const bom = String.fromCharCode(0xfeff);
  const text = bom + JSON_FIXTURES.others;
  const add = planJsonAdd(text, JENTRY);
  assert.equal(add.action, "add", add.reason);
  assert.ok(add.text.startsWith(bom) && add.text.charCodeAt(1) !== 0xfeff, "one BOM, kept");
  assert.equal(planJsonAdd(add.text, JENTRY).action, "same");
  const rm = planJsonRemove(add.text, { entry: JENTRY });
  assert.equal(rm.action, "remove");
  assert.ok(rm.text.startsWith(bom));
  assert.deepEqual(parseJsonc(rm.text.slice(1)), parseJsonc(JSON_FIXTURES.others));
});

test("json: an entry the user edited is kept on uninstall", () => {
  const add = planJsonAdd(JSON_FIXTURES.others, JENTRY);
  const edited = add.text.replace('"tools"', '"hooks"');
  const rm = planJsonRemove(edited, { entry: JENTRY });
  assert.equal(rm.action, "edited");
  assert.equal(planJsonRemove(JSON_FIXTURES.others, { entry: JENTRY }).action, "absent");
});

// ---------------- TOML (Codex) ----------------

const TOML_OK = {
  missing: "",
  others: '# my config\nmodel = "o5"\n\n[mcp_servers.github]\ncommand = "gh-mcp" # keep me\nargs = ["--x"]\n\n[profiles.fast]\nmodel = "mini"\n',
  crlf: 'model = "o5"\r\n\r\n[mcp_servers.a]\r\ncommand = "x"\r\n',
  noTrailingNewline: 'model = "o5"',
  dottedOther: 'mcp_servers.other.command = "x"\n',
};

for (const [name, text] of Object.entries(TOML_OK)) {
  test(`toml ${name}: add then remove leaves the rest as it was`, () => {
    const add = planTomlAdd(text, ENTRY);
    assert.equal(add.action, "add", `${name}: ${add.reason ?? ""}`);
    const doc = parseToml(add.text);
    assert.deepEqual(JSON.parse(JSON.stringify(doc.mcp_servers["agent-daemon-memory"])), ENTRY);
    assert.ok(add.text.startsWith(text.replace(/\r?\n?$/, "")), "the file's own text comes first, unchanged");
    if (text.includes("\r\n")) assert.ok(!/[^\r]\n/.test(add.text), "CRLF kept");
    assert.equal(planTomlAdd(add.text, ENTRY).action, "same");
    const rm = planTomlRemove(add.text, { entry: ENTRY });
    assert.equal(rm.action, "remove");
    assert.equal(rm.text.replace(/\r?\n$/, ""), text.replace(/\r?\n$/, ""), "back to the original text");
    if (text.includes("# keep me")) assert.ok(rm.text.includes("# keep me"));
  });
}

test("toml: every hidden shape of an existing entry is refused, file untouched", () => {
  const shapes = {
    table: '[mcp_servers.agent-daemon-memory]\ncommand = "node"\n',
    dotted: 'mcp_servers.agent-daemon-memory.command = "node"\n',
    inlineUnder: '[mcp_servers]\nagent-daemon-memory = { command = "node" }\n',
    inlineRoot: 'mcp_servers = { other = { command = "x" } }\n',
    notTable: 'mcp_servers = "nope"\n',
    broken: '[mcp_servers.x\ncommand = \n',
    quotedKey: '[mcp_servers."agent-daemon-memory"]\ncommand = "node"\n',
  };
  // Each refusal says why: the user fixes their file from this text.
  const why = {
    table: /outside ad's markers/, dotted: /outside ad's markers/, inlineUnder: /outside ad's markers/, quotedKey: /outside ad's markers/,
    inlineRoot: /can't go into this file/, notTable: /mcp_servers isn't a table/, broken: /doesn't parse as TOML/,
  };
  for (const [name, text] of Object.entries(shapes)) {
    const r = planTomlAdd(text, ENTRY);
    assert.equal(r.action, "refuse", `${name} must be refused`);
    assert.equal(r.text, undefined);
    assert.match(r.reason, why[name], `${name}: ${r.reason}`);
  }
});

test("toml: ad's block edited by hand is kept; ad's own block is updated in place", () => {
  const add = planTomlAdd(TOML_OK.others, ENTRY);
  const edited = add.text.replace("'tools'", "'hooks'");
  assert.equal(planTomlAdd(edited, ENTRY).action, "refuse");
  assert.equal(planTomlRemove(edited, { entry: ENTRY }).action, "edited");
  const upd = planTomlAdd(add.text, ENTRY2, { owned: true });
  assert.equal(upd.action, "update");
  assert.equal(upd.text.indexOf(BEGIN), add.text.indexOf(BEGIN), "same place");
  assert.deepEqual(JSON.parse(JSON.stringify(parseToml(upd.text).mcp_servers["agent-daemon-memory"])), ENTRY2);
});

test("toml strings: literal when possible, escaped basic strings otherwise; env as an inline table", () => {
  assert.equal(tomlString("C:\\a b\\c"), "'C:\\a b\\c'");
  assert.equal(tomlString("it's"), '"it\'s"');
  assert.equal(parseToml(`x = ${tomlString("C:\\it's\\q\"x")}`).x, "C:\\it's\\q\"x");
  const block = tomlBlock({ ...ENTRY, command: "C:\\Users\\o'neil\\node.exe", env: { AD_ROOT: "D:\\ad" } });
  const doc = parseToml(block);
  assert.equal(doc.mcp_servers["agent-daemon-memory"].command, "C:\\Users\\o'neil\\node.exe");
  assert.equal(doc.mcp_servers["agent-daemon-memory"].env.AD_ROOT, "D:\\ad");
});
