// L7 P2b-1 (design D12c): writes to ad's state are stopped; reads pass; the rest of
// `.agent-daemon` stays writable. Shell text (redirects, positionals, option values, data
// positions, readers, git inside ad's root, sqlite3, interpreter code, deletes, links,
// recursive copies) and the file tools (Write, Edit, apply_patch), with paths spelled every
// way a shell or Windows spells them. Plus the parser's additions (redirects, assignments,
// pipes) and the fast path for writes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-state-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_ENV_FILE"]) delete process.env[k];

const SP = await import("../src/hooks/self-protect.mjs");
const TB = await import("../src/hooks/tool-before.mjs");
const { commandsIn } = await import("../src/rules/shell.mjs");

const HOME = { linux: "/home/dev", windows: "C:\\Users\\dev", macos: "/Users/dev" };
const sp = (command, { platform = "linux", tool = "Bash", cwd, home, root, extra = {}, realpath } = {}) => {
  const os_ = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  const h = home ?? HOME[os_];
  const input = { tool_name: tool, tool_input: typeof command === "string" ? { command, ...extra } : command, cwd: cwd ?? (os_ === "windows" ? "C:\\work\\app" : "/work/app"), session_id: "s" };
  return SP.selfProtect(input, { host: "claude", platform, home: h, root, env: {}, uid: 1000, realpath: realpath ?? ((p) => { throw new Error(`no ${p}`); }) })?.decision ?? "allow";
};
const check = (cases, opts) => {
  const wrong = [];
  for (const [want, c] of cases) {
    const got = sp(c, opts);
    if (got !== want) wrong.push(`${want}: ${JSON.stringify(c).slice(0, 110)} → ${got}`);
  }
  assert.deepEqual(wrong, []);
};

test("the parser gives each command its redirects, its own assignments and the command feeding it", () => {
  const f = commandsIn("X=1 Y=2 tee -a f >> g < h 2>&1; echo hi >&2; cat a | sqlite3 b.db");
  assert.deepEqual(f[0].redirects, [{ op: ">>", target: "g", write: true }, { op: "<", target: "h", write: false }]);
  assert.deepEqual(f[0].assigns, ["X=1", "Y=2"]);
  assert.deepEqual(f[1].redirects, []);
  assert.deepEqual(f[3].pipedFrom.argv, ["cat", "a"]);
  assert.deepEqual(commandsIn("echo x &> ~/a.log")[0].redirects, [{ op: "&>", target: "~/a.log", write: true }]);
  assert.deepEqual(commandsIn("Set-Content x > out.txt", { dialect: "powershell" })[0].redirects, [{ op: ">", target: "out.txt", write: true }]);
  assert.deepEqual(commandsIn("echo x > out.txt", { dialect: "cmd" })[0].redirects, [{ op: ">", target: "out.txt", write: true }]);
});

