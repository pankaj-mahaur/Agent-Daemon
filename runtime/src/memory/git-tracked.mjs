// What git tracks in a project, for deciding whether a .agent-daemon/ folder (or a journal
// in it) came with the repository. A clone brings only tracked files, so a folder git
// tracks nothing in was made on this machine; one with tracked files was shipped.
// Fails closed: inside a work tree, an answer git couldn't give (dubious ownership, a
// timeout, no git) counts as tracked. Outside any repository nothing is tracked.

import fs from "node:fs";
import path from "node:path";
import { execFileSyncNoShell, resolveGit, resolvedArgv } from "../safe-spawn.mjs";

/** A .git entry (a folder, or a worktree's or submodule's pointer file) here or above. */
export function insideWorkTree(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

// Runs git in root; throws as execFileSync does (err.status: git's exit code). The folder
// may be a download that ships its own .git/config: no fsmonitor program runs.
function git(root, args, run) {
  if (run) return run(args, { cwd: root });
  const argv = resolvedArgv(resolveGit(), ["-c", "core.fsmonitor=false", ...args]);
  execFileSyncNoShell(argv[0], argv[1], { cwd: root, stdio: "ignore", timeout: 5000 });
}

// `git ls-files --error-unmatch -- <pathspec>` in root: true when git lists it, false on
// git's own "not tracked" (exit 1), true on anything else (fail closed).
function lsFiles(root, spec, { run } = {}) {
  try {
    git(root, ["ls-files", "--error-unmatch", "--", spec], run);
    return true;
  } catch (err) {
    return err?.status !== 1;
  }
}

// A literal pathspec, case-insensitive: a committed Learning-Journal.jsonl is the same file
// on a case-insensitive file system, and erring toward "tracked" only skips a drain.
const spec = (rel) => `:(icase,literal)${rel.split(path.sep).join("/")}`;

/**
 * Is this file inside the project and tracked by git there?
 * @param {{run?:Function}} [o]  tests inject run(args, opts)
 */
export function gitTracked(file, cwd, o = {}) {
  const root = path.resolve(cwd);
  const abs = path.resolve(file);
  if (!abs.startsWith(root + path.sep)) return false;
  // Nothing there, nothing to drain or move: no git spawn on most session starts.
  if (!o.run && !fs.existsSync(abs)) return false;
  if (!insideWorkTree(root)) return false;
  return lsFiles(root, spec(path.relative(root, abs)), o);
}

/** Does git track anything under this folder of the project (".agent-daemon")? */
export function gitTracksAnyUnder(cwd, rel, o = {}) {
  const root = path.resolve(cwd);
  if (!insideWorkTree(root)) return false;
  return lsFiles(root, spec(rel), o);
}

/**
 * Would git keep this not-yet-existing file of the project out of a commit? Outside any
 * repository, yes. Inside one, only git's own "ignored" answer (exit 0) counts: a shipped
 * .agent-daemon/.gitignore of "!*" (which beats .git/info/exclude), a tracked file, or an
 * error all answer no.
 */
export function gitIgnores(cwd, rel, { run } = {}) {
  const root = path.resolve(cwd);
  if (!insideWorkTree(root)) return true;
  try {
    git(root, ["check-ignore", "-q", "--", rel.split(path.sep).join("/")], run);
    return true;
  } catch {
    return false;
  }
}
