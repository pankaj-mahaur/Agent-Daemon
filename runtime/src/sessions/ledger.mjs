// One logical session's record (P4.1): ~/.agent-daemon/sessions/ses_<ulid>.jsonl, append-only,
// one writer (lock "session-<ulid>"). Which account and model ran which turn, and what each
// tool call did — never its content.
//
//   openLedger({ sessionId, root, lockDir }) → { sessionId, seq, append(ev), close(), repaired }
//     throws SESSION_LEDGER_BUSY (another window has it)
//   readLedger(sessionId, { root }) → events (a bad line is skipped)
//   compactFile(file, sessionId)   over 1 MB (at open and close, under the lock): keep what a
//                                  switch or a fallback needs
//   sessionsDir(root)
//
// Envelope: { v: 1, sessionId, seq, eventId, at, type, ...payload }. seq grows by one per file
// (also across reopen, repair and compaction). Never stored: credentials, headers, env,
// reasoning (summaries, raw, encrypted), approval ids, question answers, file contents,
// command output. Prompts, summaries and error messages are redacted; a <private> prompt is
// stored as text null.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { acquireLock } from "../lock.mjs";
import { ulid } from "../ids.mjs";
import { redact } from "../auth/redact.mjs";

const LINE_CAP = 32 * 1024;
const TEXT_CAP = 16 * 1024;
const SUMMARY_CAP = 200;
const COMPACT_OVER = 1024 * 1024;
const KEEP_RECENT = 2000;
// Durable: what a switch or a fallback relies on after a crash.
const FSYNC = new Set(["created", "bindingStarted", "bindingEnded", "checkpoint", "goalPaused", "goalResumed", "violation", "routeFailure", "fallbackInterrupt", "switchRequested", "switchCommitted", "switchAborted", "paused", "snapshot"]);
// Kept by compaction, whatever their age.
const KEEP = new Set([...FSYNC]);
// Keys that must never reach the file, wherever they sit.
const FORBIDDEN = new Set(["reasoning", "encrypted_content", "encryptedContent", "summaryText", "headers", "env", "answers", "content", "output", "aggregatedOutput"]);

export const sessionsDir = (root = adRoot()) => path.join(root, "sessions");
const fileOf = (root, id) => path.join(sessionsDir(root), `${id}.jsonl`);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const SESSION_TEXTS = Object.freeze({
  BUSY: (pid) => `This session is open in another ad window (pid ${pid ?? "unknown"}).`,
  REPAIRED: (n) => `Repaired the session record after an unclean exit (${n} partial line dropped).`,
});

// Drops forbidden keys anywhere; redacts strings; caps prompt-like text.
function clean(value, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!FORBIDDEN.has(k)) out[k] = clean(v, depth + 1);
    return out;
  }
  return value;
}

function capText(s, max) {
  if (typeof s !== "string" || Buffer.byteLength(s) <= max) return { text: s, cut: false };
  let t = s.slice(0, max);
  while (Buffer.byteLength(t) > max) t = t.slice(0, -64);
  return { text: t, cut: true };
}

/** Reads the tail to find the last seq, repairing a torn last line. */
function recover(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { seq: 0, repaired: 0 };
  }
  if (!size) return { seq: 0, repaired: 0 };
  const fd = fs.openSync(file, "r+");
  try {
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let repaired = 0;
    let end = len;
    if (buf[len - 1] !== 0x0a) {
      // A torn last line (a crash mid-write): cut at the last newline.
      const nl = buf.lastIndexOf(0x0a);
      const keep = nl < 0 ? (len === size ? 0 : size - len) : size - len + nl + 1;
      fs.ftruncateSync(fd, keep);
      fs.fsyncSync(fd);
      repaired = 1;
      end = nl < 0 ? 0 : nl + 1;
    }
    const lines = buf.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (Number.isInteger(j.seq)) return { seq: j.seq, repaired };
      } catch {
        // a line cut by the 64 KB window, or garbage: look further back
      }
    }
    return { seq: 0, repaired };
  } finally {
    fs.closeSync(fd);
  }
}

