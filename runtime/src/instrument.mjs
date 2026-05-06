// Token usage instrumentation.
// Parses Claude Code session JSONLs and aggregates usage stats.
// Used by `agent-daemon doctor --tokens` to measure injection cost and cache efficiency.

import fs from "node:fs/promises";
import path from "node:path";

const OPUS_PRICING = {
  inputPerMillion: 15,
  outputPerMillion: 75,
  cacheWritePerMillion: 18.75,
  cacheReadPerMillion: 1.5
};

const SONNET_PRICING = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.30
};

const PRICING = { opus: OPUS_PRICING, sonnet: SONNET_PRICING };

/**
 * @typedef {Object} SessionTokenStats
 * @property {string} sessionId
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheCreationTokens
 * @property {number} cacheReadTokens
 * @property {number} turns
 * @property {number} firstTurnInputTokens    - input tokens on the first assistant turn (injection cost proxy)
 * @property {number} firstTurnCacheCreation   - cache creation on first turn
 * @property {number} firstTurnCacheRead       - cache read on first turn
 */

/**
 * Parse a single JSONL session file and extract token usage stats.
 * Claude Code's assistant messages may include a `usage` object:
 *   { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 *
 * @param {string} filePath
 * @returns {Promise<SessionTokenStats|null>}
 */
export async function parseSessionTokens(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter(l => l.trim());
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let firstTurnInputTokens = 0;
  let firstTurnCacheCreation = 0;
  let firstTurnCacheRead = 0;
  let assistantTurnIndex = 0;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const usage = obj.usage || obj.message?.usage;
    if (!usage) continue;

    const inp = usage.input_tokens || 0;
    const out = usage.output_tokens || 0;
    const cw = usage.cache_creation_input_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;

    inputTokens += inp;
    outputTokens += out;
    cacheCreationTokens += cw;
    cacheReadTokens += cr;

    if (assistantTurnIndex === 0) {
      firstTurnInputTokens = inp;
      firstTurnCacheCreation = cw;
      firstTurnCacheRead = cr;
    }
    assistantTurnIndex++;
  }

  if (assistantTurnIndex === 0) return null;

  const fname = filePath.split(/[/\\]/).pop() || "";
  const sessionId = fname.replace(/\.jsonl$/i, "");

  return {
    sessionId,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    turns: assistantTurnIndex,
    firstTurnInputTokens,
    firstTurnCacheCreation,
    firstTurnCacheRead
  };
}

/**
 * Find Claude Code session JSONL files.
 * Default location: ~/.claude/projects/<encoded>/
 *
 * @param {{ limit?: number }} opts
 * @returns {Promise<string[]>}  Paths sorted newest-first
 */
