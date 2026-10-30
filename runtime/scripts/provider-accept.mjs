#!/usr/bin/env node
// Provider acceptance (P3.5b): one real coding task on one of your accounts, written up as
// a dated record (docs/accounts.md, "What supported means").
//
//   node runtime/scripts/provider-accept.mjs --account <ref> [--model <id>] [--out <dir>]
//
// Refused under CI; never prints or logs a key.

import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createSecretStore } from "../src/auth/secrets.mjs";
import { closeHarnessEngines } from "../src/harness/engines.mjs";
import { closeGateway } from "../src/harness/gateway-runtime.mjs";
import { defaultOutDir, runAcceptance } from "../src/providers/accept.mjs";
import { redact } from "../src/auth/redact.mjs";

const { values } = parseArgs({ options: { account: { type: "string" }, model: { type: "string" }, out: { type: "string" } } });
if (!values.account) {
  console.error("Usage: node runtime/scripts/provider-accept.mjs --account <provider/label> [--model <id>] [--out <dir>]");
  process.exit(2);
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
try {
  const r = await runAcceptance({ account: values.account, model: values.model ?? null, out: values.out ?? defaultOutDir({ repoRoot }), store: createSecretStore(), clientVersion: "accept" });
  console.log(`turn: ${r.turn ?? "not run"}; test.mjs ${r.testPasses ? "passes" : "still fails"}`);
  console.log(`record: ${r.file} (status candidate; fill in the marked lines, then review)`);
  process.exitCode = r.testPasses ? 0 : 1;
} catch (e) {
  console.error(redact(e.message));
  process.exitCode = e.code === "ACCEPT_CI" ? 2 : 1;
} finally {
  await closeHarnessEngines();
  await closeGateway();
}
