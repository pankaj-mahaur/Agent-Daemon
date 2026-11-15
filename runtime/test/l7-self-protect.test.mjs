// L7 part 2a-1 (design D12 a, b, e, h): ad's self-protection for shell calls — protected
// verbs, wrappers and other terminals, nested agents, env tampering, run-time-built verbs —
// run first in tool.before. The dev set (written from the plan, apart from the held-out
// corpus) on both sides, the exact verb shapes, the wiring, and the review-token scan.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-sp-")));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "AD_HOOK_HOST"]) delete process.env[k];
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { BLOCK, ALLOW } = await import("./fixtures/rules/self-protection-dev.mjs");
const { substitute } = await import("../testkit/rule-examples.mjs");
const SP = await import("../src/hooks/self-protect.mjs");
const TB = await import("../src/hooks/tool-before.mjs");
const { writeGuards, activePath } = await import("../src/hooks/guards.mjs");
const { closure } = await import("../scripts/build-memory-package.mjs");

// Items whose check comes with a later part (each says which).
const PENDING = { "sa-051": "P2a-2: tmux own-session record" };
const HOME = { linux: "/home/dev", macos: "/Users/dev", windows: "C:\\Users\\dev" };

function judge(it) {
  const input = substitute(it.input, { tool: it.tool, os: it.os });
  const payload = { tool_name: it.tool, tool_input: input, cwd: it.cwd, session_id: "s" };
  const platform = it.os === "windows" ? "win32" : it.os === "macos" ? "darwin" : "linux";
  const home = HOME[it.os];
  const folders = [it.os === "windows" ? `${home}\\.agent-daemon\\memory` : `${home}/.agent-daemon/memory`, "/work/ad/runtime"];
  return SP.selfProtect(payload, { host: it.host === "codex" ? "codex" : "claude", platform, home, folders });
}

test("the dev set's verbs, wrappers, env and run-time-built items (D12 a, b, e, h), both sides", () => {
  const items = [...BLOCK, ...ALLOW].filter((x) => ["a", "b", "e", "h"].includes(x.cls));
  assert.ok(items.length > 90, `${items.length} items`);
  const wrong = [];
  for (const it of items) {
    if (PENDING[it.id]) continue;
    const got = judge(it)?.decision ?? "allow";
    if (got !== it.expect) wrong.push(`${it.id}: want ${it.expect}, got ${got} (${JSON.stringify(it.input).slice(0, 100)})`);
  }
  assert.deepEqual(wrong, []);
  for (const id of Object.keys(PENDING)) assert.ok(items.some((x) => x.id === id), `${id} is still in the dev set`);
});

test("ad's verbs on exact argv shapes", () => {
  const cls = (kind, args) => SP.verbClass(kind, args).cls;
  // token-only
  for (const a of [["review"], ["review", "--list", "--accept-all"], ["review", "--import", "x.json"], ["rules", "pause"], ["rules", "list", "--all"], ["learnings", "forget", "3"], ["learning", "edit", "1"], ["setup"], ["install"], ["repair"], ["uninstall"], ["config", "review", "auto"], ["consolidate", "--apply-stale"], ["memory", "held"], ["memory", "assign", "x"], ["remember", "--token=abc", "x"], ["hook", "tool.before"], ["session-start"]]) assert.equal(cls("ad", a), "token", a.join(" "));
  // token-variant (allowed bare, never wrapped)
  for (const a of [["remember", "x"], ["forget", "1"], ["restore", "1"], ["config", "review", "strict"], ["tui"], ["init"], ["mistakes", "--save"], []]) assert.equal(cls("ad", a), "variant", a.join(" "));
  // reads
  for (const a of [["review", "--list"], ["review", "--help"], ["rules", "list"], ["rules", "list", "--json"], ["report"], ["doctor"], ["status"], ["mistakes"], ["serve"], ["--help"], ["--version"], ["memory", "search", "x"], ["memory", "assign", "--list"], ["learnings"], ["consolidate"], ["tt"]]) assert.equal(cls("ad", a), "read", a.join(" "));
  // not a literal
  for (const a of [["$v"], ["$(echo review)"], ["memory", "$x"], ["`x`"]]) assert.equal(cls("ad", a), "nonliteral", a.join(" "));
  // ad's options before the verb
  assert.equal(cls("ad", ["--cwd", "/x", "review"]), "token");
  // the package bin: the verb is first; npm exec's `--` is skipped
  assert.equal(cls("pkg", ["--", "review"]), "token");
  assert.equal(cls("pkg", []), "read");
});

test("ANSI-C quoting and the variables a line sets or unsets", () => {
  assert.equal(SP.decodeAnsiCQuotes("$'\\x61d' review"), "'ad' review");
  assert.equal(SP.decodeAnsiCQuotes("$'\\141\\144'"), "'ad'");
  assert.equal(SP.decodeAnsiCQuotes("$'it\\'s'"), "'it'\\''s'");
  const v = (t) => SP.variablesSet(t);
  for (const t of ["AD_TOOL_SHELL=0 x", "export AD_TOOL_SHELL=", "declare -x AD_TOOL_SHELL=1", "$env:AD_TOOL_SHELL = $null", "set AD_TOOL_SHELL=0", "setx AD_TOOL_SHELL 0", "[Environment]::SetEnvironmentVariable('AD_TOOL_SHELL', $null)"]) assert.ok(v(t).set.has("AD_TOOL_SHELL"), t);
  for (const t of ["unset AD_TOOL_SHELL", "unset -v X AD_TOOL_SHELL", "env -u AD_TOOL_SHELL bash", "env --unset=AD_TOOL_SHELL bash", "Remove-Item env:AD_TOOL_SHELL", "export -n AD_TOOL_SHELL"]) assert.ok(v(t).unset.has("AD_TOOL_SHELL"), t);
  assert.ok(v("env -i ad remember x").clears);
  for (const t of ["echo $AD_TOOL_SHELL", "grep -rn AD_TOOL_SHELL src/"]) assert.ok(!v(t).set.has("AD_TOOL_SHELL") && !v(t).unset.has("AD_TOOL_SHELL"), t);
});

const sp = (command, extra = {}) => SP.selfProtect({ tool_name: extra.tool ?? "Bash", tool_input: { command }, cwd: extra.cwd ?? "/work/app", session_id: "s" }, { host: extra.host ?? "claude", platform: extra.platform ?? "linux", home: "/home/dev", folders: extra.folders ?? ["/home/dev/.agent-daemon/memory", "/work/ad/runtime"] });

test("ad's own entry files are token-only; other scripts in ad's checkout and anyone else's run", () => {
  for (const c of ["node /work/ad/runtime/bin/hook.mjs tool.before", "node ~/.agent-daemon/memory/launch/run.mjs hook prompt.submit", "node ~/.agent-daemon/memory/launch/run.mjs job guards-refresh", "node /work/ad/runtime/src/memory/migrate-job.mjs", "node --no-warnings $HOME/.agent-daemon/memory/dist/3.1.0/src/memory/guards-refresh-job.mjs"]) assert.equal(sp(c)?.decision, "deny", c);
  // run.mjs with a CLI verb: the CLI's rules.
  assert.equal(sp("node ~/.agent-daemon/memory/launch/run.mjs review")?.decision, "deny");
  assert.equal(sp("node ~/.agent-daemon/memory/launch/run.mjs doctor"), null);
  // Not ad's folders, or not an entry file: nothing.
  for (const c of ["node /work/app/bin/hook.mjs", "node --test /work/ad/runtime/test/x.test.mjs", "node /work/ad/runtime/scripts/check-doc-links.mjs", "node scripts/run.mjs hook"]) assert.equal(sp(c), null, c);
  // A relative path inside ad's checkout, from its folder.
  assert.equal(sp("node bin/hook.mjs tool.before", { cwd: "/work/ad/runtime" })?.decision, "deny");
});

