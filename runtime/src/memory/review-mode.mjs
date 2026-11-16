// `review: strict` (L5 design decision 10): kept in the store, sticky.
//
//   review_mode               strict | auto
//   review_mode_ever_strict   1 once strict was ever set: from then on a missing or damaged
//                             review_mode reads as strict (deleting a row never loosens it)
//
// Turning strict on narrows trust, so it needs no token, and it moves every provisional
// note to pending at once. Turning it back to auto widens trust: only the review service
// does that (review-service.mjs setReviewAuto, with the token).

import { getSetting, putSetting, recordEvent } from "./l5-tables.mjs";

export const MODES = Object.freeze(["strict", "auto"]);

/** The effective mode: "strict" or "auto" (the default). */
export function reviewMode(handle) {
  const v = getSetting(handle, "review_mode");
  if (v === "strict" || v === "auto") return v;
  // Missing or damaged: strict once strict was ever set (the marker row exists, whatever
  // it holds), so neither deleting nor damaging a row loosens it.
  return getSetting(handle, "review_mode_ever_strict") !== null ? "strict" : "auto";
}

export const isStrict = (handle) => reviewMode(handle) === "strict";

/** Turn strict on. → { demoted } (provisional notes moved back to pending). */
export function setReviewStrict(handle, { now = new Date(), actor = "user" } = {}) {
  const t = now.toISOString();
  return handle.transaction(() => {
    putSetting(handle, "review_mode", "strict", { now });
    putSetting(handle, "review_mode_ever_strict", "1", { now });
    const demoted = handle.run("UPDATE learnings SET status = 'pending', status_at = ? WHERE status = 'provisional' AND accepted_by IS NULL", [t]).changes;
    recordEvent(handle, { kind: "strict-on", actor, detail: { demoted }, at: now });
    return { demoted };
  });
}

/** What each mode does, and the effective state today (printed by `config review`). */
export function describeModes(mode, { anyHostFirstParty = false } = {}) {
  return [
    `Review mode: ${mode}.`,
    "  strict  every learning waits for your OK in review, on every host.",
    "  auto    a correction you type applies at once (tagged, undo any) on hosts that can prove you typed it; everything else waits for review.",
    anyHostFirstParty ? "" : "Today no host can prove a prompt was typed, so every host is review-first either way.",
  ].filter(Boolean);
}
