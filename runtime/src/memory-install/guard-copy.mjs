// The guard copy's manifest (MCP launch plan L7, D10): every file of an npm copy under
// <root>/memory/dist/<version> with its sha256, written when the copy is made. The
// launcher checks only the manifest's own hash against guard.json on each call. Install
// and repair compare the copy with the package being run (expectedTree) and copy again on
// any difference (a changed file, a missing one, one the package never had); run from the
// copy itself, they can only check the tree against its manifest and the record.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MANIFEST } from "../memory/launch/dists.mjs";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * { "<posix relative path>": sha256 } for every file under dir but the manifest. A link
 * counts as changed. skipNodeModules: leave out every node_modules folder (a package as
 * copyDist copies it).
 */
export function treeHashes(dir, { skipNodeModules = false } = {}) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (skipNodeModules && e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        if (r !== MANIFEST) out[r] = sha(fs.readFileSync(p));
      } else out[r] = `not a file: ${e.isSymbolicLink() ? "link" : "other"}`;
    }
  };
  walk(dir, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Write dir's manifest (the same bytes for the same tree). → its sha256 */
export function writeManifest(dir) {
  const bytes = Buffer.from(JSON.stringify({ version: 1, files: treeHashes(dir) }, null, 1) + "\n");
  fs.writeFileSync(path.join(dir, MANIFEST), bytes);
  return sha(bytes);
}

/** The manifest's sha256, or null when it can't be read. */
export function manifestSha(dir) {
  try {
    return sha(fs.readFileSync(path.join(dir, MANIFEST)));
  } catch {
    return null;
  }
}

/**
 * The tree a copy of this package must have (copyDist's own layout): the package's files
 * outside node_modules, plus each dependency folder under node_modules/<name>.
 */
export function expectedTree(packageRoot, deps) {
  const out = { ...treeHashes(packageRoot, { skipNodeModules: true }) };
  for (const [name, dir] of Object.entries(deps)) for (const [k, v] of Object.entries(treeHashes(dir))) out[`node_modules/${name}/${k}`] = v;
  return out;
}

/** Two treeHashes results list the same files with the same contents. */
export function sameTree(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Is the tree exactly what its manifest lists? */
export function copyIntact(dir) {
  let files;
  try {
    files = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"))?.files;
  } catch {
    return false;
  }
  if (!files || typeof files !== "object") return false;
  let now;
  try {
    now = treeHashes(dir);
  } catch {
    return false;
  }
  return sameTree(files, now);
}