test("AD_ROOT at a scratch root: ad's verbs act there, except the ones that write host config", () => {
  assert.equal(sp("AD_ROOT=/tmp/scratch ad review"), null);
  assert.equal(sp("AD_ROOT=/tmp/scratch ad remember x"), null);
  for (const c of ["AD_ROOT=/tmp/scratch ad setup", "AD_ROOT=/tmp/scratch ad init", "AD_ROOT=/home/dev/.agent-daemon ad review", "AD_ROOT=/home/dev/.agent-daemon/x ad review", "AD_ROOT=$X ad remember y", "AD_ROOT=~/x ad review"]) assert.equal(sp(c)?.decision, "deny", c);
  // The injection variables for a read stay allowed; for a non-read, never.
  assert.equal(sp("HOME=/tmp/h ad doctor"), null);
  assert.equal(sp("HOME=/tmp/h ad remember x")?.decision, "deny");
  assert.equal(sp("LD_PRELOAD=/tmp/x.so teachonce forget 1")?.decision, "deny");
  assert.equal(sp("AD_MEMORY_DB=/tmp/other.db ad remember x")?.decision, "deny");
  assert.equal(sp("export AD_MEMORY_DB=/tmp/o.db; ad forget 2")?.decision, "deny");
  assert.equal(sp("AD_MEMORY_DB=/tmp/other.db ad doctor"), null);
});

test("wrappers seen through; desktop launchers and remote input ask; nested agents", () => {
  for (const c of ["tmux new -d 'ad remember x'", "ssh host ad review", "ssh -p 22 host 'teachonce forget 3'", "screen -dm teachonce remember x", "socat - EXEC:'ad forget 1'", "systemd-run --user ad remember x", "at now <<< 'ad remember x'", "echo 'ad forget 1' | at now", "ad loop 'ad review'"]) assert.equal(sp(c)?.decision, "deny", c);
  for (const c of ["tmux new -d 'npm run dev'", "ssh host uptime", "screen -dm htop", "nohup ./server &", "tmux capture-pane -p -t dev", "claude -p 'summarize'", "codex exec 'fix it'"]) assert.equal(sp(c), null, c);
  for (const c of ["tmux send-keys -t 0 'npm test' Enter", "xdotool type hello", "osascript -e 'beep'", "open -a Terminal", "xterm -e htop", "kitty @ launch htop", "claude --settings ./s.json -p x", "claude mcp add x -- y", "codex --profile p exec x", "codex -c features.x=1 exec y"]) assert.equal(sp(c)?.decision, "ask", c);
  for (const c of ["HOME=/tmp/h claude -p x", "env -i claude -p x", "XDG_CONFIG_HOME=/tmp/c codex exec x", "codex -c hooks.x=1 exec y", "claude --setting-sources project,local -p x"]) assert.equal(sp(c)?.decision, "deny", c);
  // A read verb inside a wrapper: allowed.
  assert.equal(sp("nohup ad doctor &"), null);
});

test("the Codex shell and PowerShell see the same verbs", () => {
  const codex = (command) => SP.selfProtect({ tool_name: "shell", tool_input: { command }, cwd: "/work/app", turn_id: "t" }, { host: "codex", platform: "linux", home: "/home/dev", folders: [] });
  assert.equal(codex(["bash", "-lc", "ad review"])?.decision, "deny");
  assert.equal(codex("teachonce rules pause")?.decision, "deny");
  assert.equal(codex(["ad", "doctor"]), null);
  assert.equal(sp("& npx.cmd teachonce review", { tool: "PowerShell", platform: "win32" })?.decision, "deny");
  assert.equal(sp("$env:AD_TOOL_SHELL = $null", { tool: "PowerShell", platform: "win32" })?.decision, "deny");
  // Not a shell tool: P2b's (writes).
  assert.equal(SP.selfProtect({ tool_name: "Write", tool_input: { file_path: "/x", content: "ad review" } }, { home: "/home/dev", folders: [] }), null);
});

test("tool.before: self-protection first, deny wins either way, an ask on Codex or in a bypass mode denies; nothing lowering is named", () => {
  const base = fs.mkdtempSync(path.join(TMP, "tb-"));
  const root = path.join(base, "ad");
  const project = path.join(base, "work", "app");
  fs.mkdirSync(project, { recursive: true });
  const run = (command, extra = {}) => {
    const input = JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", cwd: project, tool_name: "Bash", tool_input: { command }, permission_mode: "default", ...extra });
    const env = { ...process.env, HOME: base, USERPROFILE: base, AD_ROOT: root };
    const r = spawnSync(process.execPath, [path.join(RUNTIME, "bin", "hook.mjs"), "tool.before", ...(extra.turn_id ? ["--host", "codex"] : [])], { input, env, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  // No rules at all: self-protection still runs.
  const d = run("ad review");
  assert.equal(d.permissionDecision, "deny");
  assert.doesNotMatch(d.permissionDecisionReason, /\b(?:teachonce|review|rules|pause|resume|uninstall|repair|setup|allow-once)\b|\bad\s+[a-z]/i, d.permissionDecisionReason);
  assert.equal(run("tmux send-keys -t 0 'npm test' Enter").permissionDecision, "ask");
  assert.equal(run("tmux send-keys -t 0 'npm test' Enter", { permission_mode: "bypassPermissions" }).permissionDecision, "deny");
  assert.equal(run("tmux send-keys -t 0 'npm test' Enter", { turn_id: "t1" }).permissionDecision, "deny");
  assert.equal(run("ls -la"), null);
  // A rule that denies the same call beats self-protection's ask.
  const rule = { id: 3, kind: "command", decision: "deny", reason: "no tmux typing", scope: "all", rule: { type: "command", program: "tmux", subcommands: ["send-keys"], flags: null } };
  writeGuards({ projects: {}, global: { rules: [rule] }, pausedAll: null, allowOnce: [], ruleCount: 1, rules_rev: 1, store_id: "a".repeat(32), cmd: "ad" }, { root });
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: 1, store_id: "a".repeat(32) }));
  const both = run("tmux send-keys -t 0 'npm test' Enter");
  assert.equal(both.permissionDecision, "deny");
  assert.match(both.permissionDecisionReason, /no tmux typing/);
  // Every rule paused: self-protection still stops ad's verbs (pause never lifts it).
  writeGuards({ projects: {}, global: { rules: [rule] }, pausedAll: { at: new Date().toISOString(), until: null }, allowOnce: [], ruleCount: 1, rules_rev: 1, store_id: "a".repeat(32), cmd: "ad" }, { root });
  assert.equal(run("ad rules resume --all").permissionDecision, "deny");
});

test("a self-protection check that breaks stops a call naming ad itself, even with no rules", () => {
  const tree = fs.mkdtempSync(path.join(TMP, "tree-"));
  for (const rel of closure(["bin/hook.mjs"]).files) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.copyFileSync(path.join(RUNTIME, rel), path.join(tree, rel));
  }
  fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(tree, "src", "hooks", "self-protect.mjs"), 'throw new Error("planted");\n');
  const home = fs.mkdtempSync(path.join(TMP, "h-"));
  const run = (command) => {
    const r = spawnSync(process.execPath, [path.join(tree, "bin", "hook.mjs"), "tool.before"], { input: JSON.stringify({ session_id: "s", cwd: home, tool_name: "Bash", tool_input: { command }, permission_mode: "default" }), env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: path.join(home, ".agent-daemon") }, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  assert.equal(run("ad remember x").permissionDecision, "deny");
  assert.equal(run("node ~/.agent-daemon/memory/launch/run.mjs hook x").permissionDecision, "deny");
  // A weak trigger only (no ad name, no ad state): asked, as the check had something to look at.
  assert.equal(run("tmux new -d 'npm run dev'").permissionDecision, "ask");
  // Nothing for self-protection at all: nothing to stop.
  assert.equal(run("npm test"), null);
});

