// What the installer did, per host (P5.3): adRoot()/memory/install-ledger.json.
// File entries keep the bytes from before the FIRST install (preBytesSha256,
// originalBackup) across upgrades and repairs, so uninstall can put back exactly
// what was there; later installs move only the post-write hashes and version.
//   { schemaVersion: 1, hosts: { <id>: entry } }
//   file: { driver: "file", file, realFile, entryKey, entrySha256, preBytesSha256, originalBackup,
//           postBytesSha256, version, capture, installedBy, installedAt }
//   cli:  { driver: "cli", command, scope, entryKey, argsSha256, version, capture, installedBy, installedAt }

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.mjs";
import { syncFromV1 } from "./ledger2.mjs";

export const ledgerPath = (root) => path.join(root, "memory", "install-ledger.json");

export function readLedger(root) {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8"));
    if (j?.schemaVersion === 1 && j.hosts && typeof j.hosts === "object") return j;
  } catch {
    // missing or unreadable: start empty (doctor reports an unreadable one)
  }
  return { schemaVersion: 1, hosts: {} };
}

export async function writeLedger(root, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  await writeFileAtomic(ledgerPath(root), JSON.stringify(ledger, null, 2) + "\n");
  // Every v1 write is mirrored into ledger v2 (MCP launch plan L3, Decision 8). v1
  // was written and can rebuild the mirror, so a failure here warns and goes on.
  try {
    const note = await syncFromV1(root, ledger);
    if (note) process.stderr.write(`agent-daemon: ${note}\n`);
  } catch (e) {
    // The error's code only: the atomic writer's own message gives advice for another command.
    process.stderr.write(`agent-daemon: ledger.json not updated (${e.code ?? e.name}); the next install or uninstall writes it again\n`);
  }
}
