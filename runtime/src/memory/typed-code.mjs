// The typed confirmation code (MCP launch plan L7, D16). After the review token, a verb that
// lowers enforcement prints a random 4-letter code to the controlling terminal (/dev/tty,
// CONOUT$) with what will change, and reads it back from that terminal: a script that runs
// the verb blind in a terminal the agent opened can't answer it. A run that already proved
// itself with L1's dialog code isn't asked again. It doesn't stop a script that drives a PTY
// or reads the screen (stated in the docs).
//
//   confirmTypedCode({ what, proven, tty, alphabet, code }) → { ok: true } | { ok: false, text }

import fs from "node:fs";
import { randomInt } from "node:crypto";

/** No look-alikes (b/6, g/9, i/l/1, o/0, q, s/5, u/v, z/2). */
export const CODE_LETTERS = "acdefhjkmnprtvwxy";

export const makeCode = (alphabet = CODE_LETTERS, n = 4) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join("");

/**
 * The controlling terminal, opened apart from stdin and stdout → { ask(question): Promise<string>,
 * close() } or null when this process has none. A run whose stdin isn't a terminal (a script, a
 * CI job, a test) has none: nothing is opened. On Windows a console can exist without anyone at
 * it (a CI runner's), and reading it would wait forever.
 */
export function openTty({ platform = process.platform, isTTY = () => Boolean(process.stdin.isTTY), open = fs.openSync, read = fs.readSync, write = fs.writeSync, close = fs.closeSync } = {}) {
  if (!isTTY()) return null;
  let rfd;
  let wfd;
  try {
    if (platform === "win32") {
      // The device namespace: a bare "CONIN$" goes through toNamespacedPath (\\?\<cwd>\CONIN$),
      // which names a file, not the console; "r+" opens only what exists (never creates one).
      rfd = open("\\\\.\\CONIN$", "r+");
      wfd = open("\\\\.\\CONOUT$", "r+");
    } else {
      rfd = wfd = open("/dev/tty", "r+");
    }
  } catch {
    for (const fd of new Set([rfd, wfd])) if (fd !== undefined) try { close(fd); } catch { /* closed */ }
    return null;
  }
  return {
    async ask(question) {
      write(wfd, question);
      // One line, read byte by byte so nothing past it is taken from the terminal.
      const buf = Buffer.alloc(1);
      const bytes = [];
      while (bytes.length < 256) {
        const n = read(rfd, buf, 0, 1, null);
        if (!n || buf[0] === 0x0a) break;
        bytes.push(buf[0]);
      }
      return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    },
    close() {
      for (const fd of new Set([rfd, wfd])) try { close(fd); } catch { /* closed */ }
    },
  };
}

/**
 * Ask for the code. what: the change, in the user's words ("Pause all 4 rules in app for 1
 * hour"); proven: the run proved itself with the dialog code (no second ask); tty, alphabet,
 * code: seams for tests (tty: { ask(question) }).
 */
export async function confirmTypedCode({ what, proven = false, tty, alphabet = CODE_LETTERS, code, isTTY } = {}) {
  if (proven) return { ok: true };
  const term = tty === undefined ? openTty(isTTY ? { isTTY } : {}) : tty;
  if (!term) return { ok: false, text: "this needs a code typed in your terminal, and this run has none; nothing changed" };
  const want = (code ?? makeCode(alphabet)).toLowerCase();
  let typed;
  try {
    typed = await term.ask(`${what} — type ${want}: `);
  } catch (e) {
    return { ok: false, text: `couldn't read the code from your terminal (${e?.message ?? e}); nothing changed` };
  } finally {
    if (tty === undefined) term.close?.();
  }
  return String(typed ?? "").trim().toLowerCase() === want ? { ok: true } : { ok: false, text: "the code didn't match; nothing changed" };
}
