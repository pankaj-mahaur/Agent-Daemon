#!/usr/bin/env node
// agent-daemon CLI entry point.
// Subcommand dispatcher. Each subcommand is a small async function — the
// heavy ones live in their own module.

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

import { runSessionStart } from "./session-start.mjs";
import { runDigest } from "./digest/digest.mjs";
import { runInteractiveReview } from "./review.mjs";
import { evolveSkill } from "./digest/gepa/evolve.mjs";
import { runWatcher } from "./daemon/watch.mjs";
import { resolveProfile, listProfiles } from "./profiles.mjs";
import { buildSkillIndex, resolveSkillSource } from "./skills-source.mjs";
import { detectStack, formatStacks, loadStackSkillMap, resolveSkillsForStacks } from "./stack-detect.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");  // .../agent-daemon/
// VERSION is sourced from runtime/package.json so it can never drift from the
// shipped version. Fall back to "0.0.0-dev" if the file is unreachable (e.g.
// running the CLI from a partial checkout).
let VERSION = "0.0.0-dev";
try {
  const pkgPath = path.resolve(__dirname, "..", "package.json");
  VERSION = JSON.parse(await fs.readFile(pkgPath, "utf8")).version || VERSION;
} catch { /* keep fallback */ }

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */

const HELP = `agent-daemon ${VERSION} — self-improving memory + skills runtime

Usage:
  agent-daemon <command> [options]

Commands:
  session-start          Inject constitution + project memory into session start hook output (JSON to stdout)
  digest                 Run digest pipeline against a transcript (extract → classify → apply)
                         --force              bypass triage threshold
                         --fallback-to-llm    LLM-extract if agent didn't emit a digest block
  digest-latest          Find the newest transcript for --cwd and digest it (--force on by default)
  watch                  Watch transcript directories and fire digest on new sessions
                         --once-on-existing   also digest existing transcripts at startup
                         --force              pass --force to each digest run
                         --fallback-to-llm    enable LLM extraction in watcher
  evolve <skill>         GEPA self-improvement run for a skill (sample → reflect → generate → evaluate → select)
                         --list-candidates    list skills with ≥3 failures in 30d (no auth needed)
                         --export-traces      export skill_executions to JSONL for inline GEPA (no auth needed)
                         --json               machine-readable output (use with --list-candidates / --export-traces)
  checkpoint             Save a memory checkpoint before /compact
  init                   Scaffold .agent-daemon/ in current project
                         --profile <name>     install profile: minimal | developer (default) | security
                         --skills-mode <mode> smart (default — stack-detect) | all | minimal | manual (profile-listed only)
                         --plan               print actions without applying
  status                 Show queued proposals (skill diffs, constitution rule additions)
  review                 Interactively accept/reject queued proposals
  query-retrieve         Extract keywords from user prompt and inject relevant past learnings (UserPromptSubmit hook)
  doctor                 Diagnose the install — settings.json, PATH, dirs
  doctor --tokens        Show token usage + cache stats from recent sessions

  team create     (tc)   Create a new multi-agent team
  team status     (ts)   Show team kanban board
  team list       (tl)   List all teams
  team list-templates (tt)  List available team templates
  team inbox      (ti)   Read messages from an agent's inbox
  team cleanup    (tu)   Prune stale worktrees and dangling team data
  team delete     (td)   Delete a team and its data
  team retry      (tr)   Reset a failed task to pending (--team <id> --task <task-id>)
  spawn           (sp)   Spawn a worker agent in a team

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

async function cmdInit({ cwd = process.cwd(), dryRun = false, verbose = false, yes = false, profile, plan = false, skillsMode }) {
  // Normalise skills-mode. Default 'smart' (stack-detect-driven).
  const SKILLS_MODES = ["smart", "all", "minimal", "manual"];
  if (!skillsMode) skillsMode = "smart";
  if (!SKILLS_MODES.includes(skillsMode)) {
    console.error(`agent-daemon init: unknown --skills-mode '${skillsMode}'. Valid: ${SKILLS_MODES.join(", ")}`);
    return 1;
  }
  const target = path.join(cwd, ".agent-daemon", "memory");
  const templatesDir = path.join(PROJECT_ROOT, "memory-templates");

  // Resolve the install profile. `--plan` implies dry-run-with-plan-output.
  let resolved;
  try {
    resolved = await resolveProfile(profile);
  } catch (err) {
    const { names, default: def } = await listProfiles();
    console.error(`agent-daemon init: ${err.message}`);
    console.error(`Available profiles: ${names.join(", ")} (default: ${def})`);
    return 1;
  }
  if (plan) dryRun = true;
  console.log(`agent-daemon init — profile: ${resolved.name}`);
  console.log(`  ${resolved.description}\n`);

  // Phase 1: Audit existing agent files
  const AGENT_FILES = [
    { path: ".claude/",               label: "Claude Code project config" },
    { path: ".claude/skills/",        label: "Project-local skills" },
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
    actions.push(`+ session-logs/                (new — gitignored local journal directory)`);
  }

  // Check if AGENTS.md needs to be created
  const agentsMdPath = path.join(cwd, "AGENTS.md");
  let agentsMdExists = false;
  try {
    await fs.access(agentsMdPath);
    agentsMdExists = true;
  } catch { /* not present */ }
  if (!agentsMdExists) {
    actions.push("+ AGENTS.md (multi-agent orchestration guide for Claude)");
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

  // Check if hooks need installing in ~/.claude/settings.json
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const globalSettingsPath = path.join(home, ".claude", "settings.json");
  const claudeJsonPath = path.join(home, ".claude.json");

  // Detect QMD on PATH so we can offer to register it as an MCP server
  // and create a project collection. Best-effort — failure is non-fatal.
  // Skip the detection entirely if the profile disables the QMD feature.
  const qmdOnPath = resolved.features.qmd === false ? false : await new Promise(resolve => {
    exec("qmd --version", (err) => resolve(!err));
  });
  let qmdNeedsMcpRegister = false;
  let qmdCollectionMissing = false;
  let qmdProjName = "";
  if (qmdOnPath) {
    qmdProjName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "project";
    try {
      const cfg = JSON.parse(await fs.readFile(claudeJsonPath, "utf8"));
      const userServers = (cfg.mcpServers || {});
      const projServers = ((cfg.projects || {})[cwd] || {}).mcpServers || {};
      qmdNeedsMcpRegister = !userServers.qmd && !projServers.qmd;
    } catch {
      qmdNeedsMcpRegister = true;
    }
    qmdCollectionMissing = await new Promise(resolve => {
      exec("qmd collection list", (err, stdout) => {
        if (err) return resolve(false);
        resolve(!stdout.includes(`${qmdProjName} (qmd://`));
      });
    });
  }
  let existingSettings = {};
  try {
    existingSettings = JSON.parse(await fs.readFile(globalSettingsPath, "utf8"));
  } catch { /* no settings.json yet */ }
  const existingHooksMap = existingSettings.hooks || {};

  // Determine which profile-specified hooks are missing from the user's settings.
  function hookAlreadyPresent(event, command) {
    return (existingHooksMap[event] || []).some(h =>
      (h.hooks || []).some(hh => hh.command === command),
    );
  }
  const hooksToAdd = resolved.hooks.filter(h => !hookAlreadyPresent(h.event, h.command));
  if (hooksToAdd.length > 0) {
    const summary = hooksToAdd.map(h => `${h.event}/${h.id}`).join(", ");
    actions.push(`+ ${hooksToAdd.length} hook(s) in ~/.claude/settings.json (${summary})`);
  }

  // Resolve which skills to install — modes:
  //   manual  → profile manifest only (legacy behaviour)
  //   minimal → stack-skill-map.json `always` block only
  //   smart   → stack-detect + map (default; project-local install enabled)
  //   all     → every skill discoverable by buildSkillIndex
  const skillsDst         = path.join(home, ".claude", "skills");        // global
  const skillsDstProject  = path.join(cwd,  ".claude", "skills");        // project-local
  const skillsSrc         = path.join(PROJECT_ROOT, "skills");
  const stackMapPath      = path.join(PROJECT_ROOT, "runtime", "profiles", "stack-skill-map.json");

  let globalSkillsToInstall  = [];
  let projectSkillsToInstall = [];
  let detectedStacks = new Set();

  if (skillsMode === "manual") {
    globalSkillsToInstall  = resolved.skills;
    projectSkillsToInstall = [];
  } else if (skillsMode === "all") {
    const idx = await buildSkillIndex(skillsSrc);
    globalSkillsToInstall  = [...idx.keys()].sort();
    projectSkillsToInstall = [];
  } else {
    // smart or minimal — both need the map
    const map = await loadStackSkillMap(stackMapPath);
    if (skillsMode === "minimal") {
      globalSkillsToInstall  = [...(map.always || [])];
      projectSkillsToInstall = [];
    } else {
      // smart: detect stacks + resolve
      const detection = await detectStack(cwd);
      detectedStacks  = detection.stacks;
      const resolvedSkills = resolveSkillsForStacks(detectedStacks, map);
      globalSkillsToInstall  = resolvedSkills.global;
      projectSkillsToInstall = resolvedSkills.project;
      if (detectedStacks.size > 0) {
        console.log(`  Detected stacks: ${formatStacks(detectedStacks)}`);
      } else {
        console.log("  Detected stacks: (none — falling back to always-block)");
      }
    }
  }

  // Count missing for the plan output (global + project lanes separately)
  let missingGlobal = 0, missingProject = 0;
  for (const skill of globalSkillsToInstall) {
    try { await fs.access(path.join(skillsDst, skill)); } catch { missingGlobal++; }
  }
  for (const skill of projectSkillsToInstall) {
    try { await fs.access(path.join(skillsDstProject, skill)); } catch { missingProject++; }
  }
  if (missingGlobal > 0) {
    actions.push(`+ ${missingGlobal} skill(s) to ~/.claude/skills/ (mode: ${skillsMode})`);
  }
  if (missingProject > 0) {
    actions.push(`+ ${missingProject} skill(s) to <project>/.claude/skills/ (project-local)`);
  }

  if (qmdOnPath) {
    if (qmdNeedsMcpRegister) actions.push("+ QMD MCP server registration (~/.claude.json, user scope)");
    if (qmdCollectionMissing) actions.push(`+ QMD collection '${qmdProjName}' for this project + initial embed (background)`);
  }

  if (actions.length === 0) {
    console.log("\n  Nothing to do — agent-daemon is fully initialized in this project.");
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

  // Copy AGENTS.md if not present
  if (!agentsMdExists) {
    const agentsTmpl = path.join(PROJECT_ROOT, "templates", "AGENTS.md.template");
    try {
      await fs.copyFile(agentsTmpl, agentsMdPath);
      console.log("  ✓ Created AGENTS.md (multi-agent guide for Claude)");
    } catch {
      // template missing — skip silently
    }
  }

  // Install skills to BOTH ~/.claude/skills/ (global) AND <cwd>/.claude/skills/
  // (project-local). Idempotent — skips if dest is up-to-date with source.
  //
  // Idempotency rules:
  //   - dest missing       → copy, log `✓ installed`
  //   - source newer       → overwrite, log `↻ updated`
  //   - same mtime/size    → skip silently
  //   - dest user-edited   → preserve, log `⚠ skipped (locally modified)`
  //     detection: presence of <!-- agent-daemon:managed --> marker line in
  //     the source's SKILL.md but not in dest = user removed our marker =
  //     they took ownership. We don't currently write that marker, so all
  //     non-managed copies fall through to mtime compare.
  let skillIndex;
  try { skillIndex = await buildSkillIndex(skillsSrc); } catch { skillIndex = new Map(); }

  async function installSkillLane(skillNames, destRoot, laneLabel) {
    let installed = 0, updated = 0, skipped = 0, missing = 0;
    try {
      await fs.mkdir(destRoot, { recursive: true });
    } catch { return { installed, updated, skipped, missing }; }

    for (const skill of skillNames) {
      const src = skillIndex.get(skill);
      if (!src) { missing++; continue; }
      const dst = path.join(destRoot, skill);
      let destExists = false;
      try { await fs.access(dst); destExists = true; } catch { /* not installed */ }

      if (!destExists) {
        try { await fs.cp(src, dst, { recursive: true }); installed++; }
        catch { /* copy failed — skip silently */ }
        continue;
      }

      // dest exists — compare mtime of SKILL.md to decide update vs skip
      try {
        const [srcStat, dstStat] = await Promise.all([
          fs.stat(path.join(src, "SKILL.md")),
          fs.stat(path.join(dst, "SKILL.md"))
        ]);
        if (srcStat.mtimeMs > dstStat.mtimeMs + 1000) {  // 1s tolerance for fs precision
          try {
            await fs.rm(dst, { recursive: true, force: true });
            await fs.cp(src, dst, { recursive: true });
            updated++;
          } catch { /* update failed — skip */ }
        } else {
          skipped++;
        }
      } catch {
        // stat failed — leave as-is
        skipped++;
      }
    }
    return { installed, updated, skipped, missing };
  }

  // Global lane
  if (globalSkillsToInstall.length > 0) {
    const r = await installSkillLane(globalSkillsToInstall, skillsDst, "global");
    if (r.installed > 0) console.log(`  ✓ Installed ${r.installed} skill(s) to ~/.claude/skills/`);
    if (r.updated   > 0) console.log(`  ↻ Updated ${r.updated} skill(s) in ~/.claude/skills/ (source was newer)`);
    if (r.missing   > 0 && verbose) console.log(`  · ${r.missing} skill(s) listed in map but not found in repo (skipped)`);
  }

  // Project-local lane (only in smart mode, and only if any project skills)
  if (projectSkillsToInstall.length > 0) {
    const r = await installSkillLane(projectSkillsToInstall, skillsDstProject, "project");
    if (r.installed > 0) console.log(`  ✓ Installed ${r.installed} skill(s) to <project>/.claude/skills/`);
    if (r.updated   > 0) console.log(`  ↻ Updated ${r.updated} skill(s) in <project>/.claude/skills/`);
    if (r.installed > 0 || r.updated > 0) {
      // Also drop a small README so the folder is self-documenting
      const readme = path.join(skillsDstProject, "README.md");
      try { await fs.access(readme); } catch {
        try {
          await fs.writeFile(readme,
            "# Project-local skills\n\nInstalled by `ad init --skills-mode smart` based on detected project stack.\nClaude Code prefers these over the same-named global skill in `~/.claude/skills/`.\n\nRe-run `ad init` to update; `ad uninstall` removes the daemon-managed entries.\n",
            "utf8"
          );
        } catch { /* non-fatal */ }
      }
    }
  }

  // Install profile-specified hooks in ~/.claude/settings.json (merge — preserve existing settings)
  if (hooksToAdd.length > 0) {
    try {
      const hooks = existingSettings.hooks || {};
      for (const h of hooksToAdd) {
        const arr = hooks[h.event] || [];
        arr.push({
          matcher: h.matcher,
          hooks: [{ type: "command", command: h.command, timeout: h.timeout }],
        });
        hooks[h.event] = arr;
      }
      existingSettings.hooks = hooks;

      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      await fs.writeFile(globalSettingsPath, JSON.stringify(existingSettings, null, 2), "utf8");
      console.log(`  ✓ Added ${hooksToAdd.length} hook(s) to ~/.claude/settings.json`);
      for (const h of hooksToAdd) console.log(`      ${h.event} ← ${h.id}`);
    } catch (err) {
      console.error(`  ⚠ Could not install hooks: ${err.message}`);
    }
  }

  // -- Deeper ~/.claude/ integration (WS-3) ---------------------------
  // Three pieces, all idempotent and additive:
  //   1. ~/.claude/commands/  — copy our shipped slash commands (e.g. /evolve)
  //   2. ~/.claude/CLAUDE.md  — append managed block pointing at daemon docs
  // User's existing content is never touched outside the marker block.

  // 1. Global slash commands
  try {
    const cmdSrcDir = path.join(PROJECT_ROOT, "commands");
    const cmdDstDir = path.join(home, ".claude", "commands");
    let entries;
    try { entries = await fs.readdir(cmdSrcDir, { withFileTypes: true }); }
    catch { entries = []; }
    if (entries.length > 0) {
      await fs.mkdir(cmdDstDir, { recursive: true });
      let copied = 0, updated = 0;
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const src = path.join(cmdSrcDir, e.name);
        const dst = path.join(cmdDstDir, e.name);
        const srcTxt = await fs.readFile(src, "utf8").catch(() => null);
        if (!srcTxt) continue;
        const dstTxt = await fs.readFile(dst, "utf8").catch(() => null);
        if (dstTxt === null)      { await fs.writeFile(dst, srcTxt, "utf8"); copied++; }
        else if (dstTxt !== srcTxt) { await fs.writeFile(dst, srcTxt, "utf8"); updated++; }
      }
      if (copied  > 0) console.log(`  ✓ Installed ${copied} slash command(s) to ~/.claude/commands/`);
      if (updated > 0) console.log(`  ↻ Updated ${updated} slash command(s) in ~/.claude/commands/`);
    }
  } catch (err) {
    console.error(`  ⚠ Could not install global slash commands: ${err.message}`);
  }

  // 2. Global ~/.claude/CLAUDE.md managed block
  try {
    const globalClaudeMd = path.join(home, ".claude", "CLAUDE.md");
    let existing = "";
    try { existing = await fs.readFile(globalClaudeMd, "utf8"); } catch { /* will create */ }
    if (!existing.includes(MANAGED_START)) {
      const block = [
        "",
        MANAGED_START,
        "## agent-daemon (global)",
        "",
        "This machine has [agent-daemon](https://github.com/Pankaj-mobiux/Agent-Daemon) installed — a self-improving runtime for Claude Code.",
        "",
        "- **Global skills:** `~/.claude/skills/` — installed by `ad init` based on each project's detected stack.",
        "- **Global commands:** `~/.claude/commands/` — slash commands like `/evolve`.",
        "- **`skill-author` skill (global):** auto-triggers when you say *\"create a skill\"*, *\"is se skill banao\"*, *\"har baar yaad rakhna\"*. Handles global-vs-project scoping AND cross-session dedup — always check it for overlap before writing a new skill.",
        "- **Session close:** say *\"bye\"*, *\"session khatam\"*, *\"aaj ka kaam ho gaya\"*, *\"done for today\"* — the `session-close` skill emits the daemon digest, updates the session log, writes a handoff. No API key needed.",
        "- **GEPA evolve (no API):** in any active Claude Code session, say *\"evolve skill <name>\"* — the `gepa-evolve-inline` skill does the reflection in your current context (no headless spawn).",
        "",
        "Per-project memory lives in `<project>/.agent-daemon/memory/`. Per-project agent-daemon config blocks live in each project's `CLAUDE.md` between the same `<!-- agent-daemon:start -->` / `<!-- agent-daemon:end -->` markers.",
        "",
        "Manage:",
        "",
        "```sh",
        "ad doctor          # verify install",
        "ad status          # show queued GEPA proposals",
        "ad review          # accept/reject proposals",
        "```",
        MANAGED_END,
        ""
      ].join("\n");
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      await fs.appendFile(globalClaudeMd, block, "utf8");
      console.log(`  ✓ Added agent-daemon section to ~/.claude/CLAUDE.md (global)`);
    }
  } catch (err) {
    console.error(`  ⚠ Could not update global ~/.claude/CLAUDE.md: ${err.message}`);
  }

  // QMD auto-setup (idempotent): register MCP server in user scope of
  // ~/.claude.json and create a per-project collection. Failures are non-fatal.
  if (qmdOnPath) {
    if (qmdNeedsMcpRegister) {
      try {
        let cfg = {};
        try { cfg = JSON.parse(await fs.readFile(claudeJsonPath, "utf8")); } catch {}
        cfg.mcpServers = cfg.mcpServers || {};
        if (!cfg.mcpServers.qmd) {
          cfg.mcpServers.qmd = { type: "stdio", command: "qmd", args: ["mcp"], env: {} };
          await fs.writeFile(claudeJsonPath, JSON.stringify(cfg, null, 2), "utf8");
          console.log("  ✓ Registered QMD MCP server in ~/.claude.json (user scope)");
        }
      } catch (err) {
        console.error(`  ⚠ Could not register QMD MCP: ${err.message}`);
      }
    }
    if (qmdCollectionMissing) {
      try {
        await new Promise(resolve => {
          exec(`qmd collection add "${cwd}" --name ${qmdProjName}`, () => resolve());
        });
        console.log(`  ✓ Created QMD collection '${qmdProjName}' for this project`);
        // Background embed — don't block init. User can also run `qmd embed` later.
        exec("qmd embed", () => {});
        console.log("  ✓ Triggered background embed (qmd embed)");
      } catch (err) {
        console.error(`  ⚠ Could not set up QMD collection: ${err.message}`);
      }
    }
  }

  // Add managed section to CLAUDE.md (idempotent)
  if (claudeMdExists && !claudeMdHasSection) {
    const section = [
      "",
      MANAGED_START,
      "## agent-daemon",
      "",
      "This project uses [agent-daemon](https://github.com/Pankaj-mobiux/Agent-Daemon) — a self-improving runtime for AI coding agents with multi-agent orchestration.",
      "",
      "- **Memory:** `.agent-daemon/memory/` — project learnings extracted from each session by the digest pipeline",
      "- **Multi-agent:** `ad tc` to create teams, `ad sp` to spawn workers in isolated git worktrees, `ad ts` for status",
      "- **CLI:** All commands use the `ad` shorthand (e.g. `ad doctor`, `ad init`, `ad tt` for templates)",
      "- **Skills:** 35 auto-triggering skills in `~/.claude/skills/` — code review, debugging, orchestration, etc.",
      "- **Self-improvement:** Session digests extract learnings → SQLite episodic memory → next session starts smarter",
      "",
      "### Bootstrap (run once after `ad init`)",
      "",
      "Tell Claude: **\"bootstrap the daemon memory using the bootstrap-daemon skill\"**.",
      "",
      "Claude will scan `package.json`, key folders, recent commits, and populate `.agent-daemon/memory/*.md` with real project context (stack, conventions, gotchas). Future sessions then start with rich context loaded automatically.",
      "",
      "### Session logs (`session-logs/`)",
      "",
      "Local-only (gitignored). Tracks Claude Code session activity, timeline, decisions, and token usage.",
      "",
      "- One file per session: `YYYY-MM-DD_session-NN.md`",
      "- See `session-logs/README.md` for format",
      "- **Update triggers:**",
      "  - User says \"log tokens\" + pastes `/cost` output → append timestamped entry",
      "  - User says \"close session\" → fill End-of-session block with summary",
      "  - User says \"new session\" → create next file, link previous one",
      "- Claude cannot read token counts directly — only record what user provides",
      "- Each entry: timestamp + action/event, plus optional token figures",
      "",
      "**Session-close workflow (mandatory):** When the user signals end of session (\"end session\", \"close session\", \"session khatam\", \"ending this session\", \"wrapping up\", \"I'm done\", etc. — English or Hinglish), do ALL THREE in the same response, no confirmation needed:",
      "",
      "1. **Update the session log** — fill the \"End of session\" block with closing timestamp, outcome, net deliverables, what works, what's pending, what next session must start with. Rename duplicate headings to satisfy MD024.",
      "2. **Emit the agent-daemon digest block** — wrapped in `<agent-daemon-digest>...</agent-daemon-digest>` with valid JSON inside (per `constitution/ending-protocol.md`). Include learnings tagged with `projectbrief`, `techContext`, `systemPatterns`, `activeContext`, `progress`, `user`, plus durable `lessons`, `files` touched, and a `daemon_verification` field showing which hooks fired.",
      "3. **Create handoff docs** — invoke the `handoff` skill. Write the SAME content to BOTH locations:",
      "   - **Per-project:** `<cwd>/.agent-daemon/handoffs/handoff-<ISO-timestamp>.md` (committable, lives with the code)",
      "   - **Global:** `~/.agent-daemon/handoffs/<project-slug>/handoff-<ISO-timestamp>.md` (your personal cross-project trail — `<project-slug>` is the cwd path with `/`, `\\`, `:`, and spaces replaced by `-`, lowercased)",
      "",
      "   Filename: `handoff-<ISO-timestamp>.md` with colons replaced by hyphens (Windows-safe). Content per the `handoff` skill template — Context / State / Next action / Open questions / Suggested skills / Files touched. References to existing artifacts, not duplicates.",
      "",
      "Short / prep-only sessions still emit all three — they produce signal too.",
      MANAGED_END,
      ""
    ].join("\n");
    await fs.appendFile(claudeMdPath, section, "utf8");
    console.log("  ✓ Added agent-daemon section to CLAUDE.md");
  }

  // Scaffold session-logs/ directory with README + .gitignore entry
  const sessionLogsDir = path.join(cwd, "session-logs");
  try {
    await fs.access(sessionLogsDir);
  } catch {
    await fs.mkdir(sessionLogsDir, { recursive: true });
    const readme = renderSessionLogsReadme();
    await fs.writeFile(path.join(sessionLogsDir, "README.md"), readme, "utf8");
    // Also drop a .gitkeep so the empty dir is preserved if the user wants to track it
    await fs.writeFile(path.join(sessionLogsDir, ".gitignore"), "# Local-only session logs — not committed.\n*.md\n!README.md\n", "utf8");
    console.log("  ✓ Scaffolded session-logs/ (gitignored — local-only)");
  }

  // Scaffold .agent-daemon/handoffs/ — destination for the handoff skill (per-project).
  // Idempotent: skips silently if already present.
  const handoffsDir = path.join(cwd, ".agent-daemon", "handoffs");
  try {
    await fs.access(handoffsDir);
  } catch {
    await fs.mkdir(handoffsDir, { recursive: true });
    await fs.writeFile(
      path.join(handoffsDir, "README.md"),
      "# Handoffs (per-project)\n\nThe `handoff` skill writes session-end briefs here for the next agent to pick up.\nFilename pattern: `handoff-<ISO-timestamp>.md`.\n\nThese are per-project and committable — keep them in git so the next dev sees the state.\n\nAn identical copy is also written to `~/.agent-daemon/handoffs/<project-slug>/` for your cross-project personal trail.\n",
      "utf8"
    );
    console.log("  ✓ Scaffolded .agent-daemon/handoffs/ (per-project handoff trail)");
  }

  // Scaffold ~/.agent-daemon/handoffs/<project-slug>/ — global handoff trail.
  // Cross-project, your personal record. Indexed by project slug.
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const projectSlug = cwd.replace(/[\\/:\s]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "");
  const globalHandoffsDir = path.join(homeDir, ".agent-daemon", "handoffs", projectSlug);
  try {
    await fs.access(globalHandoffsDir);
  } catch {
    try {
      await fs.mkdir(globalHandoffsDir, { recursive: true });
      // Drop a README at the parent (~/.agent-daemon/handoffs/) only — per-project subdirs are clean
      const globalHandoffsRoot = path.join(homeDir, ".agent-daemon", "handoffs");
      const rootReadme = path.join(globalHandoffsRoot, "README.md");
      try {
        await fs.access(rootReadme);
      } catch {
        await fs.writeFile(
          rootReadme,
          "# Global Handoffs\n\nCross-project handoff trail. Subdirectories are one-per-project, named by lowercased path slug.\nEach handoff is a Markdown file. Same content as the per-project copy at `<project>/.agent-daemon/handoffs/`.\n\nUse this to grep \"what was I doing last week\" across every project at once:\n\n```sh\ngrep -r \"next action\" ~/.agent-daemon/handoffs/ | sort -r | head -10\n```\n",
          "utf8"
        );
      }
      console.log(`  ✓ Scaffolded ~/.agent-daemon/handoffs/${projectSlug}/ (global handoff trail)`);
    } catch (err) {
      // Non-fatal — global is optional. Per-project still works.
      console.error(`  ⚠ Could not create global handoffs dir (${err.message}) — per-project handoffs still work`);
    }
  }

  console.log(`
agent-daemon: initialized.

Next steps:
  ad doctor                              Verify the install
  "bootstrap the daemon memory using the bootstrap-daemon skill"
                                         Tell Claude in your first session — populates the 7 memory
                                         files with real project context (~$0.05–0.10, one-time)

Daily workflow:
  ad watch --verbose --force             Background autopilot (run in a dedicated terminal)
  ad digest-latest --verbose             One-shot manual digest after a session ends

Session logs:
  session-logs/                          Local-only journal (gitignored). Claude updates it on
                                         "log tokens" / "close session" / "new session" triggers.

Memory files contain template placeholders until bootstrapped.
The digest pipeline keeps memory updated automatically after bootstrapping.`);
  return 0;
}

