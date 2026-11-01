// The one-time code a review needs when the terminal runs inside an editor or the
// process chain breaks (MCP launch plan 02 §2.2, memory/ancestry.mjs). The code shows
// in a native dialog and must be typed back in the terminal. It reaches the dialog
// through stdin, never a command line, where ps or Win32_Process would show it to an
// agent. An agent that can read the screen can still read the dialog (a stated limit).

import { spawn as nodeSpawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { systemTool } from "../safe-spawn.mjs";

export const DIALOG_TEXTS = Object.freeze({
  why: (found) => (found?.verdict === "editor"
    ? `This terminal runs inside ${found.editor}, where an agent can run commands too: ad shows a code in a dialog.`
    : "ad can't tell which terminal this is (the process that started it is gone): ad shows a code in a dialog."),
  ask: "Type the code from the ad review dialog: ",
  noDialog: "accepting notes here needs a code from a dialog, and none can be shown. Run it in a terminal outside your editor.",
  wrongCode: "the code didn't match: nothing was accepted.",
});

const PROMPT = "Type this code in the terminal where ad asks for it:";
// Windows: the script is on the command line (encoded), the code arrives on stdin.
const WIN_SCRIPT = `$c = [Console]::In.ReadLine(); Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show("${PROMPT}" + [Environment]::NewLine + [Environment]::NewLine + $c, 'ad review')`;

/** How to show a dialog here: { cmd, args, input(code) }, or null when none can be shown. */
// powershell: Windows PowerShell by absolute path, never a bare name; null when it isn't there.
export function dialogCommand(platform = process.platform, env = process.env, { powershell = systemTool("powershell.exe", { env, platform }) } = {}) {
  if (platform === "win32") {
    if (!powershell) return null;
    return { cmd: powershell, args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WIN_SCRIPT, "utf16le").toString("base64")], input: (code) => `${code}\n` };
  }
  if (platform === "darwin") {
    // The whole AppleScript, code included, goes through stdin.
    return { cmd: "osascript", args: ["-"], input: (code) => `display dialog "${PROMPT} ${code}" with title "ad review" buttons {"OK"} default button 1\n` };
  }
  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    return { cmd: "zenity", args: ["--text-info", "--title=ad review"], input: (code) => `${PROMPT}\n\n${code}\n` };
  }
  return null;
}

/** Show a code, ask for it in the terminal. → { ok } or { ok: false, text } */
export async function confirmByDialog({ ask, found, out = (l) => console.log(l), platform = process.platform, env = process.env, spawn = nodeSpawn, code = String(randomInt(100000, 1000000)), tools } = {}) {
  const how = dialogCommand(platform, env, tools);
  if (!how || typeof ask !== "function") return { ok: false, text: DIALOG_TEXTS.noDialog };
  let child;
  try {
    child = spawn(how.cmd, how.args, { stdio: ["pipe", "ignore", "ignore"] });
  } catch {
    return { ok: false, text: DIALOG_TEXTS.noDialog };
  }
  // No zenity, no osascript: the spawn fails, and review refuses instead of waiting.
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
