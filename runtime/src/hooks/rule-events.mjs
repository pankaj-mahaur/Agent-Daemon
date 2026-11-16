// The rule events log (MCP launch plan L7, design D11): adRoot()/hooks/rule-events.jsonl.
// tool.before appends one line per ask, stop and allow-once pass; `report` and
// `rules allow-once` read it. No command text is written here (P1b); the canonical call
// a stop may be allowed once by arrives with allow-once (P1c). The file is ad's state
// (self-protected); the hook never opens the memory store, so this is how it reports.
//
// One line per event, one write() in append mode, capped at 256 KB with one rotation
// (rule-events.jsonl.1), like hook.log.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";

export const RULE_EVENTS_FILE = "rule-events.jsonl";
const CAP = 256 * 1024;

export const ruleEventsPath = (root = adRoot()) => path.join(root, "hooks", RULE_EVENTS_FILE);

/** Append one event. Best effort: a log that can't be written never changes a decision. */
export function appendRuleEvent(entry, { root = adRoot(), now = Date.now() } = {}) {
  try {
    const file = ruleEventsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > CAP) fs.renameSync(file, `${file}.1`);
    } catch {
      // no file yet
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`);
  } catch {
    // the log is best effort (L2's hook.log rule): the decision already stands
  }
}

/** Read the events (the rotated file first), oldest first. Unreadable lines are skipped. */
export function readRuleEvents({ root = adRoot() } = {}) {
  const out = [];
  for (const f of [`${ruleEventsPath(root)}.1`, ruleEventsPath(root)]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line
      }
    }
  }
  return out;
}
