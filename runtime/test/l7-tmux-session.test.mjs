// L7 P2a-2: the tmux own-session exception (D12b). A `send-keys|new-window|split-window`
// into a session this agent created in this session (recorded per real socket path) isn't
// asked about; the socket is resolved the way tmux resolves it, never through $TMPDIR; a
// running server is asked about the name only by a root-owned tmux at an absolute path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as TS from "../src/hooks/tmux-sessions.mjs";
import * as SP from "../src/hooks/self-protect.mjs";

const UID = 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-tmux-"));
// A realpath stand-in over a fixed set of existing paths (links mapped to their targets).
const fakeReal = (exists, links = {}) => (p) => {
  const q = links[p] ?? p;
  return exists.includes(q) ? q : null;
};

test("the socket is resolved the way tmux does: -S, then -L, then $TMUX, then the default; never $TMPDIR", () => {
  const realpath = fakeReal(["/tmp", "/run/t", "/tmp/tmux-1000", "/run/t/tmux-1000"]);
  const r = (args, env = {}) => TS.resolveSocket(TS.tmuxGlobals(args), { env, uid: UID, realpath, cwd: "/work" });
  assert.equal(r(["-S", "/run/t/sock", "new"]), "/run/t/sock");
  // a relative -S depends on a folder the hook can't follow: never resolved
  assert.equal(r(["-S", "rel/sock", "new"]), null);
  assert.equal(r(["-L", "work", "new"]), "/tmp/tmux-1000/work");
  assert.equal(r(["-L", "work", "new"], { TMUX_TMPDIR: "/run/t" }), "/run/t/tmux-1000/work");
  assert.equal(r(["new"], { TMUX: "/run/t/tmux-1000/x,123,0" }), "/run/t/tmux-1000/x");
  // $TMUX names a -L socket of another server: -L still wins over it
  assert.equal(r(["-L", "work", "new"], { TMUX: "/tmp/tmux-1000/default,1,0" }), "/tmp/tmux-1000/work");
  assert.equal(r(["new"]), "/tmp/tmux-1000/default");
  // a Mac-style TMPDIR is never where tmux looks
  assert.equal(r(["new"], { TMPDIR: "/var/folders/xy/T/" }), "/tmp/tmux-1000/default");
  assert.equal(r(["new"], { TMPDIR: "/run/t" }), "/tmp/tmux-1000/default");
  // TMUX_TMPDIR set but missing: not resolved (tmux would fail or look elsewhere)
  assert.equal(r(["new"], { TMUX_TMPDIR: "/nope" }), null);
  // TMUX_TMPDIR through realpath, as tmux takes it
  const linked = fakeReal(["/tmp", "/real/t", "/real/t/tmux-1000"], { "/link/t": "/real/t" });
  assert.equal(TS.resolveSocket(TS.tmuxGlobals(["new"]), { env: { TMUX_TMPDIR: "/link/t" }, uid: UID, realpath: linked }), "/real/t/tmux-1000/default");
  // anything not literal: not resolved
  assert.equal(r(["-S", "$HOME/s", "new"]), null);
  assert.equal(r(["-L", "a/b", "new"]), null);
  // clustered global options
  assert.equal(r(["-2uS", "/run/t/sock", "new"]), "/run/t/sock");
  assert.equal(r(["-uL", "work", "new"]), "/tmp/tmux-1000/work");
});

test("only a lone tmux command is read, with its own literal TMUX or TMUX_TMPDIR prefix", () => {
  assert.deepEqual(TS.commandEnv("TMUX_TMPDIR=/run/t tmux new -d -s dev", { TMUX: "/x,1,0" }), { TMUX: "/x,1,0", TMUX_TMPDIR: "/run/t" });
  assert.deepEqual(TS.commandEnv("tmux new -d -s dev 'a; b && c'", {}), {});
  for (const line of ["env -u TMUX tmux new -d -s dev", "unset TMUX; tmux new -d -s dev", "TMUX_TMPDIR=$X tmux new -d -s dev", 'export TMUX="$(pwd)"; tmux send-keys -t =dev: x', "false && tmux new -d -s x", "cd /x && tmux -S s new -d -s x", "TMUX=/tmp/tmux-1000/agent,1,0 true; tmux send-keys -t =dev: x Enter", "echo ' TMUX=/a,1'; tmux send-keys -t =dev: x", "env -i tmux new -d -s x", "tmux new -d -s x &", "tmux new -d -s x $(echo y)"]) assert.equal(TS.commandEnv(line, { TMUX_TMPDIR: "/t" }), null, line);
});

