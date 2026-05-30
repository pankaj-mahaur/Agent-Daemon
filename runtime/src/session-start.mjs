// Session-start command.
// Reads constitution + project memory and emits a JSON object Claude Code's
// SessionStart hook injects as additional context.
//
// Output schema (when --output-json):
//   { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<markdown string>" } }
//
// Total length is capped at 9KB to stay under Claude Code's 10K hook output cap.

import fs from "node:fs/promises";
import path from "node:path";
import { listRecentLearnings, projectSlug } from "./memory/episodic.mjs";
import { drainJournal } from "./hooks/journal-drain.mjs";

const MAX_OUTPUT_BYTES = 9000;

/**
 * @param {{
 *   cwd: string,
 *   outputJson?: boolean,
 *   verbose?: boolean,
 *   projectRoot: string,
 * }} opts
 */
export async function runSessionStart(opts) {
  const sections = [];

  // -1. Rotate activeContext.md if it has grown too large AND is older than
  //     a week. activeContext.md gets read raw into the 9KB SessionStart
  //     injection; unbounded growth crowds out constitution + learnings.
  //     See rotateActiveContextIfNeeded for thresholds. Best-effort.
  try {
    await rotateActiveContextIfNeeded(opts.cwd, opts.verbose);
  } catch { /* fail-safe — never block session-start */ }

  // 0. Drain the learning-journal (continuous-extraction buffer from
  //    UserPromptSubmit hooks in prior sessions) into memory + episodic
  //    SQLite. Idempotent + fail-safe — never blocks session start.
  //    Surface a brief note when learnings were drained so the next session
  //    knows what landed.
  try {
    const drain = await drainJournal({
      cwd: opts.cwd,
      projectRoot: opts.projectRoot,
      verbose: opts.verbose
    });
    if (drain.ok && drain.drained > 0 && drain.applied) {
      const a = drain.applied;
      const parts = [];
      if (a.memoryProjectAppended) parts.push(`${a.memoryProjectAppended} → activeContext.md`);
      if (a.memoryGlobalAppended)  parts.push(`${a.memoryGlobalAppended} → ~/.agent-daemon/user.md`);
      if (a.proposalsQueued)       parts.push(`${a.proposalsQueued} queued for review`);
      const detail = parts.length > 0 ? parts.join(", ") : "episodic only";
      sections.push([
        `<!-- continuous-extraction drain -->`,
        `## Carried over from prior session(s)`,
        ``,
        `${drain.drained} learning(s) captured by UserPromptSubmit hooks were applied: ${detail}.`,
        `Run \`ad status\` to review anything queued.`
      ].join("\n"));
    }
  } catch { /* fail-safe — never block session-start */ }

  // 1. Constitution — always-loaded files (~3KB total).
  //    core.md = our universal rules. karpathy-guidelines.md = behavioral
  //    guardrails distilled from Andrej Karpathy's LLM-coding observations
  //    (vendored from forrestchang/andrej-karpathy-skills, MIT).
  //    safety.md, verification.md, communication.md, ending-protocol.md are
  //    on-demand: the agent loads them via skill triggers or QMD search.
  const constitutionDir = path.join(opts.projectRoot, "constitution");
  const coreText = await tryRead(path.join(constitutionDir, "core.md"));
  if (coreText) {
    sections.push(`<!-- constitution/core.md -->\n${coreText}`);
  }
  const karpathyText = await tryRead(path.join(constitutionDir, "karpathy-guidelines.md"));
  if (karpathyText) {
    sections.push(`<!-- constitution/karpathy-guidelines.md -->\n${karpathyText}`);
  }

  // 2. Memory retrieval — prefer QMD pointer over bulk-loading files.
  //    If QMD (mcp__qmd__search) is available, inject a one-line pointer instead
  //    of loading all memory files. Falls back to bulk-load if QMD isn't installed.
  const qmdAvailable = await detectQmd(opts.cwd);
  if (qmdAvailable) {
    const activeContext = await tryRead(path.join(opts.cwd, ".agent-daemon", "memory", "activeContext.md"));
    if (activeContext) {
      sections.push(`<!-- memory: activeContext.md -->\n### activeContext.md\n\n${activeContext}`);
    }
    sections.push([
      `<!-- memory retrieval (QMD) -->`,
      `## Memory`,
      ``,
      `Memory and past learnings are indexed by QMD. Use \`mcp__qmd__search <query>\` to retrieve relevant context.`,
      `Do not read memory files directly — QMD provides ranked, compressed results at ~10x lower token cost.`
    ].join("\n"));
  } else {
    // Fallback: bulk-load memory files (pre-QMD behavior)
    const userMd = await tryRead(path.join(homeDir(), ".agent-daemon", "user.md"));
    if (userMd) {
      sections.push(`<!-- ~/.agent-daemon/user.md (cross-project user profile) -->\n${userMd}`);
    }

    const memoryLocations = [
      path.join(opts.cwd, ".agent-daemon", "memory"),
      path.join(opts.cwd, ".claude", "memory"),
      path.join(homeDir(), ".claude", "projects", encodeProjectPath(opts.cwd), "memory"),
      path.join(homeDir(), ".agent-daemon", "memory")
    ];

    let foundProjectMemory = false;
    for (const memDir of memoryLocations) {
      const result = await readMemoryDir(memDir);
      if (result) {
        if (result.hasPlaceholders) {
          // Push warning BEFORE memory content so it survives 9KB truncation
          sections.push(`<!-- memory-bootstrap-hint -->\n**⚠ Memory not yet bootstrapped.** Memory files contain unfilled template placeholders (\`{{...}}\`). Say "bootstrap the daemon memory" to populate them with real project context.`);
        }
        sections.push(`<!-- memory: ${memDir} -->\n${result.content}`);
        foundProjectMemory = true;
        break;
      }
    }

  }

  // 3. Graphify knowledge graph pointer — if a graphify-out/graph.json exists
  //    in the project, inject a lightweight pointer so Claude queries the graph
  //    for architecture/relationship questions instead of re-reading the codebase.
  {
    const graphJsonPath = path.join(opts.cwd, "graphify-out", "graph.json");
    try {
      await fs.access(graphJsonPath);
      sections.push([
        `<!-- graphify knowledge graph -->`,
        `## Architecture Graph`,
        ``,
        `A knowledge graph is available at \`graphify-out/graph.json\`. Use \`/graphify query "<question>"\` to traverse it.`,
        `For architecture overview: \`/graphify query "main components" --budget 500\``,
        `God nodes give one-shot architecture understanding without re-reading the codebase.`
      ].join("\n"));
    } catch { /* no graph — skip */ }
  }

  // If .agent-daemon/ doesn't exist in this project, suggest initialization.
  // Inserted early (index 1, right after constitution) so it survives 9KB truncation.
  {
    const projectDaemonDir = path.join(opts.cwd, ".agent-daemon");
    let projectHasDaemon = false;
    try { await fs.access(projectDaemonDir); projectHasDaemon = true; } catch {}
    if (!projectHasDaemon) {
      sections.splice(1, 0, `<!-- agent-daemon-init-hint -->\n**ℹ agent-daemon is installed** but not initialized in this project. Say "initialize the daemon" to set up persistent memory, multi-agent orchestration, and self-improving skills for this codebase.`);
    }
  }

  // 4. Project CLAUDE.md / CONVENTIONS.md (per-project rules supersede constitution)
  //    Note: AD-INSTRUCTIONS.md is NOT loaded here — it is referenced from the
  //    managed CLAUDE.md block, which Claude Code reads natively with a much
  //    larger budget. Loading it here would double-count against the 9KB cap.
  for (const fname of ["CLAUDE.md", "CONVENTIONS.md"]) {
    const text = await tryRead(path.join(opts.cwd, fname));
    if (text) {
      sections.push(`<!-- ${fname} -->\n${text}`);
    }
  }

  // 4b. Cross-agent rules — read from other agents' config dirs if present.
  //     This makes agent-daemon aware of rules set for Cursor, Cline, etc.
  const crossAgentSources = [
    { dir: path.join(opts.cwd, ".cursor", "rules"), label: "Cursor rules", ext: ".mdc" },
    { dir: path.join(opts.cwd, ".cline", "rules"),  label: "Cline rules",  ext: ".md" },
    { dir: path.join(homeDir(), ".claude", "projects", encodeProjectPath(opts.cwd), "memory"), label: "Claude Code auto-memory", ext: ".md" },
    { dir: path.join(homeDir(), ".cursor", "rules"), label: "Global Cursor rules", ext: ".mdc" }
  ];
  for (const source of crossAgentSources) {
    // Skip the readdir/file open work entirely when the directory does not
    // exist. Most projects only set up one or two of these locations.
    try { await fs.access(source.dir); } catch { continue; }
    const block = await readCrossAgentDir(source.dir, source.ext);
    if (block) {
      sections.push(`<!-- ${source.label}: ${source.dir} -->\n${block}`);
    }
  }

  // 4c. Active team context — if this session is part of a multi-agent team,
  //      inject team info, task assignments, and inbox messages.
  try {
    const teamContext = await loadActiveTeamContext();
    if (teamContext) {
      sections.push(`<!-- active team context -->\n${teamContext}`);
    }
  } catch {
    // team context is optional
  }

  // 5. Recent SQLite-backed learnings — top-K most-recent project-scoped + a few global.
  // Timestamps are omitted from output to keep the injected blob byte-stable across
  // sessions (cache-friendly). Learnings are sorted by text for deterministic ordering.
  // Skipped silently if better-sqlite3 isn't installed (graceful degradation).
  try {
    const slug = projectSlug(opts.cwd);
    const recent = await listRecentLearnings({ projectSlug: slug, limit: 5 });
    if (recent && recent.length > 0) {
      const sorted = [...recent].sort((a, b) => a.text.localeCompare(b.text));
      const block = sorted.map(r => {
        return `- **${r.category}** (conf ${r.confidence.toFixed(2)}): ${r.text}`;
      }).join("\n");
      sections.push(`<!-- recent learnings -->\n## Recent learnings\n\n${block}`);
    }
  } catch {
    // SQLite optional — silent skip
  }

  // Preserve dynamic project context ahead of static guidance under the hook
  // cap. A large constitution must not hide active context or learnings.
  const warningSections = sections.filter(s =>
    s.includes("memory-bootstrap-hint") ||
    s.includes("agent-daemon-init-hint") ||
    s.includes("continuous-extraction drain")
  );
  const memorySections = sections.filter(s =>
    s.startsWith("<!-- memory:") ||
    s.startsWith("<!-- memory retrieval (QMD)") ||
    s.startsWith("<!-- ~/.agent-daemon/user.md (cross-project user profile)")
  );
  const recentSections = sections.filter(s => s.includes("<!-- recent learnings -->"));
  const dynamic = new Set([...warningSections, ...memorySections, ...recentSections]);
  const staticSections = sections.filter(s => !dynamic.has(s));
  const combined = renderPrioritizedContext([
    { sections: warningSections, cap: 1100 },
    { sections: memorySections, cap: 4100 },
    { sections: recentSections, cap: 1700 },
    { sections: staticSections, cap: MAX_OUTPUT_BYTES }
  ]);

  if (opts.outputJson) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: combined
      }
    }));
  } else {
    process.stdout.write(combined);
    process.stdout.write("\n");
  }

  if (opts.verbose) {
    process.stderr.write(`agent-daemon: loaded ${sections.length} context sections (${Buffer.byteLength(combined, "utf8")} bytes)\n`);
  }

  return 0;
}

