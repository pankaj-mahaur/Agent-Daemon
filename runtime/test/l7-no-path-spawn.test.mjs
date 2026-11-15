// L7 P2a (D12b, v11): nothing the tool.before hook or ad's background jobs load may start a
// program found through PATH, or through a shell. A planted `tmux` or `git` earlier on the
// agent's PATH would otherwise run inside the hook, outside the host's sandbox. The check is
// static, over each import graph: no PATH-resolving helper is called, no shell is used, every
// program named as a string is an absolute path, and only the modules listed here (each with
// the way it picks its program) import child_process at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f) => path.relative(RUNTIME, f).split(path.sep).join("/");

/** Every runtime module a start file reaches through relative imports (static and literal dynamic). */
function graph(starts) {
  const seen = new Set();
  const queue = starts.map((s) => path.join(RUNTIME, s));
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    assert.ok(fs.existsSync(f), `${rel(f)} exists`);
    seen.add(f);
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec?.startsWith(".")) queue.push(path.resolve(path.dirname(f), spec));
    }
  }
  return [...seen].map(rel).sort();
}

// The tool.before path: the modules bin/hook.mjs loads for it (its other events load theirs
// only on their own branches), and the launcher's guard copy entry.
const TOOL_BEFORE = ["src/hooks/io.mjs", "src/hooks/hook-log.mjs", "src/hooks/routes.mjs", "src/hooks/host-capabilities.mjs", "src/hooks/tool-before.mjs", "src/hooks/guards.mjs", "src/hooks/self-protect.mjs", "src/memory/launch/run.mjs"];
const JOBS = ["src/memory/guards-refresh-job.mjs", "src/memory/migrate-job.mjs", "src/memory/recall-context-job.mjs"];