test("a new session is recorded only when no session of the user's can have that name", () => {
  const root = tmp();
  const base = { env: {}, uid: UID, cwd: "/work", adRoot: root, sessionId: "s1", realpath: fakeReal(["/tmp", "/tmp/tmux-1000"]) };
  const spawned = [];
  const spawn = (status, stderr = status === 1 ? "can't find session: x" : "") => (bin, args) => {
    spawned.push([bin, ...args]);
    return { status, stderr };
  };
  // no server socket: recorded with no spawn at all
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "dev", "npm run dev"], { ...base, line: "tmux new -d -s dev 'npm run dev'", exists: () => false, spawn: spawn(1), tmuxBin: () => "/usr/bin/tmux" }), true);
  assert.deepEqual(spawned, []);
  assert.deepEqual(TS.readRecords(root, "s1"), [{ socket: "/tmp/tmux-1000/default", name: "dev" }]);
  // a running server that already has the name (the user's): not recorded
  assert.equal(TS.recordNewSession(["tmux", "new-session", "-ds", "mine"], { ...base, line: "tmux new-session -ds mine", exists: () => true, spawn: spawn(0), tmuxBin: () => "/usr/bin/tmux" }), false);
  assert.deepEqual(spawned.at(-1), ["/usr/bin/tmux", "-S", "/tmp/tmux-1000/default", "has-session", "-t", "=mine"]);
  // a running server without it: recorded
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "api"], { ...base, line: "tmux new -d -s api", exists: () => true, spawn: spawn(1), tmuxBin: () => "/usr/bin/tmux" }), true);
  // exit 1 for another reason (no access, a protocol mismatch): not recorded
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "x2"], { ...base, line: "tmux new -d -s x2", exists: () => true, spawn: spawn(1, "error connecting to /tmp/tmux-1000/default (Permission denied)"), tmuxBin: () => "/usr/bin/tmux" }), false);
  // a numeric name (plain tmux's own names), a group join (-t) or an attach (-A): never recorded
  for (const argv of [["tmux", "new", "-d", "-s", "0"], ["tmux", "new", "-d", "-t", "usersess", "-s", "grp"], ["tmux", "new", "-A", "-d", "-s", "dev2"], ["tmux", "new", "-dAs", "dev3"]]) assert.equal(TS.recordNewSession(argv, { ...base, line: argv.join(" "), exists: () => false }), false, argv.join(" "));
  // not a lone tmux command: not recorded
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "y1"], { ...base, line: "false && tmux new -d -s y1", exists: () => false }), false);
  // a chained tmux command, or a backslash in the socket prefix: not recorded
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "y2", ";", "send-keys", "-t", "main", "x"], { ...base, line: "tmux new -d -s y2 ';' send-keys -t main x", exists: () => false }), false);
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "y3"], { ...base, line: "TMUX=/tmp/tmux-1000/defaul\\t tmux new -d -s y3", exists: () => false }), false);
  // no trusted tmux to ask: not recorded (a later send-keys asks)
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "web"], { ...base, line: "tmux new -d -s web", exists: () => true, spawn: spawn(1), tmuxBin: () => null }), false);
  // a failed or timed-out spawn: not recorded
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "x1"], { ...base, line: "tmux new -d -s x1", exists: () => true, spawn: () => ({ status: null, error: new Error("t") }), tmuxBin: () => "/usr/bin/tmux" }), false);
  // not a new-session, no literal name, or an unresolvable socket: nothing
  assert.equal(TS.recordNewSession(["tmux", "send-keys", "-t", "=dev:", "x"], { ...base, line: "tmux send-keys -t =dev: x", exists: () => false }), false);
  assert.equal(TS.recordNewSession(["tmux", "new", "-d"], { ...base, line: "tmux new -d", exists: () => false }), false);
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "$N"], { ...base, line: "tmux new -d -s $N", exists: () => false }), false);
  assert.equal(TS.recordNewSession(["tmux", "new", "-d", "-s", "z"], { ...base, line: "TMUX_TMPDIR=$X tmux new -d -s z", exists: () => false }), false);
  assert.deepEqual(TS.readRecords(root, "s1").map((x) => x.name), ["dev", "api"]);
  // another session's records are its own
  assert.deepEqual(TS.readRecords(root, "s2"), []);
});

