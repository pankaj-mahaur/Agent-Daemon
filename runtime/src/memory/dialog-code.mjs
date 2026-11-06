// The one-time code a review needs when the terminal runs inside an editor or ad can't
// vouch for its host (MCP launch plan 02 §2.2, memory/ancestry.mjs). The code shows in a
// native dialog and must be typed back in the terminal. It reaches the dialog through
// stdin, never a command line, where ps or Win32_Process would show it to an agent.
//
// Nothing the caller's environment says picks the dialog: PowerShell comes from the
// Windows folder the loader used, osascript and zenity by absolute path, and on Linux the
// display comes from the editor's own process (only one in an install folder), never from
// ad's environment, which an agent could point at a display it watches. With no display
// to trust, review refuses. An agent that can read the screen can still read the dialog
// (a stated limit).

import { existsSync, readFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { loaderWindowsDir, systemTool } from "../safe-spawn.mjs";
import { cleanWindowsEnv } from "./ancestry.mjs";

export const DIALOG_TEXTS = Object.freeze({
  why: (found) => (found?.verdict === "editor"
    ? `This terminal runs inside ${found.editor}, where an agent can run commands too: ad shows a code in a dialog.`
    : `ad can't vouch for the program that started this terminal (${found?.why ?? "unknown"}): ad shows a code in a dialog.`),
  ask: "Type the code from the ad review dialog: ",
  noDialog: "accepting notes here needs a code from a dialog, and none can be shown. Run it in a terminal window of its own (not inside an editor, tmux or ssh).",
  wrongCode: "the code didn't match: nothing was accepted.",
});

const PROMPT = "Type this code in the terminal where ad asks for it:";
// Windows: the script is on the command line (encoded), the code arrives on stdin. No
// cmdlet (Add-Type would autoload a module, which a caller's PSModulePath could replace).
const WIN_SCRIPT = `$c = [Console]::In.ReadLine(); [void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [void][System.Windows.Forms.MessageBox]::Show("${PROMPT}" + [Environment]::NewLine + [Environment]::NewLine + $c, 'ad review')`;
const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"];

/** Linux: the display of the editor that hosts this terminal, from its own /proc environ; else null. */
export function trustedDisplayEnv(found, { read = (f) => readFileSync(f, "utf8") } = {}) {
  if (found?.verdict !== "editor" || found.host?.trusted !== true || !Number.isInteger(found.host?.pid)) return null;
  try {
    const env = Object.fromEntries(read(`/proc/${found.host.pid}/environ`).split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    const picked = Object.fromEntries(DISPLAY_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
    return picked.DISPLAY || picked.WAYLAND_DISPLAY ? picked : null;
  } catch {
    return null;
  }
}

/**
 * How to show a dialog here: { cmd, args, input(code), env? }, or null when none can be shown.
 * powershell: Windows PowerShell by absolute path under the loader's Windows folder;
 * displayEnv: Linux only, the trusted display (trustedDisplayEnv).
 */
export function dialogCommand(platform = process.platform, { windowsDir = platform === "win32" ? loaderWindowsDir() : null, powershell = platform === "win32" ? systemTool("powershell.exe", { platform, env: { SystemRoot: windowsDir } }) : null, displayEnv = null, exists = existsSync } = {}) {
  if (platform === "win32") {
    if (!powershell || !windowsDir) return null;
    // A clean environment: nothing of the caller's (PSModulePath, COR_PROFILER) reaches it.
    return { cmd: powershell, args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WIN_SCRIPT, "utf16le").toString("base64")], input: (code) => `${code}\n`, env: cleanWindowsEnv(windowsDir) };
  }
  if (platform === "darwin") {
    // The whole AppleScript, code included, goes through stdin.
    return { cmd: "/usr/bin/osascript", args: ["-"], input: (code) => `display dialog "${PROMPT} ${code}" with title "ad review" buttons {"OK"} default button 1\n` };
  }
  if (displayEnv && exists("/usr/bin/zenity")) {
    return { cmd: "/usr/bin/zenity", args: ["--text-info", "--title=ad review"], input: (code) => `${PROMPT}\n\n${code}\n`, env: displayEnv };
  }
  return null;
}

/** Show a code, ask for it in the terminal. → { ok } or { ok: false, text } */
export async function confirmByDialog({ ask, found, out = (l) => console.log(l), platform = process.platform, spawn = nodeSpawn, code = String(randomInt(100000, 1000000)), tools = {} } = {}) {
  const how = dialogCommand(platform, { ...(platform === "linux" ? { displayEnv: trustedDisplayEnv(found) } : {}), ...tools });
  if (!how || typeof ask !== "function") return { ok: false, text: DIALOG_TEXTS.noDialog };
  let child;
  try {
    child = spawn(how.cmd, how.args, { stdio: ["pipe", "ignore", "ignore"], ...(how.env ? { env: how.env } : {}) });
  } catch {
    return { ok: false, text: DIALOG_TEXTS.noDialog };
  }
  // A dialog that can't start refuses instead of waiting.
  const started = await new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("spawn", () => resolve(true));
  });
  if (!started) return { ok: false, text: DIALOG_TEXTS.noDialog };
  try {
    child.stdin.on("error", () => {});
    child.stdin.end(how.input(code));
    out(DIALOG_TEXTS.why(found));
    const typed = String((await ask(DIALOG_TEXTS.ask)) ?? "").trim();
    return typed === code ? { ok: true } : { ok: false, text: DIALOG_TEXTS.wrongCode };
  } finally {
    try {
      child.kill();
    } catch {
      // already closed by the user
    }
  }
}