test("writes into ad's state are denied; reads, notes, worktrees and data positions pass (D12c)", () => {
  check([
    // anchored at ad's root
    ["deny", "echo x > ~/.agent-daemon/episodic.db"],
    ["deny", "sed -i 's/a/b/' ~/.agent-daemon/episodic.db"],
    ["deny", "cp evil.json ~/.agent-daemon/guards.json"],
    ["deny", "tee ~/.agent-daemon/hooks/x < y"],
    ["deny", "echo x > $HOME/.agent-daemon/memory/x"],
    ["deny", "echo x > ${HOME}/.agent-daemon/locks/l"],
    ["deny", "touch ~/.agent-daemon/projects.json ~/.agent-daemon/install-ledger.json"],
    ["deny", "echo {} > ~/.agent-daemon/engine/config.toml"],
    ["deny", "echo x > ~/.agent-daemon/recall/served.json"],
    ["deny", "npm i --prefix ~/.agent-daemon left-pad"],
    ["deny", "dd if=/dev/zero of=/home/dev/.agent-daemon/guards.active"],
    ["deny", "echo x > ~/.agent-daemon/projects/p1/learning-journal.jsonl"],
    // cwd tracking
    ["deny", "cd ~/.agent-daemon && echo x > projects.json"],
    ["deny", "cd ~/.agent-daemon/hooks; touch a"],
    // any folder
    ["deny", "echo '{}' > proj/.agent-daemon/project.json"],
    ["deny", "echo x >> .agent-daemon/learning-journal.jsonl"],
    ["deny", "rm -rf proj/.agent-daemon/buffer"],
    // deletes and moves of folders that hold it
    ["deny", "rm -rf ~/.agent-daemon"],
    ["deny", "rm -rf ~/.agent-daemon/memory"],
    ["deny", "mv ~/.agent-daemon /tmp/x"],
    ["deny", "rm -rf ~"],
    ["deny", "rm -rf /"],
    // sqlite3 only reads with a null -init, allow-listed options and only SELECTs on the line
    ["deny", 'sqlite3 ~/.agent-daemon/episodic.db "DELETE FROM learnings"'],
    ["deny", 'sqlite3 ~/.agent-daemon/episodic.db "SELECT 1"'],
    ["deny", 'sqlite3 -init /dev/null ~/.agent-daemon/episodic.db "SELECT writefile(1,2)"'],
    ["deny", 'sqlite3 -init /dev/null -cmd x ~/.agent-daemon/episodic.db "SELECT 1"'],
    ["deny", "sqlite3 -init /dev/null ~/.agent-daemon/episodic.db < cmds.sql"],
    ["allow", 'sqlite3 -init /dev/null -readonly ~/.agent-daemon/episodic.db "SELECT count(*) FROM learnings"'],
    // interpreter code naming a protected path
    ["deny", `python3 -c "open('/home/dev/.agent-daemon/guards.json','w').write('{}')"`],
    ["deny", `node -e "require('fs').writeFileSync('/home/dev/.agent-daemon/hooks/x','')"`],
    // a reader of ad's state piped into a program that can write it
    ["deny", "cat ~/.agent-daemon/episodic.db | sqlite3 x.db"],
    ["allow", "cat ~/.agent-daemon/memory/launch/run.mjs | head -5"],
    // git: reads only inside ad's root; messages are data
    ["allow", "git -C ~/.agent-daemon status"],
    ["deny", "git -C ~/.agent-daemon checkout -- ."],
    ["deny", "cd ~/.agent-daemon && git reset --hard"],
    ["allow", 'git commit -m "touch ~/.agent-daemon/guards.json"'],
    // editors write
    ["deny", "vim ~/.agent-daemon/hooks/tool.sh"],
    // reads and running ad's own code pass
    ["allow", "ls -la ~/.agent-daemon"],
    ["allow", "grep -rn foo ~/.agent-daemon/hooks"],
    ["allow", "cat ~/.agent-daemon/episodic.db | wc -c"],
    ["allow", "node ~/.agent-daemon/memory/launch/run.mjs status"],
    ["allow", "find ~/.agent-daemon -name '*.json'"],
    ["deny", "find ~/.agent-daemon -name '*.json' -delete"],
    ["allow", "echo ~/.agent-daemon/guards.json"],
    ["allow", "cp ~/.agent-daemon/guards.json /tmp/g.json"],
    // the rest of .agent-daemon is writable; ad's workers' worktrees are ordinary
    ["allow", "echo hi > ~/.agent-daemon/notes.md"],
    ["allow", "echo hi > proj/.agent-daemon/handoff.md"],
    ["allow", "echo hi > ~/.agent-daemon/worktrees/w1/a.txt"],
    ["allow", "echo x > ~/.agent-daemon/worktrees/w1/test/fixtures/data.db"], // (a worker's checkout: ordinary files)
    ["allow", "rm -rf ~/.agent-daemon/worktrees/w1"],
    // ask: the user's profile, a .git pointer's records, links and tree copies into a home
    ["ask", "echo hi > ~/.agent-daemon/user.md"],
    ["ask", "echo gitdir: /x > repo/.git/worktrees/w/gitdir"],
    ["ask", "tar -xf x.tar -C ~"],
    ["ask", "unzip pkg.zip -d ~/"],
    ["ask", "rsync -a stage/ ~/"],
    ["ask", "cp -r stage/. ~/"],
    ["ask", "git clone https://example.com/r.git ~"],
    ["ask", "ln -s ~ link"],
    ["ask", "ln -s ~/.agent-daemon proj/ad"],
    ["ask", "echo x > ~/$X/foo"],
    // the host's own state that ad relies on
    ["deny", "echo x > ~/.claude/session-env/s/env"],
    ["deny", "echo {} > ~/.claude/plugins/installed_plugins.json"],
    ["deny", "rm -rf ~/.claude/plugins/cache/agent-daemon/agent-daemon"],
    ["allow", "rm -rf ~/.claude/plugins/cache/other/other"],
    // apply_patch as a shell command
    ["deny", "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: /tmp/p/.agent-daemon/project.json\n+{}\n*** End Patch\nEOF"],
    ["allow", "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch\nEOF"],
  ]);
});