// Modules in these graphs that may import child_process, and how each picks its program.
const SPAWNERS = {
  "src/hooks/tmux-sessions.mjs": "tmux only from TRUSTED_TMUX (absolute, root-owned file and folder)",
  "src/hooks/detached.mjs": "process.execPath",
  "src/memory/ancestry.mjs": "/bin/ps, or Windows PowerShell by absolute path under the loader's Windows folder",
  "src/memory/dialog-code.mjs": "/usr/bin/osascript, /usr/bin/zenity, or Windows PowerShell by absolute path",
  "src/process-identity.mjs": "/bin/ps, or systemTool() (absolute, under SystemRoot)",
  "src/safe-spawn.mjs": "its PATH-resolving helpers are never called from these graphs (checked below)",
};
const PATH_LOOKUPS = /\b(?:resolveCommand|resolveClaude|resolveGit|editorInvocation)\s*\(/;
// Calls that start a program, with a string as the program: child_process's own (also as a
// namespace's method: cp.spawnSync), ad's no-shell wrappers, and local aliases of them.
const SPAWN_CALL = /(?:(?<![.\w$])(?:\w+\.)?(?:spawn|spawnSync|execFile|execFileSync|fork)|(?<![.\w$])(?:execFileSyncNoShell|spawnFn|nodeSpawn|run|runFile))\(\s*(["'`])([^"'`]*)\1/g;
// Absolute programs that find what they run on PATH themselves.
// Loads the check can't follow, each known and pinned: what loads must stay exactly this.
const KNOWN_LOADS = {
  // node:crypto, when process.getBuiltinModule is missing (Node before 22.3)
  "src/hooks/tool-before.mjs": /^(?![\s\S]*\bimport\(\s*[^"'\s)])(?![\s\S]*process\.binding)(?:(?!createRequire)[\s\S])*createRequire\b[^\n]*\n(?:(?!createRequire)[\s\S])*createRequire\(import\.meta\.url\)\("node:crypto"\)(?:(?!createRequire)[\s\S])*$/,
  // the folders node would search for better-sqlite3 (a list of paths; nothing is loaded or run)
  "src/memory/driver.mjs": /^(?![\s\S]*\bimport\(\s*[^"'\s)])(?![\s\S]*process\.binding)(?:(?!createRequire)[\s\S])*createRequire\b[^\n]*\n(?:(?!createRequire)[\s\S])*createRequire\(at\)\.resolve\.paths\(name\)(?:(?!createRequire)[\s\S])*$/,
  // the launcher runs the guard copy's (or the install's) own hook, job or CLI entry: the code these graphs cover
  "src/memory/launch/run.mjs": /^(?![\s\S]*createRequire)(?![\s\S]*process\.binding)(?:(?!\bimport\(\s*[^"'\s)])[\s\S]|import\(pathToFileURL\((?:dist\.hook|g\.hook|g\.job|cli)\)\.href\))*$/,
};
const PATH_LAUNCHERS = /^\/(?:usr\/)?bin\/(?:env|sh|bash|zsh|dash|ksh|xargs|nohup|command)$/;

function check(files) {
  const problems = [];
  for (const f of files) {
    // (Comments don't run: they're left out.)
    const src = fs.readFileSync(path.join(RUNTIME, f), "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    const usesCp = /from\s+["'](?:node:)?child_process["']|import\(\s*["'](?:node:)?child_process["']\s*\)|require\(\s*["'](?:node:)?child_process["']\s*\)|getBuiltinModule\??\.?\(\s*["'](?:node:)?child_process["']/.test(src);
    if (usesCp && !SPAWNERS[f]) problems.push(`${f}: imports child_process but isn't a listed spawner`);
    if (usesCp && /\b(?:exec|execSync)\b[^(]*from\s+["'](?:node:)?child_process["']|\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*=\s*(?:await\s+)?import\(\s*["'](?:node:)?child_process/.test(src)) problems.push(`${f}: imports exec/execSync (a shell)`);
    if (/\bshell\s*:\s*true\b/.test(src)) problems.push(`${f}: uses a shell`);
    if (f !== "src/safe-spawn.mjs" && PATH_LOOKUPS.test(src)) problems.push(`${f}: calls a PATH-resolving helper`);
    for (const m of src.matchAll(SPAWN_CALL)) {
      if (!m[2].startsWith("/")) problems.push(`${f}: runs "${m[2]}" by name`);
      else if (PATH_LAUNCHERS.test(m[2])) problems.push(`${f}: runs "${m[2]}", which looks its program up on PATH`);
    }
    // Ways to reach child_process this check can't follow.
    if (/\bcreateRequire\b|process\.binding\s*\(|\bimport\(\s*[^"'\s)]|getBuiltinModule\??\.?\(\s*(?!["'](?:node:)?crypto["'])|\beval\s*:\s*true/.test(src) && !(KNOWN_LOADS[f] && KNOWN_LOADS[f].test(src))) problems.push(`${f}: loads code the check can't follow`);
  }
  return problems;
}

test("the tool.before graph spawns nothing found through PATH, and only tmux-sessions spawns at all", () => {
  const files = graph(TOOL_BEFORE);
  assert.ok(files.includes("src/hooks/self-protect.mjs") && files.includes("src/hooks/tmux-sessions.mjs"), files.join(" "));
  assert.deepEqual(check(files), []);
  const spawners = files.filter((f) => /child_process["']/.test(fs.readFileSync(path.join(RUNTIME, f), "utf8").replace(/\/\/.*$/gm, "")) && /from\s+["']node:child_process["']/.test(fs.readFileSync(path.join(RUNTIME, f), "utf8")));
  assert.deepEqual(spawners, ["src/hooks/tmux-sessions.mjs"]);
  // tmux runs only from the fixed list, by the path trustedTmux() found.
  const ts = fs.readFileSync(path.join(RUNTIME, "src/hooks/tmux-sessions.mjs"), "utf8");
  assert.match(ts, /spawn\(bin, \["-S", socket, "has-session"/);
  assert.match(ts, /export const TRUSTED_TMUX = \["\/usr\/bin\/tmux", "\/bin\/tmux", "\/usr\/local\/bin\/tmux"\]/);
});

test("the background jobs' graphs (guards-refresh, migrate, recall-context) spawn nothing found through PATH", () => {
  for (const job of JOBS) assert.deepEqual(check(graph([job])), [], job);
});

test("the check itself catches a program by name, a shell, a PATH helper and an unlisted spawner", () => {
  const dir = fs.mkdtempSync(path.join(RUNTIME, "test", ".tmp-nps-"));
  try {
    const write = (name, body) => {
      fs.writeFileSync(path.join(dir, name), body);
      return rel(path.join(dir, name));
    };
    const a = write("a.mjs", 'import { spawnSync } from "node:child_process";\nspawnSync("tmux", ["ls"]);\n');
    const b = write("b.mjs", 'import { spawn } from "node:child_process";\nspawn("/bin/x", [], { shell: true });\n');
    const c = write("c.mjs", 'import { resolveGit } from "../../src/safe-spawn.mjs";\nresolveGit();\n');
    const d = write("d.mjs", 'import { exec } from "node:child_process";\n');
    const e = write("e.mjs", 'import * as cp from "node:child_process";\ncp.spawnSync("git", []);\n');
    const g = write("g.mjs", 'import { spawnSync } from "node:child_process";\nspawnSync("/usr/bin/env", ["git"]);\nconst m = "child_" + "process";\nawait import(m);\n');
    const h = write("h.mjs", 'const { spawnSync: s } = process.getBuiltinModule("node:child_process");\ns("git");\n');
    const problems = check([a, b, c, d, e, g, h]).join("\n");
    assert.match(problems, /h\.mjs: imports child_process but isn't a listed spawner/);
    assert.match(problems, /e\.mjs: runs "git" by name/);
    assert.match(problems, /g\.mjs: runs "\/usr\/bin\/env", which looks its program up on PATH/);
    assert.match(problems, /g\.mjs: loads code the check can't follow/);
    assert.match(problems, /a\.mjs: imports child_process but isn't a listed spawner/);
    assert.match(problems, /a\.mjs: runs "tmux" by name/);
    assert.match(problems, /b\.mjs: uses a shell/);
    assert.match(problems, /c\.mjs: calls a PATH-resolving helper/);
    assert.match(problems, /d\.mjs: imports exec\/execSync/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git runs only from a fixed, trusted path (root-owned on POSIX; Program Files on Windows)", async () => {
  const { trustedGit } = await import("../src/memory/git-tracked.mjs");
  const st = (uid, mode) => ({ uid, mode, isFile: () => true });
  const table = (m) => (p) => {
    if (!(p in m)) throw new Error("ENOENT");
    return m[p];
  };
  const realpath = (p) => p;
  assert.equal(trustedGit({ platform: "linux", stat: table({ "/usr/bin/git": st(0, 0o755), "/usr/bin": st(0, 0o755) }), realpath }), "/usr/bin/git");
  assert.equal(trustedGit({ platform: "linux", stat: table({ "/usr/bin/git": st(1000, 0o755), "/usr/bin": st(0, 0o755) }), realpath }), null);
  assert.equal(trustedGit({ platform: "linux", stat: table({ "/usr/local/bin/git": st(0, 0o755), "/usr/local/bin": st(0, 0o777) }), realpath }), null);
  // a link to a git under home is judged where it points
  assert.equal(trustedGit({ platform: "darwin", stat: table({ "/Users/u/bin/git": st(0, 0o755), "/Users/u/bin": st(0, 0o755) }), realpath: (p) => (p === "/usr/bin/git" ? "/Users/u/bin/git" : p) }), null);
  const win = (files, env) => trustedGit({ platform: "win32", env, isFile: (f) => files.includes(f) });
  assert.equal(win(["C:\\Program Files\\Git\\cmd\\git.exe"], { ProgramFiles: "C:\\Program Files" }), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(win([], { ProgramFiles: "C:\\Program Files" }), null);
  assert.equal(win(["git.exe"], { ProgramFiles: "relative" }), null);
});
