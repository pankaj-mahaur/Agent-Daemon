// One capture library (L5 design decisions 1, 3, 5–9, 15, 17): what a prompt teaches,
// screened, extracted, deduplicated and stored, with the receipt the user sees.
//
//   capturePrompt(input, opts)   the dispatcher's prompt.submit: an auto capture, or a typed
//                                remember (/<plugin>:remember, /remember, $<pkg>-remember)
//   captureNote(o)               the shared core: one candidate text → one stored note
//
// Status: provisional only through writeProvisional (a first-party verdict, not strict, a
// project, unflagged); flagged → quarantined; a secret → nothing stored; else pending.
// Written straight to the store when it is current (hook mode opens only a current store),
// else to the journal (pending; the drain stores it `buffered`).

import path from "node:path";
import { screenPrompt, FLAG_PHRASES } from "./prompt-screen.mjs";
import { writeProvisional } from "./provisional-write.mjs";
import { createHash } from "node:crypto";
import { recordEvent } from "./l5-tables.mjs";
import { normKey } from "./sqlite.mjs";
import { ownWords } from "../mistakes/classify.mjs";

const ownWordsOf = (t) => ownWords(stripPasted(t));

// A directive aimed at memory or a standing rule: from a prompt no one typed it is held
// back as relayed (02 §2: unknown prompt source).
const DIRECTIVE = /\b(?:remember|memori[sz]e|save|store|record|persist|keep\s+in\s+mind|from\s+now\s+on|going\s+forward|always|never|every\s+time|make\s+(?:this|it)\s+a\s+(?:rule|habit)|rules?|yaad\s+rakh\w*|hamesha|kabhi\s+mat|sandbox|approvals?|permissions?|hooks?|agents\.md|claude\.md|memory|learnings?|prefers?|wants?)\b/i;

// A directive aimed at memory itself (narrower: no bare always/never), for pasted parts.
const MEMORY_DIRECTIVE = /\b(?:remember|memori[sz]e|save\s+(?:this|it|that|a\s+rule|to\s+(?:your\s+)?memory)|store\s+(?:this|it|that|a\s+rule|in\s+(?:your\s+)?memory)|persist|permanent(?:ly)?|from\s+now\s+on|going\s+forward|make\s+(?:this|it)\s+a\s+rule|add\s+(?:a|this)\s+(?:rule|memory)|(?:long-term|your)\s+memory|yaad\s+rakh\w*)\b/i;
// Text another agent, a script or a tracker relays inside a prompt.
const RELAY_ENVELOPE = /^\s*\[cross-session\b|\bmessage\s+from\s+(?:session|agent|the\s+\w+\s+agent)\b|\bfrom\s+session\s+[\w-]+\s*:|^\s*@(?:jira|linear|github|slack)\s*:|\b(?:issue|pr|ticket|pull\s+request)\s+(?:text|body|description|comment)\s*:|\bscript\s+step\s*:|\bimplement\s+the\s+following\s+plan\s*:|<task-notification>|^\s*\[(?:task|subagent|sub-agent|agent|background|report|result|worker)\b|\b(?:subagent|sub-agent|background\s+task|worker)\s+(?:report|result|output|summary)\s*:|\bparent\s+agent\s+note\s*:|\bsummary\s+from\s+the\s+[\w-]+\s+agent\b/im;

/**
 * Relayed by its shape alone (no source verdict): an envelope another agent, a script or a
 * tracker puts around text, or a memory directive found only in pasted, quoted or fenced
 * parts (not in the user's own words).
 */
export function contentRelayed(text) {
  const t = String(text ?? "");
  if (RELAY_ENVELOPE.test(t) || /^\s*<(?:task|subagent|sub-agent|agent|tool|function|background|result|report|worker)[\w-]*\b[^>]*>/i.test(t)) return true;
  return MEMORY_DIRECTIVE.test(t) && !MEMORY_DIRECTIVE.test(ownWordsOf(t));
}

/** Did the screen or the source hold this prompt back? → flags (empty when clean). */
export function promptFlags(prompt, source) {
  const typed = Boolean(source?.typed);
  const text = String(prompt ?? "");
  const r = screenPrompt(text, { userWords: typed });
  const flags = [...r.flags];
  const relayed = (!typed && DIRECTIVE.test(text)) || contentRelayed(text);
  if (relayed) flags.push("relayed");
  return { flags, phrases: { ...r.phrases, ...(flags.includes("relayed") ? { relayed: "an instruction that didn't come from you typing" } : {}) } };
}

// ── pasted blocks: never the user's own words ─────────────────────────────────
const HEADER = /^(?:from|to|cc|subject|date|sent|reply-to)\s*:/i;
const CHAT = /^\s*(?:\[[^\]]{1,40}\]\s*)?[\w.@ -]{1,30}\s*(?:\(\d{1,2}:\d{2}[^)]*\))?\s*:\s+\S/;

