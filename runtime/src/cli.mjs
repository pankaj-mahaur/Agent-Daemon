#!/usr/bin/env node
// agent-daemon CLI entry point.
// Subcommand dispatcher. Each subcommand is a small async function — the
// heavy ones live in their own module.

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

import { runSessionStart } from "./session-start.mjs";
import { runDigest } from "./digest/digest.mjs";
import { runInteractiveReview } from "./review.mjs";
import { evolveSkill } from "./digest/gepa/evolve.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");  // .../agent-daemon/
const VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */

const HELP = `agent-daemon ${VERSION} — self-improving memory + skills runtime

Usage:
  agent-daemon <command> [options]

Commands:
  session-start          Inject constitution + project memory into session start hook output (JSON to stdout)
  digest                 Run digest pipeline against a transcript (extract → classify → apply)
  evolve <skill>         GEPA self-improvement run for a skill (sample → reflect → generate → evaluate → select)
  checkpoint             Save a memory checkpoint before /compact
  init                   Scaffold .agent-daemon/ in current project
  status                 Show queued proposals (skill diffs, constitution rule additions)
  review                 Interactively accept/reject queued proposals
  watch                  Watch transcript directories and fire digest on new sessions (v0.2)
  doctor                 Diagnose the install — settings.json, PATH, dirs

Options:
  --version              Print version and exit
  --help                 Print this help and exit

Common command flags:
  --transcript <path>    Path to a session JSONL transcript
  --session-id <id>      Session id (when not derivable from transcript path)
  --cwd <path>           Project working directory
  --output-json          Output JSON to stdout (for hook integration)
  --dry-run              Show what would happen without making changes
  --verbose              Verbose logging to stderr

Environment:
  CLAUDE_PROJECT_DIR     Project root (set by Claude Code hook)
  CLAUDE_SESSION_ID      Session id (set by Claude Code hook)
  CLAUDE_TRANSCRIPT_PATH Transcript path (set by Claude Code hook)
  AGENT_DAEMON_HOME      Override the runtime root (default: this repo's parent)
`;

/* ------------------------------------------------------------------ */
/* Subcommand implementations                                          */
/* ------------------------------------------------------------------ */

async function cmdInit({ cwd = process.cwd(), dryRun = false }) {
  const target = path.join(cwd, ".agent-daemon", "memory");
  const templatesDir = path.join(PROJECT_ROOT, "memory-templates");

  if (dryRun) {
    console.log(`[dry-run] would scaffold: ${target}`);
    return 0;
  }

  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(templatesDir);
  let copied = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md.template")) continue;
    const src = path.join(templatesDir, entry);
    const dstName = entry.replace(/\.template$/, "");
    const dst = path.join(target, dstName);
    try {
      await fs.access(dst);
      // Skip — already exists. Don't overwrite the user's existing memory.
    } catch {
      await fs.copyFile(src, dst);
      copied++;
    }
  }
  console.log(`agent-daemon: initialized ${target} (${copied} templates copied)`);
  return 0;
}

async function cmdStatus({ cwd = process.cwd() }) {
  const proposed = path.join(cwd, ".agent-daemon", "proposed");
  try {
    const entries = await fs.readdir(proposed);
    const diffs = entries.filter(e => e.endsWith(".diff") || e.endsWith(".md"));
    if (diffs.length === 0) {
      console.log("No queued proposals.");
      return 0;
    }
    console.log(`${diffs.length} queued proposal(s):`);
    for (const d of diffs) {
      const stat = await fs.stat(path.join(proposed, d));
      console.log(`  ${d}  (${stat.size} bytes, ${stat.mtime.toISOString()})`);
    }
    console.log("\nReview with: agent-daemon review");
    return 0;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No queued proposals.");
      return 0;
    }
    throw err;
  }
}

async function cmdReview(opts) {
  return runInteractiveReview(opts);
}

