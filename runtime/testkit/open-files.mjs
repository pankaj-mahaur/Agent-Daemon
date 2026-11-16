// Files this process still holds open under a folder (test-only). Windows won't delete an
// open file (EBUSY in an after hook); Linux shows the same leak through /proc/self/fd, so a
// test can assert it there. Elsewhere it reports nothing.

import fs from "node:fs";
import path from "node:path";

/** → the open files under `dir` (Linux), else []. */
export async function openFilesUnder(dir) {
  if (process.platform !== "linux") return [];
  let root;
  try {
    root = fs.realpathSync(dir);
  } catch {
    return [];
  }
  const open = [];
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    let target;
    try {
      target = fs.readlinkSync(path.join("/proc/self/fd", fd));
    } catch {
      continue; // closed between the listing and the read
    }
    if (target === root || target.startsWith(root + path.sep)) open.push(target);
  }
  return [...new Set(open)].sort();
}
