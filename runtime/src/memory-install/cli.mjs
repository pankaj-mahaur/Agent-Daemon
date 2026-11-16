#!/usr/bin/env node
// agent-daemon-memory — ad's memory for other agents (P5.3).
//   install [--host <id> …] [--yes] [--dry-run] [--capture auto|hooks|tools] [--adopt] [--no-plugin] [--no-setup]
//   setup [--host claude-code|codex] [--no-plugin] [--dry-run]   the hooks and the agent-shell marker
//   doctor [--json]   repair [--host <id>] [--adopt]   status [--json]
//   uninstall [--host <id> …] [--purge-data [--force]]
//   serve [--project <dir>] [--host <id>] [--capture …]   (what hosts start)
// `serve` loads only the server: the install modules (and their parsers) load
// for the other commands, so the installed copy runs without dependencies.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRODUCT } from "../product.mjs";

const USAGE = `${PRODUCT.package}: ad's memory server for Claude Code, Codex, Cursor, VS Code and Gemini CLI.
  install [--host <id> …] [--yes] [--dry-run] [--capture auto|hooks|tools] [--no-plugin] [--no-setup]
  setup [--host claude-code|codex] [--no-plugin] [--dry-run]   the hooks (in your own terminal)
  doctor [--json]  ·  repair [--host <id>]  ·  status [--json]
  uninstall [--host <id> …] [--purge-data [--force]]
  review [--list | --plain | --accept-all [--with-agent] | --proposals] [--accept <file>] [--global]   decide what waits (in your own terminal)
  remember <text>  ·  forget <number>  ·  restore <number>   (accepted at once only in your own terminal)
  learnings list|show <number>|edit <number>|forget <number>|export|import <file>   your learnings (edit and forget in your own terminal)
  config review [strict|auto]   review-first for every learning, or not
  safety [on|status]   ask before four kinds of catastrophic commands (off by default; in your own terminal)
  rules list [--json]   the rules that ask before or stop commands and file writes (changes: rules --help in your own terminal)
  view [--all-projects]   write a read-only HTML page of your learnings, rules and weekly numbers
  report [--days 30] [--weeks 4] [--all-projects] [--json] [--share] [--share-link] [--purge]   is memory working here
  mistakes [--all-projects] [--share | --json] [--yes]   the corrections you keep typing (read-only, offline)
  mistakes --save                                        save them and your instruction files' rules for review (asks first)
Hosts: claude-code, codex, cursor, vscode, gemini. Memory stays on this computer.`;

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
    else if (a === "--no-plugin") flags.noPlugin = true;
    else if (a === "--no-setup") flags.noSetup = true;
    else return { error: `unknown option ${a}` };
  }
  return flags;
}

