// Terminal I/O for the TUI: raw mode, capability negotiation, input events,
// handoff to a child that needs the terminal, and a restore that runs on every
// exit path (plan Part 1a).
//
// createIo({stdin, stdout, env, platform, proc, fd, writeSync, queryTimeoutMs,
//           drainTimeoutMs, staleCprGraceMs, errSink, decoderOptions})
//   → {caps, write, enter(), restore(), close(), handoff(fn), suspend(),
//      onInput(fn), onResume(fn), cpr(), size()}
//
// Everything that touches the process (signals, exit, SIGSTOP) goes through
// `proc`, so tests can drive it with a fake.

import fs from "node:fs";
import { createInputDecoder } from "./input.mjs";

const CSI = "\x1b[";
const BRACKETED_PASTE_ON = `${CSI}?2004h`;
const BRACKETED_PASTE_OFF = `${CSI}?2004l`;
const KITTY_PUSH = `${CSI}>1u`; // flag 1: disambiguate escape codes
const KITTY_POP = `${CSI}<u`;
const KITTY_QUERY = `${CSI}?u`;
const SYNC_QUERY = `${CSI}?2026$p`;
const DA1_QUERY = `${CSI}c`;
const MOK_ON = `${CSI}>4;2m`; // xterm modifyOtherKeys level 2
const MOK_OFF = `${CSI}>4;0m`;
const FOCUS_ON = `${CSI}?1004h`;
const FOCUS_OFF = `${CSI}?1004l`;

// Undo everything enter() may have set, plus what a killed frame may have left
// (an open synchronized update, autowrap off, a hidden cursor, a cursor shape).
export const RESTORE_SEQUENCE = [
  `${CSI}?2026l`,
  KITTY_POP,
  MOK_OFF,
  BRACKETED_PASTE_OFF,
  FOCUS_OFF,
  `${CSI}?7h`,
  `${CSI}?25h`,
  `${CSI}0 q`,
].join("");

const SIGNALS = ["SIGTERM", "SIGHUP", "SIGBREAK", "SIGINT"];

