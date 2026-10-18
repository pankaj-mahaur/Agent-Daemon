// Tests for runtime/src/memory/scope.mjs: which project a memory server (or
// hook) is bound to. Order: an explicit project, then a working folder that
// looks like a project (git or .agent-daemon), else unbound. Home, roots,
// system folders, ad's own folders and the package folder are never valid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { neverValid, resolveMemoryScope } from "../src/memory/scope.mjs";
import { adPackageRoot } from "../src/ad-root.mjs";
import { projectSlug } from "../src/memory/episodic.mjs";

const isWin = process.platform === "win32";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ad-scope-"));
  const home = path.join(root, "home");
  const mk = (...p) => { const d = path.join(...p); mkdirSync(d, { recursive: true }); return d; };
  const repoA = mk(home, "work", "a");
  mk(repoA, ".git");
  const sub = mk(repoA, "packages", "x");
  const repoB = mk(home, "work", "b");
  mk(repoB, ".git");
  const wt = mk(home, "work", "wt");
  writeFileSync(path.join(wt, ".git"), "gitdir: ../a/.git/worktrees/wt\n");
  const marked = mk(home, "notes");
  mk(marked, ".agent-daemon");
  const plain = mk(home, "Downloads", "app-install");
  const adRootDir = mk(root, "adroot");
  const insideAdRoot = mk(adRootDir, "worktrees", "team-t1-w1");
  mk(insideAdRoot, ".git");
  const env = { HOME: home, USERPROFILE: home, AD_ROOT: adRootDir };
  return { root, home, repoA, sub, repoB, wt, marked, plain, adRootDir, insideAdRoot, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const opts = (f, extra = {}) => ({ env: f.env, home: f.home, platform: process.platform, ...extra });

test("order: --project, then AD_MEMORY_PROJECT, then CLAUDE_PROJECT_DIR (Claude Code only), then a project-like cwd", () => {
  const f = fixture();
  try {
    const env = { ...f.env, AD_MEMORY_PROJECT: f.repoB, CLAUDE_PROJECT_DIR: f.marked };
    let s = resolveMemoryScope(opts(f, { project: f.repoA, env, cwd: f.wt, host: "claude-code" }));
    assert.deepEqual([s.kind, s.source, s.dir], ["project", "arg", f.repoA]);
    s = resolveMemoryScope(opts(f, { env, cwd: f.wt, host: "claude-code" }));
    assert.deepEqual([s.kind, s.source, s.dir], ["project", "env:AD_MEMORY_PROJECT", f.repoB]);
    s = resolveMemoryScope(opts(f, { env: { ...f.env, CLAUDE_PROJECT_DIR: f.marked }, cwd: f.wt, host: "claude-code" }));
    assert.deepEqual([s.kind, s.source, s.dir], ["project", "env:CLAUDE_PROJECT_DIR", f.marked]);
    s = resolveMemoryScope(opts(f, { env: f.env, cwd: f.wt }));
    assert.deepEqual([s.kind, s.source, s.dir], ["project", "cwd", f.wt]);
    assert.deepEqual(s.keys, [projectSlug(f.wt)]);
  } finally { f.cleanup(); }
});

test("CLAUDE_PROJECT_DIR is ignored for other hosts (inherited from a Claude Code shell)", () => {
  const f = fixture();
  try {
    const s = resolveMemoryScope(opts(f, { env: { ...f.env, CLAUDE_PROJECT_DIR: f.repoA }, cwd: f.plain }));
    assert.equal(s.kind, "unbound");
    const s2 = resolveMemoryScope(opts(f, { env: { ...f.env, CLAUDE_PROJECT_DIR: f.repoA }, cwd: f.repoB, host: "ad" }));
    assert.deepEqual([s2.source, s2.dir], ["cwd", f.repoB]);
  } finally { f.cleanup(); }
});

test("an invalid explicit value is skipped to the next source, with a note", () => {
  const f = fixture();
  try {
    const notes = [];
    const s = resolveMemoryScope(opts(f, { project: f.home, env: { ...f.env, AD_MEMORY_PROJECT: "relative/dir" }, cwd: f.repoA, note: (n) => notes.push(n) }));
    assert.deepEqual([s.kind, s.source, s.dir], ["project", "cwd", f.repoA]);
    assert.equal(notes.length, 2, notes.join("\n"));
    const missing = resolveMemoryScope(opts(f, { project: path.join(f.home, "nope"), cwd: f.plain, note: () => {} }));
    assert.equal(missing.kind, "unbound");
  } finally { f.cleanup(); }
});

test("a cwd with no .git and no .agent-daemon is unbound; subfolders of a repo bind", () => {
  const f = fixture();
  try {
    assert.equal(resolveMemoryScope(opts(f, { cwd: f.plain })).kind, "unbound");
    assert.deepEqual(resolveMemoryScope(opts(f, { cwd: f.plain })).keys, []);
    const s = resolveMemoryScope(opts(f, { cwd: f.sub }));
    assert.deepEqual([s.kind, s.dir], ["project", f.sub]);
    assert.equal(resolveMemoryScope(opts(f, { cwd: f.marked })).kind, "project");
    assert.equal(resolveMemoryScope(opts(f, {})).kind, "unbound", "no cwd at all");
  } finally { f.cleanup(); }
});

test("a git repo at the home folder doesn't make a home subfolder a project", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.home, ".git"));
    assert.equal(resolveMemoryScope(opts(f, { cwd: f.plain })).kind, "unbound");
    assert.equal(resolveMemoryScope(opts(f, { cwd: f.home })).kind, "unbound");
    assert.equal(resolveMemoryScope(opts(f, { cwd: f.repoA })).kind, "project");
  } finally { f.cleanup(); }
});

