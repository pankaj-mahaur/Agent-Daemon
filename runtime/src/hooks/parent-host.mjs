// Is this hook's parent the host's own executable? (L5 design decision 4)
//
// Compared by executable path, never argv (argv is spoofable without exec):
//   Linux   realpath(/proc/<ppid>/exe)
//   macOS   the parent's executable file from one `lsof -d txt` (ps's comm can come from argv)
//   others  unknown → not the host (Windows has no cheap executable path for a parent).
// The path must match the allow-list entry's `parentExe`. A node-hosted host never
// matches (its parent is node, which the agent can start too). The running host's
// version is read next to its executable (a `versions/<x.y.z>` folder or a
// package.json above it), never from the `claude` on PATH.
//
// Defence in depth only: the agent's own Bash tool is also a child of the host, and
// `exec node hook.mjs` there keeps the host as the parent. No allow-list entry may be
// added before L7's self-protection is live and the S-L5-PARENT spike finds a signal
// the agent can't fake.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The parent process's executable path, or null when it can't be read cheaply. */
export function parentExe({ ppid = process.ppid, platform = process.platform, readlink = fs.realpathSync, run = execFileSync } = {}) {
  try {
    if (platform === "linux") return readlink(`/proc/${ppid}/exe`);
    if (platform === "darwin") {
      // The executable's file (lsof's txt entry), not ps's comm, which can come from argv.
      const out = String(run("lsof", ["-a", "-p", String(ppid), "-d", "txt", "-Fn"], { encoding: "utf8", timeout: 1500 }));
      const first = out.split("\n").find((l) => l.startsWith("n/"));
      return first ? first.slice(1) : null;
    }
  } catch {
    // gone, no permission, or no ps: unknown
  }
  return null;
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+.][\w.-]*)?$/;

/** The host's version from its install, next to its executable; null if unknown. */
export function versionNear(exe, { read = (f) => fs.readFileSync(f, "utf8") } = {}) {
  if (!exe) return null;
  // A native build kept per version: …/versions/2.1.400 (the file or its folder).
  const parts = exe.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i - 1] === "versions" && VERSION.test(parts[i])) return parts[i];
  // A package install: the nearest package.json above the executable.
  let dir = path.dirname(exe);
  for (let i = 0; i < 6; i++) {
    try {
      const v = JSON.parse(read(path.join(dir, "package.json")))?.version;
      if (typeof v === "string" && VERSION.test(v)) return v;
    } catch {
      // none here
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * → { ok, version } for an allow-list entry: ok only when the parent's executable path
 * matches the entry's parentExe and isn't node itself.
 */
export function parentIsHost(entry, opts = {}) {
  const exe = (opts.parentExe ?? parentExe)(opts);
  if (!entry || !exe) return { ok: false, version: null };
  const base = path.basename(exe).toLowerCase();
  if (base === "node" || base === "node.exe" || base === "nodejs") return { ok: false, version: null };
  if (!(entry.parentExe instanceof RegExp) || !entry.parentExe.test(exe.replace(/\\/g, "/"))) return { ok: false, version: null };
  return { ok: true, version: (opts.versionNear ?? versionNear)(exe) };
}
