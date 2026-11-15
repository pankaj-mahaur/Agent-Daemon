// A starter-policy corpus item as the matcher's call (L7b), shared by the corpus gate and
// the policy tests. A Codex `cmd` item stands for a command passed to cmd.exe /c (corpus
// README): it is replayed as Codex's exec argv ["cmd.exe", "/c", <text>], as it arrives.

import { matchRule } from "../../src/rules/match.mjs";
import { FAMILIES } from "../../src/rules/policy.mjs";

/** A corpus item as the matcher's call (what tool-before builds from a payload). */
export function callFor(item) {
  const c = item.context;
  const tool = item.host === "codex" ? "shell" : item.tool;
  let input = item.input;
  if (item.host === "codex" && item.shell === "cmd") input = { ...input, command: ["cmd.exe", "/c", input.command] };
  return {
    tool,
    input,
    host: item.host,
    os: c.os,
    cwd: c.cwd,
    project_root: c.project_root,
    policy: { homes: [c.home], project_root: c.project_root, default_branches: [c.default_branch], current_branch: c.current_branch },
  };
}

export const firing = (item) => FAMILIES.filter((family) => matchRule({ type: "policy", family }, callFor(item)).match);