test("every reviewToken( call site maps to verbs self-protection keeps from the agent's shell", () => {
  // file → the verbs whose run it gates (token-only: denied bare; token-variant: denied wrapped)
  const SITES = {
    "src/review.mjs": { token: ["ad review", "teachonce review"] },
    "src/cli-full.mjs": { token: ["ad consolidate --apply-merges", "ad consolidate --apply-stale"] },
    "src/memory/held.mjs": { token: ["ad memory held"] },
    "src/memory/memory-cli.mjs": { variant: ["teachonce remember x", "teachonce forget 1", "teachonce restore 1"] },
    "src/memory/safety-cli.mjs": { token: ["ad safety on", "ad safety off", "teachonce safety off"] },
    "src/portability/import.mjs": { token: ["ad review --import x.json"] },
    "src/tui/ad-layer.mjs": { variant: ["ad tui"] },
  };
  const DEFINITION = "src/memory/review-service.mjs";
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs") && /\breviewToken\(/.test(fs.readFileSync(p, "utf8"))) files.push(path.relative(RUNTIME, p).split(path.sep).join("/"));
    }
  };
  walk(path.join(RUNTIME, "src"));
  assert.deepEqual(files.filter((f) => f !== DEFINITION).sort(), Object.keys(SITES).sort(), "a new reviewToken( site needs its verbs here and in D12a");
  for (const [file, { token = [], variant = [] }] of Object.entries(SITES)) {
    for (const c of token) assert.equal(sp(c)?.decision, "deny", `${file}: ${c}`);
    for (const c of variant) {
      assert.equal(sp(c), null, `${file}: ${c} bare`);
      assert.equal(sp(`nohup ${c} &`)?.decision, "deny", `${file}: ${c} wrapped`);
    }
  }
});

test("the fast path: ordinary commands never load self-protection; ad's names always do", () => {
  for (const c of ["ls -la", "npm test", "git push origin main", "python3 -m pytest", "cat README.md", "make build"]) assert.equal(TB.selfProtectTriggered({ tool_input: { command: c } }), false, c);
  for (const c of ["ad doctor", "teachonce review", "tmux new -d x", "echo $'\\x61d'", "unset AD_TOOL_SHELL", "$env:X = 1", "x & disown", "$AD review", "claude -p x"]) assert.equal(TB.selfProtectTriggered({ tool_input: { command: c } }), true, c);
});

const spOn = (command, { platform = "linux", tool = "Bash", home, extra = {} } = {}) => {
  const os_ = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  const h = home ?? HOME[os_];
  const memory = os_ === "windows" ? `${h}\\.agent-daemon\\memory` : `${h}/.agent-daemon/memory`;
  return SP.selfProtect({ tool_name: tool, tool_input: { command, ...extra }, cwd: os_ === "windows" ? "C:\\work\\app" : "/work/app", session_id: "s" }, { host: "claude", platform, home: h, folders: [memory, "/work/ad/runtime"] });
};
const b64ps = (s) => Buffer.from(s, "utf16le").toString("base64");

test("review round 1: every bypass it found is closed, and its false positives pass", () => {
  const DENY = [
    // H1 the scratch root: only a lone `AD_ROOT=<literal> <ad command>`, and it relaxes AD_ROOT only
    "ad rules pause --all # AD_ROOT=/tmp/x", "AD_ROOT=/tmp/x; ad rules rm 3", "echo AD_ROOT=/tmp/x; ad review", "AD_ROOT=/tmp/x ad doctor && ad config review auto", "AD_ROOT=/tmp/x ad review; ad rules pause --all", "AD_ROOT=/tmp/x sh -c 'AD_ROOT=/home/dev/.agent-daemon ad review'", "export AD_ROOT=/tmp/s; unset AD_ROOT; ad review", "AD_ROOT=/tmp/s env -u AD_ROOT ad review", "AD_ROOT=/tmp/x AD_MEMORY_DB=/home/dev/.agent-daemon/episodic.db ad review", "AD_ROOT=/tmp/x NODE_OPTIONS=--require=/tmp/e.js ad review", "AD_ROOT=/tmp/x ad memory install", "AD_ROOT=/ ad review",
    // H2, H3 memory's subcommands
    "ad memory consolidate --apply-merges", "ad memory --apply-merges consolidate", "node /work/ad/runtime/src/cli-full.mjs memory consolidate --apply-merges", "ad memory --json promote 3", "ad memory --days 3 held", "ad memory --all-projects held", "ad memory -x redact t:1",
    // H4 PTY wrappers
    "script -qc 'ad review' /dev/null", "script -qec 'ad review' /dev/null", "script --command='ad review'", `python3 -c 'import pty; pty.spawn(["ad","review"])'`,
    // H5 options before or clustered with the subcommand
    "tmux -L s new -d 'ad review'", "tmux -S /tmp/s new -d ad review", "tmux -f /dev/null new 'ad review'", "tmux -2 new 'ad review'", "tmux new -ds w 'ad review'", "screen -dmS x ad review", "systemd-run --user --unit x ad review", "systemd-run -u x ad remember y",
    // M1 xargs
    "echo promote 3 | xargs ad memory", "echo auto | xargs ad config review", "echo edit 3 | xargs ad learnings", "echo --import x.json | xargs ad review --list", "echo review | xargs -I{} ad {}", "echo ad review | xargs -I{} sh -c '{}'",
    // M2 commands held in variables or positional parameters
    'c="ad review"; $c', 'c="ad review"; eval "$c"', 'set -- ad review; "$@"', 'f() { "$@"; }; f ad review', `bash -c '"$@"' _ ad review`, "sh -c '$0 $1' ad review", "AD=ad; $AD setup", '"$(which ad)" memory promote 3',
    // M3 shells fed on stdin or a process substitution
    "printf 'ad review\\n' | bash", "printf '%s\\n' 'ad review' | bash", "bash <(echo ad review)", "source <(echo ad review)", "sh < <(echo ad review)",
    // M4 a cd earlier in the line
    "cd ~/.agent-daemon/memory/launch && node run.mjs review", "cd /work/ad/runtime && node src/cli.mjs review", "pushd /work/ad/runtime; node bin/hook.mjs x",
    // M5 a code point past Unicode: no crash
    "$'\\U110000'; claude --setting-sources project -p x",
    // M6 the marker's long tail
    "unset -n AD_TOOL_SHELL", "unset ${!AD_*}", "v=AD_TOOL_SHELL; unset $v", "x=AD_TOOL; unset ${x}_SHELL", "declare +x AD_TOOL_SHELL", "printf -v AD_TOOL_SHELL 0", "read AD_TOOL_SHELL <<< 0", "env -iu X ad remember x", "export {AD_TOOL_SHELL,X}=0", "fish -c 'set -e AD_TOOL_SHELL; ad remember x'", `node -e "delete process.env.AD_TOOL_SHELL"`,
    // M7 other ways to reach an entry point
    "npx --prefix /tmp teachonce review", "npm -w pkg exec teachonce review", "pnpm --filter x exec teachonce review", "corepack pnpm dlx teachonce review", "bun ~/.agent-daemon/memory/launch/run.mjs review", "node $(which ad) rules pause --all", "xvfb-run ad review", "dbus-run-session -- ad review", "direnv exec . ad review", "nix develop -c ad review", "cross-env FOO=1 ad review", "strace -f ad review", `node -e "require('child_process').execSync('ad review')"`, `python3 -c "import os; os.system('ad review')"`, "vim -c '!ad review'", "git -c alias.x='!ad review' x",
    // lows
    "nohup ad remember x", "setsid ad forget 2", "(ad remember x &)", "{ ad remember x & }", "ad remember x & wait", "coproc ad remember x", "ssh host -- ad review", "expect -c 'spawn -noecho ad review'", "ad bash-pre",
  ];
  const misses = [];
  for (const c of DENY) if (spOn(c)?.decision !== "deny") misses.push(`deny: ${c} → ${spOn(c)?.decision ?? "allow"}`);
  assert.equal(spOn("ad remember x", { extra: { run_in_background: true } })?.decision, "deny", "run_in_background");
  assert.equal(spOn("AD_ROOT=/Users/dev/.AGENT-DAEMON ad review", { platform: "darwin" })?.decision, "deny", "macOS folds case");
  assert.equal(spOn("node ~/.AGENT-DAEMON/memory/launch/run.mjs review", { platform: "darwin" })?.decision, "deny", "macOS folds case (script)");
  assert.equal(spOn("AD_ROOT=/c/Users/dev/.agent-daemon ad rules pause --all", { platform: "win32" })?.decision, "deny", "Git Bash /c/ path");
  assert.equal(spOn("node /c/Users/dev/.agent-daemon/memory/launch/run.mjs hook x", { platform: "win32" })?.decision, "deny", "Git Bash script path");
  // H6/H7 PowerShell
  const PS_DENY = ["'ad review' | iex", '"ad review" | Invoke-Expression', "iex ('ad'+' review')", "$c='ad review'; iex $c", "Set-Alias x ad; x review", "& (gcm ad) review", "function x { ad @args }; x review", "[scriptblock]::Create('ad review').Invoke()", "${env:AD_TOOL_SHELL} = ''", "Remove-Item -LiteralPath Env:AD_TOOL_SHELL", "Remove-Item Env:AD_*", "Set-Content Env:AD_TOOL_SHELL 0", `pwsh -enc ${b64ps("ad review")}`, `pwsh -EncodedCommand ${b64ps("$env:AD_TOOL_SHELL=''; ad remember x")}`];
  for (const c of PS_DENY) if (spOn(c, { platform: "win32", tool: "PowerShell" })?.decision !== "deny") misses.push(`deny (PowerShell): ${c} → ${spOn(c, { platform: "win32", tool: "PowerShell" })?.decision ?? "allow"}`);
  assert.equal(spOn("tmux -L s send-keys -t w 'npm test' Enter")?.decision, "ask");
  assert.equal(spOn('eval "$(echo YWQgcmV2aWV3 | base64 -d)"')?.decision, "ask");
  // Allowed: scratch roots, reads, and the false positives the review found.
  const ALLOW = ["AD_ROOT=/tmp/scratch ad review", "ls | xargs ad doctor", 'grep -rn "AD_TOOL_SHELL=" src/', 'echo "AD_TOOL_SHELL=$AD_TOOL_SHELL"', 'git commit -m "fix: set AD_TOOL_SHELL=1 in setup"', 'git commit -m "test: unset AD_TOOL_SHELL in tests"', `git commit -m "$(cat <<'EOF'\nfix: AD_TOOL_SHELL=1 for setup\nEOF\n)"`, 'grep -n "unset AD_TOOL_SHELL" -r test/', "xdg-open coverage/index.html", "kitty +kitten icat x.png", "npm install ad", "pip install ad", 'git commit -m "ad review fixes"', "echo $AD_TOOL_SHELL", "printenv AD_TOOL_SHELL"];
  for (const c of ALLOW) if (spOn(c) !== null) misses.push(`allow: ${c} → ${spOn(c)?.decision}`);
  assert.deepEqual(misses, []);
});