export function openLedger({ sessionId = `ses_${ulid()}`, root = adRoot(), lockDir } = {}) {
  const dir = sessionsDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let release;
  try {
    release = acquireLock(`session-${sessionId}`, { dir: lockDir ?? path.join(dir, ".locks") });
  } catch (e) {
    if (e.code === "LOCK_BUSY") throw fail("SESSION_LEDGER_BUSY", SESSION_TEXTS.BUSY(e.holder?.pid));
    throw e;
  }
  const file = fileOf(root, sessionId);
  let seq;
  let repaired;
  let fd;
  try {
    ({ seq, repaired } = recover(file));
    // A long record is compacted under the lock, before the append handle opens.
    tryCompact(file, sessionId, root);
    fd = fs.openSync(file, "a", 0o600);
  } catch (err) {
    release(); // a failed open never leaves this window holding its own session
    throw err;
  }
  let closed = false;
  const ledger = {
    sessionId,
    file,
    repaired,
    get seq() {
      return seq;
    },
    /** Appends one event; returns its envelope. Never throws on content, only on I/O. */
    append(ev) {
      if (closed) throw fail("SESSION_LEDGER_CLOSED", "the session record is closed");
      const { type, ...payload } = ev;
      let body = clean(payload);
      let truncated = false;
      for (const k of ["text", "summary", "message"]) {
        if (typeof body[k] === "string") {
          const c = capText(body[k], k === "text" ? TEXT_CAP : k === "summary" ? SUMMARY_CAP : 500);
          body[k] = c.text;
          truncated ||= c.cut;
        }
      }
      if (body.error && typeof body.error.message === "string") body.error.message = capText(body.error.message, 500).text;
      const env = { v: 1, sessionId, seq: seq + 1, eventId: ulid(), at: new Date().toISOString(), type, ...body, ...(truncated ? { truncated: true } : {}) };
      let line = JSON.stringify(env);
      if (Buffer.byteLength(line) > LINE_CAP) {
        // Still too long: the free text goes first, then everything but the identity.
        for (const k of ["text", "summary", "paths"]) delete env[k];
        env.truncated = true;
        line = JSON.stringify(env);
        if (Buffer.byteLength(line) > LINE_CAP) line = JSON.stringify({ v: 1, sessionId, seq: seq + 1, eventId: env.eventId, at: env.at, type, truncated: true });
      }
      fs.writeSync(fd, `${line}\n`);
      if (FSYNC.has(type) || (type === "toolResult" && payload.status === "unknown")) fs.fsyncSync(fd);
      seq += 1;
      return env;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
        tryCompact(file, sessionId, root);
      } finally {
        release();
      }
    },
  };
  return ledger;
}

export function readLedger(sessionId, { root = adRoot() } = {}) {
  let text;
  try {
    text = fs.readFileSync(fileOf(root, sessionId), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // a torn line another reader will repair: skipped
    }
  }
  return out;
}

/**
 * Over 1 MB (or forced): a new file that starts with a snapshot, keeps every durable event,
 * every tool still running or unknown, and the last 2,000 others. Called at open and close,
 * under the session's lock, with no append handle open (Windows can't replace an open file).
 * The snapshot takes the last seq ("through"), and the last event is always kept, so the
 * next append still continues from it.
 */
// Compaction is housekeeping: when it fails (a rename Windows refuses) the record stays as it is.
function tryCompact(file, sessionId, root) {
  try {
    compactFile(file, sessionId, { root });
  } catch {
    try {
      fs.rmSync(`${file}.tmp`, { force: true });
    } catch {
      // nothing more to do: the next open tries again
    }
  }
}

export function compactFile(file, sessionId, { root = adRoot(), force = false } = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (!force && size <= COMPACT_OVER) return false;
  const events = readLedger(sessionId, { root }).filter((e) => e.type !== "snapshot");
  if (!events.length) return false;
  const toolState = new Map();
  for (const e of events) {
    if (e.type === "toolIntent") toolState.set(e.key, "running");
    if (e.type === "toolResult") toolState.set(e.key, e.status);
  }
  const open = new Set([...toolState].filter(([, s]) => s === "running" || s === "unknown").map(([k]) => k));
  const recent = new Set(events.slice(-KEEP_RECENT).map((e) => e.seq));
  const kept = events.filter((e) => KEEP.has(e.type) || recent.has(e.seq) || ((e.type === "toolIntent" || e.type === "toolResult") && open.has(e.key)));
  const through = events.at(-1).seq;
  const bindings = events.filter((e) => e.type === "bindingStarted").map((e) => e.binding);
  const childTurns = Object.fromEntries(events.filter((e) => e.type === "turnStarted" && e.parentTurnId).map((e) => [e.turnId, e.parentTurnId]));
  // seq 0: the snapshot comes before every kept event (it never repeats one's seq).
  const snap = { v: 1, sessionId, seq: 0, eventId: ulid(), at: new Date().toISOString(), type: "snapshot", through, bindings, openTools: [...open], childTurns, counters: { events: events.length } };
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(snap)}\n`);
    for (const e of kept) fs.writeSync(fd, `${JSON.stringify(e)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      break;
    } catch (e) {
      // Windows: a reader holding the file for a moment.
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** i);
    }
  }
  return { kept: kept.length, through };
}
