// Branch facts for tool.before without spawning git (L7b design §3; offered to L7 P4):
//   currentBranch(dir)    <gitdir>/HEAD "ref: refs/heads/X" → X; detached or unreadable → null
//   defaultBranches(dir)  <commondir>/refs/remotes/origin/HEAD "ref: refs/remotes/origin/X"
//                         → [X]; unknown → ["main", "master"] (stricter: both are asked)
// A linked worktree's .git is a file naming its gitdir; that gitdir's `commondir` names the
// main repository's .git, where remote refs live. Small file reads only.

import fs from "node:fs";
import path from "node:path";

export const FALLBACK_DEFAULTS = Object.freeze(["main", "master"]);

const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);
const readText = (fsx, f) => {
  try {
    return fsx.readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

/** → {gitdir, commondir} for the repository holding `dir`, or null. */
export function gitDirs(dir, { platform = process.platform, fsx = fs, maxDepth = 40 } = {}) {
  if (!dir) return null;
  const p = pathFor(platform);
  let cur = p.resolve(String(dir));
  for (let i = 0; i < maxDepth; i++) {
    const dotgit = p.join(cur, ".git");
    let st = null;
    try {
      st = fsx.statSync(dotgit, { throwIfNoEntry: false });
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return { gitdir: dotgit, commondir: dotgit };
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(fsx, dotgit) ?? "");
      if (!m) return null;
      const gitdir = p.resolve(cur, m[1]);
      const common = readText(fsx, p.join(gitdir, "commondir"));
      return { gitdir, commondir: common ? p.resolve(gitdir, common.trim()) : gitdir };
    }
    const up = p.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

export function currentBranch(dir, opts = {}) {
  const g = gitDirs(dir, opts);
  if (!g) return null;
  const p = pathFor(opts.platform ?? process.platform);
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(readText(opts.fsx ?? fs, p.join(g.gitdir, "HEAD")) ?? "");
  return m ? m[1] : null;
}

export function defaultBranches(dir, opts = {}) {
  const g = gitDirs(dir, opts);
  if (!g) return [...FALLBACK_DEFAULTS];
  const p = pathFor(opts.platform ?? process.platform);
  const m = /^ref:\s*refs\/remotes\/[^/\s]+\/(.+?)\s*$/m.exec(readText(opts.fsx ?? fs, p.join(g.commondir, "refs", "remotes", "origin", "HEAD")) ?? "");
  return m ? [m[1]] : [...FALLBACK_DEFAULTS];
}
