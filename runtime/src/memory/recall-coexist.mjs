// Other memory on the same machine (MCP launch plan L6, design decision 14): Claude
// Code's own auto memory, the claude-mem plugin, and the learnings block ad 3.x wrote
// into CLAUDE.md. doctor explains each overlap; nothing here writes, and nothing here
// is an error (both tools can stay on).
//
// Sources (8 Nov 2026): Claude Code settings reference and env-vars page
// (autoMemoryEnabled, CLAUDE_CODE_DISABLE_AUTO_MEMORY, autoMemoryDirectory);
// github.com/thedotmack/claude-mem v15.12.0 (plugin ids, data folder).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Claude Code's managed settings file for this platform. */
export function managedSettingsFile(platform = process.platform) {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Claude Code's settings files, lowest precedence first: user, project, local, managed.
 * @returns {{scope: string, file: string, json: object}[]} the ones that exist and parse
 */
export function claudeSettings({ env = process.env, home = os.homedir(), cwd = process.cwd(), platform = process.platform } = {}) {
  const userDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  const files = [
    ["user", path.join(userDir, "settings.json")],
    ["project", path.join(cwd, ".claude", "settings.json")],
    ["local", path.join(cwd, ".claude", "settings.local.json")],
    ["managed", managedSettingsFile(platform)],
  ];
  return files.map(([scope, file]) => ({ scope, file, json: readJson(file) })).filter((s) => s.json && typeof s.json === "object");
}

/** Claude Code's folder name for a project path: every character but a letter or digit becomes "-". */
export const claudeProjectFolder = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");

/**
 * Is Claude Code's auto memory on for this folder, and why.
 * The env variable wins (from the shell or a settings file's env, highest precedence
 * first), then autoMemoryEnabled (highest precedence first), else on by default.
 * @returns {{on: boolean, why: string, file: string|null, dir: string, memory: {file: string, lines: number, bytes: number} | null}}
 */
export function autoMemoryState({ env = process.env, home = os.homedir(), cwd = process.cwd(), platform = process.platform } = {}) {
  const settings = claudeSettings({ env, home, cwd, platform });
  const byPrecedence = settings.slice().reverse();
  let on = true;
  let why = "default";
  let file = null;
  const envFlag = (v) => (v === "1" || v === "true" ? false : v === "0" || v === "false" ? true : null);
  const fromShell = envFlag(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY);
  const fromSettingsEnv = byPrecedence.map((s) => ({ s, v: envFlag(s.json.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY) })).find((x) => x.v !== null);
  const fromSetting = byPrecedence.find((s) => typeof s.json.autoMemoryEnabled === "boolean");
  if (fromShell !== null) {
    on = fromShell;
    why = "CLAUDE_CODE_DISABLE_AUTO_MEMORY in this shell";
  } else if (fromSettingsEnv) {
    on = fromSettingsEnv.v;
    why = `CLAUDE_CODE_DISABLE_AUTO_MEMORY in ${fromSettingsEnv.s.scope} settings`;
    file = fromSettingsEnv.s.file;
  } else if (fromSetting) {
    on = fromSetting.json.autoMemoryEnabled;
    why = `autoMemoryEnabled in ${fromSetting.scope} settings`;
    file = fromSetting.file;
  }
  const custom = byPrecedence.find((s) => typeof s.json.autoMemoryDirectory === "string" && s.json.autoMemoryDirectory.trim());
  const expand = (p) => (p.startsWith("~/") || p === "~" ? path.join(home, p.slice(1)) : p);
  const userDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  const dir = custom ? expand(custom.json.autoMemoryDirectory.trim()) : path.join(userDir, "projects", claudeProjectFolder(cwd), "memory");
  let memory = null;
  const mf = path.join(dir, "MEMORY.md");
  try {
    const text = fs.readFileSync(mf, "utf8");
    memory = { file: mf, lines: text.split(/\r?\n/).filter((l) => l.trim()).length, bytes: Buffer.byteLength(text) };
  } catch {
    // no notes yet
  }
  return { on, why, file, dir, memory };
}

/**
 * Is claude-mem on: in Claude Code (enabledPlugins "claude-mem@…" true in any settings
 * file, unless the user settings say false) and in Codex ([plugins."claude-mem@…"]
 * enabled = true in $CODEX_HOME/config.toml). → {claude, codex, dataDir, data}
 */
export function claudeMemState({ env = process.env, home = os.homedir(), cwd = process.cwd(), platform = process.platform, parseToml } = {}) {
  const settings = claudeSettings({ env, home, cwd, platform });
  const key = (s) => Object.entries(s.json.enabledPlugins ?? {}).find(([k]) => /^claude-mem@/.test(k));
  const user = settings.find((s) => s.scope === "user");
  const userSays = user ? key(user) : null;
  const anyOn = settings.some((s) => key(s)?.[1] === true);
  const claude = anyOn && !(userSays && userSays[1] === false);
  let codex = false;
  const codexHome = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
  try {
    const text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    if (parseToml) {
      const plugins = parseToml(text)?.plugins ?? {};
      codex = Object.entries(plugins).some(([k, v]) => /^claude-mem@/.test(k) && v?.enabled === true);
    } else {
      codex = /\[plugins\."claude-mem@[^"]+"\][^[]*?enabled\s*=\s*true/s.test(text);
    }
  } catch {
    // no Codex config
  }
  const dataDir = env.CLAUDE_MEM_DATA_DIR && path.isAbsolute(env.CLAUDE_MEM_DATA_DIR) ? env.CLAUDE_MEM_DATA_DIR : path.join(home, ".claude-mem");
  return { claude, codex, dataDir, data: fs.existsSync(path.join(dataDir, "claude-mem.db")) };
}

const MIRROR = /<!--\s*agent-daemon:learnings:start\s*-->([\s\S]*?)(?:<!--\s*agent-daemon:learnings:end\s*-->|$)/i;

/** The 3.x learnings block in this project's CLAUDE.md or AGENTS.md → [{file, lines}]. */
export function mirrorBlocks(cwd = process.cwd()) {
  const out = [];
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(cwd, name);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const m = MIRROR.exec(text);
    if (m) out.push({ file, lines: m[1].split(/\r?\n/).filter((l) => l.trim()).length });
  }
  return out;
}
