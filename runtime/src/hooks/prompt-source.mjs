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
// A provisional note (applied at once) also needs the host and version on the
// allow-list, which is empty at launch: every capture waits for review.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { adRoot } from "../ad-root.mjs";
import { typedText } from "./typed-text.mjs";
import { allowListed } from "./host-capabilities.mjs";

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

/**
 * Classify a prompt.
 * @param {object} input  the UserPromptSubmit payload
 * @param {{host?:string, version?:string|null, env?:object, scheduled?:object[]|null, root?:string, list?:object[]}} [opts]
 *   list: the provisional allow-list (default host-capabilities' PROVISIONAL_ALLOW_LIST)
 * @returns {{typed:boolean, why:string, provisionalEligible:boolean}}
 */
export function promptSource(input, { host = "claude", version = null, env = process.env, scheduled = null, root, list } = {}) {
  const prompt = String(input?.prompt ?? "");
  const not = (why) => ({ typed: false, why, provisionalEligible: false });
  if (input?.agent_id || input?.agent_type) return not("subagent");
  if (env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli" || env.CLAUDE_CODE_SESSION_ATTENDED === "0") return not("headless");
  if (env.AD_WORKER === "1") return not("ad worker");
  if (typeof input?.source === "string" && input.source !== "user") return not(`source ${input.source}`);
  if (typedText(prompt) === null) return not("not typed text");
  const recorded = scheduled ?? readScheduled({ root });
  const h = promptHash(prompt);
  const hit = recorded.find((e) => e.h === h);
  if (hit) return not(hit.k === "subagent" ? "a subagent's message" : "a scheduled prompt");
  return { typed: true, why: "typed", provisionalEligible: allowListed(host, version, list ? { list } : undefined) };
}