/** The prompt without what looks pasted (mail and chat headers, wrapper blocks, long non-prose runs). */
export function stripPasted(text) {
  const lines = String(text ?? "").replace(/<(bash-[\w-]+|local-command-[\w-]+|command-[\w-]+)>[\s\S]*?<\/\1>/g, "\n").split(/\r?\n/);
  const out = [];
  let run = [];
  const flush = () => {
    // A run of five or more lines that is mostly not prose is pasted.
    const prose = run.filter((l) => /^[A-Za-z][^{}<>|=;]*[a-z][.!?,]?$/.test(l.trim()) && l.trim().split(/\s+/).length >= 4).length;
    if (run.length < 5 || prose / run.length >= 0.6) out.push(...run);
    run = [];
  };
  let inMail = false;
  for (const l of lines) {
    if (HEADER.test(l.trim())) inMail = true;
    if (inMail) continue;
    if (!l.trim()) {
      flush();
      out.push(l);
      continue;
    }
    run.push(l);
  }
  flush();
  return out.filter((l) => !(CHAT.test(l) && /^[^:]{1,30}:\s/.test(l.trim()) && !/^(?:note|remember|rule|tip|pls|please|also|update|fyi)\s*:/i.test(l.trim()))).join("\n");
}

// ── typed commands ────────────────────────────────────────────────────────────

/**
 * A typed memory command, or null. → { verb: "remember"|"forget"|"restore", arg }.
 * Forms: /<plugin>:<verb> …, /<verb> … (Claude Code; the caller decides whether the short
 * form is ours), $<pkg>-<verb> … (the second host's skills).
 */
export function parseMemoryCommand(prompt, { plugin, pkg, bare = false } = {}) {
  const t = String(prompt ?? "").trimStart();
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [];
  if (plugin) forms.push(`/${esc(plugin)}:`);
  if (pkg) forms.push(`\\$${esc(pkg)}-`);
  if (bare) forms.push("/");
  if (!forms.length) return null;
  const m = t.match(new RegExp(`^(?:${forms.join("|")})(remember|forget|restore)(?=\\s|$)([\\s\\S]*)$`));
  return m ? { verb: m[1], arg: m[2].trim() } : null;
}

