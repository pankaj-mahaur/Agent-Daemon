// The 7-day doctor nudge (MCP launch plan L8, design decision 15): a week after the first
// install, `doctor` points to the feedback thread. Information only (ok: true, never a
// failure); no ledger, or under 7 days, prints nothing. Reads the ledgers only.

import { readLedger } from "./ledger.mjs";
import { readLedger2 } from "./ledger2.mjs";
import { DISCUSSIONS_URL } from "../memory/weekly.mjs";

export const NUDGE_DAYS = 7;
// Ledger v2 merges a v1 entry without installedAt as the epoch: no real install is that old.
const EARLIEST = Date.parse("2020-01-01T00:00:00.000Z");

/** The earliest install time in ledger v1 and v2 (ms), or null. */
export function firstInstallAt(root) {
  const times = [];
  try {
    for (const rec of Object.values(readLedger(root).hosts ?? {})) times.push(Date.parse(rec?.installedAt));
  } catch {
    // no v1 ledger
  }
  try {
    for (const item of readLedger2(root).items ?? []) times.push(Date.parse(item?.installedAt));
  } catch {
    // no v2 ledger
  }
  const ok = times.filter((t) => Number.isFinite(t) && t >= EARLIEST);
  return ok.length ? Math.min(...ok) : null;
}

/** → the nudge text once `days` have passed since the first install, else null. */
export function feedbackNudge(root, { now = Date.now(), days = NUDGE_DAYS } = {}) {
  const first = firstInstallAt(root);
  if (first === null || now - first < days * 86_400_000) return null;
  return `You've had it a week or more: what worked, what didn't? Tell us in ${DISCUSSIONS_URL}`;
}