test("the fast path loads the check for every word it acts on", async () => {
  const W = await import("../src/hooks/self-protect-words.mjs");
  for (const w of [...W.ENTRY_NAMES, ...W.VERB_WORDS, ...W.REPARENTING, ...W.TERMINALS, ...W.DESKTOP, ...W.INTERNAL_FILES, ...W.AGENTS, ...W.OTHER_TRIGGERS, ...W.ENV_NAMES]) {
    assert.equal(TB.selfProtectTriggered({ tool_input: { command: `x ${w} y` } }), true, w);
  }
  for (const c of ["pwsh -enc AAAA", "node src/memory/guards-refresh-job.mjs", "ii .", "npx @anthropic-ai/claude-code -p x", "node src/cli-full.mjs install", "'ad review' | iex", "x & wait", "(x &)"]) assert.equal(TB.selfProtectTriggered({ tool_input: { command: c } }), true, c);
});

test("review round 2: bypasses closed, false positives pass, and slow lines stay inside the budget", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform}${opts.tool ? " " + opts.tool : ""})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  for (const c of [
    // H1 a newline starts another command: no scratch root
    "AD_ROOT=/tmp/x ad doctor\nad rules pause --all", "AD_ROOT=/tmp/x ad doctor\nad config review auto", "AD_ROOT=/tmp/x ad doctor\nad memory promote 3", "AD_ROOT=/tmp/x\nad review",
    // H3 cd through $HOME, with options, or somewhere the check can't follow
    'cd "$HOME/.agent-daemon/memory/launch" && node run.mjs review', "cd $HOME/.agent-daemon/memory/launch && node run.mjs review", "cd ${HOME}/.agent-daemon/memory/launch; node run.mjs hook x", "cd -- ~/.agent-daemon/memory/launch && node run.mjs review", "cd -P ~/.agent-daemon/memory/launch && node run.mjs review", "pushd -n ~/.agent-daemon/memory/launch; node run.mjs review", "cd $SOMEWHERE && node run.mjs review",
    // M6 interpreters fed code on stdin
    "python3 - <<'EOF'\nimport os\nos.system('ad review')\nEOF", "node <<'EOF'\nrequire('child_process').execSync('ad review')\nEOF", `node - <<< "require('child_process').execSync('ad review')"`, `echo "require('child_process').execSync('ad review')" | node`, `python3 <<< "import os; os.system('ad review')"`,
    // M7 clustered interpreter flags
    `node -pe "require('child_process').execSync('ad review')"`, `node --eval="require('child_process').execSync('ad review')"`, `python3 -Bc "import os; os.system('ad review')"`, `python -uc "import os; os.system('ad review')"`, `perl -le 'system "ad review"'`, `ruby -we 'system "ad review"'`,
    // M8 the marker spelled with quotes or escapes, globs, whole-environment clears, names from substitutions
    `unset "AD_TOOL""_SHELL"`, "unset AD_TOOL_SHEL\\L", `export AD_TOOL_SHEL"L"=0`, `env -u AD_TOOL"_SHELL" npm test`, "unset $(compgen -e AD)", "unset $(compgen -e)", "unset ${!A*}", "unset $(echo AD_TOOL_SHELL)", "unset $(env | grep -o '^AD_[A-Z_]*')",
    // M10 ad's scripts started directly
    "/work/ad/runtime/src/cli.mjs rules pause --all",
    // M12 programs that run a command string
    "git rebase -x 'ad review' main", "git bisect run ad review", "git submodule foreach 'ad review'", "git filter-branch --tree-filter 'ad review' HEAD", "git -c core.pager='ad review' log", "GIT_PAGER='ad review' git log", "nodemon --exec 'ad review'", "npx concurrently 'ad review' 'npm test'", "entr -s 'ad review'", "npm exec -c 'teachonce review'", "yarn run teachonce review", "parallel ad ::: review", "echo ad review | parallel", `awk 'BEGIN{system("ad review")}'`,
    // M13 ssh fed on stdin
    "ssh -T localhost <<'EOF'\nad review\nEOF", "echo 'ad review' | ssh localhost", "ssh localhost 'bash -s' <<< 'ad review'",
    // lows
    "tmux -c 'ad review'", "tmux if-shell 'ad review' ''", `tmux set-hook -g after-new-window 'run-shell "ad review"'`, "zellij -s x action write-chars 'ad review'", "watch 'ad remember x'", `osascript -e 'do shell script "ad review"'`,
  ]) want("deny", c);
  for (const c of ["node ~/.agent-daemon/memory/launch/RUN.mjs review", "node ~/.agent-daemon/memory/LAUNCH/run.mjs review"]) want("deny", c, { platform: "darwin" });
  for (const c of ["node //?/C:/Users/dev/.agent-daemon/memory/launch/run.mjs hook x", "node C:/Users/dev/.agent-daemon./memory/launch/run.mjs. review"]) want("deny", c, { platform: "win32" });
  for (const c of ["echo YWQgcmV2aWV3 | base64 -d | sh", `bash -c "$(echo YWQgcmV2aWV3 | base64 -d)"`]) want("ask", c);
  const ps = { platform: "win32", tool: "PowerShell" };
  for (const c of ["& ('ad') review", "&('ad') review", "& ('a'+'d') review", ". ('a'+'d') rules pause", "ad ('rev'+'iew')", `$a='ad'; $b='review'; iex "$a $b"`, "iex ('a'+'d review')", "[System.Diagnostics.Process]::Start('ad','review')", "Remove-Item Env:AD*", "gci env:AD* | ri", "Remove-Item Env:*", "Get-ChildItem Env: | Remove-Item", "$env:AD_TOOL`_SHELL = ''", "Start-Job { ad remember x }"]) want("deny", c, ps);
  want("ask", "& ($x) review", ps);
  for (const c of [
    // H5 quoted text in an ad command's own arguments
    `ad remember "Use the R&D folder"`, `ad remember 'Q&A docs live in docs/qa'`, `ad remember "Run lint & tests before pushing"`, `teachonce remember 'A&B'`, `ad remember 'Use HOME=/tmp for tests'`, `ad remember "NODE_OPTIONS=--max-old-space-size=8192 for builds"`, "ad remember x; npm run dev &", "make 'NODE_OPTIONS=--trace'; ad remember y",
    // reads of the marker
    `node -e "console.log(process.env.AD_TOOL_SHELL)"`, `python3 -c "import os; print(os.environ.get('AD_TOOL_SHELL'))"`, "awk '/AD_TOOL_SHELL/' f", "perl -ne 'print if /AD_TOOL_SHELL/' f", "declare -p AD_TOOL_SHELL", "compgen -v AD", `ad remember "set AD_TOOL_SHELL in tests via env"`,
    // other programs' commands, and wrapping kept to its own command
    "docker run --rm img ad review", "docker compose run ad review", 'nohup npm run dev >/dev/null 2>&1 & ad remember "x"', "ssh host uptime; ad remember x", "node -v", "python3 script.py", "git log --oneline -5",
  ]) want("allow", c);
  for (const c of ["Get-Item Env:AD_TOOL_SHELL", "Test-Path Env:AD_TOOL_SHELL", "gci env:AD_*", "Get-ChildItem Env: | Where-Object Name -like 'AD_*'", "[Environment]::GetEnvironmentVariable('AD_TOOL_SHELL')"]) want("allow", c, ps);
  assert.deepEqual(misses, []);
  // H2 lines that took seconds stay well inside the hook's 5 s, and are still decided.
  for (const c of ["sh;".repeat(16000) + "ad rules pause", "$x;".repeat(12000) + "ad rules pause", "eval;".repeat(9000) + "ad review", "AD_X=1; " + "env -a ".repeat(9000)]) {
    const t0 = Date.now();
    const r = spOn(c);
    const ms = Date.now() - t0;
    assert.ok(ms < 2500, `${ms} ms for ${c.slice(0, 20)}…`);
    if (/ad (?:rules|review)/.test(c)) assert.ok(r?.decision === "deny" || r?.decision === "ask", `${c.slice(0, 20)}… → ${r?.decision}`);
  }
});