test("Windows and macOS spellings of the same paths", () => {
  check([
    ["deny", "Set-Content -Path $env:USERPROFILE\\.agent-daemon\\guards.json -Value x"],
    ["deny", "echo x > %USERPROFILE%\\.agent-daemon\\episodic.db"],
    ["deny", "echo x > C:\\Users\\dev\\.AGENT-DAEMON\\Episodic.DB"],
    ["deny", "echo x > C:\\Users\\dev\\.agent-daemon.\\guards.json"],
    ["deny", "echo x > \\\\?\\C:\\Users\\dev\\.agent-daemon\\guards.json"],
    ["deny", "echo x > /c/Users/dev/.agent-daemon/guards.json"],
    ["deny", "echo x > C:\\Users\\dev\\AGENT-~1\\guards.json"],
    ["allow", "echo x > C:\\Users\\dev\\.agent-daemon\\notes.md"],
  ], { platform: "win32", tool: "PowerShell" });
  check([["deny", "echo x > /Users/dev/.Agent-Daemon/Guards.json"]], { platform: "darwin" });
  check([["allow", "echo x > /home/dev/.Agent-Daemon/guards.json"]]); // Linux keeps case
});

test("links are followed: a write through a link into ad's state is one", () => {
  const home = path.join(TMP, "home");
  const ad = path.join(home, ".agent-daemon");
  fs.mkdirSync(path.join(ad, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "work"), { recursive: true });
  fs.symlinkSync(ad, path.join(TMP, "work", "ad-link"));
  // Real links in this host's temp folder: judged on this host's own paths.
  const opts = { home, cwd: path.join(TMP, "work"), realpath: (p) => fs.realpathSync.native(p), platform: process.platform === "win32" ? "win32" : "linux" };
  check([
    ["deny", "echo x > ad-link/guards.json"],
    ["deny", "touch ad-link/hooks/new"],
    ["allow", "echo x > ad-link/notes.md"],
  ], opts);
  assert.equal(sp({ file_path: path.join(TMP, "work", "ad-link", "episodic.db"), content: "x" }, { ...opts, tool: "Write" }), "deny");
});

