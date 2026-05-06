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
import { runWatcher } from "./daemon/watch.mjs";

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
  query-retrieve         Extract keywords from user prompt and inject relevant past learnings (UserPromptSubmit hook)
  doctor                 Diagnose the install — settings.json, PATH, dirs
  doctor --tokens        Show token usage + cache stats from recent sessions

  team create            Create a new multi-agent team
  team status            Show team kanban board
  team list              List all teams
  team list-templates    List available team templates
  team inbox             Read messages from an agent's inbox
  team cleanup           Prune stale worktrees and dangling team data
  team delete            Delete a team and its data
  spawn                  Spawn a worker agent in a team

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

Team/spawn flags:
  --template <name>      Team template name (full-stack-feature, bug-triage-team, etc.)
  --task <description>   Task description for team or spawned agent
  --team <id>            Team id
  --role <name>          Role name for spawn
  --agent <name>         Agent name for inbox

Environment:
  CLAUDE_PROJECT_DIR     Project root (set by Claude Code hook)
  CLAUDE_SESSION_ID      Session id (set by Claude Code hook)
  CLAUDE_TRANSCRIPT_PATH Transcript path (set by Claude Code hook)
  AGENT_DAEMON_HOME      Override the runtime root (default: this repo's parent)
`;

/* ------------------------------------------------------------------ */
/* Subcommand implementations                                          */
/* ------------------------------------------------------------------ */

async function cmdInit({ cwd = process.cwd(), dryRun = false, verbose = false, yes = false }) {
  const target = path.join(cwd, ".agent-daemon", "memory");
  const templatesDir = path.join(PROJECT_ROOT, "memory-templates");

  // Phase 1: Audit existing agent files
  const AGENT_FILES = [
    { path: ".claude/",               label: "Claude Code project config" },
    { path: "CLAUDE.md",              label: "Claude Code project memory" },
    { path: ".cursor/rules/",         label: "Cursor rules" },
    { path: ".cline/rules/",          label: "Cline rules" },
    { path: "AGENTS.md",             label: "Multi-agent instructions" },
    { path: "CONVENTIONS.md",        label: "Aider conventions" },
    { path: ".agent-daemon/",        label: "agent-daemon (already initialized)" }
  ];

  console.log("agent-daemon init — project audit\n");
  console.log("  Detected:");
  const detected = [];
  for (const af of AGENT_FILES) {
    const full = path.join(cwd, af.path);
    let exists = false;
    try {
      const stat = await fs.stat(full);
      exists = stat.isFile() || stat.isDirectory();
    } catch { /* not found */ }
    const symbol = exists ? "✓" : "✗";
    console.log(`    ${symbol} ${af.path.padEnd(24)} ${af.label}${exists ? "" : " (not present)"}`);
    if (exists) detected.push(af);
  }

  // Phase 2: Plan what we'll create
  const actions = [];
  try {
    await fs.access(target);
  } catch {
    actions.push(`+ .agent-daemon/memory/       (new — ${await countTemplates(templatesDir)} memory templates)`);
  }

  // Check if CLAUDE.md exists and needs our managed section
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  const MANAGED_START = "<!-- agent-daemon:start -->";
  const MANAGED_END = "<!-- agent-daemon:end -->";
  let claudeMdExists = false;
  let claudeMdHasSection = false;
  try {
    const content = await fs.readFile(claudeMdPath, "utf8");
    claudeMdExists = true;
    claudeMdHasSection = content.includes(MANAGED_START);
    if (!claudeMdHasSection) {
      actions.push("+ Section in CLAUDE.md pointing to .agent-daemon/ (additive — existing content preserved)");
    }
  } catch { /* no CLAUDE.md */ }

  if (actions.length === 0) {
    console.log("\n  Nothing to do — agent-daemon is already initialized in this project.");
    return 0;
  }

  console.log("\n  Will create:");
  for (const a of actions) console.log(`    ${a}`);

  if (dryRun) {
    console.log("\n  [dry-run] No changes made.");
    return 0;
  }

  // Phase 3: Apply
  console.log("");

  // Create memory dir + copy templates
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
    } catch {
      await fs.copyFile(src, dst);
      copied++;
    }
  }
  if (copied > 0) console.log(`  ✓ Created .agent-daemon/memory/ (${copied} templates)`);

  // Add managed section to CLAUDE.md (idempotent)
  if (claudeMdExists && !claudeMdHasSection) {
    const section = [
      "",
      MANAGED_START,
      "## agent-daemon",
      "",
      "This project uses [agent-daemon](https://github.com/anthropics/agent-daemon) for self-improving memory and skills.",
      "Project memory lives in `.agent-daemon/memory/`. The digest pipeline extracts learnings from each session.",
      "For past learnings, use `mcp__qmd__search <query>`. For skill evolution, use `/evolve <skill>`.",
      MANAGED_END,
      ""
    ].join("\n");
    await fs.appendFile(claudeMdPath, section, "utf8");
    console.log("  ✓ Added agent-daemon section to CLAUDE.md");
  }

  console.log("\nagent-daemon: initialized. Run `agent-daemon doctor` to verify the install.");
  return 0;
}

async function countTemplates(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(e => e.endsWith(".md.template")).length;
  } catch { return 0; }
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

async function cmdDoctor({ tokens, limit, model } = {}) {
  if (tokens) {
    const { aggregateTokenStats, formatTokenReport } = await import("./instrument.mjs");
    const stats = await aggregateTokenStats({
      limit: limit ? parseInt(limit, 10) : 10,
      model: model || "opus"
    });
    console.log(formatTokenReport(stats));
    return stats.error ? 1 : 0;
  }

  const checks = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  const settingsPath = path.join(home, ".claude", "settings.json");

  // Check 1: agent-daemon CLI on PATH (we know it is — we're running)
  checks.push({ name: "agent-daemon CLI", ok: true, note: `running from ${__filename}` });

  // Check 2: claude CLI on PATH
  checks.push(await checkBinary("claude", "headless engine for digest pipeline"));

  // Check 2b: Auth — ANTHROPIC_API_KEY or OAuth/keychain
  // As of v0.5, --bare is no longer used. OAuth/keychain auth works for GEPA.
  if (process.env.ANTHROPIC_API_KEY) {
    checks.push({ name: "Auth (API key)", ok: true, note: "ANTHROPIC_API_KEY set — used for all headless calls" });
  } else {
    // Check for OAuth login
    const authFile = path.join(home, ".claude", "auth.json");
    let hasOAuth = false;
    try {
      await fs.access(authFile);
      hasOAuth = true;
    } catch { /* no auth.json */ }
    if (hasOAuth) {
      checks.push({ name: "Auth (OAuth)", ok: true, note: "~/.claude/auth.json found — OAuth/keychain login active" });
    } else {
      checks.push({ name: "Auth", ok: true, note: "no API key or OAuth — digest works via agent-emitted blocks; GEPA requires `claude auth login` or ANTHROPIC_API_KEY" });
    }
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
    const matchesHook = (h) => { const s = JSON.stringify(h).toLowerCase(); return s.includes("agent-daemon") || s.includes("agent daemon"); };
    const sessionStart = (hooks.SessionStart || []).some(matchesHook);
    const sessionEnd   = (hooks.SessionEnd   || []).some(matchesHook);
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

async function cmdQueryRetrieve(opts) {
  const { runQueryRetrieve } = await import("./query-retrieve.mjs");
  return runQueryRetrieve(opts);
}

async function cmdWatch(opts) {
  return runWatcher({
    projectRoot: opts.projectRoot,
    verbose: opts.verbose,
    onceOnExisting: false
  });
}

async function cmdTeam(subcommand, opts) {
  const { createTeam, loadTeam, listTeams, addTask, formatTeamStatus, listTasks } = await import("./orchestration/team.mjs");
  const { loadTemplate, listTemplates, findLeader } = await import("./orchestration/templates.mjs");
  const { readInbox } = await import("./orchestration/inbox.mjs");

  switch (subcommand) {
    case "create": {
      if (!opts.task) {
        console.error("agent-daemon team create: --task is required");
        return 1;
      }
      let roles = [];
      let flows = [];
      let templateTasks = [];
      let templateName = null;

      if (opts.template) {
        const tmpl = await loadTemplate(opts.template);
        roles = tmpl.roles;
        flows = tmpl.flows;
        templateTasks = tmpl.tasks || [];
        templateName = tmpl.name;
      }

      const team = await createTeam({
        description: opts.task,
        template: templateName,
        roles,
        flows
      });

      // Create default tasks from template
      const taskIdMap = {};
      for (const tt of templateTasks) {
        const blockedBy = (tt.blocked_by || []).map(title => taskIdMap[title]).filter(Boolean);
        const task = await addTask(team.id, {
          title: tt.title,
          owner: tt.owner || null,
          blockedBy
        });
        taskIdMap[tt.title] = task.id;
      }

      console.log(`Team created: ${team.id}`);
      if (templateName) console.log(`  Template: ${templateName}`);
      console.log(`  Description: ${team.description}`);
      console.log(`  Roles: ${roles.map(r => r.name).join(", ") || "(none — ad-hoc)"}`);
      if (templateTasks.length > 0) {
        console.log(`  Tasks: ${templateTasks.length} created from template`);
      }
      console.log(`\nNext steps:`);
      console.log(`  agent-daemon spawn --team ${team.id} --role <role> --task "<task>"`);
      console.log(`  agent-daemon team status --team ${team.id}`);
      return 0;
    }

    case "status": {
      if (!opts.team) {
        // Show all teams
        const teams = await listTeams();
        if (teams.length === 0) {
          console.log("No teams created yet. Create one with: agent-daemon team create --task \"...\"");
          return 0;
        }
        for (const t of teams) {
          console.log(`${t.id}  ${t.template || "(ad-hoc)"}  ${t.description.slice(0, 60)}`);
        }
        return 0;
      }
      const board = await formatTeamStatus(opts.team);
      console.log(board);
      return 0;
    }

    case "list": {
      const teams = await listTeams();
      if (teams.length === 0) {
        console.log("No teams.");
        return 0;
      }
      for (const t of teams) {
        console.log(`  ${t.id}  template=${t.template || "ad-hoc"}  ${t.description.slice(0, 50)}`);
      }
      return 0;
    }

    case "list-templates": {
      const templates = await listTemplates();
      if (templates.length === 0) {
        console.log("No templates found.");
        return 0;
      }
      console.log("Available team templates:\n");
      for (const t of templates) {
        console.log(`  ${t.name.padEnd(24)} ${t.description}  (${t.source})`);
      }
      return 0;
    }

    case "inbox": {
      if (!opts.team) {
        console.error("agent-daemon team inbox: --team is required");
        return 1;
      }
      const agentName = opts.agent || "leader";
      const messages = await readInbox(opts.team, agentName);
      if (messages.length === 0) {
        console.log(`No messages in ${agentName}'s inbox.`);
        return 0;
      }
      console.log(`${messages.length} message(s) in ${agentName}'s inbox:\n`);
      for (const m of messages) {
        console.log(`  [${m.type}] from=${m.from} at=${m.timestamp}`);
        if (m.payload?.summary) {
          console.log(`    ${m.payload.summary.slice(0, 100)}`);
        }
        if (m.payload?.status) {
          console.log(`    status: ${m.payload.status}`);
        }
      }
      return 0;
    }

    case "cleanup": {
      const { cleanupWorktrees } = await import("./orchestration/spawn.mjs");
      console.log("Cleaning up stale worktrees...");
      const { removed } = await cleanupWorktrees(opts.cwd);
      console.log(`  Pruned ${removed} stale worktree(s).`);

      // Also report old completed teams
      const teams = await listTeams();
      const oldTeams = [];
      const now = Date.now();
      for (const t of teams) {
        const tasks = await listTasks(t.id);
        const allDone = tasks.length > 0 && tasks.every(tk => tk.status === "completed");
        const created = new Date(t.createdAt).getTime();
        if (allDone || (now - created > 7 * 24 * 60 * 60 * 1000)) {
          oldTeams.push(t);
        }
      }
      if (oldTeams.length > 0) {
        console.log(`\n  ${oldTeams.length} team(s) eligible for deletion:`);
        for (const t of oldTeams) {
          console.log(`    ${t.id}  ${t.description.slice(0, 50)}`);
        }
        console.log(`\n  Delete with: agent-daemon team delete --team <id>`);
      }
      return 0;
    }

    case "delete": {
      if (!opts.team) {
        console.error("agent-daemon team delete: --team is required");
        return 1;
      }
      const home = process.env.HOME || process.env.USERPROFILE;
      const teamPath = path.join(home, ".agent-daemon", "teams", opts.team);
      try {
        await fs.stat(teamPath);
      } catch {
        console.error(`Team ${opts.team} not found.`);
        return 1;
      }
      await fs.rm(teamPath, { recursive: true, force: true });
      console.log(`Deleted team: ${opts.team}`);
      return 0;
    }

    default:
      console.error(`agent-daemon team: unknown subcommand "${subcommand}". Use: create, status, list, list-templates, inbox, cleanup, delete`);
      return 1;
  }
}