test("review round 3: aliases, node's value options, marker variants, whole backgrounded lists, launchers, and long lines in linear time", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  for (const c of [
    // M2 node options that take the next word
    "node --disable-warning ExperimentalWarning ~/.agent-daemon/memory/launch/run.mjs rules pause", "node --env-file-if-exists .env ~/.agent-daemon/memory/launch/run.mjs review", "node --unhandled-rejections strict ~/.agent-daemon/memory/launch/run.mjs rules pause",
    // M3 bash aliases
    "alias x='ad rules pause'\nx", "alias x=ad\nx review", "shopt -s expand_aliases\nalias x='ad rules pause'\nx",
    // M4 the marker built from pieces, brace-expanded, or changed from code
    "unset AD_{TOOL,X}_SHELL; ad doctor", "unset AD_TOOL_{SHELL,X}", "export AD_TOOL_{SHELL,X}=", `python3 -c "import os,subprocess; del os.environ['AD_TOOL_SHELL']; subprocess.run(['ad','doctor'])"`, `node -e "process.env.AD_TOOL_SHELL=''"`,
    // code that runs a command still counts
    "sed -n 's/x/ad rules pause/e' f", `perl -e 'system("ad rules pause")'`,
    // L6 a backgrounded list or group
    "ad remember x | cat &", "ad remember x |& tee log &", "ad remember x && echo ok &", "{ ad remember x; } &",
    // L7 entry spellings
    "deno run -A npm:agent-daemon rules pause", "deno run npm:agent-daemon@3 review", "npx git+https://github.com/someone/Agent-Daemon.git review",
    // L8 remote input and compositors
    "kitten @ send-text 'ad review\\r'", "kitty @ --to unix:/tmp/k send-text 'ad review\\r'", "swaymsg 'exec kitty -e ad review'", "hyprctl --batch 'dispatch exec kitty -e ad review'", "zellij run -- ad rules pause", "tmux send -t w ad Space review Enter",
  ]) want("deny", c);
  for (const c of ["Get-Item Env:AD_TOOL_SHELL | Remove-Item", "Get-ChildItem Env:AD_TOOL_SHELL | Remove-Item", "dir env:AD_TOOL_SHELL | del", "Remove-Item (Get-Item Env:AD_TOOL_SHELL).PSPath", `[Environment]::SetEnvironmentVariable("AD_TOOL" + "_SHELL", $null)`, `$n='AD_TOOL'+'_SHELL'; Remove-Item "Env:$n"`]) want("deny", c, { platform: "win32", tool: "PowerShell" });
  for (const c of ["i3-msg 'exec kitty'", "hyprctl -j dispatch exec kitty", "hyprctl dispatch -- exec kitty", "uwsm app -- kitty", "x-terminal-emulator -e htop", "st -e htop", "cool-retro-term", "open -na Terminal", "zellij run -- htop", "zellij action new-pane -- htop", "kitten @ send-text 'ls\\r'", "$(echo ad) --cwd /x rules pause"]) want("ask", c);
  for (const c of [
    // M5 editing ad's own source: the text a program edits is data
    "sed -i 's/AD_TOOL_SHELL/AD_AGENT_SHELL/g' f", "sed -i 's/unset AD_TOOL_SHELL/env -u AD_TOOL_SHELL/' f", "perl -0pi -e 's/ad rules pause/ad rules list/' docs/a.md", `ruby -pi -e 'gsub(/ad review/, "ad review --list")' f`,
    `node -e "const fs=require('fs');fs.writeFileSync('x.md', fs.readFileSync('x.md','utf8').replace('ad review','ad review --list'))"`, "python3 - <<'EOF'\np='x.md'\ns=open(p).read().replace('ad review','ad review --list')\nopen(p,'w').write(s)\nEOF",
    "node --test-reporter spec ./scripts/x.mjs review", "ad remember x; sleep 1 &", "ad doctor && npm run dev &", "kitten icat img.png", "hyprctl clients", "swaymsg -t get_tree", "uwsm check is-active",
  ]) want("allow", c);
  want("allow", "(Get-Content x.mjs) -replace 'AD_TOOL_SHELL','AD_X' | Set-Content x.mjs", { platform: "win32", tool: "PowerShell" });
  assert.deepEqual(misses, []);
  // H1 60 KB of one-word arguments: linear, decided well inside the hook's 5 s.
  const words = Array(30000).fill("x").join(" ");
  for (const [c, opts] of [["echo " + words + "; ad rules pause --all"], ["grep " + words + " f; unset AD_TOOL_SHELL"], ["ad rules pause " + words], ["Write-Output " + words + "; ad rules pause --all", { platform: "win32", tool: "PowerShell" }]]) {
    const t0 = Date.now();
    const r = spOn(c, opts);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `${ms} ms for ${c.slice(0, 20)}…`);
    assert.equal(r?.decision, "deny", c.slice(0, 20));
  }
});

