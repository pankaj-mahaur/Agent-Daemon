// `ad tui` helpers (tui/main.mjs) and `ad codex` (harness/codex-ui.mjs), plan Part 6.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookRows, meters, preflight, sinceLastTime, splitArgs, splitUnifiedDiff } from "../src/tui/main.mjs";
import { codexArgs, MIRROR_MARKER, MIRRORED_FLAG, runStockCodex, syncSkills } from "../src/harness/codex-ui.mjs";
import { skillRoots } from "../src/harness/setup.mjs";

const tty = { isTTY: true };

test("preflight: TTY, TERM=dumb, Node on Windows, mintty", () => {
  assert.equal(preflight({ stdin: tty, stdout: tty, platform: "linux", version: "22.1.0", env: {} }), null);
  assert.match(preflight({ stdin: {}, stdout: tty, platform: "linux", version: "22.1.0", env: {} }), /interactive terminal/);
  assert.match(preflight({ stdin: tty, stdout: tty, platform: "linux", version: "22.1.0", env: { TERM: "dumb" } }), /TERM=dumb/);
  assert.match(preflight({ stdin: tty, stdout: tty, platform: "win32", version: "22.14.0", env: {} }), /22\.17\+/);
  assert.equal(preflight({ stdin: tty, stdout: tty, platform: "win32", version: "22.17.0", env: {} }), null);
  assert.equal(preflight({ stdin: tty, stdout: tty, platform: "win32", version: "24.2.0", env: {} }), null);
  assert.match(preflight({ stdin: tty, stdout: tty, platform: "win32", version: "24.2.0", env: { TERM_PROGRAM: "mintty" } }), /winpty/);
});

test("splitArgs keeps quoted words together", () => {
  assert.deepEqual(splitArgs(`memory search "fake timers" --limit 3`), ["memory", "search", "fake timers", "--limit", "3"]);
  assert.deepEqual(splitArgs(""), []);
});

test("splitUnifiedDiff: one change per file, new and deleted files marked", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
  ].join("\n");
  const out = splitUnifiedDiff(diff);
  assert.deepEqual(out.map((c) => [c.path, c.kind]), [["src/a.ts", "update"], ["new.txt", "add"], ["old.txt", "delete"]]);
  assert.match(out[0].diff, /^@@ -1 \+1 @@\n-x\n\+y/);
});

test("hookRows: only ad's own hooks; recalled memory, guard blocks, failures", () => {
  const hooksFile = path.join(tmpdir(), "ad-home", "hooks.json");
  const run = (o) => ({ phase: "completed", sourcePath: hooksFile, event: "UserPromptSubmit", status: "completed", entries: [], ...o });
  assert.deepEqual(hookRows(run({ entries: [{ kind: "context", text: "## Learnings\n- a\n- b\n- c" }] }), { hooksFile }), [{ kind: "recalled", text: "3 learnings" }]);
  assert.deepEqual(hookRows(run({ event: "PreToolUse", status: "blocked", entries: [{ kind: "feedback", text: "rm -rf / is blocked\nmore" }] }), { hooksFile }), [{ kind: "guard", text: "rm -rf / is blocked" }]);
  assert.deepEqual(hookRows(run({ status: "failed", entries: [{ kind: "error", text: "boom" }] }), { hooksFile }), [{ kind: "hook", text: "UserPromptSubmit hook failed: boom" }]);
  assert.deepEqual(hookRows(run({ sourcePath: path.join(tmpdir(), "repo", ".codex", "hooks.json"), entries: [{ kind: "context", text: "- x" }] }), { hooksFile }), [], "a repo's hooks are not ad's");
  assert.deepEqual(hookRows({ ...run({}), phase: "started" }, { hooksFile }), []);
  // Escapes in hook output never reach the row.
  assert.ok(!/\x1b/.test(hookRows(run({ status: "blocked", entries: [{ kind: "feedback", text: "\x1b[2Jno" }] }), { hooksFile })[0].text));
});

test("meters: context left and the usage window, amber from 80 % used", () => {
  assert.deepEqual(meters({ tokens: { last: { total: 85_000 }, contextWindow: 100_000 }, rateLimits: { primary: { usedPercent: 38.4, windowDurationMins: 300 } } }), [
    { text: "ctx 15%", warn: true },
    { text: "5h 38%", warn: false },
  ]);
  assert.deepEqual(meters({}), []);
});

