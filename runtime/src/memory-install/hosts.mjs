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

export const SERVER_NAME = "agent-daemon-memory";

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** ad init's hooks are in Claude Code's settings (the prompt hook captures there). */
export function claudeHasAdHooks(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    return (j?.hooks?.UserPromptSubmit ?? []).some((g) => (g?.hooks ?? []).some((h) => /\bhook user-prompt-extract\b/.test(String(h?.command ?? ""))));
  } catch {
    return false;
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
]);

export const hostById = (id) => HOSTS.find((h) => h.id === id) ?? null;