async function cmdDoctor() {
  const checks = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  const settingsPath = path.join(home, ".claude", "settings.json");

  // Check 1: agent-daemon CLI on PATH (we know it is — we're running)
  checks.push({ name: "agent-daemon CLI", ok: true, note: `running from ${__filename}` });

  // Check 2: claude CLI on PATH
  checks.push(await checkBinary("claude", "headless engine for digest pipeline"));

  // Check 2b: ANTHROPIC_API_KEY (required by --bare mode used in digest)
  if (process.env.ANTHROPIC_API_KEY) {
    checks.push({ name: "ANTHROPIC_API_KEY", ok: true, note: "set (length=" + process.env.ANTHROPIC_API_KEY.length + ")" });
  } else {
    checks.push({ name: "ANTHROPIC_API_KEY", ok: false, note: "missing — required for digest pipeline (--bare mode). Get a key at https://console.anthropic.com/settings/keys" });
  }

  // Check 2c: better-sqlite3 native binding (episodic memory)
  try {
    const sqliteMod = await import("./memory/sqlite.mjs");
    const driver = await sqliteMod.checkDriver();
    if (driver.installed) {
      checks.push({ name: "better-sqlite3 (episodic memory)", ok: true, note: "installed" });
      // Quick stats if DB exists
      try {
        const ep = await import("./memory/episodic.mjs");
        const stats = await ep.stats();
        if (stats.driver) {
          const total = Object.values(stats.counts).reduce((a, b) => a + b, 0);
          checks.push({ name: "episodic DB", ok: true, note: `${stats.dbPath} — ${total} rows total` });
        }
      } catch { /* DB not yet created — fine */ }
    } else {
      checks.push({ name: "better-sqlite3 (episodic memory)", ok: false, note: driver.error || "not installed (cd runtime && npm install)" });
    }
  } catch (err) {
    checks.push({ name: "better-sqlite3 (episodic memory)", ok: false, note: `error: ${err.message}` });
  }

  // Check 3: settings.json exists and parses
  try {
    const txt = await fs.readFile(settingsPath, "utf8");
    JSON.parse(txt);
    checks.push({ name: "Claude Code settings.json", ok: true, note: settingsPath });
  } catch (err) {
    checks.push({ name: "Claude Code settings.json", ok: false, note: err.code === "ENOENT" ? `not found at ${settingsPath}` : `parse error: ${err.message}` });
  }

  // Check 4: hooks wired
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const hooks = settings.hooks || {};
    const sessionStart = (hooks.SessionStart || []).some(h => JSON.stringify(h).includes("agent-daemon"));
    const sessionEnd   = (hooks.SessionEnd   || []).some(h => JSON.stringify(h).includes("agent-daemon"));
    checks.push({ name: "SessionStart hook → agent-daemon", ok: sessionStart, note: sessionStart ? "wired" : "missing — run setup.sh --hooks" });
    checks.push({ name: "SessionEnd hook → agent-daemon",   ok: sessionEnd,   note: sessionEnd   ? "wired" : "missing — run setup.sh --hooks" });
  } catch {
    checks.push({ name: "Hook wiring", ok: false, note: "could not read settings.json" });
  }

  // Check 5: project root dirs exist
  for (const dir of ["constitution", "memory-templates", "skills", "hooks"]) {
    const p = path.join(PROJECT_ROOT, dir);
    try {
      const stat = await fs.stat(p);
      checks.push({ name: `${dir}/`, ok: stat.isDirectory(), note: p });
    } catch {
      checks.push({ name: `${dir}/`, ok: false, note: `missing: ${p}` });
    }
  }

  // Print results
  const max = Math.max(...checks.map(c => c.name.length));
  let allOk = true;
  for (const c of checks) {
    const symbol = c.ok ? "✓" : "✗";
    console.log(`  ${symbol}  ${c.name.padEnd(max)}  ${c.note}`);
    if (!c.ok) allOk = false;
  }
  console.log("");
  console.log(allOk ? "agent-daemon: all checks passed." : "agent-daemon: some checks failed — see above.");
  return allOk ? 0 : 1;
}

async function checkBinary(name, purpose) {
  const { spawn } = await import("node:child_process");
  return new Promise(resolve => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [name], { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", c => out += c);
    child.on("close", code => {
      const ok = code === 0 && out.trim().length > 0;
      resolve({ name: `${name} on PATH`, ok, note: ok ? `${out.trim().split(/\s+/)[0]} (${purpose})` : `not found (${purpose})` });
    });
    child.on("error", () => {
      resolve({ name: `${name} on PATH`, ok: false, note: `error checking PATH (${purpose})` });
    });
  });
}