async function tryRead(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readMemoryDir(memDir) {
  try {
    const entries = await fs.readdir(memDir);
    const mdFiles = entries.filter(e => e.endsWith(".md") && !e.endsWith(".template"));
    if (mdFiles.length === 0) return null;

    // MEMORY.md first, then the rest sorted alphabetically for byte-stable output
    const ordered = [
      ...mdFiles.filter(f => /^activeContext\.md$/i.test(f)),
      ...mdFiles.filter(f => /^MEMORY\.md$/i.test(f)),
      ...mdFiles.filter(f => !/^(activeContext|MEMORY)\.md$/i.test(f)).sort()
    ];
    const blocks = [];
    let hasPlaceholders = false;
    for (const f of ordered) {
      const text = await tryRead(path.join(memDir, f));
      if (text) {
        blocks.push(`### ${f}\n\n${text}`);
        if (text.includes("{{")) hasPlaceholders = true;
      }
    }
    return { content: blocks.join("\n\n"), hasPlaceholders };
  } catch {
    return null;
  }
}

async function readCrossAgentDir(dir, ext) {
  try {
    const entries = await fs.readdir(dir);
    const files = entries.filter(e => e.endsWith(ext)).sort();
    if (files.length === 0) return null;
    const blocks = [];
    for (const f of files.slice(0, 5)) {
      const text = await tryRead(path.join(dir, f));
      if (text && text.trim().length > 0) {
        blocks.push(`### ${f}\n\n${text.trim()}`);
      }
    }
    return blocks.length > 0 ? blocks.join("\n\n") : null;
  } catch {
    return null;
  }
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function encodeProjectPath(p) {
  // Claude Code's encoding: replace `/` and `\` and `:` with `-`.
  // Approximate; real algorithm may differ slightly.
  return p.replace(/[\\/:]/g, "-");
}

async function detectQmd(cwd) {
  // Claude Code stores MCP server config in ~/.claude.json (top-level mcpServers
  // for user scope, and projects[<cwd>].mcpServers for local scope). It does NOT
  // live in ~/.claude/settings.json — that file's schema rejects mcpServers.
  // Project-scope .mcp.json is also a valid location.
  const home = homeDir();
  cwd = cwd || process.cwd();

  try {
    const claudeJsonPath = path.join(home, ".claude.json");
    const cfg = JSON.parse(await fs.readFile(claudeJsonPath, "utf8"));
    const userServers = cfg.mcpServers || {};
    if (userServers.qmd || userServers["qmd-search"]) return true;
    const projects = cfg.projects || {};
    const projectEntry = projects[cwd] || {};
    const projServers = projectEntry.mcpServers || {};
    if (projServers.qmd || projServers["qmd-search"]) return true;
  } catch { /* no ~/.claude.json or unparseable */ }

  // .mcp.json (committed project-level MCP config)
  try {
    const projMcp = path.join(cwd, ".mcp.json");
    const cfg = JSON.parse(await fs.readFile(projMcp, "utf8"));
    const servers = cfg.mcpServers || {};
    if (servers.qmd || servers["qmd-search"]) return true;
  } catch { /* no .mcp.json */ }

  return false;
}

async function loadActiveTeamContext() {
  const home = homeDir();
  const teamsDir = path.join(home, ".agent-daemon", "teams");

  let entries;
  try {
    entries = await fs.readdir(teamsDir);
  } catch {
    return null;
  }

  // Find teams that are still active (have non-completed tasks)
  const activeTeams = [];
  for (const e of entries) {
    if (e === "templates") continue;
    const teamJsonPath = path.join(teamsDir, e, "team.json");
    const tasksJsonPath = path.join(teamsDir, e, "tasks.json");
    try {
      const team = JSON.parse(await fs.readFile(teamJsonPath, "utf8"));
      const tasks = JSON.parse(await fs.readFile(tasksJsonPath, "utf8"));
      const hasIncomplete = tasks.some(t => t.status !== "completed");
      if (hasIncomplete || tasks.length === 0) {
        activeTeams.push({ team, tasks });
      }
    } catch {
      // skip
    }
  }

  if (activeTeams.length === 0) return null;

  const lines = [`## Active Teams`, ``];
  for (const { team, tasks } of activeTeams.slice(0, 3)) {
    lines.push(`### ${team.id}${team.template ? ` (${team.template})` : ""}`);
    lines.push(`${team.description}`);
    lines.push(``);

    if (tasks.length > 0) {
      const pending = tasks.filter(t => t.status === "pending").length;
      const running = tasks.filter(t => t.status === "in_progress").length;
      const done = tasks.filter(t => t.status === "completed").length;
      const blocked = tasks.filter(t => t.status === "blocked").length;
      lines.push(`Tasks: ${done} done, ${running} running, ${pending} pending, ${blocked} blocked`);

      // Only expand individual tasks when the incomplete set is small. For
      // bigger teams the summary line + the `team status` hint below are enough.
      const incomplete = pending + running + blocked;
      if (incomplete > 0 && incomplete <= 3) {
        for (const t of tasks.filter(t => t.status !== "completed")) {
          const owner = t.owner ? ` @${t.owner}` : "";
          lines.push(`- [${t.status}] ${t.title}${owner}`);
        }
      }
    }

    lines.push(``);
    lines.push(`Use \`agent-daemon team status --team ${team.id}\` for full details.`);
    lines.push(`Use \`agent-daemon team inbox --team ${team.id}\` to check messages.`);
    lines.push(``);
  }

  return lines.join("\n");
}

function truncateToBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Find a UTF-8-safe break at maxBytes.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function renderPrioritizedContext(groups) {
  const marker = "\n\n<!-- (agent-daemon: context truncated to fit 9KB hook cap) -->";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  let output = "";
  let truncated = false;

  for (const group of groups) {
    const text = group.sections.join("\n\n---\n\n");
    if (!text) continue;
    const separator = output ? "\n\n---\n\n" : "";
    const remaining = MAX_OUTPUT_BYTES - markerBytes - Buffer.byteLength(output + separator, "utf8");
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const groupBudget = Math.min(group.cap, remaining);
    const chunk = truncateToBytes(text, groupBudget);
    output += separator + chunk;
    if (Buffer.byteLength(text, "utf8") > groupBudget) truncated = true;
  }

  return truncated ? output + marker : output;
}

/* ------------------------------------------------------------------ */
/* WS-8 — activeContext.md rotation                                    */
/* ------------------------------------------------------------------ */

const ROTATE_SIZE_THRESHOLD = 32 * 1024;             // 32KB
const ROTATE_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Rotate `<cwd>/.agent-daemon/memory/activeContext.md` if it has both grown
 * past 32KB AND its oldest content is older than 7 days. Both thresholds
 * must trigger together — size alone preserves "high-touch project last
 * week", age alone preserves "low-traffic project with one important note".
 *
 * On trigger: move oldest 50% (by line count) to
 *   `<cwd>/.agent-daemon/archive/activeContext-<ISO-date>.md`
 * Keep newest 50% in place. Idempotent and best-effort — failure to rotate
 * never blocks session-start.
 *
 * @param {string} cwd
 * @param {boolean} [verbose]
 * @returns {Promise<{ rotated: boolean, reason?: string, archive?: string }>}
 */
export async function rotateActiveContextIfNeeded(cwd, verbose = false) {
  if (!cwd) return { rotated: false, reason: "no cwd" };

  const memDir   = path.join(cwd, ".agent-daemon", "memory");
  const filePath = path.join(memDir, "activeContext.md");

  let stat;
  try { stat = await fs.stat(filePath); }
  catch { return { rotated: false, reason: "no activeContext.md" }; }

  if (!stat.isFile()) return { rotated: false, reason: "not a file" };

  const sizeOk = stat.size > ROTATE_SIZE_THRESHOLD;
  const ageOk  = (Date.now() - stat.mtimeMs) > ROTATE_AGE_THRESHOLD_MS;

  if (!sizeOk || !ageOk) {
    return {
      rotated: false,
      reason: `thresholds not met (size=${stat.size}B / ${ROTATE_SIZE_THRESHOLD}B; age=${Math.round((Date.now() - stat.mtimeMs)/86400000)}d / 7d)`
    };
  }

  // Both thresholds hit — split file at midpoint by line count
  let content;
  try { content = await fs.readFile(filePath, "utf8"); }
  catch { return { rotated: false, reason: "read failed" }; }

  const lines = content.split(/\r?\n/);
  if (lines.length < 10) return { rotated: false, reason: "too few lines to split" };

  const mid    = Math.floor(lines.length / 2);
  const oldest = lines.slice(0, mid).join("\n");
  const newest = lines.slice(mid).join("\n");

  const archiveDir  = path.join(cwd, ".agent-daemon", "archive");
  const dateStamp   = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const archivePath = path.join(archiveDir, `activeContext-${dateStamp}.md`);

  try {
    await fs.mkdir(archiveDir, { recursive: true });

    // If archive already exists for today (rotation ran earlier today), append
    let existingArchive = "";
    try { existingArchive = await fs.readFile(archivePath, "utf8"); } catch { /* new */ }
    const merged = existingArchive
      ? existingArchive + "\n\n---\n\n" + oldest
      : `# Archived from activeContext.md on ${new Date().toISOString()}\n\n${oldest}`;
    await fs.writeFile(archivePath, merged, "utf8");

    // Truncate activeContext.md to newest half + a breadcrumb pointing to archive
    const breadcrumb = `<!-- agent-daemon: ${mid} earlier line(s) rotated to ${path.relative(cwd, archivePath)} on ${dateStamp} -->\n\n`;
    await fs.writeFile(filePath, breadcrumb + newest, "utf8");

    if (verbose) {
      process.stderr.write(`agent-daemon: rotated ${mid} lines of activeContext.md → ${path.relative(cwd, archivePath)}\n`);
    }

    return { rotated: true, archive: archivePath };
  } catch (err) {
    return { rotated: false, reason: `archive failed: ${err.message}` };
  }
}
