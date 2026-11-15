// Edit text in the user's editor (the terminal is handed over), shared by `ad tui` and
// `learnings edit` (MCP launch plan L8, design decision 6). The editor command is
// $VISUAL, $EDITOR, then notepad / vi (safe-spawn.mjs editorCommand); it starts by full
// path, through cmd.exe only for a .cmd/.bat editor (safe-spawn.mjs editorInvocation).

import path from "node:path";
import { editorCommand, editorInvocation } from "./safe-spawn.mjs";


/**
 * Edits `text` in the user's editor (the terminal is handed over) and returns
 * the result, or null when the editor failed. The temp file is private and removed.
 */
export async function editInEditor(text, { run, env = process.env, platform = process.platform, now = () => Date.now(), resolve, cmdExe, name = "prompt.md", prefix = "ad-prompt-" } = {}) {
  const { mkdtempSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const file = path.join(dir, name);
  try {
    writeFileSync(file, text, { mode: 0o600 });
    const { cmd, args } = editorCommand(env, platform);
    const spawnAs = editorInvocation(cmd, [...args, file], { platform, env, resolve, cmdExe });
    const t0 = now();
    const code = await run(spawnAs.cmd, spawnAs.args, spawnAs.verbatim);
    if (code !== 0) return null;
    const out = read(file, "utf8");
    // Back at once with nothing changed: the editor didn't wait (it opened the
    // file in an existing window). Keep the prompt rather than lose the edit.
    if (out === text && now() - t0 < 1500) throw new Error("The editor returned at once without waiting. Set EDITOR to one that waits (e.g. \"code --wait\"); your text is unchanged.");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