test("review round 4: data is cut only where its own command sits, sed addresses, alias values, edit code, and bounded expansions", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  const ps = { platform: "win32", tool: "PowerShell" };
  for (const c of [
    // H2 a reader's copy of the words never hides the real command
    "unset AD_TOOL_SHELL; printenv AD_TOOL_SHELL; bash x.sh", "export AD_TOOL_SHELL=; printenv AD_TOOL_SHELL", "env -u AD_TOOL_SHELL bash x.sh; printenv AD_TOOL_SHELL", "printenv AD_TOOL_SHELL; unset AD_TOOL_SHELL",
    `echo "NODE_OPTIONS"=--require=/tmp/x.js; NODE_OPTIONS=--require=/tmp/x.js ad remember y`, `echo "HOME"=/tmp/h; HOME=/tmp/h claude -p hi`, "ad rules pause; echo ad rules pause", "echo ad review; ad review",
    // M3 sed's e command after an address
    "sed -n '1e ad rules pause' f", "sed '$e ad review' f", "sed '/x/e ad rules pause' f", "sed -e '1!e ad review' f",
    // M4 an alias's value is a command line
    "alias x='npx agent-daemon rules pause'\nx", "alias x='command ad rules pause'\nx", "alias x='env ad rules pause'\nx", "alias x='true; ad rules pause'\nx",
    // L6 more ways code starts a process; bash runs backticks inside double quotes
    `awk 'BEGIN{system("ad review")}'`, `ruby -ropen3 -e 'Open3.capture2("ad rules pause")'`, `perl -e 'readpipe("ad rules pause")'`, "node -e \"fs.writeFileSync('a.md', s.replace('`ad review`', 'x'))\"",
    `node - <<< "require('child_process').execSync('ad review')"`,
  ]) want("deny", c);
  for (const c of ["$env:AD_TOOL_SHELL=''; type env:AD_TOOL_SHELL; & ./x.ps1", "$env:AD_TOOL_SHELL=''; Get-Content env:AD_TOOL_SHELL", "Get-Item Env:AD_TOOL_SHELL | Set-Item -Value x", "Set-Content env:AD_TOOL_SHELL x"]) want("deny", c, ps);
  want("ask", "uwsm-app -- htop");
  for (const c of [
    // M5 false positives
    "perl -pi -e 's/`ad review`/`ad review --list`/g' README.md", "perl -pi -e 's/exec ad review/x/' f", `ruby -pi -e 'gsub("system ad review", "x")' f`, "node -e \"fs.writeFileSync('a.md', s.replace('\\`ad review\\`', 'x'))\"",
    "python3 - <<'EOF'\nimport re\ns=open('x.md').read().replace('`ad review`','x')\nEOF", "source .venv/bin/activate && pip install requests", ". ~/.nvm/nvm.sh && nvm install 20", `eval "$(pyenv init -)" && pyenv install 3.12`,
    "grep -rn 'Remove-Item env:AD_TOOL_SHELL' docs/", `rg -n "env:AD_TOOL_SHELL" runtime/src/cli.mjs`, "git log -S 'env:AD_TOOL_SHELL' -- src/cli", `echo "\${AD_TOOL_SHELL:-unset}"`, "awk '/ad review/ {print NR}' f", "echo ad review; echo ad review",
    `python3 -c "import os; print('AD_TOOL_SHELL' in os.environ)"`,
  ]) want("allow", c);
  want("allow", "(Get-Item Env:AD_TOOL_SHELL).Value | Set-Content out.txt", ps);
  assert.deepEqual(misses, []);
  // H1 brace expansion, unfound words, long argument lists: each well under 1 s, still decided.
  for (const c of ["x {" + ",".repeat(60000) + " ; ad review", "x " + "a".repeat(60000) + " {a,b}; ad review", "x " + "A".repeat(30000) + "{" + ",".repeat(30000) + "}; ad review", "echo " + "'a'b ".repeat(12000) + "; ad rules pause", "alias " + "x=y ".repeat(15000) + "; ad review"]) {
    const t0 = Date.now();
    const r = spOn(c);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `${ms} ms for ${c.slice(0, 20)}…`);
    assert.equal(r?.decision, "deny", c.slice(0, 20));
  }
});

test("review round 5: placement stays inside its own command, dynamic calls in code, shell scripts' own line checks, and env-drive pipelines", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  const ps = { platform: "win32", tool: "PowerShell" };
  for (const c of [
    // H1 a decoy in a substitution or another command never cuts the real one
    `echo; unset AD_TOOL_SHELL; grep "$(echo unset AD_TOOL_SHELL)" f; ./x.sh`, `echo && unset AD_TOOL_SHELL && grep "$(echo unset AD_TOOL_SHELL)" f`, "unset AD_TOOL_\\\nSHELL; ./x.sh",
    // H2 process calls by a looked-up or evaluated name, and division isn't a regex
    `python3 -c "import os; getattr(os, 'system')('ad rules pause')"`, `python3 -c "__import__('subprocess').call(['ad', 'rules', 'pause'])"`, `node -e "eval('require(\\"child_process\\").execSync(\\"ad rules pause\\")')"`, `ruby -e 'send("system", "ad rules pause")'`, `php -r '$f = "system"; $f("ad rules pause");'`,
    `python3 -c "import os; h = 10 / 2; os.system('ad rules pause'); print(h / 2)"`, `node -e "const h = 10 / 2; require('child_process').execSync('ad rules pause'); console.log(h / 2)"`,
    // H3 a shell's script gets the line's own checks
    "bash -c 'export NODE_OPTIONS=--require=/tmp/e.js; ad remember x'", "bash -c 'ad remember x &'", "bash -c 'HOME=/tmp/h claude -p hi'",
    // M4 unsetting a built name after a keyword or wrapper; brace expansion of a whole word
    "v=AD_TOOL_SHEL; if :; then unset ${v}L; fi", "v=AD_TOOL_SHEL; builtin unset ${v}L", "v=AD_TOOL_SHEL; env --unset=${v}L ./x.sh", "unset A{D,}_TOO{L,}_SHEL{L,}; ./x.sh",
    // L7, L8 heredoc strip within one command; sed ranges
    "cat README.md; bash <<'EOF'\nunset AD_TOOL_SHELL\n./x.sh\nEOF", "sed '/a/,/b/e ad rules pause' f", "sed --expression='1e ad rules pause' f",
  ]) want("deny", c);
  for (const c of ["gi env:AD_TOOL_SHELL | % { ri $_.PSPath }", "Get-Item Env:AD_TOOL_SHELL | ForEach-Object { Remove-Item $_.PSPath }", "$v = Get-Item Env:AD_TOOL_SHELL; Remove-Item $v.PSPath"]) want("deny", c, ps);
  for (const c of ["ad remember x &", "export NODE_OPTIONS=--require=/tmp/e.js; ad remember x"]) {
    const r = SP.selfProtect({ tool_name: "shell", tool_input: { command: ["bash", "-lc", c] }, cwd: "/work/app" }, { host: "codex", platform: "linux", home: HOME.linux, folders: [`${HOME.linux}/.agent-daemon/memory`] });
    if (r?.decision !== "deny") misses.push(`deny (codex): ${c} → ${r?.decision ?? "allow"}`);
  }
  for (const c of [
    "grep -rn \\\n  \"unset AD_TOOL_SHELL\" docs/", "awk '/ad review/ || /ad rules/' docs/a.md", "unset $(compgen -v | grep ^PYTHON); python3 x.py", `eval "$(direnv hook bash)"`, `eval "$(conda shell.bash hook)"`,
    "node -e \"const fs=require('fs');fs.writeFileSync('x.md', fs.readFileSync('x.md','utf8').replace('ad review','ad review --list'))\"", `python3 -c "import json; d=json.load(open('x.json')); print(d['ad review'])"`,
  ]) want("allow", c);
  assert.deepEqual(misses, []);
  // M5 continuations and many commands stay fast and aren't asked about.
  const lines = "docker run --rm \\\n  -v \"$PWD\":/app node:20 npm test\n".repeat(280);
  const t0 = Date.now();
  assert.equal(spOn(lines + "ad doctor")?.decision ?? "allow", "allow");
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  for (const c of ["awk '" + "| ".repeat(30000) + "ad review'", "sed '" + "1e x;".repeat(12000) + "'", 'perl -e "' + "s/a/b/; ".repeat(7000) + ' system ad review"']) {
    const t1 = Date.now();
    spOn(c);
    assert.ok(Date.now() - t1 < 1000, `${Date.now() - t1} ms for ${c.slice(0, 20)}…`);
  }
});

