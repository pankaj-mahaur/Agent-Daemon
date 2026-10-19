#!/usr/bin/env node
// agent-daemon-memory — ad's memory for other agents (P5.3).
//   install [--host <id> …] [--yes] [--dry-run] [--capture auto|hooks|tools] [--adopt]
//   doctor [--json]   repair [--host <id>] [--adopt]   status [--json]
//   uninstall [--host <id> …] [--purge-data [--force]]
//   serve [--project <dir>] [--host <id>] [--capture …]   (what hosts start)
// `serve` loads only the server: the install modules (and their parsers) load
// for the other commands, so the installed copy runs without dependencies.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `agent-daemon-memory: ad's memory server for Claude Code, Codex and Cursor.
  install [--host <id> …] [--yes] [--dry-run] [--capture auto|hooks|tools]
  doctor [--json]  ·  repair [--host <id>]  ·  status [--json]
  uninstall [--host <id> …] [--purge-data [--force]]
  review [--accept <file>] [--accept-all] [--global]   (in your own terminal)
Hosts: claude-code, codex, cursor. Memory stays on this computer.`;

/** --flag values: repeated --host collects; booleans are present or not. */
export function parseFlags(argv) {
  const flags = { hosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") flags.hosts.push(argv[++i]);
    else if (a === "--capture") flags.capture = argv[++i];
    else if (["--yes", "-y"].includes(a)) flags.yes = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--adopt") flags.adopt = true;
    else if (a === "--purge-data") flags.purgeData = true;
    else if (a === "--force") flags.force = true;
    else return { error: `unknown option ${a}` };
  }
  return flags;
}

function parseReviewFlags(argv) {
  const r = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--accept") r.accept = argv[++i];
    else if (argv[i] === "--accept-all") r.acceptAll = true;
    else if (argv[i] === "--global") r.global = true;
    else if (argv[i] === "--yes" || argv[i] === "-y") r.yes = true; // refused by review itself
    else return { error: `unknown option ${argv[i]}` };
  }
  return r;
}

async function ask(q) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

export async function main(argv = process.argv.slice(2), { log = (l) => console.log(l) } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd === "serve") {
    // The server reads its own flags from process.argv.
    const here = path.dirname(fileURLToPath(import.meta.url));
    await import(pathToFileURL(path.join(here, "..", "mcp", "memory-server.mjs")).href);
    return null;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === "review") {
    // The same guarded review as `ad review` (D49: your own terminal, typed).
    const r = parseReviewFlags(rest);
    if (r.error) {
      log(r.error);
      return 1;
    }
    return (await import("../review.mjs")).runInteractiveReview({ cwd: process.cwd(), ...r });
  }
  const flags = parseFlags(rest);
  if (flags.error) {
    log(`${flags.error}\n${USAGE}`);
    return 1;
  }
  const opts = { ...flags, hosts: flags.hosts.length ? flags.hosts : undefined, ask, out: log };
  const inst = await import("./install.mjs");
  switch (cmd) {
    case "install":
      return inst.install(opts);
    case "repair": {
      const { readLedger } = await import("./ledger.mjs");
      const ctx = inst.makeContext(opts);
      const owned = Object.keys(readLedger(ctx.root).hosts);
      return inst.install({ ...opts, ctx, hosts: opts.hosts ?? (owned.length ? owned : undefined) });
    }
    case "uninstall":
      return inst.uninstall(opts);
    case "status":
      return inst.status(opts);
    case "doctor":
      return (await import("./doctor.mjs")).doctor(opts);
    default:
      log(`unknown command ${cmd}\n${USAGE}`);
      return 1;
  }
}

// Started as a script (the clone). The package's bin, dist/cli.mjs, calls main() itself.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== null) process.exitCode = code;
}
