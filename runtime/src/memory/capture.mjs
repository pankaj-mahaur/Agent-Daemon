// Hookless capture (P5.2): what the memory server's record tools do with a
// lesson an agent says the user taught it. The agent may be prompt-injected,
// so nothing it records is trusted (plan §M):
//   1. an unbound server records nothing, whatever scope was asked for;
//   2. a secret: nothing stored;
//   3. per process: 20 saves per 10 minutes, 100 in all;
//   4. text that reads like an instruction to an agent: held back (quarantined);
//   5. auto mode: this host's hooks ran in this project in the last 30 minutes
//      → nothing extra (the hooks capture the user's own words);
//   6. one note per project: the same note again, from any session or origin,
//      is "already known", never reinforced, never promoted;
//   7. else a pending row — served only to this project's pull search, labelled
//      unreviewed, never to a push surface — and a memory-add proposal; a global
//      request also a memory-promote proposal. Only the user's guarded accept
//      (ad review) makes it active or global.
//
//   captureExplicit({kind, fields, scope, host, mode, now, limiter})
//     → {status, id?, proposalPaths?, message}
//   kind "correction": fields {wrong, right, user_words?, scope?, files?, session_id?}
//   kind "learning":   fields {text, kind, evidence?, scope?, files?, session_id?}
//   Bad input throws (the tool's error text).

import path from "node:path";
import { db, insertLearning, sameNote } from "./episodic.mjs";
import { normKey } from "./sqlite.mjs";
import { findSecrets } from "../security/secret-patterns.mjs";
import { screenLearning, stripPrivate, neutralizeText } from "../digest/sanitize.mjs";
import { writeMemoryProposal } from "../digest/proposals.mjs";
import { ensureProjectDataDir } from "./project-dir.mjs";
import { classifyCorrection, mcpCaptureRef } from "./metrics.mjs";

export const LEARNING_KINDS = Object.freeze(["pattern", "gotcha", "decision", "tool"]);
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 20;
const PER_PROCESS = 100;
const HOOKS_FRESH_MS = 30 * 60 * 1000;

export const TEXTS = Object.freeze({
  saved: (t) => `Saved for review: "${t}". It shows in this project's searches as unreviewed; it reaches your sessions after you accept it (ad review).`,
  savedGlobal: "Saved for review. Making it a cross-project note also needs your OK in ad review.",
  duplicate: (t) => `Already known: "${t}".`,
  quarantined: "Saved for review only: it reads like an instruction to an agent, not a lesson.",
  secret: (kind) => `Not saved: that looks like it contains a secret (${kind}). Leave the secret out and try again.`,
  unbound: "Not saved: this memory server isn't bound to a project. Install with npx agent-daemon-memory install to get per-project memory here.",
  rateLimited: "Not saved: too many memory writes this session. Ask the user to run ad review.",
  hooksActive: "This host's hooks already capture corrections; nothing extra saved.",
});