// ── receipts ──────────────────────────────────────────────────────────────────
const clip = (s, n = 60) => {
  // Neutralised: control and bidi characters out (an escape code could redraw the line).
  const t = String(s ?? "").replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The line the user sees (systemMessage on Claude Code) for a capture outcome.
 * @param {{status:string, id?:number|null, text?:string, flags?:string[], phrases?:object, kind?:string, secretKind?:string, review:string, forget?:string, first?:boolean, sessionCount?:number, project?:string|null, product?:string}} o
 */
export function captureReceipt(o) {
  const name = o.product ? `${o.product}: ` : "";
  const ref = o.id ? `#${o.id} ` : "";
  const q = `"${clip(o.text)}"`;
  const where = o.project ? ` (in ${o.project})` : "";
  switch (o.status) {
    case "provisional":
      return `${name}Learned ${ref}${q} (in use now; undo: ${o.forget ?? "forget"} ${o.id ?? ""})`.replace(/\s+\)/, ")");
    case "pending":
      if (o.first) return `${name}Saved your correction ${ref}${q}${where}. Approve it once in your own terminal and your agents will remember it: ${o.review}`;
      if ((o.sessionCount ?? 0) > 1) return `${name}+1 for review: ${ref}"${clip(o.text, 24)}"`;
      return `${name}Saved for review: ${ref}${q}${where} · run \`${o.review}\` in your own terminal to accept it`;
    case "journal":
      return `${name}Saved for review: ${q}${where} · run \`${o.review}\` in your own terminal to accept it`;
    case "quarantined": {
      const why = FLAG_PHRASES[(o.flags ?? [])[0]] ?? o.phrases?.relayed ?? "something to check";
      return `${name}Saved for a closer look: ${ref}mentions ${why} · ${o.review}`;
    }
    case "refused-secret":
      return `${name}Not saved: it contains what looks like a ${o.secretKind ?? "secret"} (your agent still saw the message). Say it again without it to save it.`;
    case "repeat":
      return `${name}You've told agents this before (${ref.trim()}); counted as a repeat.`;
    case "said-again":
      return `${name}Said ${o.count ?? 2} times now; approve ${ref.trim()} so agents remember: ${o.review}`;
    case "flagged-again":
      return `${name}${ref.trim()} is already saved for a closer look · ${o.review}`;
    case "deleted-before":
      return `${name}You deleted this before; ${o.remember ?? "/remember"} it to save it anyway`;
    case "superseded":
      return `${name}Already learned as ${ref.trim()}`;
    case "none":
      return o.why === "flagged, no current store" ? `${name}Nothing saved: ${FLAG_PHRASES[(o.flags ?? [])[0]] ?? o.phrases?.relayed ?? "it needs a closer look"} — say it yourself to save it` : null;
    case "empty":
      return `${name}Nothing saved: type ${o.remember ?? "/remember"} followed by what to remember`;
    case "too-long":
      return `${name}Nothing saved: the note is too long (${String(o.text ?? "").length} characters; up to ${MAX_NOTE})`;
    case "collides":
      return `${name}Nothing saved: this folder shares its memory with another folder`;
    default:
      return null;
  }
}

export const MAX_NOTE = 2000;

// ── the core ──────────────────────────────────────────────────────────────────

/**
 * Store one candidate. → { status, id, text, flags, phrases, secretKind?, why? }
 * status: provisional | pending | quarantined | refused-secret | repeat | said-again |
 *         flagged-again | deleted-before | superseded | none
 * @param {{handle:object, text:string, kind:"correction"|"remember", source:object,
 *   promptFlagged?:{flags:string[], phrases:object}, projectSlug:string, projectId?:string|null,
 *   projectPath?:string, sessionId?:string, now?:Date, discardedHash?:Function}} o
 */
