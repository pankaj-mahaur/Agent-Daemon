// Tests for runtime/src/safe-spawn.mjs and the worker path that uses it.
// Properties:
//   - a task with shell metacharacters reaches the Claude worker as data only
//     (stdin + a prompt file), never through a shell and never in argv;
//   - a program planted in the repo (git.exe, claude.exe) never runs: every
//     Windows child is started by absolute path;
//   - names that reach git refs and paths are checked first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkModel,
  checkName,
  resolveCommand,
  resolveGit,
  resolvedArgv,
  spawnResolved,
  systemTool,
  withPromptFile,
} from "../src/safe-spawn.mjs";
import { spawnAgent } from "../src/orchestration/spawn.mjs";
import { createSecretStore, dpapiBackend } from "../src/auth/secrets.mjs";

const isWin = process.platform === "win32";
const W = path.win32;

// A fake file system for the resolver: { "<abs path>": "<content>" }.
const fakeFs = (files) => {
  const byLower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p) => byLower.has(p.toLowerCase()),
    readFile: (p) => byLower.get(p.toLowerCase()) ?? "",
  };
};
const NODE = "C:\\node\\node.exe";
const winOpts = (env, files, extra = {}) => ({ env: { PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", ...env }, platform: "win32", fsx: fakeFs(files), execPath: NODE, ...extra });

const MODERN_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@scope\\pkg\\cli.js" %*',
  "",
].join("\r\n");

// ---------- resolver ----------

test("resolver: .exe beats .cmd in one folder, and PATH order holds across folders", () => {
  const files = { "C:\\a\\tool.cmd": "@echo off", "C:\\a\\tool.exe": "", "C:\\b\\tool.exe": "" };
  const r = resolveCommand("tool", winOpts({ PATH: "C:\\a;C:\\b" }, files));
  assert.equal(r.cmd, "C:\\a\\tool.exe");
  assert.equal(r.via, "exe");
  assert.deepEqual(r.prefix, []);
  const r2 = resolveCommand("tool", winOpts({ PATH: "C:\\b;C:\\a" }, files));
  assert.equal(r2.cmd, "C:\\b\\tool.exe");
});

test("resolver: an npm shim in the modern cmd-shim shape runs its script with our node", () => {
  const files = { "C:\\npm\\claude.cmd": "\uFEFF" + MODERN_SHIM, "C:\\npm\\node_modules\\@scope\\pkg\\cli.js": "" };
  const r = resolveCommand("claude", winOpts({ PATH: "C:\\npm" }, files));
  assert.equal(r.via, "npm-shim");
  assert.equal(r.cmd, NODE);
  assert.deepEqual(r.prefix, ["C:\\npm\\node_modules\\@scope\\pkg\\cli.js"]);
  assert.equal(r.file, "C:\\npm\\claude.cmd");
});

test("resolver: an older %~dp0 shim, an uppercase .CMD and a shim to an .exe work", () => {
  const old = '@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\x\\bin\\x.mjs" %*\n)';
  const files = { "C:\\o\\x.CMD": old, "C:\\o\\node_modules\\x\\bin\\x.mjs": "" };
  const r = resolveCommand("x", winOpts({ PATH: "C:\\o" }, files));
  assert.equal(r.cmd, NODE);
  assert.deepEqual(r.prefix, ["C:\\o\\node_modules\\x\\bin\\x.mjs"]);

  const exeShim = '@"%~dp0\\..\\vendor\\real.exe" %*';
  const files2 = { "C:\\s\\bin\\y.cmd": exeShim, "C:\\s\\vendor\\real.exe": "" };
  const r2 = resolveCommand("y", winOpts({ PATH: "C:\\s\\bin" }, files2));
  assert.equal(r2.cmd, "C:\\s\\vendor\\real.exe");
  assert.deepEqual(r2.prefix, []);
});

test("resolver: a .cmd that isn't an npm shim (or points at nothing) is unreadable, never cmd.exe", () => {
  const files = { "C:\\c\\code.cmd": '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*', "C:\\z\\z.cmd": "@echo off\r\necho hi" };
  // code.cmd names targets that don't exist here → unreadable.
  assert.deepEqual(resolveCommand("code", winOpts({ PATH: "C:\\c" }, files)), { cmd: null, via: "unreadable-shim", file: "C:\\c\\code.cmd" });
  assert.deepEqual(resolveCommand("z", winOpts({ PATH: "C:\\z" }, files)), { cmd: null, via: "unreadable-shim", file: "C:\\z\\z.cmd" });
});

test("resolver: mixed-case Path, quoted entries, and relative entries (the current folder) are skipped", () => {
  const files = { "C:\\q dir\\git.exe": "", "C:\\cwd\\git.exe": "", "git.exe": "", ".\\git.exe": "" };
  const r = resolveCommand("git", winOpts({ Path: '.;bin;;"C:\\q dir"' }, files));
  assert.equal(r.cmd, "C:\\q dir\\git.exe");
  // Only relative entries → nothing found, even though git.exe "exists" relatively.
  assert.deepEqual(resolveCommand("git", winOpts({ PATH: ".;bin" }, files)), { cmd: null, via: "missing" });
  // A drive-relative "C:bin" or a root-relative "\\bin" is not absolute either.
  assert.deepEqual(resolveCommand("git", winOpts({ PATH: "C:bin;\\bin" }, { "C:bin\\git.exe": "", "\\bin\\git.exe": "" })), { cmd: null, via: "missing" });
});

test("resolver: UNC PATH entries are used; PATHEXT order is followed and limited to .COM .EXE .BAT .CMD", () => {
  const files = { "\\\\srv\\share\\t.exe": "", "C:\\v\\t.vbs": "", "C:\\v\\t.js": "" };
  assert.equal(resolveCommand("t", winOpts({ PATH: "C:\\v;\\\\srv\\share" }, files)).cmd, "\\\\srv\\share\\t.exe");
  const order = { "C:\\p\\t.bat": "", "C:\\p\\t.exe": "" };
  assert.equal(resolveCommand("t", winOpts({ PATH: "C:\\p", PATHEXT: ".BAT;.EXE" }, order)).file, "C:\\p\\t.bat");
});

test("resolver: the override variable wins, must be absolute and existing, and a .js runs with our node", () => {
  const files = { "C:\\cc\\cli.js": "", "C:\\npm\\claude.exe": "" };
  const r = resolveCommand("claude", winOpts({ PATH: "C:\\npm", AD_CLAUDE_BIN: "C:\\cc\\cli.js" }, files, { overrideVar: "AD_CLAUDE_BIN" }));
  assert.equal(r.via, "env");
  assert.equal(r.cmd, NODE);
  assert.deepEqual(r.prefix, ["C:\\cc\\cli.js"]);
  assert.deepEqual(resolveCommand("claude", winOpts({ PATH: "C:\\npm", AD_CLAUDE_BIN: "cli.js" }, files, { overrideVar: "AD_CLAUDE_BIN" })), { cmd: null, via: "missing", file: "cli.js" });
  assert.deepEqual(resolveCommand("claude", winOpts({ PATH: "C:\\npm", AD_CLAUDE_BIN: "C:\\gone.exe" }, files, { overrideVar: "AD_CLAUDE_BIN" })), { cmd: null, via: "missing", file: "C:\\gone.exe" });
});

test("resolver: every Windows result is absolute; POSIX passes the name through to execvp", () => {
  const files = { "C:\\a\\tool.exe": "", "C:\\npm\\claude.cmd": MODERN_SHIM, "C:\\npm\\node_modules\\@scope\\pkg\\cli.js": "" };
  for (const n of ["tool", "claude"]) {
    const r = resolveCommand(n, winOpts({ PATH: "C:\\a;C:\\npm" }, files));
    assert.ok(W.isAbsolute(r.cmd) && /^([A-Za-z]:\\|\\\\)/.test(r.cmd), `${n} → ${r.cmd}`);
  }
  assert.deepEqual(resolveCommand("git", { env: { PATH: "/usr/bin" }, platform: "linux" }), { cmd: "git", prefix: [], via: "posix", file: "git" });
});

test("systemTool: Windows tools come from %SystemRoot%\\System32 and must exist; POSIX has none", () => {
  const files = { "C:\\Windows\\System32\\taskkill.exe": "", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": "" };
  const o = { env: { SystemRoot: "C:\\Windows" }, platform: "win32", fsx: fakeFs(files) };
  assert.equal(systemTool("taskkill.exe", o), "C:\\Windows\\System32\\taskkill.exe");
  assert.equal(systemTool("taskkill", o), "C:\\Windows\\System32\\taskkill.exe");
  assert.equal(systemTool("powershell.exe", o), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(systemTool("attrib.exe", o), null, "missing → null, never a bare name");
  assert.equal(systemTool("taskkill.exe", { ...o, env: { SYSTEMROOT: "C:\\Windows" } }), "C:\\Windows\\System32\\taskkill.exe");
  assert.equal(systemTool("taskkill.exe", { ...o, env: { SystemRoot: "Windows" } }), null, "relative SystemRoot → null");
  assert.equal(systemTool("taskkill.exe", { ...o, env: {} }), null);
  assert.equal(systemTool("taskkill.exe", { env: {}, platform: "linux" }), null);
});

test("spawnResolved refuses a shell, a missing command and (on Windows) a relative one", () => {
  assert.throws(() => spawnResolved({ cmd: process.execPath, prefix: [] }, ["-v"], { shell: true }), /shell/);
  assert.throws(() => spawnResolved({ cmd: null, via: "missing" }, []), /missing/);
  if (isWin) assert.throws(() => spawnResolved({ cmd: "node", prefix: [] }, ["-v"]), /absolute/);
});

// ---------- names ----------

test("checkName accepts team ids, template roles and agent names", () => {
  for (const ok of ["team-1760000000000-a1b2c3", "lead-reviewer", "coder-3f9a1c", "qa", "v1.2_x"]) assert.equal(checkName(ok, "role"), ok);
});

test("checkName rejects anything a shell, git or a path could read as more than a name", () => {
  const bad = ["dev&calc", "a|b", "x^y", "%PATH%", 'a"b', "a b", "a\nb", "../x", "x.lock", "x.", "-x", ".x", "a..b", "", "a".repeat(65), "a/b", "a\\b", "a:b", "$(id)", "a`b`"];
  for (const v of bad) assert.throws(() => checkName(v, "role"), /can only use letters, digits/, JSON.stringify(v));
  assert.throws(() => checkName(42, "role"), /can only use/);
  assert.throws(() => checkName("dev&calc", "role"), { message: 'role "dev&calc" can only use letters, digits, ".", "_" and "-" (max 64).' });
  // Long values are cut to 40 characters in the text.
  assert.throws(() => checkName("&".repeat(100), "teamId"), (e) => e.message.startsWith(`teamId "${"&".repeat(40)}" can only`));
});

test("checkModel accepts model ids and rejects shell text", () => {
  for (const ok of ["sonnet", "claude-sonnet-5-5", "openai/gpt-x:free", "anthropic/claude@2026", "a+b"]) assert.equal(checkModel(ok), ok);
  for (const v of ["", "a b", "x&y", "-m", "x;y", "a\nb", "a".repeat(129)]) assert.throws(() => checkModel(v), /isn't a model name ad can pass on/);
});

test("withPromptFile writes a private file and removes its folder, even when fn throws", async () => {
  let seen;
  const out = await withPromptFile("line1\nline2 & echo x", async (file) => {
    seen = file;
    assert.equal(readFileSync(file, "utf8"), "line1\nline2 & echo x");
    return 7;
  });
  assert.equal(out, 7);
  assert.equal(existsSync(path.dirname(seen)), false);
  await assert.rejects(withPromptFile("x", async (file) => { seen = file; throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(path.dirname(seen)), false);
});

// ---------- the Claude worker, end to end ----------

// A fake Claude Code: records argv, stdin and the system-prompt file's text.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const i = argv.indexOf("--append-system-prompt-file");
  const systemPrompt = i >= 0 ? fs.readFileSync(argv[i + 1], "utf8") : null;
  fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv, stdin, systemPrompt, promptFile: i >= 0 ? argv[i + 1] : null }));
  process.stdout.write(JSON.stringify({ result: "done" }));
});
`;

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

// A temp root with a home, a bin folder holding a fake claude (npm-shaped
// claude.cmd on Windows, an executable script elsewhere), and a marker path.
function fakeClaudeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ad-ss-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(bin, "node_modules", "fake-claude"), { recursive: true });
  const script = path.join(bin, "node_modules", "fake-claude", "cli.js");
  writeFileSync(script, FAKE_CLAUDE);
  if (isWin) {
    writeFileSync(path.join(bin, "claude.cmd"), MODERN_SHIM.replace("@scope\\pkg\\cli.js", "fake-claude\\cli.js"));
  } else {
    const sh = path.join(bin, "claude");
    writeFileSync(sh, `#!${process.execPath}\n${FAKE_CLAUDE}`);
    chmodSync(sh, 0o755);
  }
  return { root, home, bin, out: path.join(root, "out.json"), marker: path.join(root, "PWNED") };
}

