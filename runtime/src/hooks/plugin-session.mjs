// The Claude Code plugin's session.start, before any skip (MCP launch plan L3,
// Decision 19). SessionStart fires on startup, resume, clear and compact, so each
// step is idempotent:
//   - the agent-shell marker: `export AD_TOOL_SHELL=1` appended to CLAUDE_ENV_FILE
//     when that line isn't there (the plain form PowerShell's reader takes too;
//     setup's settings `env` covers a sandboxed shell);
//   - the launcher's dists list: this plugin registered by its id, so Claude Code
//     entries of the launcher follow it through updates (only the installed copy:
//     an inline --plugin-dir copy isn't what the id resolves to);
//   - "One terminal step finishes setup", once a week, while no tool.before entry
//     is live, unless the user uninstalled on purpose or no one is watching. D19 named
//     CLAUDE_CODE_CHILD_SESSION for that, but Claude Code (2.1.319) sets it to 1 in every
//     hook's environment, a top-level interactive session's included (probed 8 Nov), so
//     an unwatched session is told by the headless markers prompt-source.mjs uses
//     (CLAUDE_CODE_ENTRYPOINT=sdk-cli, CLAUDE_CODE_SESSION_ATTENDED=0) and ad's workers.
// Each step is best-effort: a hook never fails the session.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, pinnedCommand } from "../product.mjs";
import { distsFile, launcherFile, readDists, registerDist } from "../memory/launch/dists.mjs";
import { adStepInClaudeSettings } from "./routes.mjs";

// tool.before's step: a live entry of ad's (ad init's dispatcher, setup's launcher entry).
const toolBeforeLive = (o) => adStepInClaudeSettings("rules-check", o);

export const ENV_LINE = "export AD_TOOL_SHELL=1";
export const NUDGE_EVERY_MS = 7 * 86_400_000;

/** Append the marker line once. → "added" | "there" | "none" (no file given) */
export function writeEnvMarker(file) {
  if (!file) return "none";
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === ENV_LINE)) return "there";
  fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${ENV_LINE}\n`);
  return "added";
}

const configDir = (env, home) => (env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude"));
const same = (a, b) => {
  const norm = (p) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      // gone or unreadable: compare as spelled
    }
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

/** This plugin's folder: CLAUDE_PLUGIN_ROOT, else three folders up from server/src/hooks/. */
export const ownPluginRoot = (env = process.env) => env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The plugin's record in Claude Code's installed_plugins.json when it is this copy.
 * → { pluginId, pluginsFile } | null
 */
export function pluginRecord({ env = process.env, home, pluginRoot }) {
  if (!pluginRoot) return null;
  const pluginsFile = path.join(configDir(env, home), "plugins", "installed_plugins.json");
  let records;
  try {
    records = JSON.parse(fs.readFileSync(pluginsFile, "utf8"));
  } catch {
    return null;
  }
  for (const [id, entry] of Object.entries(records?.plugins ?? {})) {
    if (!id.startsWith(`${PRODUCT.plugin}@`)) continue;
    const list = Array.isArray(entry) ? entry : [entry];
    if (list.some((r) => typeof r?.installPath === "string" && same(r.installPath, pluginRoot))) return { pluginId: id, pluginsFile };
  }
  return null;
}

/**
 * Register the plugin in the launcher's list (Decision 5) when the launcher is there.
 * → "added" | "same" | "no launcher"
 */
export function registerPlugin(root, rec) {
  if (!fs.existsSync(launcherFile(root))) return "no launcher";
  const file = distsFile(root);
  const d = readDists(file);
  if (!d.unreadable && d.dists.some((x) => x.route === "plugin" && x.pluginId === rec.pluginId && x.pluginsFile === rec.pluginsFile)) return "same";
  registerDist(file, { route: "plugin", pluginId: rec.pluginId, pluginsFile: rec.pluginsFile });
  return "added";
}

const noticesFile = (root) => path.join(root, "memory", "notices.json");

/** A session no person watches: headless (claude -p, any Agent SDK entrypoint) or ad's own worker. */
export const unwatched = (env) => /^sdk(?:-|$)/.test(String(env.CLAUDE_CODE_ENTRYPOINT ?? "")) || env.CLAUDE_CODE_SESSION_ATTENDED === "0" || env.AD_WORKER === "1";

/** The weekly setup line, or null. Records when it was shown. */

export function setupNudge({ root, env = process.env, home, cwd, version, now = new Date(), liveToolBefore = toolBeforeLive }) {
  if (unwatched(env)) return null;
  if (readDists(distsFile(root)).disabledHosts.includes("claude-code")) return null;
  if (liveToolBefore({ env, home, cwd })) return null;
  let notices = {};
  try {
    notices = JSON.parse(fs.readFileSync(noticesFile(root), "utf8")) ?? {};
  } catch {
    // none yet
  }
  const last = Date.parse(notices.setupNudgeAt ?? "");
  if (Number.isFinite(last) && now.getTime() - last < NUDGE_EVERY_MS) return null;
  fs.mkdirSync(path.dirname(noticesFile(root)), { recursive: true });
  const tmp = `${noticesFile(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...notices, setupNudgeAt: now.toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, noticesFile(root));
  const cmd = version ? pinnedCommand("setup", version) : `npx -y ${PRODUCT.package} setup`;
  return `One terminal step finishes setup: run \`${cmd}\` in your own terminal (it marks the agent's shell, so ${PRODUCT.displayName}'s review can tell you from the agent).`;
}

/**
 * All three steps for the plugin's session.start. → the systemMessage to show, or null.
 * @param {{input?: object, env?: object, home: string, root: string, version?: string|null, now?: Date}} o
 */
export async function pluginSessionStart({ input, env = process.env, home, root, version, now }) {
  const quietly = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  quietly(() => writeEnvMarker(env.CLAUDE_ENV_FILE));
  quietly(() => {
    const rec = pluginRecord({ env, home, pluginRoot: ownPluginRoot(env) });
    if (rec) registerPlugin(root, rec);
  });
  const cwd = env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  return quietly(() => setupNudge({ root, env, home, cwd, version, now }));
}
