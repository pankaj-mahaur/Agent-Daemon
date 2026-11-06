// L4c: the rule matcher. The held-out gates are rules-corpus.test.mjs; this
// file holds the development set (a regression guard) and the shapes the
// matcher must see through or leave alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchRule, firstNonOption, flagsPresent } from "../src/rules/match.mjs";
import { commandsIn, programName } from "../src/rules/shell.mjs";
import { projectRelative, globToRegExp } from "../src/rules/paths.mjs";

const dev = readFileSync(fileURLToPath(new URL("./fixtures/rules/dev-guards.jsonl", import.meta.url)), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

test("development set: every block matched, no allow matched (regression guard; it was tuned on)", () => {
  const wrong = dev.filter((it) => matchRule(it.rule, it).match !== (it.expect === "block")).map((it) => `${it.id} (${it.expect})`);
  assert.deepEqual(wrong, []);
});

const npmInstall = { type: "command", program: "npm", subcommands: ["install", "i", "ci", "add"], flags: null };
const rmrf = { type: "command", program: "rm", subcommands: null, flags: ["-rf"] };
const forcePush = { type: "command", program: "git", subcommands: ["push"], flags: ["--force", "-f"] };
const removeItem = { type: "command", program: "Remove-Item", subcommands: null, flags: ["-Recurse"] };
const gen = { type: "write", globs: ["src/gen/**"] };
const lock = { type: "write", globs: ["package-lock.json"] };
const linux = (command) => ({ tool: "Bash", input: { command }, os: "linux", cwd: "/w/app", project_root: "/w/app" });
const pwsh = (command) => ({ tool: "PowerShell", input: { command }, os: "windows", cwd: "C:\\w\\app", project_root: "C:\\w\\app" });
const codexWin = (command) => ({ tool: "shell", input: { command }, os: "windows", cwd: "C:\\w\\app", project_root: "C:\\w\\app" });
const file = (tool, input, os = "linux", cwd = "/w/app", root = cwd) => ({ tool, input, os, cwd, project_root: root });

const BLOCK = [
  ["plain", npmInstall, linux("npm install")],
  ["chain", npmInstall, linux("cd web && npm i lodash")],
  ["env, sudo -u, option before verb", npmInstall, linux("FOO=1 sudo -u dev npm --silent install")],
  ["bash -lc", npmInstall, linux('bash -lc "npm ci"')],
  ["quote concat", npmInstall, linux('n"p"m install')],
  ["substitution", npmInstall, linux("echo x; $(npm install)")],
  ["backticks", npmInstall, linux("x=`npm add y`")],
  ["full path", npmInstall, linux("/usr/local/bin/npm add x")],
  ["line continuation", npmInstall, linux("npm \\\n  install")],
  ["xargs", npmInstall, linux("xargs -n1 npm i < pkgs.txt")],
  ["timeout", npmInstall, linux("timeout 30 npm install")],
  ["heredoc to a shell", npmInstall, linux("bash <<EOF\nnpm install\nEOF")],
  ["if/then", npmInstall, linux("if true; then npm install; fi")],
  ["find -exec", npmInstall, linux("find . -name package.json -execdir npm install \\;")],
  ["call operator and .cmd", npmInstall, pwsh("& 'C:\\Program Files\\nodejs\\npm.cmd' install")],
  ["cmd /c chain", npmInstall, pwsh('cmd /c "npm install && echo ok"')],
  ["Windows case", npmInstall, pwsh("NPM Install")],
  ["Start-Process", npmInstall, pwsh("Start-Process npm -ArgumentList 'install','-g'")],
  ["Invoke-Expression", npmInstall, pwsh('Invoke-Expression "npm ci"')],
  ["-EncodedCommand", npmInstall, pwsh(`powershell -NoProfile -EncodedCommand ${Buffer.from("npm install", "utf16le").toString("base64")}`)],
  ["scriptblock", npmInstall, pwsh("& { npm install }")],
  ["assignment", npmInstall, pwsh("$out = npm install")],
  ["Codex shell on Windows is PowerShell", npmInstall, codexWin("Set-Location web; npm i")],
  ["Codex exec form", npmInstall, { tool: "shell", input: { command: ["bash", "-lc", "npm install"] }, os: "linux", cwd: "/w/app", project_root: "/w/app" }],
  ["rm -rf", rmrf, linux("rm -rf build")],
  ["rm -r -f", rmrf, linux("rm -r -f build")],
  ["sudo rm -fr", rmrf, linux("sudo rm -fr /tmp/x")],
  ["git push --force", forcePush, linux("git push --force origin main")],
  ["git push -f", forcePush, linux("git push -f")],
  ["Remove-Item -Recurse", removeItem, pwsh("Remove-Item -Recurse -Force .\\dist")],
  ["PowerShell alias and abbreviation", removeItem, pwsh("rm -r dist")],
  ["-Param:value", removeItem, pwsh("remove-item dist -recurse:$true")],
  // Review round 1.
  ["an apostrophe in a heredoc inside $( ) (Claude Code's commit form)", forcePush, linux("git commit -m \"$(cat <<'EOF'\nDon't break the build\nEOF\n)\" && git push --force")],
  ["an unbalanced ( in a heredoc inside $( )", forcePush, linux("gh pr create --body \"$(cat <<'EOF'\nfix (part 1\nEOF\n)\"; git push -f")],
  ["an unclosed $( still shows what follows", npmInstall, linux("echo \"$(date; npm install")],
  ["git -C dir push", forcePush, linux("git -C ../app push --force")],
  ["git -c k=v", { type: "command", program: "git", subcommands: ["commit"], flags: ["--amend"] }, linux("git -c user.name=x commit --amend")],
  ["npm --prefix dir install", npmInstall, linux("npm --prefix web install")],
  ["kubectl -n ns delete", { type: "command", program: "kubectl", subcommands: ["delete"], flags: null }, linux("kubectl -n prod delete pod x")],
  ["cargo +toolchain", { type: "command", program: "cargo", subcommands: ["test"], flags: null }, linux("cargo +nightly test")],
  ["yarn runs a project binary", { type: "command", program: "jest", subcommands: null, flags: null }, linux("yarn jest --watch")],
  ["pnpm runs a project binary", { type: "command", program: "eslint", subcommands: null, flags: ["--fix"] }, linux("pnpm eslint --fix .")],
  ["rm -Rf", rmrf, linux("rm -Rf build")],
  ["rm --recursive --force", rmrf, linux("rm --recursive --force build")],
  ["cmd start with an empty title", npmInstall, pwsh('cmd /c start "" npm install')],
  ["Start-Process -ArgumentList @()", npmInstall, pwsh("Start-Process npm -ArgumentList @('install')")],
  ["Start-Process -ArgumentList '-g','install'", { type: "command", program: "npm", subcommands: ["install"], flags: ["-g"] }, pwsh("Start-Process npm -ArgumentList '-g','install'")],
  ["eval", npmInstall, linux('eval "npm install"')],
  ["here-string into a shell", npmInstall, linux("bash <<< 'npm install'")],
  ["echo piped into sh", npmInstall, linux("echo 'npm install' | sh")],
  ["watch with one string", { type: "command", program: "npm", subcommands: ["test"], flags: null }, linux("watch -n 5 'npm test'")],
  ["a function body", rmrf, linux("function f { rm -rf x; }; f")],
  ["cmd for … do", { type: "command", program: "del", subcommands: null, flags: ["/s"] }, pwsh('cmd /c "for %i in (a b) do del /s %i"')],
  ["cmd /c with a quoted program path", npmInstall, pwsh('cmd /c "C:\\Program Files\\nodejs\\npm.cmd" install')],
  ["the wrapper itself", { type: "command", program: "sudo", subcommands: null, flags: null }, linux("sudo apt update")],
  ["python -m pip", { type: "command", program: "pip", subcommands: ["install"], flags: null }, linux("python3 -m pip install x")],
  ["Codex apply_patch through the shell tool", gen, { tool: "shell", input: { command: ["apply_patch", "*** Begin Patch\n*** Add File: src/gen/x.ts\n+x\n*** End Patch"] }, os: "linux", cwd: "/w/app", project_root: "/w/app" }],
  ["Git Bash path on Windows", gen, file("Write", { file_path: "/c/w/app/src/gen/a.ts" }, "windows", "C:\\w\\app")],
  ["glob braces", { type: "write", globs: ["*.{pem,key}"] }, file("Write", { file_path: "/w/app/certs/x.key" })],
  // Review round 2.
  ["$( ) in an unquoted heredoc runs", npmInstall, linux("cat <<EOF\n$(npm install)\nEOF")],
  ["su -c", npmInstall, linux("su dev -c 'npm install'")],
  ["script -c", npmInstall, linux("script -q -c 'npm install' /dev/null")],
  ["flock", npmInstall, linux("flock /tmp/lock npm install")],
  ["busybox", rmrf, linux("busybox rm -rf x")],
  ["php artisan", { type: "command", program: "artisan", subcommands: ["migrate:fresh"], flags: null }, linux("php artisan migrate:fresh --seed")],
  ["Write absolute", gen, file("Write", { file_path: "/w/app/src/gen/a.ts" })],
  ["Edit relative to a subfolder", gen, file("Edit", { file_path: "gen/b.ts" }, "linux", "/w/app/src", "/w/app")],
  ["two .. up from a deeper folder", gen, file("Edit", { file_path: "../../src/gen/b.ts" }, "linux", "/w/app/a/b", "/w/app")],
  ["two .. in a patch", gen, file("apply_patch", { patch: "*** Begin Patch\n*** Add File: ../../src/gen/n.ts\n+x\n*** End Patch" }, "linux", "/w/app/a/b", "/w/app")],
  ["Windows case and backslashes", gen, file("Write", { file_path: "C:\\w\\app\\SRC\\Gen\\a.ts" }, "windows", "C:\\w\\app")],
  ["\\\\?\\ path", gen, file("Write", { file_path: "\\\\?\\C:\\w\\app\\src\\gen\\a.ts" }, "windows", "C:\\w\\app")],
  ["apply_patch update", gen, file("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/gen/x.ts\n@@\n-a\n+b\n*** End Patch" })],
  ["apply_patch move into", gen, file("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/x.ts\n*** Move to: src/gen/x.ts\n*** End Patch" })],
  ["root file", lock, file("Edit", { file_path: "/w/app/package-lock.json" })],
];
const ALLOW = [
  ["package runner is not npm", npmInstall, linux("npx jest")],
  ["other verb", npmInstall, linux("npm view lodash")],
  ["npm run", npmInstall, linux("npm run install-deps")],
  ["string", npmInstall, linux('echo "npm install"')],
  ["commit message", npmInstall, linux('git commit -m "npm install fix"')],
  ["search", npmInstall, linux("grep -r 'npm install' docs/")],
  ["comment", npmInstall, linux("ls # then npm install")],
  ["data heredoc", npmInstall, linux("cat > notes.sh <<EOF\nnpm install\nEOF")],
  ["PowerShell string expression", npmInstall, pwsh('"npm install"')],
  ["other program", npmInstall, linux("pnpm install")],
  ["command -v", npmInstall, linux("command -v npm")],
  ["rm without -f", rmrf, linux("rm -r build")],
  ["--force-with-lease", forcePush, linux("git push --force-with-lease")],
  ["other git verb", forcePush, linux("git stash push -f")],
  ["other cmdlet", removeItem, pwsh("Remove-ItemProperty -Path x -Name y")],
  ["prefix path", gen, file("Write", { file_path: "/w/app/src/generated/a.ts" })],
  ["outside the project", lock, file("Edit", { file_path: "/w/other/package-lock.json" })],
  ["shell redirect (a stated limit)", gen, linux("echo x > src/gen/a.ts")],
  ["command rule ignores file content", npmInstall, file("Write", { file_path: "/w/app/setup.sh", content: "npm install" })],
  ["Linux is case-sensitive", gen, file("Write", { file_path: "/w/app/SRC/gen/a.ts" })],
  ["a comment holding a chain", npmInstall, linux("ls # later: cd x && npm install")],
  ["a PowerShell string is printed, not run", { type: "command", program: "jest", subcommands: null, flags: null }, pwsh('"jest"')],
  ["command -v looks a program up", { type: "command", program: "jest", subcommands: null, flags: null }, linux("command -v jest")],
  ["Codex apply_patch carries its patch in command", npmInstall, { tool: "apply_patch", input: { command: "*** Begin Patch\n*** Update File: setup.sh\n@@\n npm install\n+echo done\n*** End Patch" }, os: "linux", cwd: "/w/app", project_root: "/w/app" }],
  ["another Windows drive", gen, file("Write", { file_path: "D:\\w\\app\\src\\gen\\a.ts" }, "windows", "C:\\w\\app")],
  // Review round 1: case is exact for native programs; prefixes only for cmdlets.
  ["git branch -d is not -D (Windows)", { type: "command", program: "git", subcommands: ["branch"], flags: ["-D"] }, pwsh("git branch -d x")],
  ["rubocop -a is not -A", { type: "command", program: "rubocop", subcommands: null, flags: ["-A"] }, { ...pwsh("rubocop -a"), tool: "Bash" }],
  ["git clean -fd is not -fdx (PowerShell)", { type: "command", program: "git", subcommands: ["clean"], flags: ["-fdx"] }, pwsh("git clean -fd")],
  ["an anchored glob is the root file only", { type: "write", globs: ["/package.json"] }, file("Edit", { file_path: "/w/app/web/package.json" })],
  ["a bad glob matches nothing", { type: "write", globs: ["[z-a]"] }, file("Write", { file_path: "/w/app/z" })],
  ["$( ) in a quoted heredoc is text", npmInstall, linux("cat <<'EOF'\n$(npm install)\nEOF")],
  ["find's single-dash words aren't letters", { type: "command", program: "find", subcommands: null, flags: ["-delete"] }, linux("find . -depth -mtime +7 -ls")],
];

