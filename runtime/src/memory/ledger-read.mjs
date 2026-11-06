// The install ledger v2, read-only and dependency-free (MCP launch plan L3, Decision 8):
// hooks read it (the agent-shell marker check, the plugin's setup nudge), so it may import
// nothing but node:*. Hashing and editing live in memory-install/ledger2.mjs.
//   adRoot()/memory/ledger.json = { schemaVersion: 2, items: [ … ] }

import fs from "node:fs";
import path from "node:path";

export const LEDGER_FILE = "ledger.json";
export const ledger2Path = (root) => path.join(root, "memory", LEDGER_FILE);

/** The ledger's items, or [] when it is missing, unreadable or another version. */
export function readItems(root) {
  try {
    const j = JSON.parse(fs.readFileSync(ledger2Path(root), "utf8"));
    if (j?.schemaVersion === 2 && Array.isArray(j.items)) return j.items.filter((i) => i && typeof i === "object" && typeof i.id === "string");
  } catch {
    // missing or garbled: nothing recorded (doctor reports a garbled one)
  }
  return [];
}

/** Items for a host and kind ("mcp", "hook", "env", "skill-dir"). */
export const itemsOf = (root, host, kind) => readItems(root).filter((i) => i.host === host && (!kind || i.kind === kind));
