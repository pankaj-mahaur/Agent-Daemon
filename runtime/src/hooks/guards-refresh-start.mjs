// session.start's side of the rules snapshot's refresh (MCP launch plan L7, design D3):
// start `run.mjs job guards-refresh` detached while rules may exist, at most once per
// window. The job decides whether anything changed (the store's rules_rev ahead of the
// snapshot's, a moved project folder, a pause that ended) and is one-way (S1).
//
// Through the launcher only, which runs the job from the guard copy (D10). No launcher
// (ad's clone route without the memory product's setup): no job, stated.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { jobEnv, spawnDetached } from "./detached.mjs";
import { activePath, loadGuards } from "./guards.mjs";

export const REFRESH_WINDOW_MS = 10 * 60_000;

// The sentinel, or a snapshot with a rule or a pause in it.
function rulesMayExist(root) {
  if (fs.existsSync(activePath(root))) return true;
  const { snapshot } = loadGuards({ root });
  if (!snapshot) return false;
  const projects = Object.values(snapshot.projects ?? {});
  const rules = Number(snapshot.ruleCount ?? 0) + (snapshot.global?.rules?.length ?? 0) + projects.reduce((k, p) => k + (p?.rules?.length ?? 0), 0);
  return rules > 0 || Boolean(snapshot.pausedAll) || projects.some((p) => p?.paused);
}

/** → whether the job was started. */
export function startGuardsRefresh({ root = adRoot(), spawnFn, now = Date.now(), env = process.env } = {}) {
  const launcher = path.join(root, "memory", "launch", "run.mjs");
  if (!fs.existsSync(launcher) || !rulesMayExist(root)) return false;
  return spawnDetached([launcher, "job", "guards-refresh"], {
    key: "guards-refresh",
    windowMs: REFRESH_WINDOW_MS,
    root,
    now,
    ...(spawnFn ? { spawnFn } : {}),
    // The launcher picks the driver for the guard copy's route (D10): none passed through.
    env: jobEnv(env, ["AD_SQLITE_DRIVER"]),
  });
}
