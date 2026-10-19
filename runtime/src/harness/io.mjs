// Small terminal helpers for harness commands: hidden secret input and
// opening a URL in the browser without a shell.

import { isEngineError, engineErrorText, engineErrorDetail } from "../engine/index.mjs";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { systemTool } from "../safe-spawn.mjs";
import { redact } from "../auth/redact.mjs";

const READ_TIMEOUT_MS = 5 * 60_000;

// Remove ANSI escape sequences (arrow keys, Delete, …) from raw key input.
const ESCAPES = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g;

// Read a secret from a TTY with echo off; from a pipe (`echo $KEY | ad …`),
// read the first line. Git Bash/mintty is not a TTY to node, so the prompt
// is still shown and the user is told input may be visible.
export function readSecret(prompt, { stdin = process.stdin, stderr = process.stderr, timeoutMs = READ_TIMEOUT_MS } = {}) {
  if (!stdin.isTTY) {
    stderr.write(`${prompt}(input is not hidden in this terminal; or pipe it: echo $KEY | ad …)\n`);
    return new Promise((resolve, reject) => {
      let data = "";
      const timer = setTimeout(() => finish(new Error("timed out waiting for the key on stdin")), timeoutMs);
      const onData = (c) => {
        data += c;
        if (/\r?\n/.test(data)) finish(null);
      };
      const onEnd = () => finish(null);
      function finish(err) {
        clearTimeout(timer);
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", finish);
        stdin.pause();
        if (err) reject(err);
        else resolve(data.split(/\r?\n/)[0].trim());
      }
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("error", finish);
      stdin.resume();
    });
  }
  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    let value = "";
    const timer = setTimeout(() => done(new Error("timed out waiting for input")), timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk.replace(ESCAPES, "")) {
        if (ch === "\r" || ch === "\n") return done(null);
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    function done(err) {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    }
    stdin.on("data", onData);
  });
}

// https only — the URL comes from a server response, and a shell is never
// involved (cmd.exe `start` would interpret & in query strings). Resolves
// true when the opener launched; on Windows that does not prove a browser
// actually appeared, so callers should print the URL too.
export function openUrl(url, { run = execFile } = {}) {
  if (!/^https:\/\//i.test(url)) return Promise.resolve(false);
  return openWith(url, run);
}

/**
 * Open a local file (the viewer's HTML) with the OS's default app: an
 * absolute path that exists, passed as one argument, no shell.
 */
export function openPath(file, { run = execFile } = {}) {
  if (!file || !path.isAbsolute(file) || !existsSync(file)) return Promise.resolve(false);
  return openWith(file, run);
}

// The OS opener, by full path where there is one (rundll32 in System32,
// /usr/bin/open); xdg-open from PATH (execvp: PATH only).
function openWith(target, run) {
  return new Promise((resolve) => {
    let opener;
    if (process.platform === "win32") {
      const rundll = systemTool("rundll32.exe");
      opener = rundll ? [rundll, ["url.dll,FileProtocolHandler", target]] : null;
    } else if (process.platform === "darwin") opener = ["/usr/bin/open", [target]];
    else opener = ["xdg-open", [target]];
    if (!opener) return resolve(false);
    run(opener[0], opener[1], { windowsHide: true, shell: false }, (err) => resolve(!err));
  });
}

/** "ad <cmd>: <ad's words>" and, for an engine error, "  details: <the engine's raw text>". */
export function cliErrorLines(cmd, err) {
  const lines = [`ad ${cmd}: ${isEngineError(err) ? engineErrorText(err, { details: null }) : redact(err?.message ?? String(err))}`];
  const raw = engineErrorDetail(err);
  if (raw) for (const l of String(raw).split("\n").slice(0, 8)) lines.push(`  details: ${l}`);
  return lines.join("\n") + "\n";
}
