// Tests for runtime/scripts/check-brand.mjs, the brand lint: the four rules
// on a fixture tree, the allowlist (globs, `match`, stale entries), the
// script's exit codes (a planted hit per rule must fail strict mode: the
// mutation check), the string scanner's edge cases, and the live brand
// test's assertion (spike S5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileAllowlist, extractStrings, globToRegExp, isProse, lint, listFiles, loadAllowlist, loadMethods, parseArgs, REPO_ROOT, screenHits, stripComments } from "../scripts/check-brand.mjs";
import { brandPatterns } from "../src/engine/attribution.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/check-brand.mjs", import.meta.url));

function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "ad-brand-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// The allowlist file lives outside the linted root: its own entries name the brand.
function allowFileFor(entries) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "ad-brand-allow-")), "allow.json");
  writeFileSync(file, JSON.stringify({ entries }));
  return file;
}

// One planted hit per rule in foo.mjs, plus the allowed zone and the edge cases.
const TREE = {
  "runtime/src/harness/foo.mjs": [
    'import { codexEnv } from "../engine/codex/home.mjs";', // 1: A (the path), D
    'export const text = "the Codex engine stopped";', // 2: A, C
    'export const token = "CODEX_HOME";', // 3: A; not prose
    "await engine.server.request(", // 4: B, line-broken
    '  "thread/start", {});',
    '// import old from "../engine/codex/old.mjs"; s.request("turn/start");', // 6: A only: a comment is neither B nor D
    '/* "Codex in a comment" */', // 7: A only: never C
    "",
  ].join("\n"),
  "runtime/src/engine/codex/app-server.mjs": 'export const M = "codex app-server not started";\nexport const T = "codex";\n', // A allowed; C once
  "runtime/src/engine/index.mjs": 'import { CodexAppServer } from "./codex/app-server.mjs";\nawait s.request("thread/start", {});\n', // A allowed; B and D exempt
  "runtime/src/engine/attribution.mjs": 'export const s = "ad runs on Codex.";\n', // A allowed; C exempt
  "runtime/src/nul.mjs": 'export const z = "a\0b";\nexport const brand = "Codex via a file with a NUL byte";\n', // a .mjs is text whatever it holds
  "runtime/src/esc.mjs": 'export const e = "\\u0043odex escaped", f = "\\x43odex too";\n', // C after decoding; the raw line never says the word (no A)
  "docs/codex-notes.md": "# Notes\nCodex is the engine.\n", // A: the file name and line 2
  "runtime/test/codex-adapter.test.mjs": 'await server.request("thread/start", {}); // codex\n', // A and B allowed
  "runtime/src/tui/x.json": '{"codex": "bare", "desc": "Codex does it.", "list": ["codex-home", "ask Codex"]}\n', // A once; C twice (values, not the key)
  "assets/codex-logo.bin": Buffer.from([0, 1, 2, 3]), // binary: content skipped, the file name still counts
  "skills/x/SKILL.md": [
    "Works with Claude Code, Codex and Cursor.", // 1: allowed by `match`
    "Codex is great.", // 2: a hit
    "Works with Claude Code, Codex and Cursor; Codex rules.", // 3: a hit: the brand word survives outside the match
    "",
  ].join("\n"),
  "README.md": "plain\n",
};

const ALLOW = [
  { path: "runtime/src/engine/codex/", rules: ["A"], reason: "the adapter" },
  { path: "runtime/src/engine/index.mjs", rules: ["A"], reason: "the façade" },
  { path: "runtime/src/engine/attribution.mjs", rules: ["A"], reason: "the attribution module" },
  { path: "runtime/test/codex-*.test.mjs", rules: ["A", "B"], reason: "tests of the adapter" },
  { path: "skills/**/SKILL.md", rules: ["A"], match: "Claude Code, Codex", reason: "descriptive" },
];
const STALE = { path: "nothing/here.md", rules: ["A"], reason: "stale on purpose" };

const where = (hits) => hits.map((h) => `${h.file}:${h.line}`).sort();

