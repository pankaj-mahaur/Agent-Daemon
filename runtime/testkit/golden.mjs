// Byte-for-byte golden files under test/golden/ (LF on every platform, see
// .gitattributes). AD_UPDATE_GOLDEN=1 rewrites them instead of comparing;
// review the diff before committing.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "golden");

export function assertGolden(name, actual) {
  const file = path.join(ROOT, name);
  const text = actual.endsWith("\n") ? actual : actual + "\n";
  if (process.env.AD_UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  if (!fs.existsSync(file)) assert.fail(`missing golden ${name}; run with AD_UPDATE_GOLDEN=1 and review it`);
  assert.equal(text, fs.readFileSync(file, "utf8"), `golden ${name} differs (AD_UPDATE_GOLDEN=1 rewrites it)`);
}