async function cmdSpawn(opts) {
  if (!opts.team) {
    console.error("agent-daemon spawn: --team is required");
    return 1;
  }
  if (!opts.role) {
    console.error("agent-daemon spawn: --role is required");
    return 1;
  }
  if (!opts.task) {
    console.error("agent-daemon spawn: --task is required");
    return 1;
  }
  if (opts.role.length > 64 || /[\/\\:*?"<>|]/.test(opts.role)) {
    console.error("agent-daemon spawn: --role contains invalid characters or is too long");
    return 1;
  }

  const { loadTeam } = await import("./orchestration/team.mjs");
  const { spawnAgent, getActiveAgentCount } = await import("./orchestration/spawn.mjs");

  let team;
  try {
    team = await loadTeam(opts.team);
  } catch (err) {
    console.error(`agent-daemon spawn: cannot load team ${opts.team}: ${err.message}`);
    return 1;
  }

  const roleDef = team.roles.find(r => r.name === opts.role);
  const leader = team.roles.find(r => r.is_leader);

  console.log(`Spawning agent: role=${opts.role} team=${opts.team}`);
  console.log(`  Task: ${opts.task}`);

  const result = await spawnAgent({
    teamId: opts.team,
    role: opts.role,
    task: opts.task,
    instructions: roleDef?.instructions,
    skills: roleDef?.skills,
    model: opts.model,
    cwd: opts.cwd,
    worktree: true,
    leader: leader?.name || null,
    verbose: opts.verbose
  });

  if (result.ok) {
    console.log(`\nAgent spawned successfully:`);
    console.log(`  Name: ${result.agentName}`);
    console.log(`  Branch: ${result.branch}`);
    console.log(`  Worktree: ${result.worktreePath}`);
    console.log(`  PID: ${result.pid}`);
  } else {
    console.error(`\nSpawn failed: ${result.error}`);
  }

  return result.ok ? 0 : 1;
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
        verbose:      { type: "boolean" },
        tokens:       { type: "boolean" },
        limit:        { type: "string" },
        model:        { type: "string" },
        template:     { type: "string" },
        task:         { type: "string" },
        team:         { type: "string" },
        role:         { type: "string" },
        agent:        { type: "string" }
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
    case "query-retrieve": return cmdQueryRetrieve(opts);
    case "doctor":         return cmdDoctor({ ...opts, tokens: parsed.values.tokens, limit: parsed.values.limit, model: parsed.values.model });
    case "team":           return cmdTeam(parsed.positionals?.[0], { ...opts, template: parsed.values.template, task: parsed.values.task, team: parsed.values.team, agent: parsed.values.agent, model: parsed.values.model });
    case "spawn":          return cmdSpawn({ ...opts, team: parsed.values.team, role: parsed.values.role, task: parsed.values.task, model: parsed.values.model });
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
