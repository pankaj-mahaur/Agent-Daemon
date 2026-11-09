// The git facts tool.before needs without spawning git (MCP launch plan L7, design D5–D6):
// the top of the work tree a folder is in, and — for a linked worktree — the main
// repository's top, so a worktree enforces its main project's rules (resolveProject
// gives a worktree its own project id). Small file reads only; never `git`.
//
//   <top>/.git            a folder: an ordinary repository (main = top)
//   <top>/.git            a file "gitdir: <main>/.git/worktrees/<name>"; that folder's
//                         `commondir` points back at <main>/.git (main = its parent)

import fs from "node:fs";
import path from "node:path";

const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

/**
 * @param {string} dir an absolute folder
 * @returns {{top:string, main:string, worktree:boolean}|null} null outside a git work tree
 */
export function gitRoots(dir, { platform = process.platform, fsx = fs, maxDepth = 40 } = {}) {
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
    if (st?.isDirectory()) return { top: cur, main: cur, worktree: false };
    if (st?.isFile()) {
      const main = mainOf(cur, dotgit, { p, fsx });
      return { top: cur, main: main ?? cur, worktree: Boolean(main && main !== cur) };
    }
    const up = p.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function mainOf(top, dotgit, { p, fsx }) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fsx.readFileSync(dotgit, "utf8"));
    if (!m) return null;
    const gitdir = p.resolve(top, m[1]);
    let common = gitdir;
    try {
      common = p.resolve(gitdir, fsx.readFileSync(p.join(gitdir, "commondir"), "utf8").trim());
    } catch {
      // a submodule's gitdir has no commondir: it is its own repository
      return null;
    }
    return p.basename(common) === ".git" ? p.dirname(common) : null;
  } catch {
    return null;
  }
}