const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";

const homeEnv = (r) => ({
  HOME: r.home,
  USERPROFILE: r.home,
  [PATH_KEY]: r.bin + path.delimiter + process.env[PATH_KEY],
  FAKE_OUT: r.out,
  AD_CLAUDE_BIN: undefined,
  AD_AGENT_ENGINE: undefined,
  AD_CODEX_HOME: undefined,
  AD_ENGINE_DIR: undefined,
  CODEX_HOME: undefined,
});

const winPayloads = (m) => [
  `fix it & echo PWNED>"${m}"`,
  `a | echo PWNED>"${m}"`,
  `^& echo PWNED>"${m}"`,
  `%COMSPEC% /c echo PWNED>"${m}"`,
  `say "hi" & echo PWNED>"${m}"`,
  `line1\r\nline2 & echo PWNED>"${m}"`,
];
const posixPayloads = (m) => [`$(touch ${m})`, `\`touch ${m}\``, `; touch ${m}`, `line1\nline2; touch ${m}`];

test("task text with shell metacharacters never runs, and reaches Claude only as data", async () => {
  const r = fakeClaudeRoot();
  try {
    await withEnv(homeEnv(r), async () => {
      for (const task of (isWin ? winPayloads : posixPayloads)(r.marker)) {
        rmSync(r.out, { force: true });
        const res = await spawnAgent({ engine: "claude", worktree: false, teamId: "t1", role: "coder", task, cwd: r.root, timeoutMs: 60_000 });
        assert.equal(res.ok, true, `${JSON.stringify(task)}: ${res.error}`);
        assert.equal(existsSync(r.marker), false, `marker created by ${JSON.stringify(task)}`);
        const seen = JSON.parse(readFileSync(r.out, "utf8"));
        assert.ok(seen.stdin.includes(task), "stdin holds the task byte for byte");
        assert.ok(seen.systemPrompt.includes(task), "the system prompt file holds the task byte for byte");
        assert.ok(!seen.argv.some((a) => a.includes("PWNED") || a.includes("touch")), `argv holds none of it: ${JSON.stringify(seen.argv)}`);
        assert.ok(!seen.argv.includes("--append-system-prompt"), "the inline system-prompt flag is gone");
        assert.equal(existsSync(path.dirname(seen.promptFile)), false, "the prompt folder is removed");
      }
    });
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("a missing claude fails before anything is registered or started", async () => {
  const r = fakeClaudeRoot();
  try {
    await withEnv({ ...homeEnv(r), [PATH_KEY]: path.join(r.root, "empty"), AD_CLAUDE_BIN: path.join(r.root, "nope.exe") }, async () => {
      const res = await spawnAgent({ engine: "claude", worktree: false, teamId: "t1", role: "coder", task: "x", cwd: r.root });
      assert.equal(res.ok, false);
      assert.match(res.error, /claude isn't on PATH\. Install Claude Code, or set AD_CLAUDE_BIN to its path\./);
      assert.equal(existsSync(path.join(r.home, ".agent-daemon", "teams", "t1", "agents.json")), false);
    });
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("an unwritable temp folder fails the spawn and frees the agent slot", async () => {
  const r = fakeClaudeRoot();
  const gone = path.join(r.root, "no-such-temp");
  try {
    await withEnv({ ...homeEnv(r), TEMP: gone, TMP: gone, TMPDIR: gone }, async () => {
      const { getActiveAgentCount } = await import("../src/orchestration/spawn.mjs");
      const before = getActiveAgentCount();
      const res = await spawnAgent({ engine: "claude", worktree: false, teamId: "t1", role: "coder", agentName: "slot1", task: "x", cwd: r.root });
      assert.equal(res.ok, false);
      assert.match(res.error, /spawn failed/);
      assert.equal(getActiveAgentCount(), before, "the slot is freed");
      const agents = JSON.parse(readFileSync(path.join(r.home, ".agent-daemon", "teams", "t1", "agents.json"), "utf8"));
      assert.equal(agents.find((a) => a.name === "slot1").status, "error");
    });
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("a role with metacharacters never reaches git or the team registry", async () => {
  const r = fakeClaudeRoot();
  const repo = path.join(r.root, "repo");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    await withEnv(homeEnv(r), async () => {
      for (const role of [`dev&echo PWNED>"${r.marker}"`, "dev$(touch x)", "a b"]) {
        await assert.rejects(spawnAgent({ engine: "ad", teamId: "t1", role, task: "x", cwd: repo, runWorker: async () => ({ ok: true }) }), /can only use letters, digits/);
        // With an explicit agent name the role is checked on its own.
        await assert.rejects(spawnAgent({ engine: "ad", teamId: "t1", role, agentName: "w1", task: "x", cwd: repo, runWorker: async () => ({ ok: true }) }), /^Error: role .* can only use letters, digits/);
      }
      await assert.rejects(spawnAgent({ engine: "ad", teamId: "t1&x", role: "dev", task: "x", cwd: repo }), /teamId .* can only use/);
      await assert.rejects(spawnAgent({ engine: "ad", teamId: "t1", role: "dev", agentName: "w|x", task: "x", cwd: repo }), /agentName .* can only use/);
      await assert.rejects(spawnAgent({ engine: "ad", teamId: "t1", role: "dev", model: "x & y", task: "x", cwd: repo }), /isn't a model name/);
    });
    assert.equal(existsSync(r.marker), false);
    assert.equal(git("branch", "--list", "team/*"), "");
    assert.equal(existsSync(path.join(r.home, ".agent-daemon", "teams", "t1", "agents.json")), false);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("the worktree path carries no quote characters, and the worker's work is committed", async () => {
  const r = fakeClaudeRoot();
  const repo = path.join(r.root, "repo");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "init");
    await withEnv(homeEnv(r), async () => {
      const res = await spawnAgent({
        engine: "ad", teamId: "t1", role: "dev", agentName: "w1", task: "add a file", cwd: repo,
        runWorker: async ({ worktreePath }) => { writeFileSync(path.join(worktreePath, "new.txt"), "hi"); return { ok: true, output: "ok" }; },
      });
      assert.equal(res.ok, true, res.error);
      assert.match(res.commit, /^[0-9a-f]{40}$/);
    });
    const list = git("worktree", "list", "--porcelain");
    assert.ok(list.includes("team-t1-w1"), list);
    assert.ok(!/worktree .*"/.test(list), `no quotes in the worktree path: ${list}`);
    assert.match(git("rev-parse", "--verify", "refs/heads/team/t1/w1"), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

// The lookup this test guards against: with NoDefaultCurrentDirectoryInExePath
// unset (the normal user setup), Windows runs a bare "git" from the child's
// working folder (the parent's, when no cwd is given) before PATH. The test
// deletes the variable in its own process, so it proves the fix rather than a
// CI setting.
test("a binary planted in the repo never runs", { skip: !isWin && "Windows-only lookup" }, async () => {
  const r = fakeClaudeRoot();
  const repo = path.join(r.root, "repo");
  mkdirSync(repo);
  // The test's own git calls go by full path too: with the lookup enabled a
  // bare "git" here would run the planted copy.
  const gitExe = resolveGit();
  const realGit = (...a) => execFileSync(...resolvedArgv(gitExe, a), { cwd: repo, encoding: "utf8" }).trim();
  const probe = path.join(r.root, "probe.cjs");
  writeFileSync(probe, `
const path = require("node:path");
if (path.dirname(process.execPath).toLowerCase() === ${JSON.stringify(repo.toLowerCase())}) {
  require("node:fs").writeFileSync(${JSON.stringify(r.marker)}, process.execPath);
}
`);
  const before = process.cwd();
  try {
    realGit("init", "-q");
    realGit("config", "user.email", "t@t");
    realGit("config", "user.name", "t");
    realGit("commit", "-q", "--allow-empty", "-m", "init");
    copyFileSync(process.execPath, path.join(repo, "git.exe"));
    copyFileSync(process.execPath, path.join(repo, "claude.exe"));
    copyFileSync(process.execPath, path.join(repo, "powershell.exe"));
    process.chdir(repo); // a child started without a cwd is looked up here
    await withEnv({ ...homeEnv(r), NoDefaultCurrentDirectoryInExePath: undefined, NODE_OPTIONS: `--require "${probe.replace(/\\/g, "/")}"` }, async () => {
      const res = await spawnAgent({
        engine: "ad", teamId: "t1", role: "dev", agentName: "p1", task: "x", cwd: repo,
        runWorker: async ({ worktreePath }) => { writeFileSync(path.join(worktreePath, "w.txt"), "w"); return { ok: true }; },
      });
      assert.equal(res.ok, true, res.error);
      const res2 = await spawnAgent({ engine: "claude", worktree: false, teamId: "t1", role: "dev", agentName: "p2", task: "x", cwd: repo, timeoutMs: 60_000 });
      assert.equal(res2.ok, true, res2.error);
      // The DPAPI store hands secret values to powershell.exe on stdin.
      const store = createSecretStore(dpapiBackend(path.join(r.root, "secrets")));
      store.set("probe", "not-a-real-secret-value");
      assert.equal(store.get("probe"), "not-a-real-secret-value");
    });
    assert.equal(existsSync(r.marker), false, "a planted binary ran");
    assert.match(realGit("rev-parse", "--verify", "refs/heads/team/t1/p1"), /^[0-9a-f]{40}$/, "the real git made the branch");
  } finally {
    process.chdir(before);
    rmSync(r.root, { recursive: true, force: true, maxRetries: 3 });
  }
});
