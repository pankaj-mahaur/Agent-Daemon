// doctor's rows for the Claude Code plugin and Codex's command skills (MCP launch
// plan L3, Decisions 18 and 20). Kept apart from doctor.mjs's own rows:
//   plugin.installed  the plugin's record and its hook dispatcher on disk (no rows when
//                     it isn't installed: the installer's route is checked elsewhere)
//   plugin.version    its hooks use the exec form: Claude Code 2.1.314 or later
//   skills.duplicate  a command skill Codex finds twice ($CODEX_HOME/skills and ~/.agents/skills)

import fs from "node:fs";
import path from "node:path";
import { PRODUCT } from "../product.mjs";
import { EXEC_FORM_MIN_VERSION } from "../hooks/routes.mjs";
import { cmpVersion } from "../memory/launch/dists.mjs";
import { duplicateCodexSkills } from "./codex-skills.mjs";

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const configDir = (ctx) => (ctx.env.CLAUDE_CONFIG_DIR && path.isAbsolute(ctx.env.CLAUDE_CONFIG_DIR) ? ctx.env.CLAUDE_CONFIG_DIR : path.join(ctx.home, ".claude"));

/** The plugin's install record → { id, installPath, version, enabled } | null */
export function installedPlugin(ctx) {
  const records = readJson(path.join(configDir(ctx), "plugins", "installed_plugins.json"));
  const id = Object.keys(records?.plugins ?? {}).find((k) => k.startsWith(`${PRODUCT.plugin}@`));
  if (!id) return null;
  const list = [records.plugins[id]].flat();
  const rec = list.find((r) => r?.scope === "user") ?? list[0];
  const enabled = readJson(path.join(configDir(ctx), "settings.json"))?.enabledPlugins?.[id];
  return { id, installPath: rec?.installPath ?? null, version: rec?.version ?? null, enabled: enabled !== false };
}

/**
 * → [{ code, ok, note, host }]
 * @param {object} ctx  install's context (home, env, display)
 * @param {{claudeVersion?: () => Promise<string|null>}} [o]
 */
export async function productChecks(ctx, { claudeVersion } = {}) {
  const rows = [];
  const add = (code, ok, note, host) => rows.push({ code, ok, note, host });
  const plugin = installedPlugin(ctx);
  if (plugin) {
    const hook = plugin.installPath ? path.join(plugin.installPath, "server", "bin", "hook.mjs") : null;
    const there = Boolean(hook && fs.existsSync(hook));
    add("plugin.installed", there, there ? `${plugin.id}${plugin.version ? ` ${plugin.version}` : ""}${plugin.enabled ? "" : " (turned off in Claude Code)"}` : `${plugin.id} is recorded but its files are missing: reinstall it from Claude Code's /plugin menu`, "claude-code");
    const v = await (claudeVersion ?? (async () => (await import("../hooks/hook-doctor.mjs")).claudeCodeVersion()))().catch(() => null);
    if (!v) add("plugin.version", true, `couldn't tell Claude Code's version: the plugin's hooks need ${EXEC_FORM_MIN_VERSION} or later`, "claude-code");
    else {
      const ok = cmpVersion(v, EXEC_FORM_MIN_VERSION) >= 0;
      add("plugin.version", ok, ok ? `Claude Code ${v}` : `Claude Code ${v}: the plugin's hooks use the exec form, which needs ${EXEC_FORM_MIN_VERSION} or later (older versions may ignore their arguments and show a hook error on each prompt). Update Claude Code`, "claude-code");
    }
  }
  const twice = duplicateCodexSkills(ctx);
  if (twice.length) add("skills.duplicate", false, `${twice.join(", ")} ${twice.length === 1 ? "is" : "are"} in ${ctx.display(path.join(ctx.home, ".agents", "skills"))} too, so Codex lists ${twice.length === 1 ? "it" : "them"} twice: remove the copy there`, "codex");
  return rows;
}
