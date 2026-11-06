// `ad mistakes` (plan L4a, beta-0): a read-only report of the corrections the
// user typed to Claude Code and Codex. Consent first (D13): the screen names
// the folders, the session count and the date range before anything is read.
// Writes nothing, installs nothing, makes no network or model call.

import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { listSources, readPrompts, claudeRetentionDays, claudeConfigDir, findProject } from "./history.mjs";
import { ruleCoverage } from "./coverage.mjs";
import { buildReport, renderText, renderShare, renderJson, projectLabel } from "./report.mjs";
import { accountNames } from "./redact.mjs";

export const MISTAKES_USAGE = `Usage: ad mistakes [--all-projects] [--share | --json] [--yes]

A read-only report of the corrections you typed to Claude Code and Codex: how
often you corrected them, which corrections repeated, and in which agent.
Offline: no model call, no network, nothing stored or changed.

  --all-projects  read every project's history (default: this project only)
  --share         print a redacted Markdown summary you can post
  --json          print the report as JSON
  --yes, -y       don't ask before reading (needed when there's no terminal)`;

const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function span(files) {
  if (!files.length) return "";
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of files) {
    lo = Math.min(lo, f.mtimeMs);
    hi = Math.max(hi, f.mtimeMs);
  }
  return fmtDay(lo) === fmtDay(hi) ? fmtDay(lo) : `${fmtDay(lo)} to ${fmtDay(hi)}`;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The consent screen: what will be read, before anything is read. */
export function consentScreen(sources, { tilde = (p) => p } = {}) {
  const lines = ["ad mistakes counts the corrections you typed to your coding agents.", "", "It will read, without changing anything:"];
  const cc = sources.claude;
  const cx = sources.codex;
  const rows = [];
  if (cc.files.length) rows.push(["Claude Code", tilde(cc.dir), `${count(cc.projects, "project folder")}, ${count(cc.files.length, "session")}, ${span(cc.files)}`]);
  if (cx.files.length) rows.push(["Codex", `${tilde(path.join(cx.dir, "sessions"))} and archived_sessions`, `${count(cx.files.length, "session")}${sources.root ? " in all projects (only this project's are counted)" : ""}, ${span(cx.files)}`]);
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  for (const [a, b, c] of rows) lines.push(`  ${a.padEnd(w0)}  ${b.padEnd(w1)}  ${c}`);
  lines.push(`  Also: the CLAUDE.md and AGENTS.md files ${sources.root ? "of this project and " : ""}in your user folders, Claude Code's settings.json (how long it keeps history) and Codex's config.toml.`);
  lines.push("");
  if (!sources.root) lines.push("Scope: every project.");
  else if (sources.exactFolder) lines.push(`Scope: this folder only (${tilde(sources.root)}; it isn't in a git repository, so folders inside it don't count). --all-projects reads every project.`);
  else lines.push(`Scope: this project only (${tilde(sources.root)}). --all-projects reads every project.`);
  lines.push("Offline: no model call, no network. Nothing is stored or sent.");
  return lines.join("\n") + "\n";
}

/**
 * @returns {Promise<number>} the exit code
 */
export async function runMistakes(argv, { env = process.env, home = os.homedir(), cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, now = Date.now() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "all-projects": { type: "boolean" },
        share: { type: "boolean" },
        json: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    stderr.write(`ad mistakes: ${err.message}\n\n${MISTAKES_USAGE}\n`);
    return 2;
  }
  if (values.help) {
    stdout.write(`${MISTAKES_USAGE}\n`);
    return 0;
  }
  if (values.share && values.json) {
    stderr.write("ad mistakes: use --share or --json, not both\n");
    return 2;
  }
  const allProjects = values["all-projects"] === true;
  // stdout carries only the report when it's machine output or redirected to a file.
  const ui = values.share || values.json || !stdout.isTTY ? stderr : stdout;
  const tilde = (p) => (home && (p === home || p.startsWith(home + path.sep)) ? "~" + p.slice(home.length) : p);

  const sources = listSources({ env, home, cwd, allProjects });
  if (!sources.claude.files.length && !sources.codex.files.length) {
    // This is the report, so it goes where the report goes (not into --json output).
    const out = values.share || values.json ? stderr : stdout;
    out.write(`No Claude Code or Codex history found${allProjects ? "" : " for this project"}. Looked in ${tilde(sources.claude.dir)} and ${tilde(path.join(sources.codex.dir, "sessions"))}.\n`);
    if (!allProjects) out.write("Run with --all-projects to look at every project.\n");
    return 0;
  }
  ui.write(consentScreen(sources, { tilde }));
  if (!values.yes) {
    if (!stdin.isTTY) {
      ui.write("\nRun it again with --yes to read them.\n");
      return 2;
    }
    const rl = readline.createInterface({ input: stdin, output: ui });
    let answer = "";
    try {
      answer = await rl.question("\nRead these files now? [y/N] ");
    } finally {
      rl.close();
    }
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      ui.write("Nothing was read.\n");
      return 0;
    }
  }
  ui.write("\n");

  const { prompts, stats, calls } = readPrompts(sources, { calls: true });
  const coverage = ruleCoverage({ root: sources.root, env, home });
  // Write rules are project-relative: each call's project, found once per folder.
  const roots = new Map();
  const rootOf = (dir) => {
    if (sources.root) return sources.root;
    if (!dir) return null;
    if (!roots.has(dir)) roots.set(dir, findProject(dir).root);
    return roots.get(dir);
  };
  const report = buildReport({
    prompts,
    calls,
    rootOf,
    sources,
    stats,
    retentionDays: claudeRetentionDays({ env, home }),
    coverage,
    now,
    redact: { home, names: accountNames({ home, env }) },
  });
  if (values.json) stdout.write(renderJson(report));
  else if (values.share) stdout.write(renderShare(report));
  else stdout.write(renderText(report, { projectName: projectLabel(sources.root), claudeSettings: tilde(path.join(claudeConfigDir({ env, home }), "settings.json")) }));
  return 0;
}
