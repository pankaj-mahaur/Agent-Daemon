// Branch-aware command rules (MCP launch plan L7, design D6). Pure: the branch facts come
// from the caller (tool.before reads them from .git files, never by spawning git).
//
//   branchesOf(text, pattern)  the branches a correction names for a git push, commit, merge,
//                              rebase or reset rule ("never push to main", "don't commit on
//                              `release/2.0`"), or null
//   branchApplies(rule, commands, index, ctx)
//                              does a rule with `branches` apply to the matched command?
//                              Yes when the current branch is listed; when it is unknown or
//                              detached; when the chain changes folder, branch or repository
//                              before it; and, for push only, when an argument names a listed
//                              branch as a target (main, HEAD:main, src:main, +main,
//                              refs/heads/main, :main), --all/--mirror/--branches, or no
//                              refspec and the branch's upstream (branch.<current>.merge) is
//                              listed. Merge, commit, rebase and reset look at the current
//                              branch only: `git merge main` on a feature branch writes there.
//   ctx: {current?: () => string|null, upstream?: (branch) => string|null} (missing: unknown)

export const BRANCH_SUBS = Object.freeze(["push", "commit", "merge", "rebase", "reset"]);
const local = (r) => String(r).replace(/^refs\/heads\//, "");
const NAMED = "main|master|develop|trunk|production|release";
const BRANCH_WORD = /^[\w./-]{1,100}$/;

/** The branches a correction names after to/on/into/onto, for a git rule that can take them. → string[] | null */
export function branchesOf(text, pattern) {
  if (pattern?.type !== "command" || String(pattern.program ?? "").toLowerCase() !== "git") return null;
  const subs = (pattern.subcommands ?? []).map((s) => String(s).toLowerCase());
  if (!subs.some((s) => BRANCH_SUBS.includes(s))) return null;
  const found = [];
  const s = String(text ?? "").slice(0, 4000);
  // One name, or a list of them ("main or master", "`main`, `release`").
  const ONE = String.raw`(?:\x60[^\x60\s]{1,100}\x60|(?:${NAMED})\b(?![./-]\w))`;
  const SEP = String.raw`\s*(?:,|\bor\b|\band\b|/)\s*(?:the\s+)?`;
  const re = new RegExp(String.raw`\b(?:to|on|into|onto)\s+(?:the\s+)?(${ONE}(?:${SEP}${ONE})*)`, "gi");
  for (const m of s.matchAll(re)) {
    // A list that goes on with a name we can't read: no branches (the rule applies everywhere).
    if (/^\s*(?:,|\bor\b|\band\b)\s*(?:the\s+)?(?!(?:to|on|into|onto)\b)[\w\x60]/i.test(s.slice(m.index + m[0].length))) return null;
    for (const w of m[1].match(new RegExp(ONE, "gi")) ?? []) {
      const b = local(w.startsWith("\x60") ? w.slice(1, -1) : w.toLowerCase());
      if (!BRANCH_WORD.test(b) || b.startsWith("-")) return null;
      if (!found.includes(b)) found.push(b);
    }
  }
  return found.length ? found : null;
}

const base = (w) => String(w ?? "").replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/** git's subcommand, the arguments after it, and whether it runs in another repository. */
export function gitSub(argv) {
  if (!Array.isArray(argv) || base(argv[0]) !== "git") return null;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (GIT_VALUED.has(args[i])) {
      i++;
      continue;
    }
    if (String(args[i]).startsWith("-")) continue;
    const before = args.slice(0, i);
    const elsewhere = before.some((a) => a === "-C" || a === "--git-dir" || a.startsWith("--git-dir=") || a === "--work-tree" || a.startsWith("--work-tree="));
    return { sub: args[i], rest: args.slice(i + 1), elsewhere };
  }
  return null;
}

const MOVES = new Set(["cd", "pushd", "popd", "chdir", "set-location", "sl", "push-location", "pop-location"]);
const GIT_MOVES = new Set(["checkout", "switch", "worktree", "clone", "init", "stash", "bisect"]);

/** Does this command change the folder, the branch or the repository the next ones run in? */
function changesPlace(argv) {
  const p = base(argv?.[0]);
  if (MOVES.has(p)) return true;
  const g = gitSub(argv);
  if (!g) return false;
  if (g.elsewhere) return false; // runs elsewhere; leaves this repository as it was
  if (GIT_MOVES.has(g.sub)) return true;
  // `git rebase <upstream> <branch>` checks <branch> out first.
  if (g.sub === "rebase") return g.rest.filter((a) => !a.startsWith("-")).length >= 2;
  return false;
}

const call = (f, ...a) => {
  if (typeof f !== "function") return null;
  const v = f(...a);
  return typeof v === "string" && v ? v : null;
};

const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function pushHits(rest, current, ctx, want) {
  const pos = [];
  let opts = true;
  for (let i = 0; i < rest.length; i++) {
    const a = String(rest[i]);
    if (opts && a === "--") {
      opts = false;
      continue;
    }
    if (opts && PUSH_VALUED.has(a)) {
      i++;
      continue;
    }
    if (opts && a.startsWith("--")) {
      const n = a.split("=")[0];
      if (n === "--all" || n === "--mirror" || n === "--branches") return true;
      continue;
    }
    if (opts && /^-[a-zA-Z0-9]+$/.test(a)) continue;
    pos.push(a);
  }
  const refspecs = pos.slice(1);
  if (!refspecs.length) {
    const up = call(ctx?.upstream, current);
    return Boolean(up && want.includes(local(up)));
  }
  for (const r of refspecs) {
    const s = r.replace(/^\+/, "");
    let dst = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
    if (dst === "HEAD" || dst === "@") dst = current;
    if (dst && (dst.includes("*") || want.includes(local(dst)))) return true; // a glob refspec can push any branch
  }
  return false;
}

/**
 * Does a rule with `branches` apply to commands[index] (an argv it already matched)?
 * @param {{branches?:string[]}} rule
 * @param {{argv:string[]}[]} commands  the call's commands in chain order
 * @param {number} index
 * @param {{current?:Function, upstream?:Function}|null|undefined} ctx
 */
export function branchApplies(rule, commands, index, ctx) {
  const want = Array.isArray(rule?.branches) ? rule.branches.filter((b) => typeof b === "string" && b).map(local) : [];
  if (!want.length) return true;
  const argv = commands?.[index]?.argv;
  const g = gitSub(argv);
  if (!g || g.elsewhere) return true; // not plain git here: the branch can't be known
  for (let k = 0; k < index; k++) if (changesPlace(commands[k]?.argv)) return true;
  let current = null;
  try {
    current = call(ctx?.current);
  } catch {
    current = null;
  }
  if (current === null) return true; // unknown or detached: stricter
  if (want.includes(local(current))) return true;
  const sub = String(g.sub).toLowerCase();
  // `git rebase <upstream> <branch>` checks <branch> out and rewrites it.
  if (sub === "rebase") return g.rest.filter((a) => !String(a).startsWith("-"))[1] !== undefined && want.includes(local(g.rest.filter((a) => !String(a).startsWith("-"))[1]));
  if (sub !== "push") return false;
  try {
    return pushHits(g.rest, current, ctx, want);
  } catch {
    return true;
  }
}