test("the starter safety policy's switch is token-only; its status and help are reads (L7b)", () => {
  for (const c of ["ad safety off", "ad safety on", "teachonce safety off", "npx agent-daemon safety off", "ad --cwd /x safety off"]) assert.equal(spOn(c)?.decision, "deny", c);
  for (const c of ["ad safety status", "ad safety --help", "ad safety"]) assert.equal(spOn(c)?.decision ?? "allow", "allow", c);
  assert.equal(SP.verbClass("ad", ["safety", "off"]).cls, "token");
  // PowerShell's ${env:X} is the variable, not a script block.
  assert.equal(spOn("Remove-Item ${env:USERPROFILE}; ad safety off", { platform: "win32", tool: "PowerShell" })?.decision, "deny");
});

test("review round 6: continuations judged both ways, substitutions never data, code reaching a process by name, perl's s///e, compgen options", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  for (const c of [
    // H1 a continuation inside a quoted heredoc doesn't join the next line
    "cat > build.sh <<'EOF'\ndocker run \\\nEOF\nad rules pause", "cat > b.sh <<'EOF'\nx \\\nEOF\nHOME=/tmp/h claude -p hi",
    // H2 a reader's argument holding a substitution runs it
    `echo "$(unset AD_TOOL_SHELL; ./x.sh)"`, `printf '%s\\n' "$(unset AD_TOOL_SHELL; ./x.sh)"`, `echo "$(HOME=/tmp/h claude -p hi)"`, `echo "$(AD_ROOT=/tmp/r ad remember y)"`, `echo "$(export NODE_OPTIONS=--require=/tmp/e.js; ad remember x)"`,
    // H3 a module or method named in a string; perl and ruby pipes
    `node -e "require('child_process')['execSync']('ad rules pause')"`, `perl -e 'open(my $f, "-|", "ad rules pause"); print <$f>'`, `ruby -e 'open("|ad rules pause").read'`,
    // H4 s///e runs its replacement; $s, isn't s///
    `perl -pe 's/^/system("ad rules pause")/e' x`, `perl -e 'my ($s, $t) = (1, 2); system("ad", "rules", "pause")'`,
    // H5 compgen's option values and grep -v; M1 sed's s///e after an address
    "for v in $(compgen -A export); do unset $v; done; ./x.sh", "for v in $(compgen -e | grep -v '^PATH$'); do unset \"$v\"; done", "echo | sed '1s/.*/ad rules pause/e'", "echo | sed '/x/s/.*/ad rules pause/e'",
  ]) want("deny", c);
  want("deny", "$s = @'\nline `\n'@\nad rules pause", { platform: "win32", tool: "PowerShell" });
  for (const c of ["ad review --list | python3 process.py", "cat <<'EOF' > notes.md\nRun `ad review` and `ad rules pause` yourself.\nEOF", "unset $(compgen -v | grep ^PYTHON); python3 x.py"]) want("allow", c);
  assert.deepEqual(misses, []);
  // M2 placement within a compare budget: fast, and still decided.
  for (const c of ["e " + "e ".repeat(15000) + "$((1)) # " + "e ".repeat(15000), "docker run --rm \\\n  -v x:/app node:20 npm test\n".repeat(250) + "ad doctor"]) {
    const t0 = Date.now();
    const r = spOn(c);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms for ${c.slice(0, 20)}…`);
    assert.equal(r?.decision ?? "allow", "allow", c.slice(0, 20));
  }
});

test("review round 7: compgen greps, built safety verbs, interpreters' option values, perl-only s///, substitution words and comments, one join", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  const ps = { platform: "win32", tool: "PowerShell" };
  for (const c of [
    // H1 a grep pattern that may match the marker
    "unset $(compgen -v | grep TOOL)", "unset $(compgen -v | grep -i tool)", "env -u $(compgen -v | grep TOOL) ./x.sh", "unset $(compgen -v | grep -E 'X|TOOL')",
    // H2 safety's subcommand built at run time
    "m=off; ad safety $m", `ad safety "$(echo off)"`, "a=--apply-all; ad consolidate $a",
    // H3 interpreters' options that take a value
    "python3 -W ignore - <<'EOF'\nimport os; os.system('ad rules pause')\nEOF", `python3 -X utf8 <<< "import os; os.system('ad rules pause')"`, `python3 -W ignore -c "import os; os.system('ad rules pause')"`, `ruby -r json -e 'system("ad rules pause")'`,
    // M4 a string or comment that looks like s/// doesn't hide code
    `perl -e 'print "s/a/"; system("ad rules pause"); print "/"'`, `ruby -e 'x = "s/a/"; system("ad rules pause"); y = "/"'`,
    // M7 a comment's apostrophe, a backslash in single quotes, too many substitutions
    `# don't\nx="$(ad remember x &)"`, `echo 'C:\\' "$(export NODE_OPTIONS=--require=/tmp/e.js; ad remember x)"`, "$(true) ".repeat(17) + `"$(ad remember x &)"`,
    // unquoted heredoc quotes are literal; a Codex-style literal script with $ is itself
    "cat > n.md <<EOF\nit's\nEOF\necho \"$(HOME=/tmp/h claude -p hi)\"",
  ]) want("deny", c);
  for (const c of ["$m='off'; ad safety $m", "ad safety ('o'+'ff')"]) want("deny", c, ps);
  for (const c of [
    // M5 readers with substitutions; M6 <<\EOF; M9 brace lists; L10 a bare AD
    "grep -rn AD_TOOL_SHELL $(git ls-files src)", "rg -n AD_TOOL_SHELL `git ls-files src`", `echo "$(rg -c AD_TOOL_SHELL src)"`, `git commit -m "fix AD_TOOL_SHELL check ($(date +%F))"`,
    "cat <<\\EOF > a.md\nUse `ad rules pause`.\nEOF", "mkdir -p src/{api,ui,db,lib}/{read,write,head,tail}/{a,b,c,d,e}", "cd AD && unset $x", "unset $(compgen -v | grep ^npm_)", "unset $(compgen -v | grep ^PYTHON); python3 x.py",
    // L11 a literal bash -lc script with $; node's process; python's open
    "bash -lc \"grep -rn 'ad review' docs | wc -l; echo $?\"", `node -e "require('fs').writeFileSync('a.md', 'see ad rules list'); process.exit(0)"`, `python3 -c "open('README.md','a').write('| ad review | x |')"`,
  ]) want("allow", c);
  want("allow", 'Write-Output "ad review (draft)"', ps);
  assert.deepEqual(misses, []);
});

