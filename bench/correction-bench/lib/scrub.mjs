// Results and logs never carry the machine's paths.
import os from "node:os";

/** Error text without the machine's paths: episode roots, the home folder and the temp folder become placeholders. */
export function scrubPaths(text, roots = []) {
  let s = String(text ?? "");
  for (const [p, label] of [...roots.map((r) => [r, "<episode>"]), [os.homedir(), "<home>"], [os.tmpdir(), "<tmp>"]]) {
    if (!p) continue;
    for (const v of new Set([p, p.replace(/\\/g, "/"), p.replace(/\\/g, "\\\\")])) {
      // Windows paths compare without case.
      const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), process.platform === "win32" ? "gi" : "g");
      s = s.replace(re, label);
    }
  }
  return s;
}
