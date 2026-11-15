// Other command guards next to the starter safety policy (MCP launch plan L7b; D18):
// `doctor` and `safety status` name dcg and claude-code-safety-net when a host's config runs
// them, and the families both would prompt for, so the user can keep one. Host config only
// (no PATH lookups, no spawning): Claude Code's user and project settings (hook commands,
// enabled plugins) and Codex's hooks.json / config.toml. Sources (15 Nov 2026): dcg's
// install.sh and core packs; cc-safety-net's plugin manifest, hooks.json and rule sources.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAMILY_TEXT } from "../rules/policy.mjs";

/** What each tool checks among the four families (its own rules, by default). */
export const OTHER_GUARDS = Object.freeze({
  dcg: { name: "dcg (destructive_command_guard)", families: ["recursive-delete", "force-push-default"] },
  "cc-safety-net": { name: "claude-code-safety-net", families: ["recursive-delete", "force-push-default", "env-read"] },
});

const readText = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const readJson = (f) => {
  const t = readText(f);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/** Which tool a hook command runs, if one of ours to report. */
export function guardOfCommand(command) {
  const c = String(command ?? "");
  if (/cc-safety-net|claude-code-safety-net/i.test(c)) return "cc-safety-net";
  if (/destructive_command_guard|git_safety_guard/i.test(c)) return "dcg";
  const first = (/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(c) ?? []).slice(1).find(Boolean) ?? "";
  if (/^dcg(?:\.exe)?$/i.test(first.split(/[\\/]/).pop())) return "dcg";
  return null;
}

/** Every hook command in a Claude Code or Codex hooks object ({hooks: {Event: [{hooks: [{command}]}]}}). */
function hookCommands(j) {
  const out = [];
  const events = j?.hooks && typeof j.hooks === "object" ? j.hooks : {};
  for (const groups of Object.values(events)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (typeof h?.command === "string") out.push(h.command);
      if (typeof g?.command === "string") out.push(g.command);
    }
  }
  return out;
}

/**
 * → [{tool, name, where, host, families}] — one row per tool and config file that runs it.
 * @param {{home?:string, cwd?:string, env?:object}} [o]
 */
export function findOtherGuards({ home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const found = new Map();
  const add = (tool, where, host) => {
    const key = `${tool}|${where}`;
    if (!found.has(key)) found.set(key, { tool, name: OTHER_GUARDS[tool].name, where, host, families: [...OTHER_GUARDS[tool].families] });
  };
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const claudeFiles = [path.join(claudeDir, "settings.json"), path.join(claudeDir, "settings.local.json"), path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")];
  for (const f of [...new Set(claudeFiles)]) {
    const j = readJson(f);
    if (!j) continue;
    for (const c of hookCommands(j)) {
      const tool = guardOfCommand(c);
      if (tool) add(tool, f, "claude-code");
    }
    for (const [id, on] of Object.entries(j.enabledPlugins ?? {})) if (on && /^(?:cc-safety-net|claude-code-safety-net)@/i.test(id)) add("cc-safety-net", f, "claude-code");
  }
  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  const hooks = readJson(path.join(codexDir, "hooks.json"));
  for (const c of hooks ? hookCommands(hooks) : []) {
    const tool = guardOfCommand(c);
    if (tool) add(tool, path.join(codexDir, "hooks.json"), "codex");
  }
  const toml = readText(path.join(codexDir, "config.toml")) ?? "";
  for (const m of toml.matchAll(/^\s*command\s*=\s*(.+)$/gm)) {
    const tool = guardOfCommand(m[1].replace(/^\[?\s*["']|["']\s*,?.*$/g, "") + " " + m[1]);
    if (tool) add(tool, path.join(codexDir, "config.toml"), "codex");
  }
  if (/cc-safety-net@/i.test(toml)) add("cc-safety-net", path.join(codexDir, "config.toml"), "codex");
  return [...found.values()];
}

const shortFamily = {
  "recursive-delete": "recursive deletes of home, a root or the project",
  "force-push-default": "force pushes",
  "env-read": ".env reads",
  "no-verify": "--no-verify",
};

/** The lines doctor and `safety status` print: what both would prompt for, so the user can keep one. */
export function coexistLines(o = {}) {
  return findOtherGuards(o).map((g) => {
    const both = g.families.map((f) => shortFamily[f] ?? FAMILY_TEXT[f]).join(", ");
    return `${g.name} runs too (${g.where}): with the starter safety policy on, both check ${both}. You can keep one.`;
  });
}
