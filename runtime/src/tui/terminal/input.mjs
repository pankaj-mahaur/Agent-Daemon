// Terminal input decoder: raw bytes (already decoded to a string) in, events
// out. Pure apart from timers, which are injectable for tests.
//
// Events:
//   {type:"key", name, ctrl, alt, shift, super, raw}
//       name: a single lowercase character ("c", "1", "/"), or one of enter,
//       newline, tab, backspace, escape, space, up, down, left, right, home,
//       end, pageup, pagedown, insert, delete, f1..f12, unknown.
//       "newline" is a bare LF (0x0a): Ctrl+J everywhere, Ctrl+Enter in Windows
//       Terminal, Shift+Enter in Zed (plan FC0). Use isNewline(ev).
//   {type:"text", text}            printable text, consecutive characters joined
//   {type:"paste", text}           bracketed paste (or a paste burst); CR/CRLF -> LF
//   {type:"paste-empty"}           an empty bracketed paste (an image on the clipboard)
//   {type:"focus", focused}
//   {type:"reply", kind:"cpr", row, col}
//   {type:"reply", kind:"da1", params}
//   {type:"reply", kind:"decrqm", mode, value}      value: 0 unknown .. 4 permanently reset
//   {type:"reply", kind:"kitty", flags}
//
// Keybindings never see paste content. Pasted text is not sanitized here; the
// composer sanitizes what it inserts.

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const TILDE = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
};
const LETTER_FINAL = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", E: "unknown", P: "f1", Q: "f2", R: "f3", S: "f4" };
// CSI-u / modifyOtherKeys code points with names; everything else is the character.
const CODE_NAMES = { 9: "tab", 13: "enter", 27: "escape", 32: "space", 127: "backspace", 8: "backspace" };
// Kitty functional keys in the private-use area (only the common ones).
// Kitty keypad keys (flag 1 reports them as CSI-u): KP_0..9, then operators.
const KITTY_FUNCTIONAL = {
  57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4", 57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
  57409: ".", 57410: "/", 57411: "*", 57412: "-", 57413: "+", 57414: "enter", 57415: "=", 57416: ",",
  57417: "left", 57418: "right", 57419: "up", 57420: "down", 57421: "pageup", 57422: "pagedown",
  57423: "home", 57424: "end", 57425: "insert", 57426: "delete", 57427: "unknown",
};
// A CSI longer than this is junk (real ones are a few dozen bytes): dropped.
const MAX_SEQUENCE = 256;

function mods(param) {
  // xterm/kitty: value = 1 + bits; shift 1, alt 2, ctrl 4, super 8, hyper 16,
  // meta 32, caps lock 64, num lock 128. Lock bits are not modifiers.
  const bits = Math.max(0, (Number(param) || 1) - 1);
  return { shift: !!(bits & 1), alt: !!(bits & 2 || bits & 32), ctrl: !!(bits & 4), super: !!(bits & 8) };
}

function key(name, raw, m = {}) {
  return { type: "key", name, ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift, super: !!m.super, raw };
}

/** True for every way the user can ask for a newline in the composer. */
export function isNewline(ev) {
  if (ev?.type !== "key" || ev.alt) return false;
  if (ev.name === "newline") return true;
  if (ev.name === "enter") return ev.shift || ev.ctrl;
  // Under CSI-u or modifyOtherKeys, Ctrl+J arrives as a key, not as LF.
  return ev.name === "j" && ev.ctrl && !ev.shift;
}

// A single control byte (not ESC) as a key.
function controlKey(ch, raw = ch, alt = false) {
  const c = ch.charCodeAt(0);
  if (ch === "\r") return key("enter", raw, { alt });
  if (ch === "\n") return key("newline", raw, { alt });
  if (ch === "\t") return key("tab", raw, { alt });
  if (ch === "\x7f") return key("backspace", raw, { alt });
  if (ch === "\x08") return key("backspace", raw, { ctrl: true, alt }); // Ctrl+Backspace (or Ctrl+H)
  if (c === 0) return key("space", raw, { ctrl: true, alt });
  if (c >= 1 && c <= 26) return key(String.fromCharCode(c + 96), raw, { ctrl: true, alt });
  if (c >= 28 && c <= 31) return key(["\\", "]", "^", "_"][c - 28], raw, { ctrl: true, alt });
  return key("unknown", raw);
}