/**
 * Markdown template for session-logs/README.md.
 * Documents the file-naming convention, entry format, and close-workflow.
 */
function renderSessionLogsReadme() {
  return [
    "# Session logs",
    "",
    "Local-only working journal of Claude Code sessions for this project.",
    "Tracks timeline, decisions, token usage, deliverables. **Gitignored** — never committed.",
    "",
    "## File naming",
    "",
    "One file per session: `YYYY-MM-DD_session-NN.md` (e.g. `2026-05-12_session-01.md`).",
    "Incrementing `NN` within a day. Number resets per day.",
    "",
    "## Entry format (example)",
    "",
    "```markdown",
    "# 2026-05-12 — Session 03",
    "",
    "**Started:** 2026-05-12 14:32 IST",
    "**Goal:** Wire SSE streaming for /api/chat",
    "",
    "## Timeline",
    "",
    "- 14:32 — Started by reading `src/app/api/chat/route.ts`",
    "- 14:48 — User said \"log tokens\" → cumulative: 12K input / 4K output (cost $0.18)",
    "- 15:10 — Implemented streaming with `ReadableStream`; lint passes",
    "- 15:24 — Wrote 3 tests, all green",
    "",
    "## Decisions",
    "",
    "- Chose `ReadableStream` over `eventsource-parser` (one less dep)",
    "- Kept JSON fallback for clients without SSE support",
    "",
    "## Files touched",
    "",
    "- `src/app/api/chat/route.ts` (modified)",
    "- `src/app/api/chat/route.test.ts` (new)",
    "",
    "## End of session",
    "",
    "**Closed:** 2026-05-12 15:35 IST",
    "**Outcome:** SSE streaming shipped end-to-end on `feat/chat-page`",
    "**Net deliverables:** 1 feature, 3 tests, 0 reverts",
    "**What works:** SSE flushes incrementally, tests cover happy + error paths",
    "**Pending:** Wire frontend consumer in next session",
    "**Next session must start with:** Read `src/components/chat/ChatWindow.tsx` and switch from JSON fetch to SSE consumer",
    "",
    "## Tokens (final)",
    "",
    "- Input: 18,420",
    "- Output: 6,210",
    "- Cost: $0.27",
    "",
    "<!-- Linked digest block (also emitted by Claude at session close) -->",
    "",
    "```",
    "<agent-daemon-digest>",
    "  ...",
    "</agent-daemon-digest>",
    "```",
    "```",
    "",
    "## Update triggers (what Claude listens for)",
    "",
    "- **\"log tokens\"** + `/cost` output paste → append a timestamped entry to **Tokens** section",
    "- **\"close session\" / \"end session\" / \"session khatam\"** → fill the **End of session** block + emit agent-daemon digest block (mandatory, in the same response)",
    "- **\"new session\"** → create the next-numbered file; link previous one at the top",
    "",
    "Claude cannot read token counts directly — only records what the user pastes.",
    "",
    "## Why local-only",
    "",
    "Session logs contain in-progress thinking, half-formed ideas, and raw token numbers — useful for *you* but noisy in shared git history. Durable learnings get distilled into `.agent-daemon/memory/*.md` (which IS committed) via the digest pipeline.",
    ""
  ].join("\n");
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
    const matchesHook = (h) => { const s = JSON.stringify(h).toLowerCase(); return s.includes("agent-daemon") || s.includes("agent daemon") || s.includes("ad session-start") || s.includes("ad digest"); };
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

/**
 * `ad digest-latest` — find the most recent transcript for the current project
 * (or any project via --cwd) under ~/.claude/projects and digest it.
 *
 * The Claude Code VS Code extension doesn't fire SessionEnd hooks reliably, so
 * this gives users a one-shot manual digest without typing the transcript path.
 */
async function cmdDigestLatest(opts) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const projectsDir = path.join(home, ".claude", "projects");
  const targetCwd = path.resolve(opts.cwd || process.cwd());

  // Encoded folder name: drive letter lowercased, ":" and "\" and " " all become "-".
  // (Lossy — multiple originals can map to the same encoded form. We pick the
  // newest matching folder.)
  const encoded = encodePath(targetCwd);

  let entries;
  try {
    entries = await fs.readdir(projectsDir);
  } catch (err) {
    console.error(`agent-daemon: cannot read ${projectsDir}: ${err.message}`);
    return 1;
  }

  const matches = entries.filter(name => name.toLowerCase() === encoded.toLowerCase());
  if (matches.length === 0) {
    console.error(`agent-daemon: no transcripts found for ${targetCwd}`);
    console.error(`  searched: ${path.join(projectsDir, encoded)}`);
    return 1;
  }

  // Find the newest .jsonl under all matched folders.
  let newest = null;
  for (const m of matches) {
    const folder = path.join(projectsDir, m);
    let files;
    try { files = await fs.readdir(folder); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(folder, f);
      let stat;
      try { stat = await fs.stat(fp); } catch { continue; }
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { path: fp, mtimeMs: stat.mtimeMs };
      }
    }
  }

  if (!newest) {
    console.error(`agent-daemon: no .jsonl files found under ${path.join(projectsDir, encoded)}`);
    return 1;
  }

  const ageMin = ((Date.now() - newest.mtimeMs) / 60000).toFixed(1);
  console.error(`agent-daemon: digesting ${path.basename(newest.path)} (modified ${ageMin}min ago)`);

  return runDigest({
    ...opts,
    transcript: newest.path,
    cwd: targetCwd,
    force: true  // digest-latest implies user wants it; pass --dry-run to preview
  });
}

