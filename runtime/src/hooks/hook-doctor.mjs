// `ad doctor`'s checks of ad's hooks (plan L2): a step run from two entries
// (Claude Code's settings files, the memory plugin), the rules check's
// fail-closed mode and the Claude Code version it needs, Codex hook trust,
// and the hook log's tail. Pure functions: cli-full.mjs reads the files and
// the engine, these turn what was read into doctor rows.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXEC_FORM_MIN_VERSION, OLD_PLUGIN_TAGS, duplicateSteps, entryAlive, ourHandlers } from "./routes.mjs";
import { HOSTS, cmpVersion } from "./host-capabilities.mjs";

const PLUGIN_NAME = "agent-daemon-memory";
const claudeDir = (env, home) => (env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude"));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * The memory plugin, when it is on in Claude Code: its key, version, and
 * whether it predates the hook dispatcher. Such a plugin's duplicate guard
 * only knows ad's older `ad hook …` entries, so next to ad init's routes every
 * memory step runs twice. outdated: null when its files can't be read.
 * @returns {{key:string, version:string|null, outdated:boolean|null}|null}
 */
export function memoryPluginState({ env = process.env, home = os.homedir(), cwd = env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const dir = claudeDir(env, home);
  // On in the user's settings or a project's (shared or local).
  const files = [path.join(dir, "settings.json"), ...(cwd ? [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")] : [])];
  const key = files.map((f) => Object.entries(readJson(f)?.enabledPlugins ?? {}).find(([k, v]) => v === true && k.startsWith(`${PLUGIN_NAME}@`))?.[0]).find(Boolean);
  if (!key) return null;
  const entry = readJson(path.join(dir, "plugins", "installed_plugins.json"))?.plugins?.[key];
  const rec = Array.isArray(entry) ? entry.find((x) => x?.scope === "user") ?? entry[0] : entry;
  let outdated = null;
  try {
    if (rec?.installPath) outdated = !/\s--plugin\b/.test(fs.readFileSync(path.join(rec.installPath, "hooks", "hooks.json"), "utf8"));
  } catch {
    // not readable: unknown
  }
  return { key, version: rec?.version ?? null, outdated };
}

/**
 * Claude Code's version from its install, without starting it: the npm
 * package's package.json, or a version in the native install's real path.
 * @returns {Promise<string|null>}
 */
export async function claudeCodeVersion() {
  try {
    const { resolveCommand } = await import("../safe-spawn.mjs");
    const r = resolveCommand("claude");
    const start = r.via === "npm-shim" ? r.prefix?.[0] : r.file ?? r.cmd;
    if (!start) return null;
    let real = start;
    try {
      real = fs.realpathSync.native(start);
    } catch {
      // keep the path as found
    }
    for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const pkg = readJson(path.join(dir, "package.json"));
      if (pkg?.name === "@anthropic-ai/claude-code" && pkg.version) return String(pkg.version);
      if (pkg?.name) break;
    }
    return real.match(/[\\/](\d+\.\d+\.\d+)(?:[\\/]|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The hook script lives in a copy that may go away (an npx cache, a temp
 * folder, a git worktree): settings would then point at nothing. → why, or null.
 */
export function transientInstall(hookPath, { tmp = os.tmpdir() } = {}) {
  const p = path.resolve(hookPath);
  const fold = (s) => (process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s);
  if (/[\\/]_npx[\\/]/.test(p)) return "an npx cache";
  if (fold(p).startsWith(fold(path.resolve(tmp)) + path.sep)) return "a temporary folder";
  const repo = path.resolve(p, "..", "..", "..");
  try {
    if (fs.statSync(path.join(repo, ".git")).isFile()) return "a git worktree";
  } catch {
    // no .git: an installed package
  }
  return null;
}

/**
 * The scripts ad's routes in the settings run: gone (each such hook fails), or
 * in a copy that may go. With no routes, the script `ad init` would write (hookPath).
 */
export function scriptRow(sources, hookPath, { transient = transientInstall } = {}) {
  const routes = sources.flatMap((s) => ourHandlers(s.hooks)).filter((o) => o.info.kind === "dispatcher" && !o.info.plugin && o.info.script);
  const scripts = [...new Set(routes.map((o) => o.info.script))];
  const dead = [...new Set(routes.filter((o) => !entryAlive(o.info)).map((o) => o.info.script))];
  if (dead.length) return { name: "Hook script", ok: false, note: `${dead.join(", ")} ${dead.length === 1 ? "is" : "are"} gone, so those hooks fail: run ad init from the ad you use` };
  const list = scripts.length ? scripts : [hookPath];
  const shaky = list.map((p) => [p, transient(p)]).filter(([, why]) => why);
  if (shaky.length) return { name: "Hook script", ok: false, note: `${shaky.map(([p, why]) => `${p} is in ${why}`).join("; ")}: hooks stop working when it goes. Run ad init from your installed ad` };
  return { name: "Hook script", ok: true, note: list.join(", ") };
}

/** Exec-form routes on a Claude Code older than the version the form was verified on. */
export function execFormRow(sources, claudeVersion) {
  const exec = sources.some((s) => ourHandlers(s.hooks).some((o) => o.info.kind === "dispatcher" && Array.isArray(o.handler.args)));
  if (!exec || !claudeVersion || cmpVersion(claudeVersion, EXEC_FORM_MIN_VERSION) >= 0) return null;
  return { name: "Claude Code version (hooks)", ok: false, note: `${claudeVersion}: ad's hooks use the exec form, verified from ${EXEC_FORM_MIN_VERSION}. Update Claude Code, or run ad init again to write them as command strings` };
}

const label = (file) => {
  const parts = String(file).split(/[\\/]/);
  return parts.slice(-2).join("/");
};

/** A step that runs from more than one of ad's entries, across settings files. */
export function duplicateRow(sources) {
  const dups = duplicateSteps(sources);
  if (!dups.length) return { name: "Hook routes", ok: true, note: "each step runs from one entry" };
  const where = dups.map(({ step, entries }) => `${step} (${entries.map((e) => `${label(e.source)}: ${e.event ?? "an older ad hook entry"}`).join(", ")})`).join("; ");
  return { name: "Hook routes", ok: false, note: `run twice: ${where}. ad init keeps one route each in your settings; remove ad's entries from a project's settings files by hand` };
}

/**
 * The memory plugin is on: say how it and ad init's hooks share the work, and
 * flag a plugin that predates the dispatcher next to ad init's routes.
 * @param {{plugin: ReturnType<typeof memoryPluginState>, sources: object[]}} o
 */
export function pluginRow({ plugin, sources }) {
  if (!plugin) return null;
  const all = sources.flatMap((s) => ourHandlers(s.hooks)).filter((o) => !o.info.plugin);
  const name = `${plugin.key}${plugin.version ? ` ${plugin.version}` : ""}`;
  // Routes the older plugin can't see: without OLD_PLUGIN_TAGS on them.
  const unseen = all.filter((o) => o.info.kind === "dispatcher" && (o.info.event === "prompt.submit" || o.info.event === "session.start") && !String(o.handler.command ?? "").includes(` # ${OLD_PLUGIN_TAGS[o.info.event]}`));
  if (plugin.outdated && unseen.length) return { name: "Memory plugin hooks", ok: false, note: `${name} predates ad's hook dispatcher, so with ad init's hooks each memory step runs twice (notes shown twice). Run ad init again (it writes them in a form this plugin recognises), or update the plugin from Claude Code's /plugin menu` };
  if (plugin.outdated && all.length) return { name: "Memory plugin hooks", ok: true, note: `${name} predates ad's hook dispatcher; ad's prompt and session-start hooks are in its older form, so it stands aside. Update it from Claude Code's /plugin menu, then run ad init again` };
  if (plugin.outdated === null && all.some((o) => o.info.kind === "dispatcher")) return { name: "Memory plugin hooks", ok: true, note: `${plugin.key} is on, and ad couldn't read which version: if notes show twice, update it from Claude Code's /plugin menu` };
  return { name: "Memory plugin hooks", ok: true, note: all.length ? `${name} is on; its hooks pass through where ad init's run, so nothing is captured twice` : `${name} is on and runs the memory hooks` };
}

/** Active rules in the snapshot (not paused). */
export function ruleCount(snapshot) {
  return Object.values(snapshot?.projects ?? {}).reduce((n, p) => n + (p && !p.paused && Array.isArray(p.rules) ? p.rules.length : 0), 0);
}

/**
 * The rules check's mode per host, and the Claude Code version fail-closed needs.
 * @param {{sources: {name:string, hooks:object}[], rules: number, claudeVersion?: string|null}} o
 */
export function failClosedRows({ sources, rules, claudeVersion = null }) {
  const before = sources.flatMap((s) => ourHandlers(s.hooks).filter((o) => o.info.event === "tool.before" && !o.info.plugin));
  if (!before.length) return [];
  const block = before.some((o) => o.handler.onFailure === "block");
  const rows = [
    {
      name: "Rules check mode (Claude Code)",
      ok: block || rules === 0,
      note: block ? "fail-closed: a crashed or timed-out check blocks the tool" : rules ? `advisory although ${rules} rule(s) are set: a crashed or timed-out check lets the tool run` : "advisory: no rules yet, so a crashed check lets the tool run (your first rule makes it fail-closed)",
    },
    { name: "Rules check mode (Codex)", ok: true, note: "advisory: Codex runs the tool when a hook fails or times out, and doesn't support ask, so rules answer deny there" },
  ];
  if (block) {
    const min = HOSTS.claude.minFailClosedVersion;
    const ok = Boolean(claudeVersion) && cmpVersion(claudeVersion, min) >= 0;
    rows.push({ name: "Claude Code version (fail-closed)", ok, note: claudeVersion ? `${claudeVersion}${ok ? "" : `: onFailure needs ${min} or newer, so a crashed check lets the tool run; update Claude Code`}` : `couldn't read Claude Code's version; onFailure needs ${min} or newer` });
  }
  return rows;
}

const EVENT_OF_KEY = /:([a-z_]+):\d+:\d+$/i;

/**
 * Trust of ad's hooks in a Codex home: Codex skips an untrusted or modified
 * hook silently (S-HOOKS), so a rule there isn't enforced.
 * @param {{key?:string, sourcePath?:string, trustStatus:string, eventName?:string}[]} hooks  app-server hooks/list rows
 * @param {string} hooksFile  the hooks.json ad wrote
 * @returns {{trusted:number, total:number, untrusted:string[]}}
 */
export function codexTrust(hooks, hooksFile, { platform = process.platform } = {}) {
  const norm = (p) => {
    const r = path.normalize(String(p ?? ""));
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
  };
  const sourceOf = (h) => h.sourcePath ?? String(h.key ?? "").replace(EVENT_OF_KEY, "");
  const ours = (hooks ?? []).filter((h) => norm(sourceOf(h)) === norm(hooksFile));
  const bad = ours.filter((h) => h.trustStatus !== "trusted" && h.trustStatus !== "managed");
  return { trusted: ours.length - bad.length, total: ours.length, untrusted: bad.map((h) => `${h.eventName ?? String(h.key ?? "").match(EVENT_OF_KEY)?.[1] ?? "?"} (${h.trustStatus})`) };
}

/**
 * The rules snapshot (guards.json) as the rules check reads it.
 * @param {{source:string, warning:string|null}} g  hooks/guards.mjs loadGuards()
 */
export function rulesFileRow(g, file) {
  if (g.source === "current") return { name: "Rules file", ok: true, note: file };
  if (g.source === "none" && !g.warning) return { name: "Rules file", ok: true, note: "no rules yet" };
  // No warning: guards.json is missing (moved aside) and the last good copy reads fine.
  if (g.source === "last-good" && !g.warning) return { name: "Rules file", ok: true, note: `${file} is missing; the rules check uses the last good copy (guards.last-good.json) until ad writes the file again` };
  if (g.source === "last-good") return { name: "Rules file", ok: false, note: `${file} is unreadable; the rules check uses the last good copy (guards.last-good.json). Rules changed since then don't apply: see docs/troubleshooting.md, "The rules file is unreadable"` };
  return { name: "Rules file", ok: false, note: `${file} and its last good copy are unreadable, so no rules apply: see docs/troubleshooting.md, "The rules file is unreadable"` };
}

/** The hook log's last lines. */
export function logRow(lines) {
  return { name: "Hook log", ok: true, note: lines.length ? lines.slice(-3).join(" | ") : "nothing logged" };
}
