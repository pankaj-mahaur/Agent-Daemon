#!/usr/bin/env node
// The release's name gate (MCP launch plan L3, Decision 24; owner checkpoint C-L3-NAME):
// a real (non-dry-run) release refuses while product.mjs still holds the old name,
// unless the owner dispatched it with legacy_name: true. A dry run always passes.
// release-memory.yml passes the dispatch inputs through the environment (never inline).
//   DRY_RUN=true|false LEGACY_NAME=true|false node runtime/scripts/release-name-gate.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_NAMES, PRODUCT } from "../src/product.mjs";

export { LEGACY_NAMES };

/** → { ok, message } */
export function nameGate({ dryRun, legacyName, product = PRODUCT }) {
  const legacy = [product.package, product.plugin, product.mcpServerKey].some((n) => LEGACY_NAMES.includes(n));
  if (!legacy) return { ok: true, message: `release name: ${product.package}` };
  if (dryRun) return { ok: true, message: `dry run under the old name ${product.package}: fine (a real release needs legacy_name: true)` };
  if (legacyName) return { ok: true, message: `releasing under the old name ${product.package}: legacy_name was set` };
  return { ok: false, message: `${product.package} is the old name (C-L3-NAME): a real release under it needs the dispatch input legacy_name: true, or switch product.mjs to the launch name first` };
}

// "true" only, as GitHub passes booleans to env; anything else (unset, "false", junk) is false.
const flag = (v) => String(v ?? "").trim().toLowerCase() === "true";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // dry_run must be said: the publish job reads a missing one as a real run, so the gate
  // can't read it as a dry run (fail closed).
  const d = String(process.env.DRY_RUN ?? "").trim().toLowerCase();
  if (d !== "true" && d !== "false") {
    console.error(`::error::DRY_RUN is ${JSON.stringify(process.env.DRY_RUN ?? null)}: the gate needs the dispatch input dry_run (true or false)`);
    process.exit(1);
  }
  const r = nameGate({ dryRun: d === "true", legacyName: flag(process.env.LEGACY_NAME) });
  (r.ok ? console.log : console.error)(r.ok ? r.message : `::error::${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
