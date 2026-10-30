// Where each host loads user skills from, and the files a skill becomes there (P5.7).
// Facts from the S-HOSTCFG spike (vendor docs and source, Oct 2026):
//   Claude Code  ~/.claude/skills (ad init's lane; not ~/.agents/skills)
//   Codex        $CODEX_HOME/skills (default ~/.codex/skills); also ~/.agents/skills
//   Gemini CLI   ~/.gemini/skills; also ~/.agents/skills
//   OpenCode, VS Code (Copilot), Cursor: read ~/.claude/skills too, so a skill in
//                Claude Code's folder already reaches them; writing their own folder
//                as well would load it twice.
//   ~/.agents/skills: read by Codex, Gemini, OpenCode, VS Code and Cursor, so a copy
//                there doubles up with ~/.claude/skills; only when the user names it.
// Every host reads the same SKILL.md layout; `name` stays the folder name (OpenCode,
// VS Code and Cursor require it).

import fs from "node:fs";
import path from "node:path";

/** id → { label, own: has a folder ad writes, via?: the host whose folder it reads, optIn? } */
export const SKILL_TARGETS = Object.freeze({
  "claude-code": { label: "Claude Code", own: true },
  codex: { label: "Codex", own: true },
  gemini: { label: "Gemini CLI", own: true },
  agents: { label: "~/.agents/skills", own: true, optIn: true },
  cursor: { label: "Cursor", own: false, via: "claude-code" },
  vscode: { label: "VS Code", own: false, via: "claude-code" },
  opencode: { label: "OpenCode", own: false, via: "claude-code" },
});

/** The folder a host loads user skills from, or null when ad writes none for it. */
export function userSkillRoot(target, { home, env = process.env }) {
  switch (target) {
    case "claude-code":
      return path.join(home, ".claude", "skills");
    case "codex":
      return path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex"), "skills");
    case "gemini":
      return path.join(home, ".gemini", "skills");
    case "agents":
      return path.join(home, ".agents", "skills");
    default:
      return null;
  }
}

/** A skill folder → the files it becomes in a host: [{ path (relative), bytes }]. Same layout everywhere. */
export function renderSkill(target, skillDir) {
  if (!SKILL_TARGETS[target]) throw new Error(`unknown skill target: ${target}`);
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".ad-skill.json" || e.name === ".ad-skill-staging") continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ path: r, bytes: fs.readFileSync(abs) });
    }
  };
  walk(skillDir, "");
  if (!out.some((f) => f.path === "SKILL.md")) throw new Error(`${skillDir} has no SKILL.md`);
  return out;
}