/**
 * Encode a project path the way Claude Code names transcript folders.
 * Drive letter is lowercased, ":" / "\" / "/" / " " all become "-".
 */
function encodePath(p) {
  // Drive letter lowercased, drop the colon — "D:" becomes "d-" (the colon's
  // slot also collapses to "-" via the next pass).
  return p
    .replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + "-")
    .replace(/[\s\\/]/g, "-");  // each separator becomes its own "-", do not collapse
}

async function cmdWatch(opts) {
  return runWatcher({
    projectRoot: opts.projectRoot,
    verbose: opts.verbose,
    onceOnExisting: opts.onceOnExisting || false,
    force: opts.force || false,
    fallbackToLlm: opts.fallbackToLlm || false
  });
}

async function cmdTeam(subcommand, opts) {
  const { createTeam, loadTeam, listTeams, addTask, formatTeamStatus, listTasks, retryTask } = await import("./orchestration/team.mjs");
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

    case "retry": {
      if (!opts.team) {
        console.error("agent-daemon team retry: --team is required");
        return 1;
      }
      if (!opts.task) {
        console.error("agent-daemon team retry: --task is required (the task ID, e.g. task-abc12345)");
        return 1;
      }
      try {
        const result = await retryTask(opts.team, opts.task);
        if (result.reset) {
          console.log(`Task ${opts.task} reset to "${result.task.status}" (attempt ${result.task.attempts + 1}/${result.task.max_retries + 1})`);
          if (result.task.last_error) {
            console.log(`  Previous error: ${result.task.last_error}`);
          }
        } else {
          console.error(`Cannot retry task ${opts.task}: ${result.reason}`);
          return 1;
        }
      } catch (err) {
        console.error(`agent-daemon team retry: ${err.message}`);
        return 1;
      }
      return 0;
    }

    default:
      console.error(`agent-daemon team: unknown subcommand "${subcommand}". Use: create, status, list, list-templates, inbox, cleanup, delete, retry`);
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

  const { loadTeam, listTasks } = await import("./orchestration/team.mjs");
  const { spawnAgent, getActiveAgentCount } = await import("./orchestration/spawn.mjs");
  const { detectConflicts, formatConflicts } = await import("./orchestration/conflict-detect.mjs");

  let team;
  try {
    team = await loadTeam(opts.team);
  } catch (err) {
    console.error(`agent-daemon spawn: cannot load team ${opts.team}: ${err.message}`);
    return 1;
  }

  const roleDef = team.roles.find(r => r.name === opts.role);
  const leader = team.roles.find(r => r.is_leader);

  // WS-7c — File-conflict pre-detection. Compare the new task's file paths
  // against active tasks (pending / in_progress / retrying). TTY → prompt,
  // non-TTY → stderr warn and proceed.
  try {
    const existingTasks = await listTasks(opts.team);
    const activeTasks = existingTasks.filter(t =>
      ["pending", "in_progress", "retrying"].includes(t.status)
    );
    const newTaskShim = {
      id: `new:${opts.role}`,
      title: opts.task,
      description: opts.task,
      instructions: roleDef?.instructions || ""
    };
    const reports = detectConflicts([...activeTasks, newTaskShim]);
    const involvingNew = reports.filter(r => r.taskA === newTaskShim.id || r.taskB === newTaskShim.id);
    if (involvingNew.length > 0) {
      console.error("\n" + formatConflicts(involvingNew));
      if (process.stdout.isTTY) {
        // Hard prompt only on TTY. Default = abort.
        process.stderr.write("\nProceed anyway? (y/N): ");
        const answer = await new Promise(resolve => {
          process.stdin.once("data", buf => resolve(String(buf).trim().toLowerCase()));
        });
        if (answer !== "y" && answer !== "yes") {
          console.error("Aborted by user (file-conflict pre-detection).");
          return 1;
        }
      } else {
        console.error("(Non-TTY — proceeding with warning. Set ad team retry or re-task to fix.)");
      }
    }
  } catch (err) {
    // Best-effort — conflict detection failure must not block spawning
    if (opts.verbose) console.error(`[conflict-detect] skipped: ${err.message}`);
  }

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

  // Expand short aliases → full commands
  const ALIASES = {
    tc: ["team", "create"],
    ts: ["team", "status"],
    tl: ["team", "list"],
    tt: ["team", "list-templates"],
    ti: ["team", "inbox"],
    td: ["team", "delete"],
    tu: ["team", "cleanup"],
    tr: ["team", "retry"],
    sp: ["spawn"]
  };

  let expanded = argv;
  if (ALIASES[argv[0]]) {
    expanded = [...ALIASES[argv[0]], ...argv.slice(1)];
  }

  const [command, ...rest] = expanded;

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
        agent:        { type: "string" },
        profile:      { type: "string" },
        plan:         { type: "boolean" },
        "skills-mode": { type: "string" },
        "fallback-to-llm": { type: "boolean" },
        force:        { type: "boolean" },
        "once-on-existing": { type: "boolean" },
        "list-candidates": { type: "boolean" },
        "export-traces": { type: "boolean" },
        json:         { type: "boolean" }
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
    fallbackToLlm: parsed.values["fallback-to-llm"] || process.env.AGENT_DAEMON_FALLBACK_LLM === "1",
    force:       parsed.values.force          || false,
    onceOnExisting: parsed.values["once-on-existing"] || false,
    projectRoot: PROJECT_ROOT
  };

  switch (command) {
    case "session-start":  return runSessionStart(opts);
    case "digest":         return runDigest(opts);
    case "digest-latest":  return cmdDigestLatest(opts);
    case "evolve":         return cmdEvolve({
      ...opts,
      skillName:       parsed.positionals?.[0],
      listCandidates:  parsed.values["list-candidates"] || false,
      exportTraces:    parsed.values["export-traces"]   || false,
      json:            parsed.values.json               || false
    });
    case "checkpoint":     return cmdCheckpoint(opts);
    case "init":           return cmdInit({ ...opts, profile: parsed.values.profile, plan: parsed.values.plan, skillsMode: parsed.values["skills-mode"] });
    case "status":         return cmdStatus(opts);
    case "review":         return cmdReview(opts);
    case "watch":          return cmdWatch(opts);
    case "query-retrieve": return cmdQueryRetrieve(opts);
    case "doctor":         return cmdDoctor({ ...opts, tokens: parsed.values.tokens, limit: parsed.values.limit, model: parsed.values.model });
    case "team":           return cmdTeam(parsed.positionals?.[0], { ...opts, template: parsed.values.template, task: parsed.values.task, team: parsed.values.team, agent: parsed.values.agent, model: parsed.values.model });
    case "spawn":          return cmdSpawn({ ...opts, team: parsed.values.team, role: parsed.values.role, task: parsed.values.task, model: parsed.values.model });
    case "hook":           return cmdHook(parsed.positionals?.[0]);
    default:
      console.error(`agent-daemon: unknown command "${command}"`);
      console.error(HELP);
      return 2;
  }
}