/** A per-process limiter: 20 saves per 10 minutes and 100 in all. */
export function createLimiter() {
  const times = [];
  let total = 0;
  return {
    /** true when one more save is allowed (and counts it) */
    take(now = Date.now()) {
      while (times.length && now - times[0] >= WINDOW_MS) times.shift();
      if (times.length >= PER_WINDOW || total >= PER_PROCESS) return false;
      times.push(now);
      total++;
      return true;
    },
  };
}
const DEFAULT_LIMITER = createLimiter();
const eventLimiter = createLimiter();

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function str(fields, name, { min = 0, max, required = false }) {
  const v = fields[name];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${name} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${name} must be text.`);
  if (/[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}]/u.test(v)) throw new Error(`${name} must not contain control characters.`);
  const t = oneLine(v);
  if (t.length < min || t.length > max) throw new Error(`${name} must be ${min}–${max} characters.`);
  return t;
}

/** The validated note: {category, text, evidence, files, wantsGlobal, sessionRef}. */
export function parseFields(kind, fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("arguments must be an object.");
  const scope = fields.scope ?? "project";
  if (!["project", "global"].includes(scope)) throw new Error("scope must be project or global.");
  const files = fields.files ?? [];
  if (!Array.isArray(files) || files.length > 12 || files.some((x) => typeof x !== "string" || x.length > 200)) throw new Error("files must be up to 12 paths of up to 200 characters.");
  const sessionRef = str(fields, "session_id", { max: 128 });
  let category, text, evidence;
  if (kind === "correction") {
    const wrong = str(fields, "wrong", { min: 3, max: 300, required: true });
    const right = str(fields, "right", { min: 8, max: 300, required: true });
    const userWords = str(fields, "user_words", { max: 400 });
    category = "correction";
    // "(not: …)" unless the rule already names the wrong thing as words ("npm install" isn't in "pnpm install").
    const named = new RegExp(`(?:^|[^\\p{L}\\p{N}])${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "iu").test(right);
    text = (named ? right : `${right} (not: ${wrong})`).slice(0, 300);
    evidence = userWords || `was: ${wrong}`;
  } else if (kind === "learning") {
    text = str(fields, "text", { min: 8, max: 300, required: true });
    if (!LEARNING_KINDS.includes(fields.kind)) throw new Error(`kind must be one of ${LEARNING_KINDS.join(", ")}.`);
    category = fields.kind;
    evidence = str(fields, "evidence", { max: 400 });
  } else {
    throw new Error(`unknown capture kind: ${kind}`);
  }
  return { category, text, evidence, files: files.map(oneLine).filter(Boolean), wantsGlobal: scope === "global", sessionRef };
}

/**
 * True when `host`'s hooks wrote a heartbeat for one of `keys` within 30 minutes.
 * A server started without --host (older registrations) can't tell its host:
 * any host's hooks count.
 */
export function hooksActive(handle, host, keys, now = Date.now()) {
  if (!keys?.length) return false;
  try {
    const since = new Date(now - HOOKS_FRESH_MS).toISOString();
    const hostSql = host ? "host = ? AND " : "";
    return Boolean(handle.get(`SELECT 1 FROM capture_heartbeats WHERE ${hostSql}project_slug IN (${keys.map(() => "?").join(",")}) AND last_seen >= ? LIMIT 1`, [...(host ? [host] : []), ...keys, since]));
  } catch {
    return false;
  }
}

/** The hooks ran here: record it (UserPromptSubmit). Never throws. */
export function writeHeartbeat(handle, { host, projectKey, captureRef, now = Date.now() }) {
  if (!handle || !host || !projectKey) return;
  try {
    handle.run(
      `INSERT INTO capture_heartbeats (host, project_slug, capture_ref, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(host, project_slug) DO UPDATE SET capture_ref = excluded.capture_ref, last_seen = excluded.last_seen`,
      [host, projectKey, captureRef || null, new Date(now).toISOString()]
    );
  } catch {
    // a store without the table (older schema): no heartbeat, the record tools stay on
  }
}

