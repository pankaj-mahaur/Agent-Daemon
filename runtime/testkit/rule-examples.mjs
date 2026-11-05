// Turning the rule corpora's examples into tool calls for the matcher (L4c).
// The correction → pattern corpus gives examples without a host or folder:
// PowerShell and `cmd /c` examples run on Windows, the rest on Linux, and
// write paths are relative to the project root. The guards corpus gives full
// calls with two placeholders to substitute.

const WIN_ROOT = "C:\\work\\app";
const POSIX_ROOT = "/work/app";

/** A correction-pattern example → a call. */
export function exampleCall(ex) {
  const windows = ex.tool === "PowerShell" || /^\s*cmd(?:\.exe)?\s+\/c\b/i.test(ex.command ?? "");
  const root = windows ? WIN_ROOT : POSIX_ROOT;
  const input = ex.command !== undefined ? { command: ex.command } : ex.file_path !== undefined ? { file_path: ex.file_path } : { patch: ex.patch };
  return { tool: ex.tool, input, os: windows ? "windows" : "linux", cwd: root, project_root: root };
}

/** Is a derived rule right for this correction-pattern item? */
export function derivationCorrect(item, got, matchRule) {
  const wantRule = item.expected.type !== "not-a-rule";
  const gotRule = got.type === "command" || got.type === "write";
  if (wantRule !== gotRule) return false;
  if (!gotRule) return true;
  return item.examples.block.every((ex) => matchRule(got, exampleCall(ex)).match) && !item.examples.allow.some((ex) => matchRule(got, exampleCall(ex)).match);
}

/** Substitute the guards corpus placeholders ({pkg}, {adroot}) for a tool and OS. */
export function substitute(value, { pkg = "teachonce", tool, os }) {
  const adroot = tool === "Write" || tool === "Edit" || tool === "apply_patch"
    ? os === "windows" ? "C:\\Users\\dev\\.agent-daemon" : os === "macos" ? "/Users/dev/.agent-daemon" : "/home/dev/.agent-daemon"
    : tool === "PowerShell" ? "$env:USERPROFILE\\.agent-daemon" : "~/.agent-daemon";
  const sub = (s) => String(s).replaceAll("{pkg}", pkg).replaceAll("{adroot}", adroot);
  if (typeof value === "string") return sub(value);
  if (Array.isArray(value)) return value.map((v) => substitute(v, { pkg, tool, os }));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, { pkg, tool, os })]));
  return value;
}

/** A guards corpus item → its rule and call, placeholders filled. */
export function guardCase(item) {
  const ctx = { tool: item.tool, os: item.os };
  return { rule: substitute(item.rule, ctx), call: { tool: item.tool, input: substitute(item.input, ctx), os: item.os, cwd: item.cwd, project_root: item.project_root, host: item.host } };
}
