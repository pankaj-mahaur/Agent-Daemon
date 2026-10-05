#!/usr/bin/env node
// Generates src/engine/codex/protocol-notifications.json: every server
// notification of the pinned Codex, split into stable and experimental, read
// from the protocol source (codex-rs/app-server-protocol/src/protocol/common.rs
// at the pinned tag). The JSON schema and TS bindings don't mark which
// notifications are experimental; the `#[experimental(...)]` attribute in the
// source does, and experimental ones are never sent to clients without the
// opt-in (should_skip_notification_for_connection), which ad never asks for.
//
// Usage:
//   node scripts/codex-notifications.mjs                 # the pinned version
//   node scripts/codex-notifications.mjs --file common.rs --version 0.160.0
//
// Run it on every Codex bump (the codex-upgrade skill lists it); the events
// exhaustiveness test then names every notification that needs a decision.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "engine", "codex", "protocol-notifications.json");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Parses the server_notification_definitions! block. */
export function parseNotifications(source) {
  const start = source.indexOf("server_notification_definitions! {");
  if (start < 0) throw new Error("server_notification_definitions! block not found");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const out = [];
  let experimental = false;
  let rename = null;
  for (const line of body.split("\n")) {
    if (/#\[experimental\("[^"]+"\)\]/.test(line)) {
      experimental = true;
      continue;
    }
    const r = /#\[serde\(rename = "([^"]+)"\)\]/.exec(line);
    if (r) {
      rename = r[1];
      continue;
    }
    // `Variant => "wire" (Params),`  or  `Variant(Params),` with a serde rename above.
    const v = /^\s*([A-Z][A-Za-z0-9]*)\s*(?:=>\s*"([^"]+)")?\s*\(?\s*(?:v\d+::)?([A-Z][A-Za-z0-9]*)/.exec(line);
    if (v && !line.trim().startsWith("//")) {
      const wire = v[2] ?? rename;
      if (!wire) throw new Error(`no wire name for ${v[1]}`);
      out.push({ method: wire, variant: v[1], params: v[3], experimental });
      experimental = false;
      rename = null;
    }
  }
  return out;
}

async function main() {
  const require = createRequire(import.meta.url);
  const version = arg("--version") ?? require("@openai/codex/package.json").version;
  const file = arg("--file");
  let source;
  if (file) source = fs.readFileSync(file, "utf8");
  else {
    const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/app-server-protocol/src/protocol/common.rs`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    source = await res.text();
  }
  const all = parseNotifications(source);
  if (all.length < 40) throw new Error(`only ${all.length} notifications parsed; wrong file?`);
  const doc = {
    codexVersion: version,
    source: "codex-rs/app-server-protocol/src/protocol/common.rs",
    stable: all.filter((n) => !n.experimental).map((n) => n.method),
    experimental: all.filter((n) => n.experimental).map((n) => n.method),
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${doc.stable.length} stable, ${doc.experimental.length} experimental (Codex ${version})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