export function createIo({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  platform = process.platform,
  proc = process,
  fd = 1,
  writeSync = fs.writeSync,
  queryTimeoutMs = 300,
  drainTimeoutMs = 100,
  staleCprGraceMs = 2000,
  errSink = (err) => process.stderr.write(`${err?.stack ?? err}\n`),
  decoderOptions = {},
} = {}) {
  const caps = {
    kitty: false,
    modifyOtherKeys: false,
    sync: false,
    focus: platform !== "win32", // as in Codex: no focus reporting on Windows
    da1: null,
  };
  const inputListeners = new Set();
  const resumeListeners = new Set();
  const cprWaiters = [];
  // CPR queries that timed out: their replies may still arrive, and must not
  // answer a later query. Each entry expires after a grace period.
  const staleCpr = [];
  let da1Waiter = null;
  let entered = false;
  let entering = null; // the in-flight enter() promise
  let restored = true;
  let procHooked = false;
  let away = false; // the terminal belongs to a child (handoff) or we are stopped

  const decoder = createInputDecoder({
    escTimeoutMs: env.SSH_CONNECTION ? 100 : 30,
    ...decoderOptions,
    onEvent: handleEvent,
  });

  function handleEvent(ev) {
    if (ev.type === "reply") {
      if (ev.kind === "cpr") {
        if (staleCpr.length) clearTimeout(staleCpr.shift()); // a late answer to a query given up on
        else cprWaiters.shift()?.resolve({ row: ev.row, col: ev.col });
      } else if (ev.kind === "kitty") {
        // A late reply (ConPTY can answer after DA1) still upgrades.
        if (!caps.kitty && caps.modifyOtherKeys && entered) {
          writeRaw(MOK_OFF);
          caps.modifyOtherKeys = false;
        }
        caps.kitty = true;
      } else if (ev.kind === "decrqm" && ev.mode === 2026) caps.sync = ev.value === 1 || ev.value === 2;
      else if (ev.kind === "da1") {
        caps.da1 = ev.params;
        da1Waiter?.();
      }
      return;
    }
    for (const fn of inputListeners) fn(ev);
  }

  const onData = (chunk) => decoder.feed(String(chunk));
  const writeRaw = (s) => {
    try {
      writeSync(fd, s);
    } catch (err) {
      errSink(err);
    }
  };

  function hookProcess() {
    if (procHooked) return;
    procHooked = true;
    proc.on("exit", restore);
    for (const sig of SIGNALS) {
      try {
        proc.on(sig, onSignal);
      } catch {
        // Signal not supported on this platform.
      }
    }
    proc.on("uncaughtException", onFatal);
    proc.on("unhandledRejection", onFatal);
    proc.on("warning", errSink);
  }

  function unhookProcess() {
    if (!procHooked) return;
    procHooked = false;
    proc.off("exit", restore);
    for (const sig of SIGNALS) proc.off(sig, onSignal);
    proc.off("uncaughtException", onFatal);
    proc.off("unhandledRejection", onFatal);
    proc.off("warning", errSink);
  }

  function onSignal(sig) {
    // While a child has the terminal in cooked mode, Ctrl+C / Ctrl+Break go to
    // the whole foreground group: they are the child's, not a reason to quit.
    if (away && (sig === "SIGINT" || sig === "SIGBREAK")) return;
    restore();
    proc.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 }[sig] ?? 1));
  }

  function onFatal(err) {
    restore();
    errSink(err);
    proc.exit(1);
  }

  function setRaw(on) {
    try {
      stdin.setRawMode?.(on);
    } catch (err) {
      errSink(err);
    }
  }

  let attached = false;
  function attachInput() {
    if (attached) return; // never two data listeners: every key would arrive twice
    attached = true;
    stdin.setEncoding?.("utf8"); // a StringDecoder: split UTF-8 sequences stay whole
    stdin.on("data", onData);
    stdin.resume?.();
  }

  function detachInput() {
    attached = false;
    stdin.off("data", onData);
    stdin.pause?.();
  }

  function modesOn() {
    let s = BRACKETED_PASTE_ON + KITTY_PUSH;
    if (caps.modifyOtherKeys) s += MOK_ON;
    if (caps.focus) s += FOCUS_ON;
    return s;
  }

  /** Raw mode, modes on, capabilities negotiated. Resolves with `caps`. */
  function enter() {
    if (entering) return entering;
    if (entered) return Promise.resolve(caps);
    entering = doEnter().finally(() => {
      entering = null;
    });
    return entering;
  }

  async function doEnter() {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("the terminal UI needs an interactive terminal (stdin and stdout must be TTYs)");
    decoder.reset();
    hookProcess();
    restored = false;
    entered = true;
    setRaw(true);
    attachInput();
    // DA1 goes last: every terminal answers it, so it marks the end of the replies.
    const gotDa1 = new Promise((resolve) => {
      da1Waiter = resolve;
    });
    writeRaw(BRACKETED_PASTE_ON + KITTY_PUSH + KITTY_QUERY + SYNC_QUERY + (caps.focus ? FOCUS_ON : "") + DA1_QUERY);
    let timer;
    await Promise.race([gotDa1, new Promise((resolve) => (timer = setTimeout(resolve, queryTimeoutMs)))]);
    clearTimeout(timer);
    da1Waiter = null;
    if (restored) return caps; // restored while negotiating
    if (!caps.kitty) {
      caps.modifyOtherKeys = true;
      if (!away) writeRaw(MOK_ON); // a handoff child owns the terminal; modesOn() adds it later
    }
    return caps;
  }

  /** Synchronous and idempotent: safe from any exit path. */
  function restore() {
    if (restored) return;
    restored = true;
    entered = false;
    away = false;
    writeRaw(RESTORE_SEQUENCE);
    setRaw(false);
    detachInput();
    decoder.reset(); // a half paste must not swallow the next session's input
    for (const w of cprWaiters.splice(0)) w.resolve(null);
    for (const t of staleCpr.splice(0)) clearTimeout(t);
    da1Waiter?.();
    unhookProcess();
  }

  /** Waits briefly for outstanding replies (so they don't land in the shell), then restores. */
  async function close() {
    const deadline = Date.now() + drainTimeoutMs;
    while (cprWaiters.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    restore();
    unhookProcess();
  }

  /** Cursor position (1-based), or null on timeout. */
  function cpr(timeoutMs = queryTimeoutMs) {
    if (!entered || away) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve: (v) => (clearTimeout(waiter.timer), resolve(v)) };
      waiter.timer = setTimeout(() => {
        const i = cprWaiters.indexOf(waiter);
        if (i >= 0) cprWaiters.splice(i, 1);
        // Its reply may still come: drop it then, or stop waiting after a grace period.
        const expiry = setTimeout(() => {
          const j = staleCpr.indexOf(expiry);
          if (j >= 0) {
            staleCpr.splice(j, 1);
            decoder.cancel("cpr");
          }
        }, staleCprGraceMs);
        expiry.unref?.();
        staleCpr.push(expiry);
        resolve(null);
      }, timeoutMs);
      cprWaiters.push(waiter);
      decoder.expect("cpr");
      writeRaw(`${CSI}6n`);
    });
  }

  /**
   * Gives the terminal to `fn` (stock Codex UI, an editor): input detached,
   * modes restored, then everything re-entered. The caller must make sure no
   * turn is running. Listeners get onResume afterwards to re-anchor.
   */
  async function handoff(fn) {
    if (!entered || away) return fn();
    decoder.flush();
    detachInput();
    writeRaw(RESTORE_SEQUENCE);
    setRaw(false);
    away = true;
    try {
      return await fn();
    } finally {
      away = false;
      // Closed or restored meanwhile: stay restored.
      if (entered && !restored) {
        // libuv#5156: Windows needs an off→on cycle to re-establish VT input.
        setRaw(false);
        setRaw(true);
        writeRaw(modesOn());
        attachInput();
        for (const f of resumeListeners) f({ reason: "handoff" });
      }
    }
  }

  /** Ctrl+Z. POSIX: restore and stop; on SIGCONT re-enter. Windows: false, nothing happens. */
  function suspend() {
    if (platform === "win32" || !entered || away) return false;
    detachInput();
    writeRaw(RESTORE_SEQUENCE);
    setRaw(false);
    away = true;
    const onCont = () => {
      away = false;
      if (!entered || restored) return;
      setRaw(true);
      writeRaw(modesOn());
      attachInput();
      for (const f of resumeListeners) f({ reason: "sigcont" });
    };
    proc.once("SIGCONT", onCont);
    try {
      proc.kill(proc.pid, "SIGSTOP");
    } catch (err) {
      // Could not stop: take the terminal back as it was.
      errSink(err);
      proc.off("SIGCONT", onCont);
      away = false;
      setRaw(true);
      writeRaw(modesOn());
      attachInput();
      return false;
    }
    return true;
  }

  return {
    caps,
    write: (s) => stdout.write(s),
    enter,
    restore,
    close,
    handoff,
    suspend,
    cpr,
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    onInput(fn) {
      inputListeners.add(fn);
      return () => inputListeners.delete(fn);
    },
    onResume(fn) {
      resumeListeners.add(fn);
      return () => resumeListeners.delete(fn);
    },
    get entered() {
      return entered;
    },
  };
}
