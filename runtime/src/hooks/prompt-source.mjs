// Did a person type this prompt? (plan L2, 02 §2.1)
//
// UserPromptSubmit also fires for prompts no one typed: a background
// subagent's report (<task-notification>), a ScheduleWakeup or CronCreate
// prompt (identical to a typed one in the payload), headless and CI runs, ad's
// own workers, a plan hand-off, Codex subagent turns. No host marks all of them
// (S-HOOKS, 06 §1), so a prompt counts as typed only when none of these holds:
//   a subagent marker (agent_id, agent_type);
//   a headless run (CLAUDE_CODE_ENTRYPOINT=sdk-cli, CLAUDE_CODE_SESSION_ATTENDED=0);
//   ad's own worker (AD_WORKER=1);
//   a payload `source` other than "user" (Claude Code's field, rolling out);
//   a wrapper or generated text (typed-text.mjs);
//   the same text as a recorded CronCreate/ScheduleWakeup input or a
//   SubagentStop message (hashes kept in adRoot()/hooks/scheduled.jsonl).
// A first-party prompt (L5 decision 4: may become a provisional note) also needs an
// allow-list entry whose positive signal holds, the hook's parent to be that host's own
// executable, and the running host's version at or above the entry's floor. The list is
// empty at launch: every capture waits for review.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { adRoot } from "../ad-root.mjs";
import { typedText } from "./typed-text.mjs";
import { allowEntry, versionOk } from "./host-capabilities.mjs";
import { parentIsHost } from "./parent-host.mjs";

const KEEP = 500;
const KEEP_MS = 7 * 86_400_000;

export const scheduledPath = (root = adRoot()) => path.join(root, "hooks", "scheduled.jsonl");

/** The hash a prompt is matched by: trimmed, whitespace folded. */
export const promptHash = (text) => createHash("sha256").update(String(text ?? "").trim().replace(/\s+/g, " ")).digest("hex");

/**
 * Remember text that will come back as a prompt no one typed. Kept to the
 * newest KEEP lines within KEEP_MS.
 */
export function recordScheduled(text, { root = adRoot(), session = null, kind = "scheduled", now = Date.now() } = {}) {
  if (typeof text !== "string" || !text.trim()) return false;
  const file = scheduledPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kept = readScheduled({ root, now }).slice(-(KEEP - 1));
  kept.push({ h: promptHash(text), s: session, k: kind, t: now });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.renameSync(tmp, file);
  return true;
}

/** The recorded entries still in the window (a missing or damaged file is empty). */
export function readScheduled({ root = adRoot(), now = Date.now() } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(scheduledPath(root), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.h === "string" && Number.isFinite(e.t) && now - e.t <= KEEP_MS) out.push(e);
    } catch {
      // a torn line: skip it
    }
  }
  return out;
}

// Verdicts this module issued with firstParty true. Only an object minted here passes
// isFirstParty(), so a caller can't hand the provisional writer a home-made verdict.
const FIRST = new WeakMap();

/** Did promptSource() issue this verdict as first-party? */
export const isFirstParty = (v) => Boolean(v && typeof v === "object" && FIRST.has(v));

const fold = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The prompt a first-party verdict was issued for (folded), or null: a verdict only vouches for its own prompt's words. */
export const promptOfVerdict = (v) => (isFirstParty(v) ? FIRST.get(v) : null);

/** Do these words come from the prompt this verdict was issued for? */
export const verdictCovers = (v, text) => {
  const p = promptOfVerdict(v);
  const t = fold(text);
  return Boolean(p && t && p.includes(t));
};

/**
 * Classify a prompt.
 * @param {object} input  the UserPromptSubmit payload
 * @param {{host?:string, env?:object, scheduled?:object[]|null, root?:string, list?:object[], parent?:Function}} [opts]
 *   list: the provisional allow-list (default host-capabilities' PROVISIONAL_ALLOW_LIST)
 *   parent: (entry) => {ok, version} (default parent-host.mjs parentIsHost; tests inject it)
 * @returns {{typed:boolean, why:string, firstParty:boolean, provisionalEligible:boolean}}
 */
export function promptSource(input, { host = "claude", env = process.env, scheduled = null, root, list, parent = parentIsHost } = {}) {
  const prompt = String(input?.prompt ?? "");
  const not = (why) => Object.freeze({ typed: false, why, firstParty: false, provisionalEligible: false });
  if (input?.agent_id || input?.agent_type) return not("subagent");
  if (env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli" || env.CLAUDE_CODE_SESSION_ATTENDED === "0") return not("headless");
  if (env.AD_WORKER === "1") return not("ad worker");
  if (typeof input?.source === "string" && input.source !== "user") return not(`source ${input.source}`);
  if (typedText(prompt) === null) return not("not typed text");
  const recorded = scheduled ?? readScheduled({ root });
  const h = promptHash(prompt);
  const hit = recorded.find((e) => e.h === h);
  if (hit) return not(hit.k === "subagent" ? "a subagent's message" : "a scheduled prompt");
  const typed = (firstParty) => Object.freeze({ typed: true, why: "typed", firstParty, provisionalEligible: firstParty });
  const entry = allowEntry(input, host, list ? { list } : undefined);
  // The parent check (a process lookup) runs only once everything else holds.
  if (!entry) return typed(false);
  const p = parent(entry) ?? {};
  if (!p.ok || !versionOk(entry, p.version)) return typed(false);
  const v = typed(true);
  FIRST.set(v, fold(prompt));
  return v;
}
