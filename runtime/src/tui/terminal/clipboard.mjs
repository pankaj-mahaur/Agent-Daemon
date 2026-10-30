// The clipboard (plan P2.3): copying through the platform's tool and the
// terminal, reading it back for a right-click paste, and the per-terminal
// defaults. Moved from commands.mjs, which re-exports copyText.
//
// copyText(text, {terminalWrite, env, platform, spawnFn, timeoutMs, readFile})
//   → {ok, via, error?}. Order: the native tool (clip.exe first on WSL), each
//   killed after timeoutMs; then, in addition, tmux's buffer (else OSC 52
//   wrapped for tmux) inside tmux, OSC 52 over SSH, and OSC 52 when the native
//   tool failed and nothing else carried it. OSC 52 is not written when the
//   native tool worked outside tmux and SSH.
// readClipboard({env, platform, spawnFn, timeoutMs, readFile}) → string | null
// copyOnSelectDefault({env, platform, setting}) → boolean
// rightClickPaste({env, platform, setting, readFile}) → boolean

import { spawn } from "node:child_process";
import fs from "node:fs";

export const TERMINAL_MAX = 100_000;

const NATIVE = {
  win32: [["clip.exe", []]],
  darwin: [["pbcopy", []]],
  linux: [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ],
};
const READ = {
  win32: [["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]],
  darwin: [["pbpaste", []]],
  linux: [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ],
};

const readProcVersion = () => fs.readFileSync("/proc/version", "utf8");

export function isWsl({ env = process.env, platform = process.platform, readFile = readProcVersion } = {}) {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFile());
  } catch {
    return false;
  }
}

const overSsh = (env) => Boolean(env.SSH_TTY || env.SSH_CONNECTION);

// Runs a tool with `input` on stdin; true when it exits 0 in time. A tool that
// hangs (a clipboard manager waiting for a display) is killed and counts as failed.
function run(cmd, args, { input = null, spawnFn, timeoutMs, capture = false }) {
  return new Promise((resolve) => {
    let child;
    let out = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    try {
      child = spawnFn(cmd, args, { stdio: ["pipe", capture ? "pipe" : "ignore", "ignore"], windowsHide: true });
    } catch {
      return resolve(capture ? null : false);
    }
    const timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        // Already gone.
      }
      done(capture ? null : false);
    }, timeoutMs);
    child.on("error", () => done(capture ? null : false));
    if (capture) child.stdout?.on?.("data", (d) => (out += String(d)));
    child.on("exit", (code) => done(capture ? (code === 0 ? out : null) : code === 0));
    // A tool that exits without reading makes the write fail: that's a "no".
    child.stdin?.on?.("error", () => done(capture ? null : false));
    child.stdin?.end?.(input ?? undefined);
  });
}

const osc52 = (text) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
const forTmux = (seq) => `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;

export async function copyText(text, { terminalWrite, write, env = process.env, platform = process.platform, spawnFn = spawn, timeoutMs = 2000, readFile = readProcVersion, osc52: allowTerminal = true } = {}) {
  const value = String(text ?? "");
  if (!value) return { ok: false, via: null, error: "nothing to copy" };
  const toTerminal = terminalWrite ?? write;
  const wsl = isWsl({ env, platform, readFile });
  const tools = wsl ? [...NATIVE.win32, ...NATIVE.linux] : NATIVE[platform] ?? NATIVE.linux;
  let native = null;
  for (const [cmd, args] of tools) {
    // clip.exe reads the console code page; UTF-16LE with a BOM is what it takes for Unicode.
    const input = cmd === "clip.exe" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]) : value;
    if (await run(cmd, args, { input, spawnFn, timeoutMs })) {
      native = cmd;
      break;
    }
  }
  let via = native;
  let error;
  let forwarded = false;
  const tooLarge = Buffer.byteLength(value) > TERMINAL_MAX;
  const terminal = (seq) => {
    if (!allowTerminal || !toTerminal) return false;
    if (tooLarge) {
      error = "too large for the terminal clipboard";
      return false;
    }
    toTerminal(seq);
    via ??= "terminal";
    return true;
  };
  if (env.TMUX) {
    if (await run("tmux", ["load-buffer", "-w", "-"], { input: value, spawnFn, timeoutMs })) {
      forwarded = true;
      via ??= "tmux";
    } else forwarded = terminal(forTmux(osc52(value))) || forwarded;
  }
  if (overSsh(env)) forwarded = terminal(env.TMUX ? forTmux(osc52(value)) : osc52(value)) || forwarded;
  if (!native && !forwarded) forwarded = terminal(env.TMUX ? forTmux(osc52(value)) : osc52(value));
  const ok = Boolean(native) || forwarded;
  return ok ? { ok, via } : { ok: false, via: null, ...(error ? { error } : {}) };
}

export async function readClipboard({ env = process.env, platform = process.platform, spawnFn = spawn, timeoutMs = 2000, readFile = readProcVersion } = {}) {
  const tools = isWsl({ env, platform, readFile }) ? READ.win32 : READ[platform] ?? READ.linux;
  for (const [cmd, args] of tools) {
    const text = await run(cmd, args, { spawnFn, timeoutMs, capture: true });
    if (typeof text === "string") return text.replace(/\r\n?/g, "\n");
  }
  return null;
}

const versionAtLeast = (v, min) => {
  const a = String(v ?? "").split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
};

/**
 * Copy when a mouse selection ends? On where the terminal's own selection
 * doesn't copy for you; off where the terminal already copies a selection
 * (Windows Terminal, VS Code on Windows, kitty on macOS, Ghostty 1.2+).
 */
export function copyOnSelectDefault({ env = process.env, platform = process.platform, setting = null } = {}) {
  if (setting === "always") return true;
  if (setting === "never") return false;
  if (env.TMUX || env.ZELLIJ) return true;
  if (env.WT_SESSION && !env.TERM_PROGRAM) return false;
  if (env.TERM_PROGRAM === "vscode" && platform === "win32") return false;
  if (env.KITTY_WINDOW_ID && platform === "darwin") return false;
  if (env.TERM_PROGRAM === "ghostty" && versionAtLeast(env.TERM_PROGRAM_VERSION, "1.2.0")) return false;
  return true;
}

/** May a right-click without a selection paste the clipboard? Never over SSH or in VS Code. */
export function rightClickPaste({ env = process.env, platform = process.platform, setting = "auto", readFile = readProcVersion } = {}) {
  if (overSsh(env) || env.TERM_PROGRAM === "vscode") return false;
  if (setting === "on") return true;
  if (setting === "off") return false;
  return platform === "win32" || platform === "linux" || isWsl({ env, platform, readFile });
}
