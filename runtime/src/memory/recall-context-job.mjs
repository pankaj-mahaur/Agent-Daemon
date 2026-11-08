#!/usr/bin/env node
// The detached job that refreshes the session brief's repo context (MCP launch plan
// L6, design decision 9): `node recall-context-job.mjs <repository root>`.
//
// session.start starts it (hooks/detached.mjs, single-flight) when the cache is
// missing, old or from another branch, and never waits for it: the brief of the
// next session uses what it wrote. It accepts only a folder that is itself a
// repository root (never the home folder or one above it), runs git read-only and
// offline there, prunes old cache files, and always exits 0.

import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { pruneDir, repoRoot, writeContext } from "./recall-context.mjs";
import { collectContext, jobAllowed } from "./recall-context-git.mjs";

const dir = process.argv[2];
try {
  if (dir && path.isAbsolute(dir)) {
    const found = repoRoot(dir, { stopAt: dir });
    if (found && path.resolve(found.root) === path.resolve(dir) && jobAllowed(found.root)) writeContext(found.root, collectContext(found.root));
  }
} catch {
  // best-effort: the next session start tries again
}
try {
  pruneDir(path.join(adRoot(), "recall", "context"));
  pruneDir(path.join(adRoot(), "recall", "served"), { days: 1 });
} catch {
  // best-effort
}
process.exit(0);