export async function captureExplicit({ kind, fields, scope, host = null, mode = "auto", now = Date.now(), limiter = DEFAULT_LIMITER }) {
  const note = parseFields(kind, fields);
  if (scope?.kind !== "project" || !scope.keys?.length || !scope.dir) return { status: "rejected-unbound", message: TEXTS.unbound };

  const text = stripPrivate(note.text).trim();
  const evidence = stripPrivate(note.evidence).trim();
  const secret = [text, evidence, ...note.files].flatMap((s) => findSecrets(s))[0];
  if (secret) return { status: "rejected-secret", message: TEXTS.secret(secret.kind) };
  if (!text) throw new Error("nothing left to save once private parts were removed.");

  const handle = await db();
  if (!handle) throw new Error("Memory store unavailable (better-sqlite3 not installed). Run ad doctor.");
  if (mode === "auto" && hooksActive(handle, host, scope.keys, now)) return { status: "hooks-active", message: TEXTS.hooksActive };

  // Corrections feed the repeat metric (P5.5), duplicates included: a repeat is the signal.
  // The process ref ties them to what this server showed (it never learns the host session).
  // An agent can't inflate the report: one event per text per process (metrics.mjs),
  // a reword needs two different sessions, and events are capped like saves.
  if (note.category === "correction" && eventLimiter.take(now)) {
    const r = classifyCorrection(handle, { keys: scope.keys, text, captureRef: mcpCaptureRef(), source: "tools", host, now });
    if (r.reword) {
      const old = handle.get("SELECT text FROM learnings WHERE id = ?", [r.learningId]);
      try {
        await writeMemoryProposal({ kind: "memory-reword", learningId: r.learningId, text: old.text, evidence: `repeated twice after being shown; last time: ${text}`, origin: "ad (the same correction came back after the lesson was shown)", proposedDir: path.join(ensureProjectDataDir(scope.dir), "proposed") });
      } catch {
        // the metric never blocks capture
      }
    }
  }

  const nk = normKey(text);
  for (const key of scope.keys) {
    if (sameNote(handle, key, text, nk)) return { status: "duplicate", message: TEXTS.duplicate(neutralizeText(text)) };
  }
  if (!limiter.take(now)) return { status: "rate-limited", message: TEXTS.rateLimited };

  // This server process, never an id the agent supplied: session identity behind the
  // repeat metric can't be chosen by the agent (session_id only deduplicated).
  const captureRef = mcpCaptureRef();
  const row = {
    sessionId: null,
    projectSlug: scope.keys[0],
    projectPath: scope.dir,
    category: note.category,
    text,
    evidence,
    confidence: 0.6,
    tags: note.files.length ? note.files : undefined,
    origin: "agent",
    captureRef,
  };
  let screen = { verdict: "clean", reasons: [] };
  try {
    screen = screenLearning({ text, evidence_quote: evidence, tags: note.files });
  } catch {
    // a screen error counts as clean: the read-time check (render-safe.mjs) is the second layer
  }
  if (screen.verdict === "suspicious") {
    await insertLearning({ ...row, text: neutralizeText(text), evidence: neutralizeText(evidence), appliedTo: "quarantined", status: "quarantined", quarantineReason: `injection:${screen.reasons.join(",")}` });
    return { status: "quarantined", message: TEXTS.quarantined };
  }

  const id = await insertLearning({ ...row, appliedTo: "proposed:mcp", status: "pending", promoteRequest: note.wantsGlobal ? "global" : null });
  if (!id) return { status: "duplicate", message: TEXTS.duplicate(neutralizeText(text)) };
  const stamp = new Date(now).toISOString();
  const proposalPaths = [];
  try {
    const proposedDir = path.join(ensureProjectDataDir(scope.dir), "proposed");
    const who = `an agent (${host ?? "unknown host"})`;
    proposalPaths.push(await writeMemoryProposal({ kind: "memory-add", learningId: Number(id), text, evidence, origin: who, proposedDir, stamp }));
    if (note.wantsGlobal) proposalPaths.push(await writeMemoryProposal({ kind: "memory-promote", learningId: Number(id), text, evidence, origin: who, proposedDir, stamp }));
  } catch (e) {
    // No proposal, no note: a pending row nobody can review would block every retry as "already known".
    handle.run("DELETE FROM learnings WHERE id = ? AND status = 'pending'", [id]);
    for (const p of proposalPaths) await import("node:fs/promises").then((fsp) => fsp.rm(p, { force: true }));
    throw new Error(`Not saved: ad couldn't write the review file (${e.message}).`);
  }
  return { status: "saved", id: Number(id), proposalPaths, message: note.wantsGlobal ? TEXTS.savedGlobal : TEXTS.saved(neutralizeText(text)) };
}
