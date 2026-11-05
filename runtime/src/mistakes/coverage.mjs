// Which of your written rules each agent can see (plan L4a: "Codex sees none
// of your 42 CLAUDE.md rules"). Claude Code reads CLAUDE.md files, Codex reads
// AGENTS.md files; a rule written in only one of them is invisible to the
// other agent. Read-only.

import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir, codexHomeDir } from "./history.mjs";

// ad's own managed block is product text, not the user's rules.
const MANAGED = /<!-- agent-daemon:start -->[\s\S]*?<!-- agent-daemon:end -->/g;

/** The rule-shaped lines of a Markdown file: list items outside code fences and ad's block. */
export function ruleLines(text) {
  const out = [];
  let fence = false;
  for (const line of String(text).replace(MANAGED, "").split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!m) continue;
    // A bullet that is only a link, only a command, or the header of a sub-list isn't a rule.
    if (/^\[[^\]]*\]\([^)]*\)\W*$/.test(m[1].trim()) || /^`[^`]+`\W*$/.test(m[1].trim()) || /:\s*$/.test(m[1])) continue;
    const body = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
    if (body.length >= 8) out.push(body);
  }
  return out;
}

const ruleKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const readOr = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/**
 * Count the rules in the files each agent reads for this project (or, with no
 * project, the user-level files only).
 * @returns {{claudeRules:number, agentsRules:number, codexMissing:number, claudeMissing:number, claudeFiles:string[], agentsFiles:string[]}}
 */
export function ruleCoverage({ root = null, env = process.env, home } = {}) {
  const claudeHome = claudeConfigDir({ env, home });
  const codexHome = codexHomeDir({ env, home });
  const claudePaths = [path.join(claudeHome, "CLAUDE.md")];
  const agentsPaths = [path.join(codexHome, "AGENTS.override.md"), path.join(codexHome, "AGENTS.md")];
  if (root) {
    claudePaths.push(path.join(root, "CLAUDE.md"), path.join(root, "CLAUDE.local.md"), path.join(root, ".claude", "CLAUDE.md"));
    agentsPaths.push(path.join(root, "AGENTS.override.md"), path.join(root, "AGENTS.md"));
  }
  const claude = new Map();
  const agents = new Map();
  const claudeFiles = [];
  const agentsFiles = [];
  let claudeImportsAgents = false;
  for (const p of claudePaths) {
    const t = readOr(p);
    if (t === null) continue;
    claudeFiles.push(p);
    if (/^\s*@\.?\/?AGENTS\.md\b/m.test(t)) claudeImportsAgents = true;
    for (const r of ruleLines(t)) claude.set(ruleKey(r), r);
  }
  for (const p of agentsPaths) {
    const t = readOr(p);
    if (t === null) continue;
    agentsFiles.push(p);
    for (const r of ruleLines(t)) agents.set(ruleKey(r), r);
  }
  // Codex can be told to read CLAUDE.md where a folder has no AGENTS.md.
  const config = readOr(path.join(codexHome, "config.toml")) ?? "";
  const codexReadsClaude = /project_doc_fallback_filenames\s*=\s*\[[^\]]*CLAUDE\.md/.test(config) && root && !agentsFiles.some((f) => path.dirname(f) === root);
  if (codexReadsClaude) for (const p of [path.join(root, "CLAUDE.md")]) for (const r of ruleLines(readOr(p) ?? "")) agents.set(ruleKey(r), r);
  let codexMissing = 0;
  for (const k of claude.keys()) if (!agents.has(k)) codexMissing++;
  let claudeMissing = 0;
  if (!claudeImportsAgents) for (const k of agents.keys()) if (!claude.has(k)) claudeMissing++;
  return { claudeRules: claude.size, agentsRules: agents.size, codexMissing, claudeMissing, claudeFiles, agentsFiles };
}