function parseReviewFlags(argv) {
  const r = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--accept") r.accept = argv[++i];
    else if (argv[i] === "--accept-all") r.acceptAll = true;
    else if (argv[i] === "--with-agent") r.withAgent = true;
    else if (argv[i] === "--list") r.list = true;
    else if (argv[i] === "--plain") r.plain = true;
    else if (argv[i] === "--proposals") r.proposals = true;
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

// Changes to a host's hooks and settings (L3, Decision 12): never from the agent's own
// shell; setup's own step needs a terminal (install and repair then skip it and say so).
const GATED = new Set(["install", "setup", "repair", "uninstall"]);
const realTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** → why cmd can't run here, or null. */
export function commandGate(cmd, { env = process.env, isTTY = realTTY, command = (v) => `npx -y ${PRODUCT.package} ${v}` } = {}) {
  if (!GATED.has(cmd)) return null;
  if (env.AD_TOOL_SHELL === "1") return `${cmd} can't run from the agent's own shell. Run it yourself in a terminal: ${command(cmd)}`;
  if (cmd === "setup" && !isTTY()) return "setup needs an interactive terminal. In Git Bash (mintty, which node doesn't see as a terminal), run it through winpty, or use PowerShell or Windows Terminal.";
  return null;
}

export async function main(argv = process.argv.slice(2), { log = (l) => console.log(l), env = process.env, isTTY = realTTY, ctx: ctxOpts = {} } = {}) {
  // Run in the user's own terminal: git-tracked may use the git on their PATH (hooks and jobs
  // use a trusted git only, L7 D12b).
  // (Only a command typed in a terminal: never serve, watch or a scheduled job, which run in the background.)
  if (process.stdin.isTTY && process.stdout.isTTY && !["serve", "watch"].includes(argv[0]) && !process.env.AD_SCHEDULE_JOB) try {
    const [{ setGitFinder }, { resolveGit }] = await Promise.all([import("../memory/git-tracked.mjs"), import("../safe-spawn.mjs")]);
    setGitFinder(() => {
      try {
        return resolveGit();
      } catch {
        return null;
      }
    });
  } catch {
    // the trusted git only
  }
  const [cmd, ...rest] = argv;
  // How the policy and rules verbs are typed on this route (the hook's notices name it too).
  const verbBase = async () => {
    const inst = await import("./install.mjs");
    return inst.verbBase(inst.makeContext({ env, ...ctxOpts }));
  };
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
  if (cmd === "view") return (await import("../memory/viewer-cli.mjs")).viewMain(rest, { out: log, env, command: (v) => `npx -y ${PRODUCT.package} ${v}` });
  if (cmd === "report" && rest.includes("--purge")) return (await import("../memory/report-purge.mjs")).reportPurgeMain(rest, { out: log });
  if (cmd === "report") return (await import("../memory/report.mjs")).reportMain(rest, { out: log });
  if (cmd === "mistakes") {
    // L4a's read-only report (npx agent-daemon-memory@beta mistakes): offline, stores nothing.
    return (await import("../mistakes/cli.mjs")).runMistakes(rest, { command: `npx ${PRODUCT.package} mistakes` });
  }
  if (cmd === "review") {
    // The same guarded review as `ad review` (D49: your own terminal, typed).
    const r = parseReviewFlags(rest);
    if (r.error) {
      log(r.error);
      return 1;
    }
    // L7b: after the rule step, the starter safety policy is offered once (with this run's token).
    const { reviewOffer } = await import("../memory/safety-offer.mjs");
    const base = await verbBase();
    const command = (v) => `${base} ${v}`;
    return (await import("../review.mjs")).runInteractiveReview({ cwd: process.cwd(), command, afterRuleStep: reviewOffer({ env, isTTY, cmdName: base, command }), ...r });
  }
  // L5: remember, forget, restore, config review (memory/memory-cli.mjs: trusted only with
  // the review token, in your own terminal).
  if (["remember", "forget", "restore", "config"].includes(cmd)) return (await import("../memory/memory-cli.mjs")).memoryVerbMain(cmd, rest, { out: log });
  // L7b: the starter safety policy (off by default; on and off only in your own terminal).
  if (cmd === "safety") {
    const base = await verbBase();
    return (await import("../memory/safety-cli.mjs")).safetyMain(rest, { out: log, env, isTTY, cmdName: base, command: (v) => `${base} ${v}` });
  }
  // L7: rules (memory/rules-cli.mjs): list without a token; changes in your own terminal.
  if (cmd === "rules") {
    const base = await verbBase();
    return (await import("../memory/rules-cli.mjs")).rulesMain(rest, { out: log, env, isTTY, cmdName: base, command: (v) => `${base} ${v}` });
  }
  // L8: your learnings (memory/learnings-cli.mjs): list, show, edit, forget, export, import.
  if (cmd === "learnings") return (await import("../memory/learnings-cli.mjs")).learningsMain(rest[0], rest.slice(1), { out: log });
  const flags = parseFlags(rest);
  if (flags.error) {
    log(`${flags.error}\n${USAGE}`);
    return 1;
  }
  const opts = { ask, out: log, env, isTTY, ...ctxOpts, ...flags, hosts: flags.hosts.length ? flags.hosts : undefined };
  const inst = await import("./install.mjs");
  const refused = commandGate(cmd, { env, isTTY, command: inst.makeContext(opts).command });
  if (refused) {
    log(refused);
    return 2;
  }
  switch (cmd) {
    case "install":
      return inst.install(opts);
    case "setup": {
      const code = await (await import("./setup.mjs")).setup({ ...opts, ctx: inst.makeContext(opts) });
      // L7b: the starter safety policy is offered once, at the end of a setup that didn't fail.
      if (code !== 1 && !opts.dryRun) {
        const { setupOffer } = await import("../memory/safety-offer.mjs");
        const ctx = inst.makeContext(opts);
        // The offer names safety and rules verbs: ad's own on a clone, the pinned npx command otherwise.
        await setupOffer({ out: log, env, isTTY, ask: opts.ask, cmdName: inst.verbBase(ctx), command: ctx.viaLauncher ? ctx.command : (v) => `ad ${v}` }).catch((e) => log(`The starter safety policy's offer stopped: ${e?.message ?? e}.`));
      }
      return code;
    }
    case "repair": {
      const { readLedger } = await import("./ledger.mjs");
      const { readLedger2 } = await import("./ledger2.mjs");
      const ctx = inst.makeContext(opts);
      // The hosts ad set up: MCP entries (v1) and setup's items (v2).
      const owned = [...new Set([...Object.keys(readLedger(ctx.root).hosts), ...readLedger2(ctx.root).items.filter((i) => !i.source).map((i) => i.host)])];
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
