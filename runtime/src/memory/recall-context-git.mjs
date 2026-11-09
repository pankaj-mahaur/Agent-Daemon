// The context job's git work (MCP launch plan L6, design decision 9): the recent
// paths and commit subjects of one repository, read-only and offline. Only the job
// (recall-context-job.mjs) imports this; the hook reads the cache.
//
// A repository's own config is the part a downloaded folder controls, so:
//   - no transport at all (protocol.allow=never) and no lazy fetch: nothing leaves
//     the machine, on any git version;
//   - no file-system monitor, no signature checks (gpg.program), no rename detection;
//   - `status` is skipped when the repository's own config names a clean filter, an
//     ssh command or a gpg program (status runs clean filters while it refreshes the
//     index); `log` too in a partial clone (missing objects would need a fetch).
// The user's global and system config are their own (git-lfs users keep their paths).

import path from "node:path";
import { execFileSyncNoShell, resolveGit, resolvedArgv } from "../safe-spawn.mjs";
import { readBranch, repoRoot } from "./repo-head.mjs";
import { MAX_COMMITS, MAX_PATHS } from "./recall-context.mjs";

export { jobAllowed } from "./recall-context.mjs";

/** The environment git runs with: no GIT_* from outside, no fetch, no prompts, no optional locks. */
export function gitEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k)) out[k] = v;
  return { ...out, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** git's leading arguments for every call. */
export const gitArgs = (root, args) => [
  "-c", "core.fsmonitor=false",
  "-c", "core.quotePath=false",
  "-c", "status.renames=false",
  "-c", "diff.renames=false",
  "-c", "log.showSignature=false",
  "-c", "protocol.allow=never",
  "--no-optional-locks",
  "-C", root,
  ...args,
];

const cleanPath = (s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

/**
 * @param {string} root  a repository root (repoRoot's)
 * @param {{timeoutMs?: number, run?: (args: string[]) => string|null}} [opts]
 * @returns {{branch: string|null, paths: string[], commits: string[], skipped: string[]}}
 */
export function collectContext(root, { timeoutMs = 4000, run } = {}) {
  const found = repoRoot(root, { stopAt: root });
  const branch = found ? readBranch(found.gitDir) : null;
  const runGit = run ?? gitRunner(root, timeoutMs, found?.gitDir ?? null);
  const own = (pattern) => ["--local", "--worktree"].some((scope) => (runGit(["config", scope, "--includes", "--get-regexp", pattern]) ?? "").trim() !== "");
  const skipped = [];
  const partial = own("^(extensions\\.partialclone|remote\\..*\\.promisor)$");
  const runsPrograms = partial || own("^(filter\\.|core\\.sshcommand$|gpg\\.)");
  const paths = [];
  const seen = new Set();
  const push = (p) => {
    const f = cleanPath(p);
    if (f && !seen.has(f) && paths.length < MAX_PATHS) {
      seen.add(f);
      paths.push(f);
    }
  };
  if (runsPrograms) skipped.push("status");
  else {
    // status -z: "XY path\0" (renames are off, so one name each).
    const status = runGit(["status", "--porcelain=v1", "-z", "--ignore-submodules=all", "--untracked-files=normal", "--no-renames"]) ?? "";
    for (const e of status.split("\0")) if (e.length >= 4) push(e.slice(3));
  }
  const commits = [];
  if (partial) skipped.push("log");
  else {
    const log = runGit(["log", "-n", "15", "--since=30.days", "--no-merges", "--no-renames", "--no-show-signature", "--format=%x1e%s", "--name-only"]) ?? "";
    for (const block of log.split("\x1e").slice(1)) {
      const [subject, ...files] = block.split("\n");
      const s = cleanPath(subject ?? "");
      if (s && commits.length < MAX_COMMITS) commits.push(s);
      for (const f of files) if (f.trim()) push(f.trim());
    }
  }
  return { branch, paths, commits, skipped };
}

function gitRunner(root, timeoutMs, gitDir) {
  return (args) => {
    try {
      if (!gitDir) return null;
      // GIT_CEILING_DIRECTORIES: git never walks above the root repo-head.mjs found (a
      // broken .git there makes git look upward); git's own ownership check still runs.
      const [cmd, argv] = resolvedArgv(resolveGit(), gitArgs(root, args));
      return execFileSyncNoShell(cmd, argv, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(root) } });
    } catch {
      return null;
    }
  };
}