async function cmdEvolve(opts) {
  // Mode 1: --list-candidates — emit skills needing evolution. No LLM, no auth needed.
  // Used by the gepa-evolve-inline skill to pick a target.
  if (opts.listCandidates) {
    const { findSkillsNeedingEvolution } = await import("./memory/episodic.mjs");
    const candidates = await findSkillsNeedingEvolution({ minFailures: 3, dayWindow: 30 });
    if (opts.json) {
      console.log(JSON.stringify({ candidates }, null, 2));
    } else {
      if (candidates.length === 0) {
        console.log("agent-daemon evolve: no candidates (no skills with ≥3 failures in the last 30 days)");
      } else {
        console.log(`agent-daemon evolve: ${candidates.length} candidate(s) needing evolution:`);
        for (const c of candidates) {
          console.log(`  - ${c.skill_name}  (${c.failure_count} failure(s) in 30d)`);
        }
        console.log("\nTo evolve one inline (no API key needed), say in any Claude Code session:");
        console.log("  evolve skill <name>");
      }
    }
    return 0;
  }

  // Mode 2: --export-traces — write JSONL of executions for one skill.
  // The active Claude session reads this and does reflection inline.
  if (opts.exportTraces) {
    if (!opts.skillName) {
      console.error("agent-daemon evolve --export-traces: requires a skill name. Usage: agent-daemon evolve <skill-name> --export-traces");
      return 1;
    }
    const { exportSkillTraces } = await import("./digest/gepa/export-traces.mjs");
    const result = await exportSkillTraces({
      skillName: opts.skillName,
      cwd: opts.cwd,
      total: 50,
      verbose: true
    });
    if (!result.ok) {
      console.error(`agent-daemon evolve --export-traces: ${result.error}`);
      return 1;
    }
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, path: result.path, count: result.count }));
    } else {
      console.log(`agent-daemon evolve: exported ${result.count} traces → ${result.path}`);
      console.log("\nNow in any Claude Code session, say 'evolve skill <name>' and the");
      console.log("`gepa-evolve-inline` skill will read these traces and propose changes.");
    }
    return 0;
  }

  // Mode 3 (default): run the full GEPA pipeline (requires headless claude auth or ANTHROPIC_API_KEY).
  if (!opts.skillName) {
    console.error("agent-daemon evolve: requires a skill name. Usage: agent-daemon evolve <skill-name>");
    console.error("  --list-candidates    show which skills need evolution (no auth needed)");
    console.error("  --export-traces      export skill traces for inline evolution (no auth needed)");
    return 1;
  }
  const skillsSrc = path.join(opts.projectRoot, "skills");
  const skillDir = await resolveSkillSource(skillsSrc, opts.skillName);
  if (!skillDir) {
    console.error(`agent-daemon evolve: no such skill "${opts.skillName}" under ${skillsSrc}`);
    return 1;
  }
  const skillPath = path.join(skillDir, "SKILL.md");

  const result = await evolveSkill({
    skillPath,
    skillName: opts.skillName,
    dryRun: opts.dryRun,
    verbose: opts.verbose,
    proposedDir: path.join(opts.cwd, ".agent-daemon", "proposed")
  });

  // Auth-fallback messaging: if GEPA failed because of missing auth, surface
  // the no-API path so the user isn't stuck.
  if (result.status === "error" && /auth|api[-_ ]?key|anthropic|claude.*not.*logged|spawn.*EOF|ENOENT/i.test(result.reason || "")) {
    console.error(`\nagent-daemon evolve: GEPA stage failed — likely missing auth.`);
    console.error(`  ${result.reason}`);
    console.error(`\nOptions:`);
    console.error(`  1. Run \`claude auth login\` (preferred — uses Claude Code's existing OAuth)`);
    console.error(`  2. Set ANTHROPIC_API_KEY environment variable`);
    console.error(`  3. **No-API path** — in your active Claude Code session, say:`);
    console.error(`        "evolve skill ${opts.skillName}"`);
    console.error(`     The \`gepa-evolve-inline\` skill will export traces and reflect inline.`);
    return 0;  // not a hard error — guidance given
  }

  console.error(`\nagent-daemon evolve: ${result.status} — ${result.reason}`);
  console.error(`  cost: $${result.totalCostUsd.toFixed(4)}`);
  if (result.proposalPath) {
    console.error(`  proposal: ${result.proposalPath}`);
    console.error(`  review with: agent-daemon review`);
  }
  return result.status === "error" ? 1 : 0;
}

async function cmdHook(name) {
  switch (name) {
    case "bash-pre":            return (await import("./hooks/bash-pre.mjs")).bashPre();
    case "bash-post":           return (await import("./hooks/bash-post.mjs")).bashPost();
    case "edit-post":           return (await import("./hooks/edit-post.mjs")).editPost();
    case "mcp-pre":             return (await import("./hooks/mcp-audit.mjs")).mcpAudit();
    case "user-prompt-extract": return (await import("./hooks/user-prompt-extract.mjs")).userPromptExtract();
    default:
      console.error(`agent-daemon hook: unknown handler "${name}". Known: bash-pre, bash-post, edit-post, mcp-pre, user-prompt-extract`);
      return 2;
  }
}

main(process.argv.slice(2)).then(code => process.exit(code || 0)).catch(err => {
  console.error(`agent-daemon: fatal: ${err.stack || err.message}`);
  process.exit(1);
});