export async function findSessionFiles({ limit = 10 } = {}) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return [];

  const projectsDir = path.join(home, ".claude", "projects");
  let projectDirs;
  try {
    projectDirs = await fs.readdir(projectsDir);
  } catch {
    return [];
  }

  const candidates = [];
  for (const dir of projectDirs) {
    const full = path.join(projectsDir, dir);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let entries;
    try { entries = await fs.readdir(full); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const fp = path.join(full, entry);
      let fstat;
      try { fstat = await fs.stat(fp); } catch { continue; }
      candidates.push({ path: fp, mtime: fstat.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, limit).map(c => c.path);
}

/**
 * Compute aggregate token stats across N sessions.
 *
 * @param {{ limit?: number, model?: string }} opts
 * @returns {Promise<Object>}
 */
export async function aggregateTokenStats({ limit = 10, model = "opus" } = {}) {
  const files = await findSessionFiles({ limit });
  if (files.length === 0) {
    return { error: "No session JSONL files found in ~/.claude/projects/" };
  }

  const sessions = [];
  for (const fp of files) {
    const s = await parseSessionTokens(fp);
    if (s) sessions.push(s);
  }

  if (sessions.length === 0) {
    return { error: "No sessions with usage data found (usage fields may not be present in older transcripts)" };
  }

  const pricing = PRICING[model] || OPUS_PRICING;
  const count = sessions.length;
  const sum = (fn) => sessions.reduce((a, s) => a + fn(s), 0);
  const avg = (fn) => Math.round(sum(fn) / count);

  const totalInput = sum(s => s.inputTokens);
  const totalOutput = sum(s => s.outputTokens);
  const totalCacheCreation = sum(s => s.cacheCreationTokens);
  const totalCacheRead = sum(s => s.cacheReadTokens);
  const totalFirstTurnInput = sum(s => s.firstTurnInputTokens);
  const totalFirstTurnCacheCreation = sum(s => s.firstTurnCacheCreation);

  const totalCacheable = totalCacheCreation + totalCacheRead;
  const cacheHitRate = totalCacheable > 0 ? totalCacheRead / totalCacheable : 0;

  const costPerSession = (s) => {
    const freshInput = s.inputTokens - s.cacheCreationTokens - s.cacheReadTokens;
    return (
      (Math.max(0, freshInput) * pricing.inputPerMillion / 1e6) +
      (s.outputTokens * pricing.outputPerMillion / 1e6) +
      (s.cacheCreationTokens * pricing.cacheWritePerMillion / 1e6) +
      (s.cacheReadTokens * pricing.cacheReadPerMillion / 1e6)
    );
  };

  const totalCost = sum(costPerSession);

  return {
    sessionsAnalyzed: count,
    sessionsScanned: files.length,
    avgInputPerSession: avg(s => s.inputTokens),
    avgOutputPerSession: avg(s => s.outputTokens),
    avgCacheCreation: avg(s => s.cacheCreationTokens),
    avgCacheRead: avg(s => s.cacheReadTokens),
    avgTurns: avg(s => s.turns),
    cacheHitRate,
    avgFirstTurnInput: avg(s => s.firstTurnInputTokens),
    avgFirstTurnCacheCreation: avg(s => s.firstTurnCacheCreation),
    avgCostPerSession: totalCost / count,
    totalCost,
    model,
    sessions: sessions.map(s => ({
      sessionId: s.sessionId.slice(0, 12) + "...",
      input: s.inputTokens,
      output: s.outputTokens,
      cacheHit: s.cacheReadTokens > 0
        ? (s.cacheReadTokens / (s.cacheCreationTokens + s.cacheReadTokens) * 100).toFixed(0) + "%"
        : "0%",
      turns: s.turns,
      cost: "$" + costPerSession(s).toFixed(4)
    }))
  };
}

/**
 * Format aggregated stats for terminal output.
 *
 * @param {Object} stats - from aggregateTokenStats()
 * @returns {string}
 */
export function formatTokenReport(stats) {
  if (stats.error) return `  (!) ${stats.error}`;

  const lines = [
    `  Token usage (last ${stats.sessionsAnalyzed} sessions, ${stats.model} pricing):`,
    ``,
    `    avg input/session:        ${stats.avgInputPerSession.toLocaleString()}`,
    `    avg output/session:       ${stats.avgOutputPerSession.toLocaleString()}`,
    `    avg cache creation:       ${stats.avgCacheCreation.toLocaleString()}  <- injection cost`,
    `    avg cache read:           ${stats.avgCacheRead.toLocaleString()}  <- cache reuse`,
    `    avg cache hit rate:       ${(stats.cacheHitRate * 100).toFixed(0)}%`,
    `    avg turns/session:        ${stats.avgTurns}`,
    ``,
    `    avg first-turn input:     ${stats.avgFirstTurnInput.toLocaleString()}  <- context loading cost`,
    `    avg first-turn cache-new: ${stats.avgFirstTurnCacheCreation.toLocaleString()}`,
    ``,
    `    avg cost/session:         $${stats.avgCostPerSession.toFixed(4)} (${stats.model})`,
    `    total cost (${stats.sessionsAnalyzed} sessions):  $${stats.totalCost.toFixed(4)}`,
    ``
  ];

  if (stats.sessions && stats.sessions.length > 0) {
    lines.push(`  Per-session breakdown:`);
    lines.push(`    ${"Session".padEnd(16)} ${"Input".padStart(8)} ${"Output".padStart(8)} ${"Cache".padStart(7)} ${"Turns".padStart(6)} ${"Cost".padStart(8)}`);
    lines.push(`    ${"─".repeat(16)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(7)} ${"─".repeat(6)} ${"─".repeat(8)}`);
    for (const s of stats.sessions) {
      lines.push(`    ${s.sessionId.padEnd(16)} ${String(s.input).padStart(8)} ${String(s.output).padStart(8)} ${s.cacheHit.padStart(7)} ${String(s.turns).padStart(6)} ${s.cost.padStart(8)}`);
    }
  }

  return lines.join("\n");
}