async function cmdCheckpoint({ transcript, sessionId }) {
  // Lightweight v0.1: append a checkpoint marker to a log; full implementation in v0.2.
  if (!transcript) {
    console.error("agent-daemon: --transcript is required");
    return 1;
  }
  const cpDir = path.join(process.env.HOME || process.env.USERPROFILE, ".agent-daemon", "checkpoints");
  await fs.mkdir(cpDir, { recursive: true });
  const cpFile = path.join(cpDir, `${sessionId || "unknown"}-${Date.now()}.json`);
  const stat = await fs.stat(transcript).catch(() => null);
  const checkpoint = {
    sessionId: sessionId || null,
    transcript,
    transcriptSize: stat?.size || null,
    transcriptMtime: stat?.mtime?.toISOString() || null,
    timestamp: new Date().toISOString(),
    note: "pre-compact checkpoint (v0.1: marker only; full state save lands in v0.2)"
  };
  await fs.writeFile(cpFile, JSON.stringify(checkpoint, null, 2));
  console.error(`agent-daemon: checkpoint → ${cpFile}`);
  return 0;
}

async function cmdWatch() {
  console.log("agent-daemon: watch mode lands in v0.2 (chokidar over transcript dirs).");
  console.log("For v0.1, hook-based triggering covers Claude Code. Other agents need manual `agent-daemon digest --transcript <path>` for now.");
  return 0;
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

async function main(argv) {
  // Show help if no args or --help
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return 0;
  }

  const [command, ...rest] = argv;

  // Parse remaining args generically (each command interprets what it needs)
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        transcript:   { type: "string" },
        "session-id": { type: "string" },
        cwd:          { type: "string" },
        "output-json":{ type: "boolean" },
        "dry-run":    { type: "boolean" },
        verbose:      { type: "boolean" }
      },
      allowPositionals: true,
      strict: false
    });
  } catch (err) {
    console.error(`agent-daemon: ${err.message}`);
    return 1;
  }

  const opts = {
    transcript:  parsed.values.transcript    || process.env.CLAUDE_TRANSCRIPT_PATH,
    sessionId:   parsed.values["session-id"] || process.env.CLAUDE_SESSION_ID,
    cwd:         parsed.values.cwd           || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    outputJson:  parsed.values["output-json"] || false,
    dryRun:      parsed.values["dry-run"]    || false,
    verbose:     parsed.values.verbose       || false,
    projectRoot: PROJECT_ROOT
  };

  switch (command) {
    case "session-start":  return runSessionStart(opts);
    case "digest":         return runDigest(opts);
    case "evolve":         return cmdEvolve({ ...opts, skillName: parsed.positionals?.[0] });
    case "checkpoint":     return cmdCheckpoint(opts);
    case "init":           return cmdInit(opts);
    case "status":         return cmdStatus(opts);
    case "review":         return cmdReview(opts);
    case "watch":          return cmdWatch(opts);
    case "doctor":         return cmdDoctor(opts);
    default:
      console.error(`agent-daemon: unknown command "${command}"`);
      console.error(HELP);
      return 2;
  }
}

async function cmdEvolve(opts) {
  if (!opts.skillName) {
    console.error("agent-daemon evolve: requires a skill name. Usage: agent-daemon evolve <skill-name>");
    return 1;
  }
  const skillPath = path.join(opts.projectRoot, "skills", opts.skillName, "SKILL.md");
  try {
    await fs.access(skillPath);
  } catch {
    console.error(`agent-daemon evolve: no such skill at ${skillPath}`);
    return 1;
  }

  const result = await evolveSkill({
    skillPath,
    skillName: opts.skillName,
    dryRun: opts.dryRun,
    verbose: opts.verbose,
    proposedDir: path.join(opts.cwd, ".agent-daemon", "proposed")
  });

  console.error(`\nagent-daemon evolve: ${result.status} — ${result.reason}`);
  console.error(`  cost: $${result.totalCostUsd.toFixed(4)}`);
  if (result.proposalPath) {
    console.error(`  proposal: ${result.proposalPath}`);
    console.error(`  review with: agent-daemon review`);
  }
  return result.status === "error" ? 1 : 0;
}

main(process.argv.slice(2)).then(code => process.exit(code || 0)).catch(err => {
  console.error(`agent-daemon: fatal: ${err.stack || err.message}`);
  process.exit(1);
});
