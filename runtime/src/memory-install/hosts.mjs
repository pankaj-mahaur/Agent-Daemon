// The hosts the installer knows (P5.3: three; P5.4 adds rows). Facts from
// S-HOSTCFG (vendor docs, 19 Oct 2026).
//
//   claude-code  driver cli: `claude mcp add --scope user` (Claude Code rewrites
//                ~/.claude.json itself, so ad never edits it); default capture
//                hooks when ad init's hooks are in ~/.claude/settings.json, else tools;
//                the server reads CLAUDE_PROJECT_DIR (--host claude-code)
//   codex        driver toml: $CODEX_HOME/config.toml (default ~/.codex); capture tools
//                (its hooks need trust in Codex); the server binds to the session
//                folder. Codex passes servers only a fixed environment, so an
//                AD_ROOT you set goes into the entry's env
//   cursor       driver json: ~/.cursor/mcp.json; capture tools; --project
//                ${workspaceFolder} (Cursor expands it; home never counts as a project)
//
// ctx: { env, home, root (adRoot), node (absolute node), target (absolute launcher
//        or server file), viaLauncher, resolve(name) → resolved command | null }

import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { installedSteps } from "../hooks/routes.mjs";
import { PRODUCT } from "../product.mjs";

export const SERVER_NAME = PRODUCT.mcpServerKey;

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// A settings file read the way setup reads it (comments and trailing commas allowed).
function settingsJson(file) {
  const errors = [];
  const j = parseJsonc(fs.readFileSync(file, "utf8").replace(/^\u{FEFF}/u, ""), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("not JSON");
  return j;
}

/** ad init's hooks are in Claude Code's settings (the prompt hook captures there): a dispatcher route or an older entry. */
export function claudeHasAdHooks(home) {
  try {
    const j = settingsJson(path.join(home, ".claude", "settings.json"));
    return installedSteps(j?.hooks, { live: true }).has("user-prompt-extract");
  } catch {
    return false;
  }
}

/**
 * The agent-daemon-memory plugin is enabled in Claude Code's user settings
 * (`enabledPlugins["<plugin>@<marketplace>"]: true`, the plugin named in product.mjs) → that key, else null.
 * One route per host: with the plugin, the installer leaves Claude Code alone.
 */
export function claudePluginEnabled(home, env = {}) {
  const dir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  try {
    const j = settingsJson(path.join(dir, "settings.json"));
    return Object.entries(j?.enabledPlugins ?? {}).find(([k, v]) => v === true && k.startsWith(`${PRODUCT.plugin}@`))?.[0] ?? null;
  } catch {
    return null;
  }
}

function args(ctx, host, capture, extra = []) {
  return ["--disable-warning=ExperimentalWarning", ctx.target, ...(ctx.viaLauncher ? ["serve"] : []), "--host", host, "--capture", capture, ...extra];
}

export const HOSTS = Object.freeze([
  {
    id: "claude-code",
    name: "Claude Code",
    driver: "cli",
    detect(ctx) {
      if (ctx.resolve("claude")) return { found: true };
      // A ~/.claude folder without the CLI: show the command, run nothing.
      if (exists(path.join(ctx.home, ".claude"))) return { found: true, manualOnly: true, why: "the claude command isn't on PATH" };
      return { found: false };
    },
    defaultCapture: (ctx) => (claudeHasAdHooks(ctx.home) ? "hooks" : "tools"),
    entry: (ctx, capture) => ({ command: ctx.node, args: args(ctx, "claude-code", capture) }),
    where: () => "`claude mcp add` (user scope)",
  },
  {
    id: "codex",
    name: "Codex",
    driver: "toml",
    file: (ctx) => path.join(ctx.env.CODEX_HOME && path.isAbsolute(ctx.env.CODEX_HOME) ? ctx.env.CODEX_HOME : path.join(ctx.home, ".codex"), "config.toml"),
    detect(ctx) {
      const dir = path.dirname(this.file(ctx));
      return { found: Boolean(ctx.resolve("codex")) || exists(dir) };
    },
    defaultCapture: () => "tools",
    entry(ctx, capture) {
      const e = { command: ctx.node, args: args(ctx, "codex", capture) };
      if (ctx.env.AD_ROOT && path.isAbsolute(ctx.env.AD_ROOT)) e.env = { AD_ROOT: ctx.env.AD_ROOT };
      return e;
    },
    where: (ctx) => ctx.display(HOSTS[1].file(ctx)),
  },
  {
    id: "cursor",
    name: "Cursor",
    driver: "json",
    file: (ctx) => path.join(ctx.home, ".cursor", "mcp.json"),
    detect: (ctx) => ({ found: exists(path.join(ctx.home, ".cursor")) }),
    defaultCapture: () => "tools",
    entry: (ctx, capture) => ({ type: "stdio", command: ctx.node, args: args(ctx, "cursor", capture, ["--project", "${workspaceFolder}"]) }),
    where: (ctx) => ctx.display(HOSTS[2].file(ctx)),
  },
  {
    // VS Code with Copilot: the user's portable MCP file, the docs' preferred
    // personal location (the profile mcp.json is the deprecated route). The
    // server starts in the open workspace folder, so it binds to that project.
    id: "vscode",
    name: "VS Code",
    driver: "json",
    file: (ctx) => path.join(ctx.env.COPILOT_HOME && path.isAbsolute(ctx.env.COPILOT_HOME) ? ctx.env.COPILOT_HOME : path.join(ctx.home, ".copilot"), "mcp-config.json"),
    detect(ctx) {
      const appData = ctx.env.APPDATA && path.isAbsolute(ctx.env.APPDATA) ? ctx.env.APPDATA : null;
      const config = ctx.env.XDG_CONFIG_HOME && path.isAbsolute(ctx.env.XDG_CONFIG_HOME) ? ctx.env.XDG_CONFIG_HOME : path.join(ctx.home, ".config");
      const userDirs = ["Code", "Code - Insiders"].flatMap((n) => [appData && path.join(appData, n, "User"), path.join(ctx.home, "Library", "Application Support", n, "User"), path.join(config, n, "User")]).filter(Boolean);
      return { found: Boolean(ctx.resolve("code")) || exists(path.dirname(this.file(ctx))) || userDirs.some(exists) };
    },
    defaultCapture: () => "tools",
    entry: (ctx, capture) => ({ type: "stdio", command: ctx.node, args: args(ctx, "vscode", capture) }),
    where: (ctx) => ctx.display(HOSTS[3].file(ctx)),
  },
  {
    // Gemini CLI: ~/.gemini/settings.json (GEMINI_CLI_HOME moves the .gemini
    // folder). `gemini mcp add` defaults to the project scope and overwrites an
    // existing name, so ad edits the user file itself, its own entry only. The
    // server starts in the CLI's folder and binds to that project. Gemini passes MCP
    // servers only safe variables (HOME, PATH, TMPDIR…), so an AD_ROOT you set goes
    // into the entry's env, as for Codex.
    id: "gemini",
    name: "Gemini CLI",
    driver: "json",
    file: (ctx) => path.join(ctx.env.GEMINI_CLI_HOME && path.isAbsolute(ctx.env.GEMINI_CLI_HOME) ? ctx.env.GEMINI_CLI_HOME : ctx.home, ".gemini", "settings.json"),
    detect(ctx) {
      return { found: Boolean(ctx.resolve("gemini")) || exists(path.dirname(this.file(ctx))) };
    },
    defaultCapture: () => "tools",
    entry(ctx, capture) {
      const e = { command: ctx.node, args: args(ctx, "gemini", capture) };
      if (ctx.env.AD_ROOT && path.isAbsolute(ctx.env.AD_ROOT)) e.env = { AD_ROOT: ctx.env.AD_ROOT };
      return e;
    },
    where: (ctx) => ctx.display(HOSTS[4].file(ctx)),
  },
]);

export const hostById = (id) => HOSTS.find((h) => h.id === id) ?? null;