function codeKey(code, m, raw) {
  const name = CODE_NAMES[code] ?? KITTY_FUNCTIONAL[code];
  if (name) return key(name, raw, m);
  if (code >= 57344 && code <= 63743) return key("unknown", raw, m);
  const ch = String.fromCodePoint(code);
  // Report letters lowercase; shift stays a modifier.
  return key(ch.toLowerCase(), raw, m);
}

/**
 * Decodes one complete CSI sequence. `outstandingCpr` decides whether
 * `CSI r;c R` is a cursor report or a modified F3.
 */
function decodeCsi(seq, outstandingCpr) {
  const body = seq.slice(2);
  const final = body[body.length - 1];
  const inner = body.slice(0, -1);
  let m;

  if (final === "I" && inner === "") return { type: "focus", focused: true };
  if (final === "O" && inner === "") return { type: "focus", focused: false };
  if (final === "Z") return key("tab", seq, { shift: true });

  if (final === "R" && (m = /^(\d+);(\d+)$/.exec(inner))) {
    if (outstandingCpr) return { type: "reply", kind: "cpr", row: Number(m[1]), col: Number(m[2]) };
    if (m[1] === "1") return key("f3", seq, mods(m[2]));
  }
  if (final === "c" && inner.startsWith("?")) {
    return { type: "reply", kind: "da1", params: inner.slice(1).split(";").filter(Boolean).map(Number) };
  }
  if (final === "y" && (m = /^\?(\d+);(\d+)\$$/.exec(inner))) {
    return { type: "reply", kind: "decrqm", mode: Number(m[1]), value: Number(m[2]) };
  }
  if (final === "u" && (m = /^\?(\d+)$/.exec(inner))) return { type: "reply", kind: "kitty", flags: Number(m[1]) };

  if (final === "u" && (m = /^(\d+)(?::\d*)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?$/.exec(inner))) {
    if (m[3] === "3") return null; // key release (only with flag 2; never asked for)
    return codeKey(Number(m[1]), mods(m[2]), seq);
  }
  if (final === "~" && (m = /^27;(\d+);(\d+)$/.exec(inner))) return codeKey(Number(m[2]), mods(m[1]), seq);
  if (final === "~" && (m = /^(\d+)(?:;(\d+))?$/.exec(inner))) {
    const name = TILDE[m[1]];
    if (name) return key(name, seq, mods(m[2]));
  }
  if (LETTER_FINAL[final] && (m = /^(?:1?;(\d+)|\d*)$/.exec(inner))) return key(LETTER_FINAL[final], seq, mods(m[1]));
  return key("unknown", seq);
}

function decodeSs3(seq) {
  const name = LETTER_FINAL[seq[2]];
  return key(name ?? "unknown", seq);
}

/**
 * createInputDecoder({onEvent, escTimeoutMs, sequenceCapMs, pasteIdleMs,
 *                     pasteAbandonMs, pasteBurst, setTimeout, clearTimeout})
 *   feed(chunk)       decode a chunk; emits events through onEvent
 *   expect("cpr")     a CPR query was sent; the next CSI r;c R is its reply
 *   cancel("cpr")     a CPR query was given up on
 *   flush()           emit whatever is pending (a lone ESC, a half paste)
 *   reset()           drop all state without emitting (re-entry after restore)
 *   dispose()         cancel timers
 *
 * A paste that stalls is shown after pasteIdleMs, but the decoder stays in
 * paste mode until the end marker or pasteAbandonMs of quiet, so the rest of a
 * stalled paste never turns into keys.
 */