test("never valid: home, a root, a folder inside ad's root, the package folder, system folders", () => {
  const f = fixture();
  try {
    const o = { env: f.env, home: f.home, platform: process.platform };
    assert.ok(neverValid(f.home, o));
    assert.ok(neverValid(path.parse(f.home).root, o));
    assert.ok(neverValid(f.adRootDir, o));
    assert.ok(neverValid(f.insideAdRoot, o), "a worker worktree inside ad's root");
    assert.ok(neverValid(adPackageRoot(), o));
    assert.ok(neverValid(path.join(adPackageRoot(), "src"), o));
    assert.equal(neverValid(f.repoA, o), null);
    // Even with a .git inside, a folder in ad's root never binds.
    assert.equal(resolveMemoryScope(opts(f, { cwd: f.insideAdRoot })).kind, "unbound");
    assert.equal(resolveMemoryScope(opts(f, { project: f.insideAdRoot, cwd: f.plain, note: () => {} })).kind, "unbound");
    // The HOME-based legacy root counts as ad's too.
    const legacyHome = path.join(f.root, "msys-home");
    mkdirSync(path.join(legacyHome, ".agent-daemon", "x"), { recursive: true });
    assert.ok(neverValid(path.join(legacyHome, ".agent-daemon", "x"), { ...o, env: { ...f.env, HOME: legacyHome } }));
  } finally { f.cleanup(); }
});

test("system folders never bind, with or without .git inside", { skip: false }, () => {
  if (isWin) {
    const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u", HOME: "C:\\Users\\u" };
    const o = { env, home: "C:\\Users\\u", platform: "win32" };
    for (const d of ["C:\\Windows\\System32", "c:\\windows\\system32\\drivers", "C:\\Program Files\\Git", "C:\\Program Files (x86)\\x", "C:\\ProgramData\\y", "C:\\Users\\u\\AppData\\Local\\Programs\\cursor"]) assert.ok(neverValid(d, o), d);
    assert.equal(neverValid("C:\\Users\\u\\work\\app", o), null);
    assert.equal(neverValid("D:\\Program Files\\work\\app", o), null, "only the real %ProgramFiles%");
  } else {
    const o = { env: { HOME: "/home/u" }, home: "/home/u", platform: process.platform };
    for (const d of ["/usr/lib", "/usr", "/etc/x", "/opt/homebrew/y", "/bin"]) assert.ok(neverValid(d, o), d);
    assert.equal(neverValid("/home/u/work/app", o), null);
  }
});

test("a link (junction) into ad's own folder or home never binds", () => {
  const f = fixture();
  try {
    const link = path.join(f.root, "elsewhere", "looks-normal");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(f.insideAdRoot, link, "junction");
    assert.ok(neverValid(link, { env: f.env, home: f.home, platform: process.platform }), "the real path is inside ad's root");
    const homeLink = path.join(f.root, "elsewhere", "home-link");
    symlinkSync(f.home, homeLink, "junction");
    assert.equal(neverValid(homeLink, { env: f.env, home: f.home, platform: process.platform }), "the home folder");
  } finally { f.cleanup(); }
});

test("a collision withholds the project", () => {
  const f = fixture();
  try {
    const s = resolveMemoryScope(opts(f, { cwd: f.repoA, collides: (key, dir) => key === projectSlug(f.repoA) && dir === f.repoA }));
    assert.equal(s.kind, "collision");
    assert.deepEqual(s.keys, []);
  } finally { f.cleanup(); }
});