test("the file tools: Write, Edit and apply_patch", () => {
  assert.equal(sp({ file_path: "/home/dev/.agent-daemon/guards.json", content: "{}" }, { tool: "Write" }), "deny");
  assert.equal(sp({ file_path: "/home/dev/.agent-daemon/memory/x.mjs", old_string: "a", new_string: "b" }, { tool: "Edit" }), "deny");
  assert.equal(sp({ file_path: ".agent-daemon/project.json", content: "{}" }, { tool: "Write", cwd: "/work/app" }), "deny");
  assert.equal(sp({ file_path: "/home/dev/.agent-daemon/user.md", content: "x" }, { tool: "Write" }), "ask");
  assert.equal(sp({ file_path: "/home/dev/.agent-daemon/notes.md", content: "x" }, { tool: "Write" }), "allow");
  assert.equal(sp({ file_path: "/work/app/src/a.js", content: "x" }, { tool: "Write" }), "allow");
  const patch = "*** Begin Patch\n*** Update File: src/a.js\n*** Move to: /home/dev/.agent-daemon/hooks/a.js\n*** End Patch";
  const r = SP.selfProtect({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: "/work/app" }, { host: "codex", platform: "linux", home: "/home/dev", env: {}, realpath: () => { throw new Error("x"); } });
  assert.equal(r?.decision, "deny");
});

test("the fast path loads the check for writes that may touch ad's state, and not for ordinary work", () => {
  const t = (tool, ti, cwd) => TB.selfProtectTriggered({ tool_name: tool, tool_input: ti, cwd });
  for (const [tool, ti, cwd] of [
    ["Bash", { command: "echo x > ~/$X/foo" }],
    ["Bash", { command: "rm -rf ~" }],
    ["Bash", { command: "ls" }, "/home/u/.agent-daemon/x"],
    ["Bash", { command: "echo gitdir: x > .git" }],
    ["Bash", { command: "ln -s ~ x" }],
    ["Write", { file_path: "/home/u/.agent-daemon/guards.json" }],
    ["Write", { file_path: "x/.agent-daemon/project.json" }],
  ]) assert.equal(t(tool, ti, cwd), true, JSON.stringify(ti));
  for (const [tool, ti, cwd] of [["Bash", { command: "npm test" }], ["Write", { file_path: "/work/src/a.js" }], ["Edit", { file_path: "src/hooks/x.js" }, "/work"]]) assert.equal(t(tool, ti, cwd), false, JSON.stringify(ti));
});

test("review round 1: variables, globs and braces, copies into a folder, pipes into writers, groups' redirects, code with split paths", () => {
  check([
    ["deny", "D=$HOME/.agent-daemon; rm -rf $D"],
    ["deny", 'AD="$HOME/.agent-daemon" && rm -rf "$AD"'],
    ["deny", 'GIT_DIR="$HOME/.agent-daemon/.git" git reset --hard'],
    ["deny", "rm -rf ~/.agent-daemon/*"],
    ["deny", "rm -rf ~/.agent-daemon/.*"],
    ["deny", "cd ~/.agent-daemon; rm -rf *"],
    ["deny", "rm -rf ~/.agent-daemon/{hooks,memory}"],
    ["deny", "rm ~/.agent-daemon/episodic.d?"],
    ["deny", "cp x ~/.agent-*/guards.json"],
    ["deny", "cp /tmp/evil/guards.json ~/.agent-daemon/"],
    ["deny", "cp -t ~/.agent-daemon /tmp/guards.json"],
    ["deny", `sqlite3 :memory: "attach '/home/dev/.agent-daemon/episodic.db' as e; drop table e.x"`],
    ["deny", "find ~/.agent-daemon -name '*.db' | xargs rm"],
    ["deny", "echo ~/.agent-daemon/guards.json | xargs rm"],
    ["deny", "{ echo x; } > ~/.agent-daemon/guards.json"],
    ["deny", "(echo x) > ~/.agent-daemon/guards.json"],
    ["deny", "> ~/.agent-daemon/guards.json"],
    ["deny", "for i in 1; do echo x; done > ~/.agent-daemon/guards.json"],
    ["deny", `node -e 'fs.writeFileSync(path.join(os.homedir(),".agent-daemon","guards.json"),"")'`],
    ["deny", `node -e 'require("fs").rmSync(os.homedir()+"/.agent-daemon",{recursive:true})'`],
    ["deny", `awk '{print > "/home/dev/.agent-daemon/guards.json"}' x`],
    ["deny", "npm install -g foo --prefix=/home/dev/.agent-daemon"],
    // filters stay filters; ordinary work stays ordinary
    ["allow", "grep -rn x ~/.agent-daemon/memory | sed -n 1,20p"],
    ["allow", "cat ~/.agent-daemon/guards.json | jq ."],
    ["deny", "cat ~/.agent-daemon/guards.json | python3 -m json.tool"], // (not a text filter: the spec's rule)
    ["allow", "rm -rf ~/projects/old-app ~/.cache/pip"],
    ["allow", "cp -r ~/projects/a ~/projects/b"],
  ]);
  check([
    ["deny", "Remove-Item -Recurse ~\\.agent-daemon\\*"],
    ["deny", "gci ~\\.agent-daemon\\hooks | ri -Force"],
    ["deny", "'x' > C:\\Users\\dev\\.agent-daemon\\guards.json"],
    ["deny", `[IO.File]::WriteAllText("$env:USERPROFILE\\.agent-daemon\\guards.json", 'x')`],
    ["deny", "New-Item -ItemType File -Path ~\\.agent-daemon -Name guards.json -Force"],
  ], { platform: "win32", tool: "PowerShell" });
  const t = (command) => TB.selfProtectTriggered({ tool_name: "PowerShell", tool_input: { command } });
  for (const c of ["Remove-Item C:\\Users\\dev\\.agent-daemon\\hooks -Recurse", "Set-Content -Path ~\\.agent-daemon\\guards.json -Value x", "tar -xf x.tar -C ~", "git clone url ~", "find . -name '*.pyc' -delete"]) assert.equal(t(c), true, c);
});