export function createInputDecoder({
  onEvent,
  escTimeoutMs = process.env.SSH_CONNECTION ? 100 : 30,
  sequenceCapMs = 500,
  pasteIdleMs = 1000,
  pasteAbandonMs = 10_000,
  pasteBurst = false,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  if (typeof onEvent !== "function") throw new TypeError("createInputDecoder: onEvent is required");
  let buf = "";
  let paste = null; // string while inside a bracketed paste
  let pasteShown = false; // part of the current paste was already emitted
  let timer = null;
  let timerKind = null;
  let cprOutstanding = 0;
  let text = "";

  const emitText = () => {
    if (text) {
      onEvent({ type: "text", text });
      text = "";
    }
  };
  let altPrefix = false;
  const emit = (ev) => {
    if (!ev) return;
    emitText();
    if (altPrefix) {
      altPrefix = false;
      if (ev.type === "key") ev = { ...ev, alt: true, raw: ESC + ev.raw };
    }
    if (ev.type === "reply" && ev.kind === "cpr") cprOutstanding = Math.max(0, cprOutstanding - 1);
    onEvent(ev);
  };
  const emitPaste = (raw) => {
    const t = raw.replace(/\r\n?/g, "\n");
    emit(t ? { type: "paste", text: t } : { type: "paste-empty" });
  };
  const arm = (ms, fn, kind = null) => {
    if (timer) clearT(timer);
    timerKind = kind;
    timer = setT(() => {
      timer = null;
      timerKind = null;
      fn();
    }, ms);
  };
  const disarm = () => {
    if (timer) clearT(timer);
    timer = null;
    timerKind = null;
  };
  let abandonTimer = null;
  const endPaste = (content) => {
    if (abandonTimer) clearT(abandonTimer);
    abandonTimer = null;
    const shown = pasteShown;
    paste = null;
    pasteShown = false;
    if (content || !shown) emitPaste(content);
  };

  function drain() {
    while (buf.length) {
      if (paste !== null) {
        const end = buf.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible partial end marker in buf; the rest is content.
          let keep = 0;
          for (let k = Math.min(PASTE_END.length - 1, buf.length); k > 0; k--) {
            if (PASTE_END.startsWith(buf.slice(-k))) {
              keep = k;
              break;
            }
          }
          paste += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          arm(pasteIdleMs, () => {
            // Stalled: show what arrived, stay in paste mode. A trailing CR
            // waits, in case its LF is still coming.
            if (paste === null) return;
            const cut = paste.endsWith("\r") ? paste.length - 1 : paste.length;
            if (cut > 0) {
              const p = paste.slice(0, cut);
              paste = paste.slice(cut);
              pasteShown = true;
              emitPaste(p);
            }
            // Counted once from the first stall; later bytes don't extend it.
            abandonTimer ??= setT(() => {
              abandonTimer = null;
              const rest = paste + buf;
              buf = "";
              disarm();
              endPaste(rest);
            }, pasteAbandonMs);
          });
          return;
        }
        const content = paste + buf.slice(0, end);
        buf = buf.slice(end + PASTE_END.length);
        disarm();
        endPaste(content);
        continue;
      }

      const ch = buf[0];
      if (ch === ESC) {
        if (buf.length === 1) {
          // A lone ESC: the Esc key, unless more bytes follow quickly.
          emitText();
          arm(escTimeoutMs, () => {
            if (buf === ESC) {
              buf = "";
              emit(key("escape", ESC));
            }
          });
          return;
        }
        const next = buf[1];
        if (next === "[") {
          const m = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/.exec(buf);
          if (!m) {
            if (/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*$/.test(buf)) {
              // Started but unfinished: wait for the final byte, but at most
              // sequenceCapMs from the start (not re-armed by more bytes) and
              // at most MAX_SEQUENCE bytes.
              emitText();
              if (buf.length > MAX_SEQUENCE) {
                disarm();
                emit(key("unknown", buf.slice(0, 16)));
                buf = "";
                return;
              }
              if (timerKind !== "sequence") {
                arm(sequenceCapMs, () => {
                  const raw = buf;
                  buf = "";
                  emit(key("unknown", raw.slice(0, 16)));
                }, "sequence");
              }
              return;
            }
            // Malformed: drop the introducer, keep going.
            emit(key("unknown", buf.slice(0, 2)));
            buf = buf.slice(2);
            continue;
          }
          const seq = m[0];
          buf = buf.slice(seq.length);
          disarm();
          if (seq === PASTE_START) {
            emitText();
            paste = "";
            pasteShown = false;
            continue;
          }
          emit(decodeCsi(seq, cprOutstanding > 0));
          continue;
        }
        if (next === "O") {
          if (buf.length < 3) {
            emitText();
            arm(escTimeoutMs, () => {
              const raw = buf;
              buf = "";
              emit(key("o", raw, { alt: true, shift: true }));
            });
            return;
          }
          disarm();
          const third = buf.charCodeAt(2);
          if (third < 0x40 || third > 0x7e) {
            // Not SS3: Alt+Shift+O, and the next byte is decoded on its own.
            buf = buf.slice(2);
            emit(key("o", ESC + "O", { alt: true, shift: true }));
            continue;
          }
          const seq = buf.slice(0, 3);
          buf = buf.slice(3);
          emit(decodeSs3(seq));
          continue;
        }
        // ESC ESC [ / ESC ESC O: some terminals send Alt+<special key> this way.
        if (next === ESC && (buf[2] === "[" || buf[2] === "O")) {
          buf = buf.slice(1);
          altPrefix = true;
          continue;
        }
        if (next === ESC && buf.length === 2) {
          // Could still become ESC ESC [ ...; wait like a lone ESC.
          emitText();
          arm(escTimeoutMs, () => {
            if (buf === ESC + ESC) {
              buf = "";
              emit(key("escape", ESC + ESC, { alt: true }));
            }
          });
          return;
        }
        // ESC + one character: Alt+key.
        disarm();
        const cp = buf.codePointAt(1);
        const len = cp > 0xffff ? 3 : 2;
        const raw = buf.slice(0, len);
        buf = buf.slice(len);
        if (next === ESC) {
          emit(key("escape", raw, { alt: true }));
        } else if (cp < 0x20 || cp === 0x7f) {
          emit(controlKey(next, raw, true));
        } else {
          const c = String.fromCodePoint(cp);
          emit(key(c === " " ? "space" : c.toLowerCase(), raw, { alt: true, shift: c !== c.toLowerCase() }));
        }
        continue;
      }

      disarm();
      const c = ch.charCodeAt(0);
      if (c < 0x20 || c === 0x7f) {
        if (pasteBurst && (ch === "\r" || ch === "\n") && text.length > 0 && buf.length > 1 && !buf.includes(ESC)) {
          // No bracketed paste: text, a line break and more text in one chunk
          // is a paste, not typing (plan 1a paste-burst heuristic).
          const p = text + buf;
          text = "";
          buf = "";
          emitPaste(p);
          return;
        }
        buf = buf.slice(1);
        emit(controlKey(ch));
        continue;
      }
      // Printable run up to the next control or ESC.
      const m = /^[^\x00-\x1f\x7f]+/.exec(buf);
      text += m[0];
      buf = buf.slice(m[0].length);
    }
    emitText();
  }

  return {
    feed(chunk) {
      if (paste !== null && pasteShown && chunk === "\x03") {
        // A lone Ctrl+C while a stalled paste waits for its end marker: the
        // terminal lost the marker. End the paste and let Ctrl+C through.
        const rest = paste + buf;
        buf = "";
        disarm();
        endPaste(rest);
      }
      buf += chunk;
      drain();
    },
    expect(kind) {
      if (kind !== "cpr") throw new Error(`expect: unknown reply kind ${kind}`);
      cprOutstanding++;
    },
    cancel(kind) {
      if (kind !== "cpr") throw new Error(`cancel: unknown reply kind ${kind}`);
      cprOutstanding = Math.max(0, cprOutstanding - 1);
    },
    get pending() {
      return { buffered: buf.length, inPaste: paste !== null, cprOutstanding };
    },
    flush() {
      disarm();
      if (paste !== null) {
        const p = paste + buf;
        buf = "";
        endPaste(p);
      } else if (buf === ESC) {
        buf = "";
        emit(key("escape", ESC));
      } else if (buf) {
        const raw = buf;
        buf = "";
        emit(key("unknown", raw));
      }
      emitText();
    },
    reset() {
      disarm();
      if (abandonTimer) clearT(abandonTimer);
      abandonTimer = null;
      buf = "";
      text = "";
      paste = null;
      pasteShown = false;
      altPrefix = false;
      cprOutstanding = 0;
    },
    dispose() {
      disarm();
      if (abandonTimer) clearT(abandonTimer);
      abandonTimer = null;
    },
  };
}