test("review round 8: every compgen counts, Codex scripts as the line, a shell's script is data, heredocs in one pass", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  const codex = (c) => SP.selfProtect({ tool_name: "shell", tool_input: { command: ["bash", "-lc", c] }, cwd: "/work/app" }, { host: "codex", platform: "linux", home: HOME.linux, folders: [`${HOME.linux}/.agent-daemon/memory`] })?.decision ?? "allow";
  for (const c of [
    // H1 every compgen on the line; a value letter in a cluster
    "unset $(compgen -v npm_) $(compgen -v AD)", "compgen -v X >/dev/null; for v in $(compgen -v A); do unset \"$v\"; done", "unset $(compgen -vA variable)",
    // M6 # in an unquoted heredoc body is text; $( ) still runs
    "cat > notes.md <<EOF\n# Notes $(ad remember x &)\nEOF", "cat <<EOF\n# $(unset AD_TOOL_SHELL)\nEOF",
    // L7 ruby's -F takes no separate value; L8 a backgrounded shell script
    `ruby -F -e 'system("ad remember x &")'`, "bash -c 'ad remember x' &", `sh -c "ad forget 3" & disown`,
    // L9 perl's code block in a pattern; a long heredoc header; # inside ${ }
    `perl -e 's/(?{system qw(ad remember x)})a//'`, "python3 - <<'EOF' #" + "x".repeat(600) + "\nimport os\nos.system(\"ad remember x &\")\nEOF", "echo ${x// #/} $(ad remember x &)",
  ]) want("deny", c);
  for (const c of ["rg AD_TOOL_SHELL", "grep -rn AD_TOOL_SHELL runtime/src", "git log -S AD_TOOL_SHELL", "AD_ROOT=/tmp/scratch-ad ad remember x"]) if (codex(c) !== "allow") misses.push(`allow (codex): ${c} → ${codex(c)}`);
  for (const c of ["bash -lc 'grep -rn AD_TOOL_SHELL src'", "unset $(compgen -v | grep ^npm_)", "echo hi # $(ad remember x &)"]) want("allow", c);
  assert.deepEqual(misses, []);
  // M4, M5 heredoc heads and compgens in one pass
  for (const c of ["ruby -e '" + "out << line_item_value\n".repeat(2600) + "puts out'", "echo '\n" + "<<A\n".repeat(15000) + "' ; ad status", "ad status; echo " + "compgen ".repeat(7900)]) {
    const t0 = Date.now();
    const r = spOn(c);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms for ${c.slice(0, 20)}…`);
    assert.notEqual(r?.decision, "ask", c.slice(0, 20));
  }
});

test("review round 9: here-strings and unterminated heads aren't heredocs, ${ } keeps its substitutions, backgrounding per shell script, chained heredocs", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  for (const c of [
    // H1 a here-string or a quoted "<<x" never swallows the rest of the line
    `grep foo <<< "bar"\nunset AD_TOOL_SHELL`, `git commit -m "fix <<EOF docs"\nunset AD_TOOL_SHELL`, `git log --grep "<<x"\nad remember x &`, `wc -w <<< 'hello'\necho "$(ad remember x &)"`,
    // M2 a substitution inside ${ }
    `echo "\${X:-$(unset AD_TOOL_SHELL)}"`, `echo "\${X:-$(ad remember x &)}"`,
    // M3 the shell script itself is backgrounded
    "bash -c 'ad remember x' & sleep 1", "bash -c 'ad forget 3' & npm run dev",
    // L6 grep -e may match the marker
    "unset $(compgen -v | grep -e FOO -e SHELL)",
  ]) want("deny", c);
  want("deny", "ad --cwd (Resolve-Path .) rules pause", { platform: "win32", tool: "PowerShell" });
  for (const c of ["npm run dev &\nbash -lc 'ad remember \"dev server runs on 3000\"'", "(cd api && npm start) &\nbash -lc 'ad remember \"api on 8080\"'", "cat <<'A' > a.md; cat <<'B' > b.md\nx\nA\nunset AD_TOOL_SHELL\nB"]) want("allow", c);
  const r = SP.selfProtect({ tool_name: "shell", tool_input: { command: ["powershell.exe", "-Command", "Start-Job { ad remember x }"] } }, { host: "codex", platform: "linux", home: HOME.linux });
  if (r?.decision !== "deny") misses.push(`deny (codex powershell -Command): Start-Job → ${r?.decision ?? "allow"}`);
  assert.deepEqual(misses, []);
});

test("review round 10: chained stdin heredocs, arithmetic << isn't a heredoc, -Command prefixes, Start-Process arguments, a reader's heredoc piped to a shell", () => {
  const misses = [];
  const want = (expect, c, opts) => {
    const got = spOn(c, opts)?.decision ?? "allow";
    if (got !== expect) misses.push(`${expect}${opts?.platform ? ` (${opts.platform})` : ""}: ${JSON.stringify(c).slice(0, 90)} → ${got}`);
  };
  for (const c of [
    "tee a.txt <<'A' >/dev/null; node <<'B'\nx\nA\nrequire(\"child_process\").execSync(\"ad rules pause\")\nB", "let m=1<<2; python3 - <<'EOF'\nimport os; os.system(\"ad remember x\")\nEOF",
    "pwsh -Command 'Start-Job { ad remember x }'", "pwsh -Command 'ad remember x' &", "bash -o pipefail -c 'ad remember x' &", "cat <<'EOF' | sh\nunset AD_TOOL_SHELL\nEOF",
  ]) want("deny", c);
  for (const c of ["Start-Process ad -ArgumentList 'remember','x'", "Start-Process -FilePath ad -ArgumentList 'remember x'"]) want("deny", c, { platform: "win32", tool: "PowerShell" });
  want("allow", "echo $((1<<4)); cat <<'EOF' > notes.md\nunset AD_TOOL_SHELL\nEOF");
  for (const c of [["powershell.exe", "-NoProfile", "-Command", "Start-Job { ad remember x }"], ["pwsh", "-NoLogo", "-NoProfile", "-Command", "ad remember x &"]]) {
    const r = SP.selfProtect({ tool_name: "shell", tool_input: { command: c } }, { host: "codex", platform: "linux", home: HOME.linux });
    if (r?.decision !== "deny") misses.push(`deny (codex): ${c.join(" ")} → ${r?.decision ?? "allow"}`);
  }
  assert.deepEqual(misses, []);
  // A head budget: many heredoc heads stay fast and are decided.
  const tags = Array.from({ length: 4400 }, (_, i) => `T${i}`);
  const c = "cat " + tags.map((t) => "<<" + t).join(" ") + "\n" + tags.join("\n") + "\nad rules pause";
  const t0 = Date.now();
  assert.equal(spOn(c)?.decision, "deny");
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

test("mutation checks: wrappers, remote input text, an unread tail, Codex's quoted argv, sed's e command, unterminated heads", () => {
  const ps = { platform: "win32", tool: "PowerShell" };
  // nohup is a wrapper even without a trailing &
  assert.equal(spOn("nohup ad remember x")?.decision, "deny");
  // keys sent to a window carry their text: a token verb in it denies
  assert.equal(spOn("$w = New-Object -ComObject WScript.Shell; $w.SendKeys('ad rules pause{ENTER}')", ps)?.decision, "deny");
  // a line too long to read whole that names ad: deny
  assert.equal(spOn("echo " + "x".repeat(70 * 1024) + "; ad rules pause")?.decision, "deny");
  // Codex quotes each argv element: a message holding `;` is one word
  const codex = (c) => SP.selfProtect({ tool_name: "shell", tool_input: { command: c } }, { host: "codex", platform: "linux", home: HOME.linux })?.decision ?? "allow";
  assert.equal(codex(["git", "commit", "-m", "fix; ad rules pause"]), "allow");
  // sed's e command runs its text: it isn't a reader's data
  assert.equal(spOn("sed '1e unset AD_TOOL_SHELL' f")?.decision, "deny");
  // an arithmetic << has no terminator: not a heredoc
  assert.equal(spOn("echo $((1<<4)); ad doctor")?.decision ?? "allow", "allow");
});