test("review round 2: dot-names and globs, folders that hold state, laundering pipes, stale assignments, ATTACH, braces, copies into folders", () => {
  check([
    // globs never match a leading dot; a narrow glob is judged by its names
    ["allow", "rm -rf dist/*"],
    ["allow", "mv src/* lib/"],
    ["allow", "rm -rf ~/.cache/*"],
    ["allow", "rm -f ~/.agent-daemon/logs/*"],
    ["allow", "rm -f ~/.agent-daemon/*.log"],
    ["deny", "rm -rf ~/.agent-daemon/memory/*"],
    ["deny", "rm -rf ~/.agent-daemon/projects/p*"],
    // folders that hold ad's state
    ["deny", "rm -rf ~/.agent-daemon/projects"],
    ["deny", "mv ~/.agent-daemon/engine /tmp/e"],
    ["deny", "find ~/.agent-daemon/projects -delete"],
    ["deny", "npm install --prefix ~/.agent-daemon/projects x"],
    // pipes through filters still carry the reading
    ["deny", "find ~/.agent-daemon -name '*.db' | grep . | xargs rm -f"],
    ["deny", "ls -d ~/.agent-daemon/* | xargs rm -rf"],
    ["deny", "ls ~/.agent-daemon | sed s/x/y/ | xargs rm -rf"],
    // a later built value replaces an earlier literal one
    ["ask", "D=/tmp/x; D=$(echo ~/.agent-daemon); rm -rf $D"],
    // ATTACH from any SQL it gets
    ["deny", `sqlite3 <<< "ATTACH '/home/dev/.agent-daemon/episodic.db' AS e; DELETE FROM e.t;"`],
    ["deny", `sqlite3 -cmd "ATTACH '/home/dev/.agent-daemon/episodic.db' AS e" /tmp/x.db 'DELETE FROM e.t'`],
    // braces: ranges, products, more than 32
    ["deny", "rm -rf ~/.agent-dae{m..m}on"],
    ["deny", "rm -rf ~/.agent-daemon/{a,b}{c,d}{e,f}{g,h}{i,j}{k,m}{memory,hooks}"],
    ["deny", `rm -rf ~/{${Array.from({ length: 33 }, (_, i) => `a${i}`).join(",")},.agent-daemon}`],
    // a copy or move into an existing state folder
    ["deny", "cp episodic.db ~/.agent-daemon/projects"],
    ["deny", "mv /tmp/learning-journal.jsonl ~/.agent-daemon/projects/p/"],
    // state names in code, sed's w and e
    ["deny", `node -e "fs.writeFileSync(os.homedir()+'/.agent-daemon/projects.json','{}')"`],
    ["deny", "echo '{}' | sed -n '1w /home/dev/.agent-daemon/projects.json'"],
    ["deny", "echo | sed '1e rm -rf /home/dev/.agent-daemon'"],
    // find -exec with a reader stays a read
    ["allow", "find ~ -type f -name '*.md' -exec grep -l TODO {} +"],
    ["deny", "find ~ -name '*.pyc' -delete"],
  ]);
  const t = (command, cwd) => TB.selfProtectTriggered({ tool_name: "Bash", tool_input: { command }, cwd });
  for (const c of ["echo x > ~/.agent-{daemon,x}/guards.json", "cd && rm -rf .agent-d*", "cd ~/.; rm -rf .agent-d*"]) assert.equal(t(c), true, c);
  assert.equal(t("rm -rf .agent-d*", os.homedir()), true);
});