test("only a root-owned tmux at a fixed absolute path is ever asked", () => {
  const st = (uid, mode, file = true) => ({ uid, mode, isFile: () => file });
  const table = (m) => (p) => {
    if (!(p in m)) throw new Error("ENOENT");
    return m[p];
  };
  const realpath = (p) => p;
  assert.equal(TS.trustedTmux({ stat: table({ "/usr/bin/tmux": st(0, 0o755), "/usr/bin": st(0, 0o755) }), realpath }), "/usr/bin/tmux");
  assert.equal(TS.trustedTmux({ stat: table({ "/usr/bin/tmux": st(1000, 0o755), "/usr/bin": st(0, 0o755) }), realpath }), null);
  assert.equal(TS.trustedTmux({ stat: table({ "/usr/bin/tmux": st(0, 0o775), "/usr/bin": st(0, 0o755) }), realpath }), null);
  assert.equal(TS.trustedTmux({ stat: table({ "/usr/local/bin/tmux": st(0, 0o755), "/usr/local/bin": st(0, 0o777) }), realpath }), null);
  assert.equal(TS.trustedTmux({ stat: table({ "/usr/local/bin/tmux": st(0, 0o755), "/usr/local/bin": st(0, 0o755) }), realpath }), "/usr/local/bin/tmux");
  // a link out of the fixed folders is judged where it points
  assert.equal(TS.trustedTmux({ stat: table({ "/home/u/bin/tmux": st(0, 0o755), "/home/u/bin": st(0, 0o755) }), realpath: (p) => (p === "/usr/bin/tmux" ? "/home/u/bin/tmux" : p) }), null);
  assert.deepEqual(TS.TRUSTED_TMUX, ["/usr/bin/tmux", "/bin/tmux", "/usr/local/bin/tmux"]);
});