test("the shapes the matcher sees through", () => {
  for (const [why, rule, call] of BLOCK) assert.equal(matchRule(rule, call).match, true, why);
});

test("look-alikes it leaves alone", () => {
  for (const [why, rule, call] of ALLOW) assert.equal(matchRule(rule, call).match, false, why);
});

test("helpers: program names, the first non-option, flags", () => {
  assert.equal(programName("C:\\Program Files\\nodejs\\npm.CMD"), "npm");
  assert.equal(programName("./node_modules/.bin/jest"), "jest");
  assert.equal(firstNonOption(["--silent", "install"]), "install");
  assert.equal(firstNonOption(["--", "-rf"]), "-rf");
  assert.equal(firstNonOption(["/s", "dir"], { windows: true }), "dir");
  assert.equal(flagsPresent(["-rf"], ["-f", "x", "-r"]), true);
  assert.equal(flagsPresent(["-rf"], ["--", "-rf"]), false, "after -- it is a file name");
  assert.equal(flagsPresent(["--force"], ["--force=true"]), true);
  assert.equal(flagsPresent(["-Recurse"], ["-rec"], { program: "Remove-Item" }), true);
  assert.deepEqual(commandsIn("a | b && c; d &").map((c) => c.argv[0]), ["a", "b", "c", "d"]);
});