test("review round 3: trailing slashes, readers that write, cd into a glob, values in pieces, project folders, code running deletes", () => {
  check([
    ["deny", "rm -rf ~/.agent-daemon/*/"],
    ["deny", "mv ~/.agent-daemon/*/ /tmp/"],
    ["deny", "rm -rf ~/.*/"],
    ["deny", "uniq /dev/null ~/.agent-daemon/guards.json"],
    ["deny", "cat x | uniq - ~/.agent-daemon/guards.json"],
    ["deny", "xxd -r dump.hex ~/.agent-daemon/episodic.db"],
    ["deny", "find ~/.agent-daemon -name '*.db' -exec sort -o {} /dev/null +"],
    ["deny", "cd ~/.agent-*/ && rm -rf hooks"],
    ["deny", "cd ~/.agent-d* && echo x > guards.json"],
    ["deny", 'D="$HOME"/.agent-daemon; rm -rf $D/hooks'],
    ["deny", `D=~/".agent-daemon"; rm -rf $D/hooks`],
    ["deny", "rm -rf ~/.agent-daemon/projects/myapp"],
    ["deny", "mv ~/.agent-daemon/projects/myapp /tmp/"],
    ["deny", "sqlite3 /tmp/o.db '.shell rm -rf ~/.agent-daemon'"],
    ["deny", `awk 'BEGIN{system("rm -rf ~/.agent-daemon")}'`],
    ["deny", `python3 -c "import os; os.system('rm -rf ~/.agent-daemon')"`],
    ["allow", "ls ~/.agent-daemon/*/"],
    ["allow", "ls ~ | xargs -n1 echo"],
    ["allow", "find ~ -name '*.py' | xargs grep foo"],
  ]);
});

test("review P2b-3: sqlite3's NUL is the null device on Windows only; CLAUDE_ENV_FILE in any spelling; class h's own verbs", () => {
  check([
    ["deny", `sqlite3 -init NUL ~/.agent-daemon/episodic.db "SELECT 1"`],
    ["deny", "echo x >> ${CLAUDE_ENV_FILE:-/tmp/x}"],
    ["deny", "F=$CLAUDE_ENV_FILE; echo x >> $F"],
    ["deny", 'echo x >> "$(dirname "$CLAUDE_ENV_FILE")/x.sh"'],
    ["allow", 'eval "$PM install"'],
    ["allow", 'eval "$TOOL config get x"'],
    ["ask", 'eval "$X review"'],
  ]);
  check([
    ["allow", `sqlite3 -init NUL -readonly $env:USERPROFILE\\.agent-daemon\\episodic.db "SELECT 1"`],
    ["allow", "& ($pm) install"],
  ], { platform: "win32", tool: "PowerShell" });
});