test("the four rules on a fixture tree, with the allowlist applied", () => {
  const root = fixture(TREE);
  try {
    const r = lint({ root, allowlist: compileAllowlist([...ALLOW, STALE]), methods: new Set(["thread/start", "turn/start"]) });
    assert.deepEqual(where(r.hits.A), [
      "assets/codex-logo.bin:0",
      "docs/codex-notes.md:0",
      "docs/codex-notes.md:2",
      "runtime/src/harness/foo.mjs:1",
      "runtime/src/harness/foo.mjs:2",
      "runtime/src/harness/foo.mjs:3",
      "runtime/src/harness/foo.mjs:6",
      "runtime/src/harness/foo.mjs:7",
      "runtime/src/nul.mjs:2",
      "runtime/src/tui/x.json:1",
      "skills/x/SKILL.md:2",
      "skills/x/SKILL.md:3",
    ]);
    assert.deepEqual(where(r.hits.B), ["runtime/src/harness/foo.mjs:4"]);
    assert.equal(r.hits.B[0].text, '.request( "thread/start"');
    assert.deepEqual(where(r.hits.C), [
      "runtime/src/engine/codex/app-server.mjs:1",
      "runtime/src/esc.mjs:1",
      "runtime/src/esc.mjs:1",
      "runtime/src/harness/foo.mjs:2",
      "runtime/src/nul.mjs:2",
      "runtime/src/tui/x.json:1",
      "runtime/src/tui/x.json:1",
    ]);
    assert.deepEqual(r.hits.C.map((h) => h.text).sort(), ["Codex does it.", "Codex escaped", "Codex too", "Codex via a file with a NUL byte", "ask Codex", "codex app-server not started", "the Codex engine stopped"]);
    assert.deepEqual(where(r.hits.D), ["runtime/src/harness/foo.mjs:1"]);
    assert.equal(r.hits.D[0].text, "../engine/codex/home.mjs");
    // allowed: adapter file name + 2 lines, façade 1, attribution 1, test file name + 1 line, skills line 1
    assert.deepEqual(r.allowed, { A: 8, B: 1, C: 0, D: 0 });
    assert.deepEqual(r.stale.map((e) => e.path), ["nothing/here.md"]);
    assert.equal(r.scanned, Object.keys(TREE).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted-but-indexed file is neither scanned nor a file-name hit", () => {
  const root = fixture({ "README.md": "plain\n" });
  try {
    const r = lint({ root, files: ["README.md", "docs/codex-gone.md"], allowlist: compileAllowlist([]), methods: new Set() });
    assert.equal(r.scanned, 1);
    assert.deepEqual(r.hits.A, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the script: report mode exits 0; strict mode fails on a planted hit per rule", () => {
  const root = fixture(TREE);
  const allowFile = allowFileFor(ALLOW); // no stale entry: only the planted hits can fail a rule
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--root", root, "--allowlist", allowFile, ...args], { encoding: "utf8" });
  try {
    const report = run();
    assert.equal(report.status, 0, report.stdout + report.stderr);
    assert.match(report.stdout, /report mode/);
    assert.doesNotMatch(report.stdout, /match nothing/);
    const json = JSON.parse(run("--json").stdout);
    assert.deepEqual(Object.keys(json.hits), ["A", "B", "C", "D"]);
    for (const rule of ["A", "B", "C", "D"]) {
      assert.ok(json.hits[rule].length >= 1, `rule ${rule} has a planted hit`);
      const r = run(`--strict=${rule}`);
      assert.equal(r.status, 1, `rule ${rule} planted hit must fail: ${r.stdout}`);
      assert.match(r.stdout, new RegExp(`FAIL: rule\\(s\\) ${rule} `));
    }
    assert.equal(run("--strict").status, 1);
    assert.equal(run("--strict=Z").status, 1); // unknown rule
    assert.equal(run("--bogus").status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(path.dirname(allowFile), { recursive: true, force: true });
  }
});

test("the script: a clean tree passes strict mode; a stale entry is reported and fails only the rules it names", () => {
  const root = fixture({ "README.md": "plain\n", "runtime/src/engine/codex/x.mjs": 'export const a = "codex";\n' });
  const clean = allowFileFor([ALLOW[0]]);
  const stale = allowFileFor([ALLOW[0], STALE]);
  const run = (allowFile, ...args) => spawnSync(process.execPath, [SCRIPT, "--root", root, "--allowlist", allowFile, ...args], { encoding: "utf8" });
  try {
    const r = run(clean, "--strict");
    assert.equal(r.status, 0, r.stdout);
    const report = run(stale);
    assert.equal(report.status, 0);
    assert.match(report.stdout, /Allowlist entries that match nothing[\s\S]*nothing\/here\.md \[A\]/);
    assert.equal(run(stale, "--strict=B,C,D").status, 0);
    assert.equal(run(stale, "--strict=A").status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(path.dirname(clean), { recursive: true, force: true });
    rmSync(path.dirname(stale), { recursive: true, force: true });
  }
});

test("allowlist entries need a path, rules and a reason; globs match segments; a folder may hold a glob", () => {
  assert.throws(() => compileAllowlist([{ path: "x", rules: ["A"] }]), /needs a reason/);
  assert.throws(() => compileAllowlist([{ path: "x", rules: ["A"], reason: "  " }]), /needs a reason/);
  assert.throws(() => compileAllowlist([{ path: "x", rules: [], reason: "r" }]), /needs rules/);
  assert.throws(() => compileAllowlist([{ path: "x", rules: ["Q"], reason: "r" }]), /unknown rule Q/);
  assert.throws(() => compileAllowlist([{ rules: ["A"], reason: "r" }]), /needs a path/);
  assert.throws(() => compileAllowlist({ nope: [] }), /expected/);
  const g = (glob, p) => globToRegExp(glob).test(p);
  assert.ok(g("runtime/src/engine/codex/", "runtime/src/engine/codex/a/b.mjs"));
  assert.ok(!g("runtime/src/engine/codex/", "runtime/src/engine/codex.mjs"));
  assert.ok(g("README.md", "README.md"));
  assert.ok(!g("README.md", "docs/README.md"));
  assert.ok(g("skills/**/SKILL.md", "skills/a/SKILL.md"));
  assert.ok(g("skills/**/SKILL.md", "skills/a/b/SKILL.md"));
  assert.ok(g("skills/*/SKILL.md", "skills/a/SKILL.md"));
  assert.ok(!g("skills/*/SKILL.md", "skills/a/b/SKILL.md"));
  assert.ok(g("skills/*/", "skills/a/SKILL.md"));
  assert.ok(g("skills/*/", "skills/a/deep/file.md"));
  assert.ok(!g("skills/*/", "skills/SKILL.md"));
  assert.ok(g("runtime/test/codex-*.test.mjs", "runtime/test/codex-home.test.mjs"));
  assert.ok(!g("runtime/test/codex-*.test.mjs", "runtime/test/codex-home.mjs"));
  assert.ok(g("**", "any/thing.md"));
  assert.ok(g("**/*.json", "a.json"));
});

test("isProse: the brand word plus whitespace or sentence punctuation; bare tokens pass", () => {
  for (const bare of ["CODEX_HOME", "codex", "@openai/codex", ".codex", "codex-home", "codex-version", "gpt-5.1-codex", "~/.codex/sessions", "codex.exe", "thread/start", "AD_CODEX_HOME", "codex-rs/tui/src/app.rs"]) {
    assert.equal(isProse(bare), false, bare);
  }
  for (const prose of ["Codex engine not installed", "refusing CODEX_HOME: x", "on Codex ${}", "Codex.", "codex, pinned", "Codex didn't return the new thread", "ad doesn't work inside a Codex home: x"]) {
    assert.equal(isProse(prose), true, prose);
  }
  assert.equal(isProse("the engine stopped"), false); // no brand word
});

test("extractStrings: strings and templates only, never comments or regex literals", () => {
  const src = [
    '// "not Codex one"',
    "/* 'not Codex two' */",
    'const a = "Codex three";',
    "const b = 'Codex four';",
    'const re = /"Codex five"/; const d = x / 2 / "Codex six".length;',
    "const t = `on Codex ${version} (tested) ${\"Codex seven\"}`;",
    "return /x\"y/.test(s) ? \"Codex eight\" : 'no';",
    "const esc = \"say \\\"Codex nine\\\"\";",
    'const p = obj.return / 2 / "Codex ten".length;', // a property named like a keyword is not a keyword
    'const q = i++ / 2, r = j-- / 3; const s = "Codex eleven";', // a division after a postfix ++/--
    'const n = café / 2, m = nämé_1 / 3; const t = "Codex twelve";', // a non-ASCII identifier right before a division
  ].join("\n");
  const got = extractStrings(src);
  const texts = got.map((s) => s.text);
  assert.deepEqual(texts.filter((t) => /Codex/.test(t)).sort(), ["Codex eight", "Codex eleven", "Codex four", "Codex seven", "Codex six", "Codex ten", "Codex three", "Codex twelve", 'say "Codex nine"', "on Codex ${} (tested) ${}"].sort());
  assert.ok(!texts.some((t) => /one|two|five/.test(t)));
  assert.equal(got.find((s) => s.text === "Codex three").line, 3);
  assert.equal(got.find((s) => s.text.startsWith("on Codex")).line, 6);
  assert.equal(got.find((s) => s.text.startsWith("on Codex")).kind, "template");
  assert.equal(got.find((s) => s.text === "Codex ten").line, 9);
  assert.equal(got.find((s) => s.text === "Codex eleven").line, 10);
  assert.equal(got.find((s) => s.text === "Codex twelve").line, 11);
});

test("extractStrings: line numbers survive multi-line templates, unterminated strings, continuations and escapes", () => {
  const multi = "const x = `a\nb\nc`;\nconst y = \"Codex later\";\n";
  assert.equal(extractStrings(multi).find((s) => s.text === "Codex later").line, 4);
  const broken = 'const bad = "never closed\nconst ok = "Codex after";\n'; // a string cut by a newline keeps the count right
  assert.equal(extractStrings(broken).find((s) => s.text === "Codex after").line, 2);
  const notRegex = "const n = a / b\nconst z = 'Codex z';\n"; // a division that looks like an unclosed regex
  assert.equal(extractStrings(notRegex).find((s) => s.text === "Codex z").line, 2);
  const cont = 'const c = "one \\\ntwo";\nconst w = "Codex w";\n'; // backslash-newline continuation inside a string
  const got = extractStrings(cont);
  assert.equal(got.find((s) => s.text === "one two").line, 1);
  assert.equal(got.find((s) => s.text === "Codex w").line, 3);
  const contCrlf = 'const c = "one \\\r\ntwo";\r\nconst w = "Codex crlf";\r\n';
  assert.equal(extractStrings(contCrlf).find((s) => s.text === "Codex crlf").line, 3);
  const bareCr = 'const a = "x \\\ry"; const b = "Codex b";\nconst c = "Codex c";\n'; // a lone CR is not a line, as nowhere else in the lint
  assert.deepEqual(extractStrings(bareCr).filter((s) => /Codex/.test(s.text)).map((s) => s.line), [1, 2]);
  const tmplCont = "const t = `a \\\nb ${x} ${\"Codex in expr\"}`;\nconst v = 'Codex v';\n";
  assert.equal(extractStrings(tmplCont).find((s) => s.text === "Codex v").line, 3);
  const escapes = 'const u = "\\u0043odex u", x = "\\x43odex x", b = "\\u{43}odex b", k = "\\u{1F600} \\q";\n';
  assert.deepEqual(extractStrings(escapes).map((s) => s.text), ["Codex u", "Codex x", "Codex b", "😀 q"]);
});

test("stripComments blanks comments and keeps every newline, so rules B and D ignore them", () => {
  const src = 'const a = 1; // s.request("thread/start")\n/* import x from "../engine/codex/h.mjs"\n */ const b = "// not a comment";\n';
  const out = stripComments(src);
  assert.equal(out.split("\n").length, src.split("\n").length);
  assert.doesNotMatch(out, /request|engine\/codex/);
  assert.match(out, /const b = "\/\/ not a comment";/);
  assert.equal(stripComments("no comments\n"), "no comments\n");
  // a division after ++ never opens a "regex" that would swallow a comment or a real call site
  const afterIncrement = 'const n = i++ / 2; const u = "http://h"; s.request("thread/start"); // s.request("turn/start")\n';
  const stripped = stripComments(afterIncrement);
  assert.match(stripped, /s\.request\("thread\/start"\);\s+$/);
  assert.doesNotMatch(stripped, /turn\/start/);
});

test("parseArgs: --tracked limits a run to tracked files", () => {
  assert.equal(parseArgs([]).tracked, false);
  assert.equal(parseArgs(["--tracked"]).tracked, true);
});

test("parseArgs: --strict takes every rule or a list; unknown rules and options are refused", () => {
  assert.deepEqual(parseArgs([]).strict, []);
  assert.deepEqual(parseArgs(["--strict"]).strict, ["A", "B", "C", "D"]);
  assert.deepEqual(parseArgs(["--strict=b,d"]).strict, ["B", "D"]);
  assert.ok(parseArgs(["--verbose", "--json"]).verbose);
  assert.throws(() => parseArgs(["--strict=E"]), /unknown rule/);
  assert.throws(() => parseArgs(["--what"]), /unknown option/);
});

test("the real repo: the allowlist loads with reasons, no entry is stale, the snapshot has the methods", () => {
  const allowlist = loadAllowlist();
  assert.ok(allowlist.length > 10);
  const methods = loadMethods();
  assert.ok(methods.has("thread/start") && methods.has("turn/start") && methods.has("initialize"));
  assert.ok(methods.size >= 150, `snapshot lists ${methods.size} methods`);
  const files = listFiles(REPO_ROOT);
  assert.ok(files.includes("README.md") && files.includes("runtime/scripts/check-brand.mjs"));
  const r = lint({ root: REPO_ROOT, files, allowlist, methods });
  assert.deepEqual(r.stale, [], "allowlist entries that match nothing");
});

// ── spike S5: the live brand test's assertion ──────────────────────────────

test("S5: screenHits allows exactly the attribution patterns and model names", () => {
  const allow = brandPatterns();
  const screen = [
    "engine: Codex 0.160.0 by OpenAI, Apache-2.0, https://github.com/openai/codex",
    "engine: Codex by OpenAI, Apache-2.0, https://github.com/openai/codex (not installed; ad pins 0.160.0: cd runtime && npm install)",
    "its process shows as codex (codex.exe on Windows) in Task Manager",
    "model: gpt-5.x-codex (reasoning high) · codex-mini-latest",
    "Opening your browser to sign in with ChatGPT. The page is OpenAI's and may say 'Codex': that is the engine ad runs on.",
    "ad doesn't work inside a Codex home: C:\\Users\\me\\.codex",
    "engine home: ~/.agent-daemon/codex-home (older folder name; nothing is wrong)",
  ].join("\n");
  assert.deepEqual(screenHits(screen, { allow }), []);
  // and nothing else: a bare brand word on ad's chrome is still a hit
  const hits = screenHits(">_ Agent Daemon (v3.0.0) · on Codex 0.160.0 (tested)\n■ Codex stopped (exit 3). Your text is kept.\nfine\n", { allow });
  assert.deepEqual(hits.map((h) => h.line), [1, 2]);
  // literal strings work as allowances too
  assert.equal(screenHits("see codex-home now", { allow: ["codex-home"] }).length, 0);
});

test("S5 on a golden: whatever TUI chrome still names the engine is one of the lines Part 4 rewrites", () => {
  const golden = readFileSync(path.join(REPO_ROOT, "runtime", "test", "golden", "tui", "cells-120.txt"), "utf8");
  for (const h of screenHits(golden, { allow: brandPatterns() })) assert.match(h.text, /Codex (restarted|stopped)/, `unexpected brand word on screen: ${h.text}`);
});