test("send-keys into a recorded session with an exact, session-qualified target isn't asked; anything else is", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "hooks", "tmux"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "tmux", "s.json"), JSON.stringify({ sessions: [{ socket: "/tmp/tmux-1000/default", name: "dev" }, { socket: "/tmp/tmux-1000/work", name: "api" }] }));
  const sp = (command, env = {}, session = "s") => SP.selfProtect({ tool_name: "Bash", tool_input: { command }, cwd: "/work", session_id: session }, { host: "claude", platform: "linux", home: "/home/dev", root, env, uid: UID, realpath: fakeReal(["/tmp", "/tmp/tmux-1000"]) })?.decision ?? "allow";
  assert.equal(sp("tmux send-keys -t '=dev:' 'npm test' Enter"), "allow");
  assert.equal(sp("tmux send-keys -t =dev:0.1 'npm test' Enter"), "allow");
  assert.equal(sp("tmux new-window -t =dev: 'npm run lint'"), "allow");
  assert.equal(sp("tmux -L work send-keys -t =api: 'curl localhost' Enter"), "allow");
  // bare or prefix targets: tmux may resolve them to another pane, window or session
  assert.equal(sp("tmux send-keys -t dev 'npm test' Enter"), "ask");
  assert.equal(sp("tmux send-keys -t =dev 'npm test' Enter"), "ask");
  assert.equal(sp("tmux send-keys -t dev: 'npm test' Enter"), "ask");
  // a name the agent didn't create, another socket, another agent session
  assert.equal(sp("tmux send-keys -t =main: 'ls' Enter"), "ask");
  assert.equal(sp("tmux -L work send-keys -t =dev: 'ls' Enter"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: 'ls' Enter", {}, "other"), "ask");
  assert.equal(sp("TMUX_TMPDIR=/nope tmux send-keys -t =dev: 'ls' Enter"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: 'ls' Enter", { TMUX: "/tmp/tmux-1000/work,1,0" }), "ask");
  // tmux's option parsing: the last -t wins, options end at the first key
  assert.equal(sp("tmux send-keys -t =dev: -t victim: 'cmd' Enter"), "ask");
  assert.equal(sp("tmux send-keys 'echo pwned' Enter -t =dev:"), "ask");
  assert.equal(sp("tmux send-keys -l -t =dev: 'npm test'"), "allow");
  assert.equal(sp("tmux send-keys -N 2 -t =dev: 'j'"), "allow");
  // only a lone tmux command: a prefix elsewhere on the line doesn't move the socket
  assert.equal(sp("TMUX=/tmp/tmux-1000/work,1,0 true; tmux send-keys -t =api: x Enter"), "ask");
  // a token verb typed into its own session is still stopped, split across keys too
  assert.equal(sp("tmux send-keys -t =dev: 'ad rules pause' Enter"), "deny");
  assert.equal(sp("tmux send-keys -t =dev: a 'd rules pause' Enter"), "deny");
  // tmux command chains, options a newer tmux has, key names and hex keys: asked
  assert.equal(sp("tmux send-keys -t =dev: x ';' send-keys -t main 'echo hi' Enter"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: 'x;' new-window -t main"), "ask");
  assert.equal(sp("tmux splitw -T-t=dev: 'echo pwned'"), "ask");
  assert.equal(sp("tmux splitw -m-t=dev: 'echo pwned'"), "ask");
  assert.equal(sp("tmux send-keys -Z -t =dev: x"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: a d Space forget Space --all Enter"), "ask");
  assert.equal(sp("tmux send-keys -H -t =dev: 61 64 20"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: a d 0x20 forget Enter"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: 'ad forgex' BSpace 't --all'"), "ask");
  assert.equal(sp("tmux send-keys -t =dev: 'npm test' C-m"), "allow");
  // round 3: attached option values can't hide what runs; -K goes to a client; C-c and friends type no text
  assert.equal(sp("tmux send-keys -t=dev:t 'ad forget --all' Enter"), "deny");
  assert.equal(sp("tmux new-window -t =dev: -nt 'ad forget --all'"), "deny");
  assert.equal(sp("tmux split-window -t =dev: -eX=t 'ad forget --all'"), "deny");
  assert.equal(sp("tmux send-keys -K -c /dev/pts/4 -t =dev: 'rm -rf x' Enter"), "ask");
  for (const k of ["C-c", "C-d", "Escape", "q"]) assert.equal(sp(`tmux send-keys -t =dev: ${k}`), "allow", k);
  // tmux's own command resolution: prefixes, aliases, global option values
  assert.equal(sp("tmux send-k -t main 'ls' Enter"), "ask");
  // a unique prefix is the command tmux runs: into its own session, no ask
  assert.equal(sp("tmux send-k -t =dev: 'npm test' Enter"), "allow");
  assert.equal(sp("tmux split-pane -t main 'ls'"), "ask");
  assert.equal(sp("tmux splitp -t main 'ls'"), "ask");
  assert.equal(sp("tmux -Tsync send-keys -t main 'ls' Enter"), "ask");
  assert.equal(sp("tmux pipe-pane -I -t main \"printf 'cmd\\n'\""), "ask");
  assert.equal(sp("tmux if true 'send-keys -t main ls Enter'"), "ask");
  assert.equal(sp("tmux zzz -t main x"), "ask");
  assert.equal(sp("tmux ls"), "allow");
  assert.equal(sp("tmux capture-pane -p -t dev"), "allow");
  // round 4: tmux's -c in a cluster; tmux commands with their own separators; stored commands; respawn
  assert.equal(sp("tmux -c'ad review'"), "deny");
  assert.equal(sp("tmux -uc 'ad review'"), "deny");
  assert.equal(sp("tmux if-shell true 'display-message hi ; send-keys -t =main: evil Enter'"), "ask");
  assert.equal(sp("tmux run-shell -C 'send-keys -t =main: evil Enter'"), "ask");
  assert.equal(sp("tmux run -C 'send-keys -t =main: evil Enter'"), "ask");
  assert.equal(sp("tmux set-hook -g session-created 'send-keys -t =main: X Enter'"), "ask");
  assert.equal(sp("tmux set -s 'command-alias[9]' 'ls=send-keys -t =main: X Enter'"), "ask");
  assert.equal(sp("tmux source-file f.conf"), "ask");
  assert.equal(sp("tmux respawn-pane -k -t =main: 'npm test'"), "ask");
  assert.equal(sp("tmux new -d 'ad review'"), "deny");
  assert.equal(sp("tmux kill-session -t =dev"), "allow");
  // a backslash in the prefix: the shell would drop it
  assert.equal(sp("TMUX=/tmp/tmux-1000/defaul\\t tmux send-keys -t =dev: x"), "ask");
  // other remote input still asks
  assert.equal(sp("tmux paste-buffer -t =dev:"), "ask");
});

test("the hook records `tmux new` before it runs, from the shell call it checked", () => {
  const root = tmp();
  const input = (command, session = "s9") => ({ tool_name: "Bash", tool_input: { command }, cwd: "/work", session_id: session });
  const opts = { platform: "linux", root, env: {}, uid: UID, realpath: fakeReal(["/tmp", "/tmp/tmux-1000"]), exists: () => false };
  assert.equal(SP.recordTmuxSessions(input("tmux new -d -s dev 'npm run dev'"), opts), 1);
  assert.equal(SP.recordTmuxSessions(input("tmux new -d -s web"), opts), 1);
  assert.equal(SP.recordTmuxSessions(input("tmux new -d -s api 'x; y'"), opts), 1);
  // only a lone tmux command is recorded
  assert.equal(SP.recordTmuxSessions(input("cd app && tmux new -d -s other 'npm run dev'"), opts), 0);
  assert.equal(SP.recordTmuxSessions(input("tmux new -d -s a1; tmux new -d -s a2"), opts), 0);
  assert.equal(SP.recordTmuxSessions(input("tmux ls"), opts), 0);
  assert.equal(SP.recordTmuxSessions(input("tmux new -d -s w2", "s9"), { ...opts, platform: "win32" }), 0);
  assert.deepEqual(TS.readRecords(root, "s9").map((x) => x.name), ["dev", "web", "api"]);
  const r = SP.selfProtect(input("tmux send-keys -t =web: 'npm test' Enter"), { host: "claude", platform: "linux", home: "/home/dev", root, env: {}, uid: UID, realpath: fakeReal(["/tmp", "/tmp/tmux-1000"]) });
  assert.equal(r, null);
});

test("end to end: the real hook records `tmux new` and lets keys into that session through (posix)", { skip: process.platform === "win32" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = fs.realpathSync(tmp());
  const root = path.join(base, ".agent-daemon");
  const tdir = path.join(base, "tmuxdir"); // TMUX_TMPDIR with no server socket in it
  fs.mkdirSync(tdir);
  const run = (command, session = "e2e") => {
    const input = JSON.stringify({ session_id: session, hook_event_name: "PreToolUse", cwd: base, tool_name: "Bash", tool_input: { command }, permission_mode: "default" });
    const env = { ...process.env, HOME: base, USERPROFILE: base, AD_ROOT: root, TMUX_TMPDIR: tdir };
    delete env.TMUX;
    const r = spawnSync(process.execPath, [path.join(RUNTIME, "bin", "hook.mjs"), "tool.before"], { input, env, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "allow";
  };
  assert.equal(run("tmux send-keys -t '=dev:' 'npm test' Enter"), "ask");
  assert.equal(run("tmux new -d -s dev 'npm run dev'"), "allow");
  assert.deepEqual(TS.readRecords(root, "e2e").map((x) => x.name), ["dev"]);
  assert.equal(run("tmux send-keys -t '=dev:' 'npm test' Enter"), "allow");
  assert.equal(run("tmux send-keys -t '=dev:' 'npm test' Enter", "another"), "ask");
  assert.equal(run("tmux send-keys -t '=dev:' 'ad rules pause' Enter"), "deny");
  // a new session the call wraps a token verb in: denied, and not recorded
  assert.equal(run("tmux new -d -s bad 'ad review'"), "deny");
  assert.deepEqual(TS.readRecords(root, "e2e").map((x) => x.name), ["dev"]);
});
