// Keys for the review checklist (L5 design decision 11): a byte decoder and a raw-mode
// driver. Decodes POSIX and Windows-console input alike:
//   \r, \n, \r\n (one enter) · \x1b[A / \x1bOA (up) and the other arrows · \x1b[5~ \x1b[6~
//   (page up/down) · \x1b[H \x1b[F \x1b[1~ \x1b[4~ \x1bOH \x1bOF (home/end) · \x03 (ctrl-c) ·
//   \b and \x7f (backspace) · a lone \x1b (esc) only after the timeout, so an arrow split
//   across two reads is still an arrow · printable text as {char}.
// The driver flushes what was typed before it started (keys typed during the token check
// are dropped), and restores raw mode and the cursor on every exit: normal, ctrl-c, an
// error, SIGTERM.

import { StringDecoder } from "node:string_decoder";

// Signals that end the loop with the terminal restored: a kill, a closed terminal, an
// interrupt from outside (ctrl-c itself arrives as \x03 in raw mode).
const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"];

const NAMED = new Map([
  ["[A", "up"], ["OA", "up"], ["[B", "down"], ["OB", "down"], ["[C", "right"], ["OC", "right"], ["[D", "left"], ["OD", "left"],
  ["[5~", "pgup"], ["[6~", "pgdn"], ["[H", "home"], ["OH", "home"], ["[1~", "home"], ["[7~", "home"], ["[F", "end"], ["OF", "end"], ["[4~", "end"], ["[8~", "end"],
  ["[3~", "delete"],
]);
const SIMPLE = new Map([["q", "q"], ["x", "x"], ["a", "a"], ["e", "e"], ["y", "y"], ["n", "n"], ["j", "j"], ["k", "k"], ["?", "?"]]);

/**
 * A stateful decoder. feed(text) → key names; flushEsc() → ["esc"] when a lone escape is
 * pending (the driver calls it after the timeout).
 * @param {{text?:boolean}} [o]  text: printable characters come as {char} (the editor);
 *   otherwise known letters come by name and other characters as {char}.
 */
export function createDecoder() {
  let pending = "";
  let lastCR = false;
  const out = [];
  function take(text) {
    let s = pending + text;
    pending = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\x1b") {
        const rest = s.slice(i + 1);
        if (!rest.length) {
          pending = "\x1b"; // a lone escape, or the start of a split sequence
          break;
        }
        const m = /^(\[[0-9;]*[~A-Za-z]|O[A-Za-z])/.exec(rest);
        if (m) {
          out.push(NAMED.get(m[1].replace(/^\[1;\d+/, "[")) ?? "unknown");
          i += 1 + m[1].length;
          lastCR = false;
          continue;
        }
        if (/^(\[[0-9;]*|O)$/.test(rest)) {
          pending = s.slice(i); // incomplete: wait for more
          break;
        }
        // esc followed by something else: esc, then that
        out.push("esc");
        i += 1;
        lastCR = false;
        continue;
      }
      if (c === "\r") {
        out.push("enter");
        lastCR = true;
        i++;
        continue;
      }
      if (c === "\n") {
        if (!lastCR) out.push("enter"); // \r\n is one enter
        lastCR = false;
        i++;
        continue;
      }
      lastCR = false;
      if (c === "\x03") out.push("ctrl-c");
      else if (c === "\b" || c === "\x7f") out.push("backspace");
      else if (c === " ") out.push("space");
      else if (c === "\t") out.push("tab");
      else if (c < " ") out.push("unknown");
      else {
        const cp = s.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        out.push(SIMPLE.get(ch) ?? { char: ch });
        i += ch.length;
        continue;
      }
      i++;
    }
    return out.splice(0);
  }
  return {
    feed: (text) => take(String(text)),
    /** A lone escape that waited out the timeout. */
    flushEsc() {
      if (pending === "\x1b") {
        pending = "";
        return ["esc"];
      }
      if (pending) {
        // An incomplete sequence that never finished: drop it.
        pending = "";
      }
      return [];
    },
    get waiting() {
      return pending !== "";
    },
  };
}

/** In the editor, a named letter is just that letter. */
export function asText(key) {
  if (typeof key === "object") return key;
  if (SIMPLE.has(key)) return { char: key };
  return key;
}

/**
 * Run a key loop on a raw terminal until done(key) says so.
 * @param {{stdin:object, stdout:object, onKey:(key)=>boolean|Promise<boolean>, escTimeout?:number, signals?:object}} o
 *   onKey returns true when the loop is over. stdin: a TTY stream (setRawMode) or a fake.
 * @returns {Promise<{ended:"done"|"ctrl-c"|"error"|"signal", error?:Error}>}
 */
export function runKeys({ stdin, stdout, onKey, escTimeout = 60, signals = process }) {
  return new Promise((resolve) => {
    const decoder = createDecoder();
    // A UTF-8 character split across two reads stays one character.
    const utf8 = new StringDecoder("utf8");
    const wasRaw = Boolean(stdin.isRaw);
    let timer = null;
    let finished = false;
    let chain = Promise.resolve();
    // Keys typed before the checklist opened (during the token check) are dropped.
    try {
      while (typeof stdin.read === "function" && stdin.read() !== null);
    } catch {
      // nothing buffered
    }
    const restore = () => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      for (const sig of SIGNALS) signals.removeListener?.(sig, onSignal);
      try {
        if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
      } catch {
        // the terminal is gone
      }
      try {
        stdin.pause?.();
      } catch {
        // already paused
      }
      try {
        stdout.write("\x1b[?25h"); // the cursor back
      } catch {
        // stdout closed
      }
    };
    const end = (how, error) => {
      if (finished) return;
      finished = true;
      restore();
      resolve(error ? { ended: how, error } : { ended: how });
    };
    const handle = (keys) => {
      for (const k of keys) {
        chain = chain.then(async () => {
          if (finished) return;
          try {
            const over = await onKey(k);
            // ctrl-c always ends the loop, whatever the screen did with it.
            if (k === "ctrl-c") end("ctrl-c");
            else if (over) end("done");
          } catch (e) {
            end("error", e);
          }
        });
      }
    };
    function onData(chunk) {
      clearTimeout(timer);
      handle(decoder.feed(Buffer.isBuffer(chunk) ? utf8.write(chunk) : chunk));
      if (decoder.waiting) timer = setTimeout(() => handle(decoder.flushEsc()), escTimeout);
    }
    function onSignal() {
      end("signal");
    }
    try {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
      stdin.on("data", onData);
      stdin.resume?.();
      for (const sig of SIGNALS) signals.on?.(sig, onSignal);
    } catch (e) {
      end("error", e);
    }
  });
}
