// Guard: the files that start ad's child processes use no shell, no exec(),
// and no bare program names. A bare name ("git", "claude") lets Windows run a
// same-named program from the working folder before PATH; a shell lets task
// text run as commands. Programs come from resolveCommand / systemTool
// (runtime/src/safe-spawn.mjs) instead, and only safe-spawn.mjs may import
// child_process, so aliasing tricks (const bin = "git"; spawn(bin)) have
// nothing to call.
//
// Scope: the worker path. A later part widens it to all of runtime/src.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);
const GUARDED = ["orchestration/spawn.mjs", "orchestration/engine-worker.mjs", "claude.mjs", "safe-spawn.mjs"];
const MAY_IMPORT_CHILD_PROCESS = new Set(["safe-spawn.mjs"]);

// Blank out comments, keeping line numbers. Line-based: `/* … */` blocks,
// whole-line `//` comments, and a trailing ` // …` only when it sits outside
// a string (an even number of quotes before it).
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => {
      if (/^\s*\/\//.test(line)) return "";
      const m = /\s\/\/\s/.exec(line);
      if (!m) return line;
      const before = line.slice(0, m.index);
      const quotes = (before.match(/["'`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join("\n");
}

const RULES = [
  { name: "a shell", re: /\[?["'`]?\bshell["'`]?\]?\s*:(?!\s*false\b)/ },
  { name: "a shell (shorthand)", re: /[{,]\s*shell\s*[,}]/ },
  { name: "exec()", re: /(?<![\w.$])exec(Sync)?\s*\(/ },
  { name: "exec() on child_process", re: /\b(child_process|cp|childProcess|proc)\s*\.\s*exec(Sync)?\s*\(/ },
  // spawn("git", …), execFileSync('./claude', …): any string literal as the program.
  { name: "a literal program name", re: /\b(spawn|spawnSync|execFile|execFileSync|execFileSyncNoShell)\s*\(\s*(["'`])[^"'`]*\2/ },
  // A Windows system tool named as a call's first argument (run("schtasks", …) through a helper): use systemTool().
  { name: "a Windows tool by bare name", re: /(?<!systemTool)\(\s*(["'`])(schtasks|taskkill|attrib|where|cmd|powershell|pwsh|rundll32|reg|icacls|netsh|wmic|tasklist)(\.exe)?\1\s*,/i },
];
const CHILD_PROCESS = /(\bfrom\s*["'](node:)?child_process["'])|(\brequire\s*\(\s*["'](node:)?child_process["']\s*\))|(\bimport\s*\(\s*["'](node:)?child_process["']\s*\))/;

function findViolations(src, file) {
  const out = [];
  const text = stripComments(src);
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  for (const r of RULES) {
    const re = new RegExp(r.re.source, "g");
    for (const m of text.matchAll(re)) out.push(`${file}:${lineOf(m.index)}: ${r.name}: ${m[0].replace(/\s+/g, " ").trim()}`);
  }
  if (!MAY_IMPORT_CHILD_PROCESS.has(file.replace(/^runtime\/src\//, ""))) {
    const m = CHILD_PROCESS.exec(text);
    if (m) out.push(`${file}:${lineOf(m.index)}: child_process outside safe-spawn.mjs`);
  } else {
    // safe-spawn.mjs itself: one named import of spawn / execFileSync, nothing else.
    for (const m of text.matchAll(new RegExp(CHILD_PROCESS.source, "g"))) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
      if (!/^import\s*\{\s*(execFileSync|spawn)(\s*,\s*(execFileSync|spawn))?\s*\}\s*from\s*["']node:child_process["'];?\s*$/.test(line.trim())) {
        out.push(`${file}:${lineOf(m.index)}: child_process import other than { spawn, execFileSync }`);
      }
    }
  }
  return out;
}

test("the guard itself catches each dangerous shape and ignores comments", () => {
  const bad = [
    'spawn("claude", args, { shell: process.platform === "win32" })',
    "const child = spawn(cmd, args, { shell: isWin });",
    "spawn(cmd, args, { shell: true })",
    'spawn(cmd, args, { shell: "cmd.exe" })',
    "spawn(cmd, args, { cwd, shell })",
    "spawn(cmd, args, { shell, cwd })",
    "spawn(cmd, args, { shell:1 })",
    'exec(`qmd collection add "${cwd}"`)',
    "exec(cmd)",
    "cp.execSync(cmd)",
    "spawn('git', ['worktree', 'add'])",
    'spawn(\n  "git",\n  ["status"])',
    'execFileSync("git", ["-C", wt])',
    'spawn("./git", [])',
    'execFileSync("bin/claude", [])',
    "spawnSync(`claude`, [])",
    'const x = "a // b"; spawn("git", [])',
    'spawn(cmd, args, { "shell": true })',
    'spawn(cmd, args, { ["shell"]: true })',
  ];
  for (const b of bad) assert.ok(findViolations(b, "x.mjs").length > 0, b);
  for (const imp of ['import { exec, spawn } from "node:child_process";', 'const cp = require("child_process");', 'const { spawn } = await import("node:child_process");', 'import * as proc from "child_process";']) {
    assert.ok(findViolations(imp, "runtime/src/claude.mjs").length > 0, imp);
  }
  assert.deepEqual(findViolations('import { execFileSync, spawn } from "node:child_process";', "runtime/src/safe-spawn.mjs"), []);
  for (const imp of ['import { exec, spawn } from "node:child_process";', 'const cp = require("child_process"); cp.x(1);', 'import * as x from "node:child_process";']) {
    assert.ok(findViolations(imp, "runtime/src/safe-spawn.mjs").length > 0, `safe-spawn: ${imp}`);
  }
  const fine = [
    "// spawn(\"claude\", args, { shell: true })",
    "/* exec(cmd) */",
    "x(); // shell: true used to be here",
    "spawnResolved(resolveCommand(\"git\"), args, { cwd })",
    "spawn(git.cmd, [...git.prefix, ...args])",
    "spawn(process.execPath, [script])",
    "spawn(cmd, args, { shell: false })",
    "const m = re.exec(text);",
  ];
  for (const f of fine) assert.deepEqual(findViolations(f, "x.mjs"), [], f);
});

test("nowhere in runtime/src: no shell, no exec(), no literal program name (allowlist aside)", () => {
  const allow = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/spawn-allowlist.json", import.meta.url)), "utf8"));
  const srcDir = fileURLToPath(SRC);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(srcDir);
  const all = [];
  const used = new Set();
  for (const f of files) {
    const rel = relative(srcDir, f).replace(/\\/g, "/");
    for (const v of findViolations(readFileSync(f, "utf8"), `runtime/src/${rel}`).filter((v) => !/child_process/.test(v))) {
      const hit = allow.findIndex((a) => a.file === rel && v.includes(a.match));
      if (hit >= 0) used.add(hit);
      else all.push(v);
    }
  }
  assert.deepEqual(all, [], `\n${all.join("\n")}`);
  assert.deepEqual(allow.map((a, i) => (used.has(i) ? null : a.file)).filter(Boolean), [], "a stale allowlist entry");
  for (const a of allow) assert.ok(a.reason, `${a.file}: every allowlist entry says why`);
});

test("worker-path files start no shell and no bare program", () => {
  const all = [];
  for (const f of GUARDED) {
    const src = readFileSync(fileURLToPath(new URL(f, SRC)), "utf8");
    all.push(...findViolations(src, `runtime/src/${f}`));
  }
  assert.deepEqual(all, [], `\n${all.join("\n")}`);
});
