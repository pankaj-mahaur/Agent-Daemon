// Session-start command.
// Reads constitution + project memory and emits a JSON object Claude Code's
// SessionStart hook injects as additional context.
//
// Output schema (when --output-json):
//   { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<markdown string>" } }
//
// Total length is capped at 9KB to stay under Claude Code's 10K hook output cap.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildUserRepresentation, representationToMarkdown } from "./memory/episodic.mjs";
import { hookProjectKeys } from "./memory/scope.mjs";
import { drainJournal } from "./hooks/journal-drain.mjs";
import { neutralizeMemoryFile } from "./digest/sanitize.mjs";
import { safeNoteText } from "./memory/render-safe.mjs";
import { projectDataDir } from "./memory/project-dir.mjs";
import { PRODUCT } from "./product.mjs";
import { UNTRUSTED_LINE, estimateTokens, BRIEF_BUDGET } from "./memory/recall-render.mjs";
import { memoryFolder, withoutLessons } from "./memory/recall-files.mjs";
import { stripManaged } from "./memory/managed-blocks.mjs";

const MAX_OUTPUT_BYTES = 9000;
// Plan L6 (01 §7): the memory product's whole session-start injection; the brief's own
// group in ad's full mode (its largest size: 1,200 estimated tokens, 4 bytes each at most);
// ad's full-mode total on the other host, which spills context above about 2,500 tokens.
const PRODUCT_BUDGET = BRIEF_BUDGET;
const BRIEF_CAP_BYTES = BRIEF_BUDGET * 4 + 100;
const SPILL_HOST_TOKENS = 2400;
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;

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
  // memoryOnly (a host plugin, P5.4): this project's memory and nothing else of ad —
  // no constitution, no pointers to ad's tools or commands, no other tools' rules
  // or CLAUDE.md (the host loads those itself), no digest sweep, no init hint.
  const full = !opts.memoryOnly;
  // The host this runs for (plan L6): what it loads itself isn't injected again.
  const host = opts.host ?? null;

  // -1. Rotate activeContext.md if it has grown too large AND is older than
  //     a week. activeContext.md gets read raw into the 9KB SessionStart
  //     injection; unbounded growth crowds out constitution + learnings.
  //     See rotateActiveContextIfNeeded for thresholds. Best-effort.
  try {
    // The memory product has no activeContext.md, and must not touch a repo's folder (plan L6).
    if (full) await rotateActiveContextIfNeeded(opts.cwd, opts.verbose);
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
        full ? `Run \`ad status\` to review anything queued.` : a.proposalsQueued ? `Some wait for your review: npx ${PRODUCT.package} review.` : null
      ].filter((l) => l !== null).join("\n"));
    }
  } catch { /* fail-safe — never block session-start */ }

  // 0b. Spawn a detached digest-sweep for transcripts whose SessionEnd never
  //     fired (the VS Code extension doesn't fire it). Detached + throttled:
  //     the installed hook has a 5s timeout, so the sweep must not be awaited,
  //     and one run per 10 minutes is plenty.
  try {
    if (full) await spawnDigestSweep(opts);
  } catch { /* fail-safe — never block session-start */ }

  // 1. Constitution — always-loaded files (~3KB total).
  //    core.md = our universal rules. karpathy-guidelines.md = behavioral
  //    guardrails distilled from Andrej Karpathy's LLM-coding observations
  //    (vendored from forrestchang/andrej-karpathy-skills, MIT).
  //    safety.md, verification.md, communication.md, ending-protocol.md are
  //    on-demand: the agent loads them via skill triggers or QMD search.
  const constitutionDir = path.join(opts.projectRoot ?? "", "constitution");
  const coreText = full ? await tryRead(path.join(constitutionDir, "core.md")) : null;
  if (coreText) {
    sections.push(`<!-- constitution/core.md -->\n${coreText}`);
  }
  const karpathyText = full ? await tryRead(path.join(constitutionDir, "karpathy-guidelines.md")) : null;
  if (karpathyText) {
    sections.push(`<!-- constitution/karpathy-guidelines.md -->\n${karpathyText}`);
  }

  // 2. Memory retrieval — prefer QMD pointer over bulk-loading files.
  //    If QMD (mcp__qmd__search) is available, inject a one-line pointer instead
  //    of loading all memory files. Falls back to bulk-load if QMD isn't installed.
  const qmdAvailable = full && (await detectQmd(opts.cwd));
  if (qmdAvailable) {
    const activeContext = await tryRead(path.join(memoryFolder(opts.cwd), "memory", "activeContext.md"));
    if (activeContext) {
      sections.push(`<!-- memory: activeContext.md -->\n### activeContext.md\n\n${neutralizeMemoryFile(fitActiveContext(withoutLessons(activeContext)))}`);
    }
    sections.push([
      `<!-- memory retrieval (QMD) -->`,
      `## Memory`,
      ``,
      `Memory and past learnings are indexed by QMD. Use \`mcp__qmd__search <query>\` to retrieve relevant context.`,
      `Do not read memory files directly — QMD provides ranked, compressed results at ~10x lower token cost.`
    ].join("\n"));
  } else {
    // Fallback: bulk-load memory files (pre-QMD behavior). The project's own
    // memory goes first, so the memory group's cap never cuts activeContext.md
    // for the global user.md; user.md (pushed after this block) gets what remains.

    // memoryOnly (the memory product): no file block at all — its learnings come only
    // through the brief, ranked and tagged (plan L6, design decision 7). Full mode: ad's
    // project memory, with every lesson line the store holds taken out (the brief sends
    // those), read without adopting folders; Claude Code's own auto memory only on a
    // host that doesn't load it itself.
    const memoryLocations = full ? [
      path.join(memoryFolder(opts.cwd), "memory"),
      path.join(opts.cwd, ".claude", "memory"),
      ...(host === "claude" ? [] : [path.join(homeDir(), ".claude", "projects", encodeProjectPath(opts.cwd), "memory")]),
      path.join(homeDir(), ".agent-daemon", "memory")
    ] : [];

    let foundProjectMemory = false;
    for (const memDir of memoryLocations) {
      const result = await readMemoryDir(memDir);
      if (result) {
        if (result.hasPlaceholders && full) {
          // Push warning BEFORE memory content so it survives 9KB truncation
          sections.push(`<!-- memory-bootstrap-hint -->\n**⚠ Memory not yet bootstrapped.** Memory files contain unfilled template placeholders (\`{{...}}\`). Say "bootstrap the daemon memory" to populate them with real project context.`);
        }
        sections.push(`<!-- memory: ${memDir} -->\n${UNTRUSTED_LINE}\n\n${result.content}`);
        foundProjectMemory = true;
        break;
      }
    }

  }

  if (!qmdAvailable && full) {
    const userMd = await tryRead(path.join(homeDir(), ".agent-daemon", "user.md"));
    if (userMd) sections.push(`<!-- ~/.agent-daemon/user.md (cross-project user profile) -->\n${neutralizeMemoryFile(userMd)}`);
  }

  // 3. Graphify knowledge graph pointer — if a graphify-out/graph.json exists
  //    in the project, inject a lightweight pointer so Claude queries the graph
  //    for architecture/relationship questions instead of re-reading the codebase.
  if (full) {
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
  if (full) {
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
  // Claude Code loads CLAUDE.md itself (plan L6): only other hosts get it here, without
  // ad 3.x's learnings block (the brief sends those).
  for (const fname of full ? [...(host === "claude" ? [] : ["CLAUDE.md"]), "CONVENTIONS.md"] : []) {
    const text = await tryRead(path.join(opts.cwd, fname));
    if (text) {
      sections.push(`<!-- ${fname} -->\n${fname === "CLAUDE.md" ? stripManaged(text) : text}`);
    }
  }

  // 4b. Cross-agent rules — read from other agents' config dirs if present.
  //     This makes agent-daemon aware of rules set for Cursor, Cline, etc.
  const crossAgentSources = [
    { dir: path.join(opts.cwd, ".cursor", "rules"), label: "Cursor rules", ext: ".mdc" },
    { dir: path.join(opts.cwd, ".cline", "rules"),  label: "Cline rules",  ext: ".md" },
    ...(host === "claude" ? [] : [{ dir: path.join(homeDir(), ".claude", "projects", encodeProjectPath(opts.cwd), "memory"), label: "Claude Code auto-memory", ext: ".md" }]),
    { dir: path.join(homeDir(), ".cursor", "rules"), label: "Global Cursor rules", ext: ".mdc" }
  ];
  for (const source of full ? crossAgentSources : []) {
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
    const teamContext = full ? await loadActiveTeamContext() : null;
    if (teamContext) {
      sections.push(`<!-- active team context -->\n${teamContext}`);
    }
  } catch {
    // team context is optional
  }

  // 4c. The session brief (plan L6): this project's learnings, ranked against the
  //     cached repo context, tagged, within its budget — the only channel for them.
  //     Claimed once per session and event, so two entries never both send it.
  const shownIds = [];
  // The memory scope for this folder (memory/scope.mjs): [] for home, a root,
  // a system folder or ad's own folders, and for a key two folders share.
  const memKeys = await hookProjectKeys(opts.cwd).catch(() => []);
  // Hooks never run the safety scan; they only say when it hasn't run yet.
  try {
    const { db } = await import("./memory/episodic.mjs");
    const { safetyScanDone } = await import("./memory/safety.mjs");
    const handle = await db();
    if (full && handle && !safetyScanDone(handle) && handle.get("SELECT 1 AS x FROM learnings LIMIT 1")) sections.push("<!-- memory-scan-hint -->\nad hasn't checked older memory notes for secrets yet. Run: ad memory scan");
  } catch { /* no store: nothing to check */ }
  let brief = null;
  // Recall off for this project, or not a host that honours it: none of it here.
  let deliver = false;
  if (memKeys.length && opts.recall !== false) {
    try {
      const { db } = await import("./memory/episodic.mjs");
      const { recallMode, briefAllowed } = await import("./memory/recall-mode.mjs");
      const { isProjectId } = await import("./memory/projects.mjs");
      const handle = await db();
      deliver = Boolean(handle) && briefAllowed(recallMode(handle, memKeys.find(isProjectId) ?? null));
    } catch {
      deliver = false;
    }
  }
  if (deliver) {
    try {
      const { db } = await import("./memory/episodic.mjs");
      const { sessionBrief } = await import("./memory/session-recall.mjs");
      const handle = await db();
      brief = await sessionBrief(handle, {
        cwd: opts.cwd,
        keys: memKeys,
        product: PRODUCT.displayName,
        review: opts.review ?? null,
        budget: full ? undefined : PRODUCT_BUDGET - 120,
        now: opts.now ?? Date.now(),
        ...(opts.spawnContextJob !== undefined ? { spawn: opts.spawnContextJob } : {}),
      });
      if (brief) shownIds.push(...brief.ids);
    } catch {
      // the store or the context is unreadable: no brief this time
    }
  }
  // 5b. User representation — the deterministic "how this user works" rollup
  //     (Honcho-inspired, no LLM): global facts and global notes, grouped (plan L6:
  //     this project's learnings come only through the brief). Sent with the brief.
  let profileText = null;
  let profileItems = [];
  if (deliver) {
    try {
      // Global facts and notes only: this project's learnings come through the brief, tagged.
      const profile = await buildUserRepresentation({ projectKeys: memKeys, scope: "global" });
      const md = representationToMarkdown(profile, { compact: true, neutralize: (t) => safeNoteText(t) });
      if (md) {
        profileText = `## How this user works\n\n${UNTRUSTED_LINE}\n\n${md}`;
        profileItems = profile.items ?? [];
      }
    } catch {
      // SQLite optional — silent skip
    }
  }
  // Claimed just before printing (plan L6, decision 8): another entry of this same start
  // already sent the learnings → none here.
  if ((brief || profileText) && !(await import("./memory/recall-deliver.mjs")).claimDelivery({ session: opts.sessionId ?? null, event: "session.start", what: opts.source ?? "" })) {
    brief = null;
    profileText = null;
    profileItems = [];
    shownIds.length = 0;
  }
  // Preserve dynamic project context ahead of static guidance under the hook
  // cap. A large constitution must not hide active context or learnings. The brief
  // is its own group, first, never matched by a marker in some other text.
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
  const dynamic = new Set([...warningSections, ...memorySections]);
  const staticSections = sections.filter(s => !dynamic.has(s));
  const briefSections = brief ? [brief.text] : [];
  const profileSections = profileText ? [`<!-- user profile -->\n${profileText}`] : [];
  let combined;
  let budgetStats;
  if (full) {
    ({ output: combined, stats: budgetStats } = renderPrioritizedContext([
      { label: "brief", sections: briefSections, cap: BRIEF_CAP_BYTES },
      { label: "warnings", sections: warningSections, cap: 1100 },
      { label: "memory", sections: memorySections, cap: 4100 },
      { label: "recent-learnings", sections: profileSections, cap: 1700 },
      { label: "static", sections: staticSections, cap: MAX_OUTPUT_BYTES }
    ]));
    // The other host spills context above about 2,500 tokens: keep the whole block under it, brief first.
    if (host && host !== "claude") combined = capTokens(combined, SPILL_HOST_TOKENS);
  } else {
    // The memory product: the whole injection within 1,200 estimated tokens — the brief
    // first, then the drain note and "how this user works" in what is left.
    ({ output: combined, stats: budgetStats } = renderTokenBudget([
      { label: "brief", sections: briefSections },
      { label: "warnings", sections: [...warningSections, ...memorySections, ...staticSections] },
      { label: "recent-learnings", sections: profileSections },
    ], PRODUCT_BUDGET));
  }

  // Local counters: only the learnings the output really holds (a cut can drop some;
  // the profile shows 3 per bucket). Prompt recall's dedupe and /recall read these.
  {
    const sent = new Set();
    for (const id of shownIds) if (combined.includes(`- #${id} `)) sent.add(id);
    for (const it of profileItems) if (combined.includes(safeNoteText(it.text).replace(/\s+/g, " ").trim().slice(0, 40))) sent.add(it.id);
    shownIds.length = 0;
    shownIds.push(...sent);
  }
  if (shownIds.length) {
    try {
      const { db } = await import("./memory/episodic.mjs");
      const { recordInjections } = await import("./memory/metrics.mjs");
      const { hostId } = await import("./memory/host-ids.mjs");
      const { hookHost } = await import("./hooks/io.mjs");
      recordInjections(await db(), { captureRef: opts.sessionId || null, keys: memKeys, ids: [...new Set(shownIds)], surface: "session-start", host: hostId(hookHost()) });
    } catch {
      // local counters only
    }
  }

  // Measurement-first retrieval telemetry: record what was considered vs
  // injected vs truncated, to JSONL + SQLite. Best-effort — never blocks.
  try {
    await recordSessionStartTelemetry(opts, budgetStats);
  } catch { /* telemetry must never block session start */ }

  if (opts.outputJson) {
    process.stdout.write(JSON.stringify({
      ...(opts.systemMessage ? { systemMessage: opts.systemMessage } : {}),
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

/**
 * Fire `ad digest-sweep --cwd <cwd>` as a detached child, at most once per
 * SWEEP_THROTTLE_MS per project (mtime flag file). Exported for tests.
 *
 * @param {{ cwd: string, sessionId?: string, verbose?: boolean }} opts
 * @returns {Promise<boolean>} true when a sweep was spawned
 */
export async function spawnDigestSweep(opts) {
  if (!opts.cwd) return false;
  if (process.env.AGENT_DAEMON_DISABLE_SWEEP === "1") return false;  // service users / tests
  const daemonDir = path.join(opts.cwd, ".agent-daemon");
  try { await fs.access(daemonDir); } catch { return false; }  // not an ad project

  const flagPath = path.join(daemonDir, "last-digest-sweep.flag");
  try {
    const stat = await fs.stat(flagPath);
    if (Date.now() - stat.mtimeMs < SWEEP_THROTTLE_MS) return false;
  } catch { /* no flag yet — sweep */ }
  await fs.writeFile(flagPath, new Date().toISOString(), "utf8");

  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  const args = [cliPath, "digest-sweep", "--cwd", opts.cwd];
  if (opts.sessionId) args.push("--exclude-session", opts.sessionId);
  // Without the hook-only variables: the sweep runs outside the hook and may open (and upgrade) the store.
  const env = { ...process.env };
  delete env.AD_HOOK_NO_MIGRATE;
  delete env.AD_HOOK_EVENT;
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env });
  child.unref();
  if (opts.verbose) {
    process.stderr.write(`agent-daemon: spawned detached digest-sweep for ${opts.cwd}\n`);
  }
  return true;
}

const ACTIVE_CONTEXT_FIT_BYTES = 3200;
const KEY_SECTIONS = ["Now", "Open issues", "Rules"];

/**
 * activeContext.md within its budget. A file over it keeps its title, its
 * `## Now`, `## Open issues` and `## Rules` sections, then the newest lines
 * from its end (new knowledge is appended there), after a marker. A file
 * without those headings is returned as is (the group cap cuts its head).
 */
export function fitActiveContext(text, capBytes = ACTIVE_CONTEXT_FIT_BYTES) {
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  if (bytes(text) <= capBytes) return text;
  const lines = text.split(/\r?\n/);
  const heads = lines.map((l, i) => [l, i]).filter(([l]) => /^## /.test(l)).map(([l, i]) => ({ name: l.slice(3).trim(), i }));
  const keep = heads.filter((h) => KEY_SECTIONS.includes(h.name));
  if (!keep.length) return text;
  const firstHead = heads.length ? heads[0].i : lines.length;
  const parts = [lines.slice(0, firstHead).join("\n").trim()];
  for (const h of keep) {
    const next = heads.find((x) => x.i > h.i);
    parts.push(lines.slice(h.i, next ? next.i : lines.length).join("\n").trim());
  }
  let out = parts.filter(Boolean).join("\n\n");
  const marker = "<!-- older lines: activeContext.md -->";
  const covered = new Set(keep.flatMap((h) => {
    const next = heads.find((x) => x.i > h.i);
    return Array.from({ length: (next ? next.i : lines.length) - h.i }, (_, k) => h.i + k);
  }));
  const tail = [];
  let room = capBytes - bytes(out) - bytes(marker) - 4;
  for (let i = lines.length - 1; i >= firstHead && room > 0; i--) {
    if (covered.has(i)) continue;
    const b = bytes(lines[i]) + 1;
    if (b > room) break;
    tail.unshift(lines[i]);
    room -= b;
  }
  if (tail.some((l) => l.trim())) out += `\n\n${marker}\n${tail.join("\n").trim()}`;
  return out;
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
        // Lesson lines are the store's notes: the brief sends those (plan L6).
        const own = withoutLessons(text);
        blocks.push(`### ${f}\n\n${neutralizeMemoryFile(/^activeContext\.md$/i.test(f) ? fitActiveContext(own) : own)}`);
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

/** The text cut at a line boundary to at most maxTokens estimated tokens (recall-render.mjs). */
function capTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  const out = [];
  let used = 0;
  for (const line of String(text).split("\n")) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens) break;
    out.push(line);
    used += cost;
  }
  return out.join("\n");
}

/** Groups in order within one token budget, each cut at a line; the same stats as renderPrioritizedContext. */
function renderTokenBudget(groups, budget) {
  let output = "";
  const stats = [];
  for (const group of groups) {
    const text = group.sections.join("\n\n---\n\n");
    if (!text) continue;
    const sep = output ? "\n\n---\n\n" : "";
    const left = budget - estimateTokens(output + sep);
    const chunk = left > 0 ? capTokens(text, left) : "";
    if (chunk) output += sep + chunk;
    stats.push({ label: group.label, bytesIn: Buffer.byteLength(text, "utf8"), bytesKept: Buffer.byteLength(chunk, "utf8"), truncated: chunk.length < text.length });
  }
  return { output, stats };
}

function renderPrioritizedContext(groups) {
  const marker = "\n\n<!-- (agent-daemon: context truncated to fit 9KB hook cap) -->";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  let output = "";
  let truncated = false;
  const stats = [];

  for (const group of groups) {
    const text = group.sections.join("\n\n---\n\n");
    if (!text) continue;
    const bytesIn = Buffer.byteLength(text, "utf8");
    const separator = output ? "\n\n---\n\n" : "";
    const remaining = MAX_OUTPUT_BYTES - markerBytes - Buffer.byteLength(output + separator, "utf8");
    if (remaining <= 0) {
      truncated = true;
      stats.push({ label: group.label || "?", bytesIn, bytesKept: 0, truncated: true });
      break;
    }
    const groupBudget = Math.min(group.cap, remaining);
    const chunk = truncateToBytes(text, groupBudget);
    output += separator + chunk;
    const groupTruncated = bytesIn > groupBudget;
    if (groupTruncated) truncated = true;
    stats.push({ label: group.label || "?", bytesIn, bytesKept: Buffer.byteLength(chunk, "utf8"), truncated: groupTruncated });
  }

  return { output: truncated ? output + marker : output, stats };
}

const TELEMETRY_ROTATE_BYTES = 256 * 1024;

/**
 * Append one JSONL telemetry line + one SQLite retrieval_events row for this
 * session-start render. Exported for tests.
 *
 * @param {{ cwd: string, sessionId?: string }} opts
 * @param {Array<{label: string, bytesIn: number, bytesKept: number, truncated: boolean}>} budgetStats
 */
export async function recordSessionStartTelemetry(opts, budgetStats) {
  if (!opts.cwd || !budgetStats || budgetStats.length === 0) return;
  const consideredBytes = budgetStats.reduce((a, g) => a + g.bytesIn, 0);
  const injectedBytes = budgetStats.reduce((a, g) => a + g.bytesKept, 0);
  const truncated = budgetStats.some(g => g.truncated);

  // JSONL file (works even without better-sqlite3). Not for the memory product: it
  // writes nothing under a repository (plan L6); the SQLite row below is its counter.
  try {
    if (opts.memoryOnly) throw new Error("no repo writes");
    const telDir = path.join(projectDataDir(opts.cwd), "telemetry");
    await fs.mkdir(telDir, { recursive: true });
    const telFile = path.join(telDir, "session-start.jsonl");
    try {
      const st = await fs.stat(telFile);
      if (st.size > TELEMETRY_ROTATE_BYTES) {
        await fs.rename(telFile, `${telFile}.1`).catch(() => {});
      }
    } catch { /* no file yet */ }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: opts.sessionId || null,
      consideredBytes, injectedBytes, truncated,
      groups: budgetStats
    });
    await fs.appendFile(telFile, line + "\n", "utf8");
  } catch { /* best-effort */ }

  // SQLite row (graceful degradation when driver missing)
  try {
    const { recordRetrievalEvent } = await import("./memory/episodic.mjs");
    await recordRetrievalEvent({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      source: "session-start",
      consideredBytes, injectedBytes, truncated,
      groups: budgetStats
    });
  } catch { /* best-effort */ }
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

  const memDir   = path.join(projectDataDir(cwd), "memory");
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

  const archiveDir  = path.join(projectDataDir(cwd), "archive");
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
