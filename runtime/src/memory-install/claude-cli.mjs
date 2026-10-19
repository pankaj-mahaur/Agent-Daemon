// Claude Code's entry goes through its own CLI (P5.3): Claude Code rewrites
// ~/.claude.json while it runs, so ad never edits that file. `claude` starts by
// full path without a shell (safe-spawn.mjs: a native claude.exe, or the script
// behind an npm .cmd shim run by node). `claude mcp get` and `list` start the
// server to check it, which the server handles (it exits when stdin ends).
//
//   claudeAdd(resolved, entry) / claudeRemove(resolved) / claudeGet(resolved)
//   → {code, out}; get → {present, otherScope, error?, out}
//
// `get` reports whichever scope wins from the folder it runs in (local, project,
// user), so it runs from a neutral folder and only a "Scope: User" entry counts
// as ad's; another scope's entry is the user's own and never touched.

import os from "node:os";
import { spawnResolved } from "../safe-spawn.mjs";
import { SERVER_NAME } from "./hosts.mjs";

function run(resolved, args, { env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawnResolved(resolved, args, { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: out + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** The argv for `claude mcp add` (exported for the snippet ad prints and for tests). */
export function claudeAddArgs(entry) {
  const env = Object.entries(entry.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // --transport between the -e pairs and the name: -e takes several values.
  return ["mcp", "add", ...env, "--transport", "stdio", "--scope", "user", SERVER_NAME, "--", entry.command, ...entry.args];
}

export const claudeAdd = (resolved, entry, opts) => run(resolved, claudeAddArgs(entry), opts);
export const claudeRemove = (resolved, opts) => run(resolved, ["mcp", "remove", "--scope", "user", SERVER_NAME], opts);

/**
 * Whether Claude Code has a user-scope entry (naming `needle`, our server file, when given).
 * A non-zero exit that doesn't say "not found" is an error, never "absent".
 */
export async function claudeGet(resolved, needle, opts) {
  const r = await run(resolved, ["mcp", "get", SERVER_NAME], opts);
  if (r.code !== 0) {
    if (/no mcp server|not found/i.test(r.out)) return { ...r, present: false };
    return { ...r, present: false, error: `couldn't read Claude Code's MCP servers (claude mcp get: ${r.out.trim().split("\n").pop() || `exit ${r.code}`})` };
  }
  const scope = /Scope:\s*(\w+)/i.exec(r.out)?.[1]?.toLowerCase() ?? null;
  const norm = (s) => String(s).replace(/\\\\/g, "\\").toLowerCase();
  const user = scope === "user";
  return { ...r, present: user && (!needle || norm(r.out).includes(norm(needle))), otherScope: !user ? scope ?? "unknown" : null };
}

/** The line a user can run by hand. */
export function claudeSnippet(entry) {
  const q = (s) => (/^[\w./:=@\\-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`);
  return `claude ${claudeAddArgs(entry).map(q).join(" ")}`;
}
