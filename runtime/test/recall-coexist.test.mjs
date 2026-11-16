// L6 P5 (design decision 15): other memory on the machine, read-only.
//   - Claude Code auto memory: on by default; off by a setting (any scope, managed
//     included, the highest wins) or by the env variable (the shell's, or a settings
//     file's env); relocated by autoMemoryDirectory; CLAUDE_CONFIG_DIR respected; the
//     folder name maps every non-alphanumeric to "-" (spaces and dots too);
//   - claude-mem: on in Claude Code (off when the user settings say false), on in Codex;
//   - the 3.x learnings block in CLAUDE.md / AGENTS.md;
//   - nothing is written.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-coexist-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const C = await import("../src/memory/recall-coexist.mjs");

let n = 0;
function fixture() {
  const home = path.join(ROOT, `h${n++}`);
  const cwd = path.join(home, "work", "my app.v2");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return { home, cwd, platform: "linux", env: {} };
}
const write = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
};

test("the folder name maps every non-alphanumeric to -", () => {
  assert.equal(C.claudeProjectFolder("/srv/work/My Projects/shop-app"), "-srv-work-My-Projects-shop-app");
  assert.equal(C.claudeProjectFolder("/home/u/.config/x"), "-home-u--config-x");
  assert.equal(C.claudeProjectFolder("C:\\Users\\u\\my app.v2"), "C--Users-u-my-app-v2");
});

test("auto memory: on by default, with its MEMORY.md found and counted", () => {
  const f = fixture();
  const dir = path.join(f.home, ".claude", "projects", C.claudeProjectFolder(f.cwd), "memory");
  write(path.join(dir, "MEMORY.md"), "# Memory\n\n- one\n- two\n");
  const s = C.autoMemoryState(f);
  assert.equal(s.on, true);
  assert.equal(s.why, "default");
  assert.equal(s.memory.lines, 3);
});

test("auto memory: the highest settings scope wins; the env variable beats every setting", () => {
  const f = fixture();
  write(path.join(f.home, ".claude", "settings.json"), { autoMemoryEnabled: false });
  assert.equal(C.autoMemoryState(f).on, false);
  assert.match(C.autoMemoryState(f).why, /user settings/);
  write(path.join(f.cwd, ".claude", "settings.local.json"), { autoMemoryEnabled: true });
  assert.equal(C.autoMemoryState(f).on, true);
  assert.match(C.autoMemoryState(f).why, /local settings/);
  // a settings file's env beats autoMemoryEnabled
  write(path.join(f.cwd, ".claude", "settings.json"), { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
  assert.equal(C.autoMemoryState(f).on, false);
  assert.match(C.autoMemoryState(f).why, /CLAUDE_CODE_DISABLE_AUTO_MEMORY in project settings/);
  // the shell's env beats all of it, both ways
  assert.equal(C.autoMemoryState({ ...f, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } }).on, true);
});

test("auto memory: managed settings count, CLAUDE_CONFIG_DIR moves the user folder, autoMemoryDirectory relocates", () => {
  const f = fixture();
  const cfg = path.join(f.home, "alt-claude");
  write(path.join(cfg, "settings.json"), { autoMemoryDirectory: "~/notes/claude-mem-dir" });
  const s = C.autoMemoryState({ ...f, env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(s.dir, path.join(f.home, "notes", "claude-mem-dir"));
  // the managed file's path is per platform; here only that it is consulted last (highest)
  assert.match(C.managedSettingsFile("linux"), /managed-settings\.json$/);
  assert.match(C.managedSettingsFile("win32"), /ClaudeCode/);
});

test("claude-mem: on in Claude Code from any settings file, off when the user settings say false; on in Codex", () => {
  const f = fixture();
  assert.equal(C.claudeMemState(f).claude, false);
  write(path.join(f.cwd, ".claude", "settings.json"), { enabledPlugins: { "claude-mem@thedotmack": true } });
  assert.equal(C.claudeMemState(f).claude, true);
  write(path.join(f.home, ".claude", "settings.json"), { enabledPlugins: { "claude-mem@thedotmack": false } });
  assert.equal(C.claudeMemState(f).claude, false);
  write(path.join(f.home, ".codex", "config.toml"), '[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
  assert.equal(C.claudeMemState(f).codex, true);
  write(path.join(f.home, ".codex", "config.toml"), '[plugins."claude-mem@claude-mem-local"]\nenabled = false\n');
  assert.equal(C.claudeMemState(f).codex, false);
});

test("the 3.x learnings block is found in CLAUDE.md and AGENTS.md", () => {
  const f = fixture();
  write(path.join(f.cwd, "CLAUDE.md"), "# Project\n<!-- agent-daemon:learnings:start -->\n- use pnpm\n- tabs in go\n<!-- agent-daemon:learnings:end -->\n");
  write(path.join(f.cwd, "AGENTS.md"), "# Agents\nnothing of ours\n");
  assert.deepEqual(C.mirrorBlocks(f.cwd), [{ file: path.join(f.cwd, "CLAUDE.md"), lines: 2 }]);
});

test("nothing is written", () => {
  const f = fixture();
  write(path.join(f.home, ".claude", "settings.json"), { autoMemoryEnabled: true, enabledPlugins: { "claude-mem@thedotmack": true } });
  const snap = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${p}:${fs.statSync(p).mtimeMs}:${fs.statSync(p).size}`);
      }
    };
    walk(dir);
    return out.sort().join("\n");
  };
  const before = snap(f.home);
  C.autoMemoryState(f);
  C.claudeMemState(f);
  C.mirrorBlocks(f.cwd);
  assert.equal(snap(f.home), before);
});