test("sinceLastTime: proposals waiting and loops newer than the last visit", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ad-since-"));
  try {
    mkdirSync(path.join(cwd, ".agent-daemon", "proposed"), { recursive: true });
    writeFileSync(path.join(cwd, ".agent-daemon", "proposed", "a.md"), "x");
    mkdirSync(path.join(cwd, ".agent-daemon", "loops"), { recursive: true });
    writeFileSync(path.join(cwd, ".agent-daemon", "loops", "t1.jsonl"), JSON.stringify({ ts: new Date().toISOString(), turnStatus: "completed", status: { progress: "docs green" } }) + "\n");
    const parts = await sinceLastTime({ cwd, since: Date.now() - 60_000, home: path.join(cwd, "no-home") });
    assert.ok(parts.some((p) => /loop ran \(1 iter\): docs green/.test(p)), parts.join(" | "));
    assert.ok(parts.some((p) => /1 skill proposal to review/.test(p)));
    const later = await sinceLastTime({ cwd, since: Date.now() + 60_000, home: path.join(cwd, "no-home") });
    assert.ok(!later.some((p) => p.startsWith("loop")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* ad codex                                                            */
/* ------------------------------------------------------------------ */

test("codexArgs: always --no-daemon; resume a thread; -C the folder", () => {
  assert.deepEqual(codexArgs({ args: ["-m", "o3"] }), ["-m", "o3", "--no-daemon"]);
  assert.deepEqual(codexArgs({ threadId: "t1", cwd: "/p" }), ["resume", "t1", "--no-daemon", "-C", "/p"]);
  assert.deepEqual(codexArgs({ args: ["--no-daemon", "-C", "/x"], cwd: "/p" }), ["--no-daemon", "-C", "/x"]);
});

test("syncSkills mirrors ~/.claude/skills, never touches the user's own folders, removes stale mirrors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ad-skills-"));
  const from = path.join(root, "claude-skills");
  const home = path.join(root, "home");
  try {
    for (const n of ["alpha", "beta"]) {
      mkdirSync(path.join(from, n), { recursive: true });
      writeFileSync(path.join(from, n, "SKILL.md"), `# ${n}`);
    }
    mkdirSync(path.join(from, "not-a-skill"), { recursive: true });
    mkdirSync(path.join(home, "skills", "mine"), { recursive: true });
    writeFileSync(path.join(home, "skills", "mine", "SKILL.md"), "user's own");
    mkdirSync(path.join(home, "skills", "beta"), { recursive: true });
    writeFileSync(path.join(home, "skills", "beta", "SKILL.md"), "user's beta");
    assert.deepEqual(syncSkills({ home, from }), { copied: 1, removed: 0 });
    assert.equal(readFileSync(path.join(home, "skills", "alpha", "SKILL.md"), "utf8"), "# alpha");
    assert.ok(existsSync(path.join(home, "skills", "alpha", MIRROR_MARKER)));
    assert.equal(readFileSync(path.join(home, "skills", "beta", "SKILL.md"), "utf8"), "user's beta", "the user's own folder stays");
    assert.ok(!existsSync(path.join(home, "skills", "not-a-skill")));
    assert.deepEqual(syncSkills({ home, from }), { copied: 0, removed: 0 }, "unchanged: nothing copied");
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(from, "alpha", "SKILL.md"), future, future);
    writeFileSync(path.join(from, "alpha", "SKILL.md"), "# alpha v2");
    utimesSync(path.join(from, "alpha", "SKILL.md"), future, future);
    assert.equal(syncSkills({ home, from }).copied, 1);
    assert.equal(readFileSync(path.join(home, "skills", "alpha", "SKILL.md"), "utf8"), "# alpha v2");
    rmSync(path.join(from, "alpha"), { recursive: true });
    assert.deepEqual(syncSkills({ home, from }), { copied: 0, removed: 1 });
    assert.ok(existsSync(path.join(home, "skills", "mine")));
    // Once mirrored, the engine stops passing ~/.claude/skills as an extra root.
    assert.ok(existsSync(path.join(home, "skills", MIRRORED_FLAG)));
    const fakeHome = path.join(root, "user");
    mkdirSync(path.join(fakeHome, ".claude", "skills"), { recursive: true });
    assert.equal(skillRoots({ home: fakeHome }).length, 1);
    assert.equal(skillRoots({ home: fakeHome, engineHome: home }).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStockCodex: pinned binary, isolated CODEX_HOME, no CODEX_* leaks, provider keys from ad's store", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ad-stock-"));
  try {
    let seen = null;
    const spawnFn = (cmd, args, opts) => {
      seen = { cmd, args, opts };
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    };
    const home = path.join(root, "home");
    const code = await runStockCodex({
      threadId: "t9",
      cwd: root,
      home,
      env: { ...process.env, CODEX_HOME: path.join(root, "evil"), CODEX_SQLITE_HOME: "x", AD_CODEX_BIN: undefined },
      store: { get: (k) => (k === "openrouter" ? "sk-or-test" : null) },
      spawnFn,
      skillsFrom: path.join(root, "none"),
    });
    assert.equal(code, 0);
    assert.equal(seen.opts.env.CODEX_HOME, path.resolve(home));
    assert.equal(seen.opts.env.CODEX_SQLITE_HOME, undefined);
    assert.deepEqual(seen.args.slice(-5), ["resume", "t9", "--no-daemon", "-C", root]);
    assert.equal(seen.opts.stdio, "inherit");
    assert.ok(Object.values(seen.opts.env).includes("sk-or-test"), "the provider key from ad's store reaches the stock UI");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sinceLastTime never passes a loop log's escapes through (a cloned repo can ship one)", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ad-since-evil-"));
  try {
    mkdirSync(path.join(cwd, ".agent-daemon", "loops"), { recursive: true });
    const OSC52 = "\x1b]52;c;cm0gLXJmIC8=\x07";
    writeFileSync(path.join(cwd, ".agent-daemon", "loops", "t.jsonl"), JSON.stringify({ ts: new Date(Date.now() + 86_400_000).toISOString(), turnStatus: "x\ny", status: { progress: `ok${OSC52}\nline2` } }) + "\n");
    const parts = await sinceLastTime({ cwd, since: Date.now(), home: path.join(cwd, "no-home") });
    const all = parts.join(" ");
    assert.ok(!/[\x00-\x1f\x7f]/.test(all), JSON.stringify(all));
    assert.match(all, /ok line2/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("syncSkills follows a linked skill folder; setup refreshes the mirror on every engine start", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "ad-skills-link-"));
  try {
    const real = path.join(root, "elsewhere", "linked");
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, "SKILL.md"), "# linked");
    const from = path.join(root, "claude-skills");
    mkdirSync(from);
    symlinkSync(real, path.join(from, "linked"), "junction");
    const home = path.join(root, "home");
    assert.equal(syncSkills({ home, from }).copied, 1);
    assert.equal(readFileSync(path.join(home, "skills", "linked", "SKILL.md"), "utf8"), "# linked");
    // A skill added later reaches the mirror through skillRoots' refresh (setup runs it on every start).
    const user = path.join(root, "user");
    mkdirSync(path.join(user, ".claude", "skills", "fresh"), { recursive: true });
    writeFileSync(path.join(user, ".claude", "skills", "fresh", "SKILL.md"), "# fresh");
    assert.deepEqual(skillRoots({ home: user, engineHome: home, refresh: syncSkills }), []);
    assert.ok(existsSync(path.join(home, "skills", "fresh", "SKILL.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare ad: the TUI by default where it can run (AD_TUI=0: help), else a reason and the help", async () => {
  const { bareAdChoice, chatHintOnce, TUI_IS_DEFAULT } = await import("../src/tui/flip.mjs");
  const tty = { isTTY: true };
  const ok = { stdin: tty, stdout: tty, platform: "linux", version: "22.17.0" };
  assert.equal(TUI_IS_DEFAULT, true, "flipped after FC3");
  assert.deepEqual(bareAdChoice({ ...ok, env: {}, isDefault: false }), { tui: false });
  assert.deepEqual(bareAdChoice({ ...ok, env: { AD_TUI: "1" }, isDefault: false }), { tui: true });
  assert.deepEqual(bareAdChoice({ ...ok, env: {}, isDefault: true }), { tui: true });
  assert.deepEqual(bareAdChoice({ ...ok, env: { AD_TUI: "0" }, isDefault: true }), { tui: false });
  assert.match(bareAdChoice({ ...ok, stdout: {}, env: {}, isDefault: true }).reason, /interactive terminal/);
  assert.match(bareAdChoice({ ...ok, env: { TERM: "dumb" }, isDefault: true }).reason, /TERM=dumb/);
  const dir = mkdtempSync(path.join(tmpdir(), "ad-hint-"));
  try {
    const file = path.join(dir, "hint");
    assert.equal(chatHintOnce({ isDefault: false, file }), null);
    assert.match(chatHintOnce({ isDefault: true, file }), /`ad` alone now opens the terminal UI/);
    assert.equal(chatHintOnce({ isDefault: true, file }), null, "only once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the launcher routes tui before the full CLI and passes everything else through", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env }, input: "" });
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+/);
  const t = run(["tui"]);
  assert.equal(t.status, 2);
  assert.match(t.stderr, /interactive terminal/);
  const bare = run([], { AD_TUI: "1" });
  assert.match(bare.stderr, /interactive terminal/, "the reason first");
  assert.match(bare.stdout, /Usage:/, "then the help");
  const def = run([]);
  assert.match(def.stderr, /interactive terminal/, "the TUI is the default: why it can't run here");
  assert.match(def.stdout, /Usage:/);
  // `ad --last` when the TUI can't open: what to do instead, never "unknown command".
  const lastOff = run(["--last"], { AD_TUI: "0" });
  assert.equal(lastOff.status, 2);
  assert.match(lastOff.stderr, /`ad tui --last` reopens the last conversation/);
  assert.doesNotMatch(lastOff.stderr + lastOff.stdout, /unknown command/);
  const lastHere = run(["--last"]);
  assert.equal(lastHere.status, 2);
  assert.match(lastHere.stderr, /interactive terminal[\s\S]*use `ad chat` and \/resume/);
  const off = run([], { AD_TUI: "0" });
  assert.equal(off.stderr, "", "AD_TUI=0: just the help");
  assert.match(off.stdout, /Usage:/);
  assert.match(run(["tui", "--help"]).stdout, /Usage: ad tui/);
  // A mistyped flag isn't silently sent as the first prompt (losing --sandbox read-only).
  const typo = run(["tui", "--sandbx", "read-only", "fix", "it"]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /Unknown option '--sandbx'/);
  const bad = run(["tui", "--sandbox", "readonly"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--sandbox must be one of read-only/);
});
