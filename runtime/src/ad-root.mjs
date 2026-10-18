// One place that says where ad keeps its state.
//
// adRoot() is ~/.agent-daemon (os.homedir(), i.e. USERPROFILE on Windows),
// or AD_ROOT when it is set to an absolute path. Some older code resolved the
// same folder from HOME first; under Git Bash / MSYS HOME and USERPROFILE can
// differ, so legacyAdRoots() names that second location too: the memory
// scope treats both as ad's own, never as a project.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function adRoot({ env = process.env, homedir = os.homedir } = {}) {
  const override = env.AD_ROOT;
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(homedir(), ".agent-daemon");
}

const same = (a, b, platform) => (platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** Other places older code put ~/.agent-daemon (HOME-based), when they differ from adRoot(). */
export function legacyAdRoots({ env = process.env, homedir = os.homedir, platform = process.platform } = {}) {
  const root = adRoot({ env, homedir });
  const out = [];
  for (const base of [env.HOME, env.USERPROFILE]) {
    if (!base || !path.isAbsolute(base)) continue;
    const p = path.join(base, ".agent-daemon");
    if (!same(p, root, platform) && !out.some((o) => same(o, p, platform))) out.push(p);
  }
  return out;
}

/** The installed runtime package folder (the one holding package.json). */
export function adPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
