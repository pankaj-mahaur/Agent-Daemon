// The version of this copy of ad's memory code, for the commands hooks print pinned
// (MCP launch plan L3, Decision 12). Every copy keeps package.json two folders above
// src/memory/: the npm dist, the plugin's server/, a clone's runtime/ (the builds
// check that the runtime and the package carry one version). Dependency-free: hooks load it.

import fs from "node:fs";

let cached;

/** → "3.1.0", or null when this copy's package.json can't be read. */
export function ownVersion() {
  if (cached !== undefined) return cached;
  try {
    const v = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    cached = typeof v === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  } catch {
    cached = null;
  }
  return cached;
}