export async function captureNote(o) {
  const { handle, source } = o;
  const text = String(o.text ?? "").trim();
  const ep = await import("./episodic.mjs");
  const { screenLearning } = await import("../digest/sanitize.mjs");
  const own = screenPrompt(text, { userWords: Boolean(source?.typed) });
  let flags = [...new Set([...(o.promptFlagged?.flags ?? []), ...own.flags])];
  const phrases = { ...(o.promptFlagged?.phrases ?? {}), ...own.phrases };
  try {
    if (screenLearning({ text }).verdict !== "clean") flags = [...new Set([...flags, "instruction"])];
  } catch {
    // the prompt screen above is the main check
  }
  if (flags.includes("secret")) return { status: "refused-secret", id: null, text, flags, phrases, secretKind: phrases.secret };

  const provenance = source?.why === "headless" ? "headless" : source?.typed ? "prompt" : "agent";
  const row = {
    sessionId: null,
    projectSlug: o.projectSlug,
    projectId: o.projectId ?? null,
    projectPath: o.projectPath,
    category: o.kind === "remember" ? "pattern" : "correction",
    text,
    evidence: o.kind === "remember" ? "you ran remember" : "from your prompt",
    confidence: o.kind === "remember" ? 0.9 : 0.7,
    origin: source?.typed ? "user" : "agent",
    provenance,
    captureRef: o.sessionId ? String(o.sessionId).slice(0, 128) : undefined,
  };

  // A capture the user deleted before (a hash-only tombstone) is not stored again.
  const nk = normKey(text);
  if (nk && discardedBefore(handle, nk, o.projectId)) return { status: "deleted-before", id: null, text, flags, phrases };

  const same = ep.sameNote(handle, o.projectSlug, text, nk ?? undefined, o.projectId ?? null);
  const event = (kind, id, actor = source?.typed ? "user" : "system") => recordEvent(handle, { kind, learningId: id, projectId: o.projectId ?? null, actor, at: o.now });

  if (same) {
    const cur = handle.get(`SELECT id, status, accepted_by, origin, superseded_by, observed_count, applied_to FROM learnings WHERE id = ?`, [same.id]);
    if (cur.accepted_by && ["active", "forget-requested"].includes(cur.status)) {
      event("repeated", cur.id);
      return { status: "repeat", id: cur.id, text, flags, phrases };
    }
    if (cur.status === "superseded" && cur.superseded_by) return { status: "superseded", id: cur.superseded_by, text, flags, phrases };
    if (cur.status === "quarantined" || String(cur.applied_to ?? "").startsWith("quarantined")) {
      handle.run("UPDATE learnings SET observed_count = observed_count + 1 WHERE id = ?", [cur.id]);
      return { status: "flagged-again", id: cur.id, text, flags, phrases };
    }
    // A flagged re-capture never changes the note it repeats (decision 15: another prompt only
    // counts; decision 12: nothing that isn't first-party demotes a user's learning).
    if (flags.length) {
      handle.run("UPDATE learnings SET observed_count = observed_count + 1 WHERE id = ? AND status <> 'hidden'", [cur.id]);
      return { status: cur.status === "hidden" ? "none" : "said-again", id: cur.id, count: (cur.observed_count ?? 1) + 1, text, flags, phrases };
    }
    if (["rejected", "archived"].includes(cur.status)) {
      handle.transaction(() => {
        handle.run("UPDATE learnings SET status = 'pending', status_at = ? WHERE id = ? AND accepted_by IS NULL AND status IN ('rejected', 'archived')", [(o.now ?? new Date()).toISOString(), cur.id]);
        event("captured", cur.id);
      });
      return { status: "pending", id: cur.id, text, flags, phrases };
    }
    if (cur.status === "provisional") {
      handle.run("UPDATE learnings SET observed_count = observed_count + 1 WHERE id = ?", [cur.id]);
      return { status: "provisional", id: cur.id, text, flags, phrases, again: true };
    }
    // pending (any origin) or hidden: the provisional writer decides (it upgrades a first-party
    // capture, revives only the agent's own hide for anything else, and keeps a user's hide).
    const r = writeProvisional(handle, source, { id: cur.id }, { now: o.now ?? new Date() });
    if (r.status === "provisional") return { status: "provisional", id: cur.id, text, flags, phrases };
    if (r.status === "pending") {
      handle.transaction(() => {
        handle.run("UPDATE learnings SET observed_count = observed_count + 1 WHERE id = ?", [cur.id]);
        if (source?.typed && source?.why !== "headless") event("captured", cur.id, "user");
      });
      const n = handle.get("SELECT observed_count AS n FROM learnings WHERE id = ?", [cur.id])?.n ?? 2;
      return { status: "said-again", id: cur.id, count: n, text, flags, phrases };
    }
    // A user's hide stands; the repeat is still counted (decision 15).
    if (r.status === "hidden") handle.run("UPDATE learnings SET observed_count = observed_count + 1 WHERE id = ?", [cur.id]);
    return { status: r.status === "hidden" ? "none" : r.status, id: cur.id, text, flags, phrases, why: r.why };
  }

  if (flags.length) {
    const qid = handle.transaction(() => {
      const id = ep.writeLearning(handle, { ...row, status: "quarantined", quarantineReason: `screen:${flags.join(",")}`, appliedTo: "quarantined" });
      if (id != null) event("captured", Number(id));
      return id == null ? null : Number(id);
    });
    return { status: "quarantined", id: qid, text, flags, phrases };
  }
  const actor = source?.typed && source?.why !== "headless" ? "user" : "system";
  const r = writeProvisional(handle, source, { row }, { now: o.now ?? new Date(), captureActor: actor });
  return { status: r.status === "provisional" ? "provisional" : "pending", id: r.id, text, flags, phrases };
}

