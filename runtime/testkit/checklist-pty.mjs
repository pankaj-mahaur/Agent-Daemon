// Test-only: run the review checklist on a real terminal (a pty), over the store at
// argv[2], for the project keys in argv[3] (comma-separated), and write the result as
// JSON to argv[4]. checklist-pty.test.mjs drives it with keys.

import { writeFileSync } from "node:fs";
import { open } from "../src/memory/sqlite.mjs";
import { openChecklist } from "../src/memory/checklist-run.mjs";
import { testReviewToken } from "./memory-trust.mjs";

const [dbPath, keyList, outFile] = process.argv.slice(2);
const handle = await open({ dbPath });
try {
  const r = await openChecklist({ handle, keys: keyList.split(","), token: testReviewToken(), stdin: process.stdin, stdout: process.stdout, header: "pty test" });
  writeFileSync(outFile, JSON.stringify({ ended: r.ended, applied: r.applied ?? null, rawAfter: Boolean(process.stdin.isRaw) }));
} finally {
  handle.close();
}
process.exit(0);