test("paths and globs", () => {
  assert.equal(projectRelative("../src/x.ts", { cwd: "/w/app/lib", root: "/w/app", os: "linux" }), "src/x.ts");
  assert.equal(projectRelative("../../etc/x", { cwd: "/w/app/lib", root: "/w/app", os: "linux" }), null);
  assert.equal(projectRelative("/w/app-old/x", { cwd: "/w/app", root: "/w/app", os: "linux" }), null);
  assert.equal(projectRelative("c:/W/APP/x", { cwd: "C:\\w\\app", root: "C:\\w\\app", os: "windows" }), "x");
  assert.ok(globToRegExp("**/*.snap").test("a/b/c.snap"));
  assert.ok(globToRegExp("**/*.snap").test("c.snap"), "**/ matches zero folders");
  assert.ok(globToRegExp("vendor/**").test("vendor/x/y.go"));
  assert.ok(!globToRegExp("vendor/**").test("vendored/x"));
  assert.ok(globToRegExp(".env*").test(".env.local"));
  assert.ok(globToRegExp("src/gen").test("src/gen/a.ts"), "a folder without a wildcard covers what is under it");
});

test("input too long or nested too deep to read whole: a match when it names the program (the caller asks)", () => {
  const big = linux(`echo ${"x".repeat(70_000)} && npm install`);
  assert.deepEqual(matchRule(npmInstall, big), { match: true, incomplete: true });
  assert.equal(matchRule(rmrf, big).match, false, "a program it doesn't name");
  const deep = Array.from({ length: 10 }).reduce((s) => `bash -c ${JSON.stringify(s)}`, "npm install");
  assert.equal(matchRule(npmInstall, linux(deep)).match, true);
});

test("a malformed rule never throws", () => {
  assert.equal(matchRule({ type: "command", program: "npm", subcommands: "install", flags: null }, linux("npm install")).match, true, "a string is a one-item list");
  assert.equal(matchRule({ type: "write", globs: "src/gen/**" }, file("Write", { file_path: "/w/app/src/gen/a" })).match, true);
  assert.equal(matchRule({ type: "command" }, linux("npm install")).match, false);
  assert.equal(matchRule(null, linux("npm install")).match, false);
  assert.equal(matchRule(npmInstall, null).match, false);
});

test("hostile input stays fast and bounded", () => {
  const deep = Array.from({ length: 20 }).reduce((s) => `bash -c ${JSON.stringify(s)}`, "npm install");
  for (const command of ["a".repeat(200_000), "$(".repeat(5000), "'".repeat(10_001), "npm " + "-x ".repeat(20_000), deep, "x | ".repeat(10_000)]) {
    const t = performance.now();
    matchRule(npmInstall, linux(command));
    assert.ok(performance.now() - t < 2000, `${command.slice(0, 20)}… took ${Math.round(performance.now() - t)} ms`);
  }
});