function discardedBefore(handle, nk, projectId) {
  try {
    return Boolean(handle.get("SELECT 1 AS ok FROM events WHERE kind = 'discarded' AND detail = ? AND project_id IS ?", [JSON.stringify({ hash: tombstoneHash(nk) }), projectId ?? null]));
  } catch {
    return false;
  }
}

/** The tombstone a deleted capture leaves: a hash of its normalised text, never the text. */
export const tombstoneHash = (nk) => createHash("sha256").update(String(nk)).digest("hex").slice(0, 32);

/**
 * The dispatcher's capture for one typed prompt (L5 decisions 1, 3, 8, 9).
 * @param {object} input  the UserPromptSubmit payload
 * @param {{source:object, host:string, cwd:string, remember?:string|null, handle?:object|null,
 *   now?:Date, journal?:Function}} opts
 *   source: promptSource()'s verdict (the minted object); remember: the remember text when
 *   the prompt is a remember command (the caller parsed it), else undefined.
 * @returns {Promise<{status:string, id:number|null, text:string|null, flags:string[], phrases:object}>}
 */
export async function capturePrompt(input, { source, host = "claude", cwd, remember, handle = undefined, now = new Date(), journal } = {}) {
  const prompt = String(input?.prompt ?? "");
  const pf = promptFlags(prompt, source);
  const none = (why) => ({ status: "none", id: null, text: null, flags: pf.flags, phrases: pf.phrases, why });
  const isRemember = typeof remember === "string";
  if (isRemember) {
    if (!remember) return { ...none("empty"), status: "empty" };
    if (remember.length > MAX_NOTE) return { ...none("too long"), status: "too-long", text: remember };
  }
  // A prompt no one typed is never captured (L2), a headless one is (pending, marked).
  if (!source?.typed && source?.why !== "headless" && !isRemember) return none("not typed");
  // A slash command is a command for the host or a plugin, never a correction.
  if (!isRemember && /^\s*\/[\w.:-]+(?:\s|$)/.test(prompt)) return none("a slash command");
  let text = remember;
  let adopted = false;
  if (!isRemember) {
    const { classifyPrompt } = await import("../mistakes/classify.mjs");
    const c = classifyPrompt(stripPasted(prompt));
    if (!c.correction || !c.sentence) return none("no correction");
    text = c.sentence;
    adopted = c.why === "adopted";
  }
  const dir = path.resolve(String(cwd || input?.cwd || process.cwd()));
  const ep = await import("./episodic.mjs");
  const projectSlug = ep.projectSlug(dir);
  const store = handle === undefined ? await ep.db().catch(() => null) : handle;
  if (store) {
    const { slugCollides } = await import("./safety.mjs");
    if (slugCollides(store, projectSlug, dir)) return { ...none("collides"), status: "collides" };
    const { projectIdOf } = await import("./projects.mjs");
    const projectId = projectIdOf(dir);
    // An adopted sentence (the user adopts a quoted comment) isn't the user's words: never provisional.
    const s = adopted ? Object.freeze({ ...source, firstParty: false, provisionalEligible: false }) : source;
    try {
      const r = await captureNote({ handle: store, text, kind: isRemember ? "remember" : "correction", source: s, promptFlagged: pf, projectSlug, projectId, projectPath: dir, sessionId: input?.session_id, now });
      if (r.status === "pending" && r.id) {
        try {
          r.first = store.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'captured' AND actor = 'user'")?.n === 1;
          const sid = input?.session_id ? String(input.session_id).slice(0, 128) : null;
          if (sid) r.sessionCount = store.get("SELECT COUNT(*) AS n FROM learnings WHERE capture_ref = ? AND provenance IN ('prompt', 'user-prompt', 'headless')", [sid])?.n ?? 1;
        } catch {
          // the receipt only loses its first-time wording
        }
      }
      return r;
    } catch (e) {
      if (!/busy|locked/i.test(String(e?.message))) throw e;
      // a busy store: the journal keeps it (pending)
    }
  }
  // No current store: the journal (pending; the drain stores it as `buffered`). A flagged
  // capture is never journaled: the drain's screen is weaker, so nothing is stored.
  if (pf.flags.length || screenPrompt(text, { userWords: Boolean(source?.typed) }).flags.length) return none("flagged, no current store");
  const write = journal ?? (async (entries) => (await import("../hooks/journal.mjs")).appendLearnings({ cwd: dir, entries }));
  const r = await write([{ ts: now.toISOString(), type: isRemember ? "pattern" : "correction", text, evidence_quote: text, confidence: isRemember ? 0.9 : 0.7, rule_id: isRemember ? "remember-command" : "prompt-capture", tags: isRemember ? ["remember"] : [], sessionId: String(input?.session_id ?? ""), source_speaker: source?.typed ? "user" : "agent", prompt_source: source?.why ?? "unknown", provisional_eligible: false, remember: isRemember || undefined }]);
  if (r && r.ok === false) return { ...none(`journal: ${r.error}`), status: "none" };
  return { status: "journal", id: null, text, flags: pf.flags, phrases: pf.phrases };
}

/**
 * CLI `remember` (L5 decision 1; P3 wires the verb): screened; with the review token it
 * is accepted through the review service (provenance user-cli); without it (the agent's
 * shell, any non-TTY run) it is a pending note of the agent's.
 * → { status, id, flags, phrases }
 */
export async function captureCli(text, { handle, cwd, token = null, now = new Date() } = {}) {
  // Trust comes only from a token the review service issued (any other value is none).
  const { isReviewToken } = await import("./review-service.mjs");
  if (!isReviewToken(token)) token = null;
  const note = String(text ?? "").trim();
  if (!note) return { status: "empty", id: null, flags: [], phrases: {} };
  if (note.length > MAX_NOTE) return { status: "too-long", id: null, flags: [], phrases: {} };
  const r = screenPrompt(note, { userWords: Boolean(token) });
  try {
    const { screenLearning } = await import("../digest/sanitize.mjs");
    if (screenLearning({ text: note }).verdict !== "clean" && !r.flags.includes("instruction")) r.flags.push("instruction");
  } catch {
    // the prompt screen above is the main check
  }
  if (r.flags.includes("secret")) return { status: "refused-secret", id: null, flags: r.flags, phrases: r.phrases, secretKind: r.phrases.secret };
  const dir = path.resolve(String(cwd || process.cwd()));
  const ep = await import("./episodic.mjs");
  const { projectIdOf } = await import("./projects.mjs");
  const projectSlug = ep.projectSlug(dir);
  const projectId = projectIdOf(dir);
  const row = { projectSlug, projectId, projectPath: dir, category: "pattern", text: note, evidence: "you ran remember in a terminal", confidence: 0.9 };
  if (r.flags.length) {
    const id = handle.transaction(() => {
      const q = ep.writeLearning(handle, { ...row, origin: token ? "user" : "agent", provenance: token ? "user-cli" : "agent", status: "quarantined", quarantineReason: `screen:${r.flags.join(",")}`, appliedTo: "quarantined" });
      if (q != null) recordEvent(handle, { kind: "captured", learningId: Number(q), projectId, actor: token ? "user" : "agent", at: now });
      return q == null ? null : Number(q);
    });
    return { status: "quarantined", id, flags: r.flags, phrases: r.phrases };
  }
  if (token) {
    const { rememberAccepted } = await import("./review-service.mjs");
    const keys = [projectSlug, projectId].filter(Boolean);
    const a = rememberAccepted(handle, token, row, { keys, now });
    return { status: a.status === "accepted" ? "accepted" : a.status, id: a.id, flags: [], phrases: {} };
  }
  const id = handle.transaction(() => {
    const w = ep.writeLearning(handle, { ...row, origin: "agent", provenance: "agent", status: "pending" });
    if (w != null) recordEvent(handle, { kind: "captured", learningId: Number(w), projectId, actor: "agent", at: now });
    return w == null ? null : Number(w);
  });
  return { status: id == null ? "duplicate" : "pending", id, flags: [], phrases: {} };
}
