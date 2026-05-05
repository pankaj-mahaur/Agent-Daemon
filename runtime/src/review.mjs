// Interactive review of queued proposals.
//
// Reads proposals from .agent-daemon/proposed/ (markdown files written by
// the digest pipeline's apply stage) and prompts the user (a)ccept /
// (r)eject / (e)dit / (s)kip / (q)uit for each one.
//
// Behavior per choice:
//   accept  — apply the proposal (move file to .applied/<name>) and update
//             SQLite proposals.status = 'accepted'
//   reject  — delete the proposal file; SQLite status = 'rejected'
//   edit    — open the proposal in $EDITOR; user saves, then re-prompted
//   skip    — leave it for next run
//   quit    — exit the review loop, leave remainder queued
//
// v0.3 scope: this manages the QUEUE side (delete / archive). Actually
// applying a skill-edit proposal to skills/<name>/SKILL.md is left to the
// user (we print the suggested patch). Auto-apply lands in v0.4 with proper
// diff-and-apply logic.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const DIVIDER = "─".repeat(72);

/**
 * @param {{cwd: string, verbose?: boolean}} opts
 * @returns {Promise<number>} exit code
 */
export async function runInteractiveReview(opts) {
  const proposedDir = path.join(opts.cwd, ".agent-daemon", "proposed");
  const appliedDir  = path.join(opts.cwd, ".agent-daemon", "applied");

  let entries;
  try {
    entries = (await fs.readdir(proposedDir))
      .filter(e => e.endsWith(".md") || e.endsWith(".diff"))
      .sort();
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No queued proposals.");
      return 0;
    }
    throw err;
  }

  if (entries.length === 0) {
    console.log("No queued proposals.");
    return 0;
  }

  if (!input.isTTY) {
    // Non-interactive caller — fall back to listing (the v0.2 behavior).
    console.log(`${entries.length} queued proposal(s) — non-TTY; listing only:`);
    for (const e of entries) console.log(`  ${e}`);
    console.log("\nRun this in an interactive terminal to accept/reject/edit.");
    return 0;
  }

  const rl = readline.createInterface({ input, output });
  let stats = { accepted: 0, rejected: 0, edited: 0, skipped: 0 };

  console.log(`\nReviewing ${entries.length} proposal(s) at ${proposedDir}\n`);

  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    const filePath = path.join(proposedDir, name);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    console.log(DIVIDER);
    console.log(`Proposal ${i + 1}/${entries.length}: ${name}`);
    console.log(DIVIDER);
    console.log(content);
    console.log(DIVIDER);

    let decision = null;
    while (!decision) {
      const ans = (await rl.question("[a]ccept / [r]eject / [e]dit / [s]kip / [q]uit: ")).trim().toLowerCase();
      switch (ans) {
        case "a": case "accept":
          decision = "accept"; break;
        case "r": case "reject":
          decision = "reject"; break;
        case "e": case "edit":
          await openInEditor(filePath);
          // re-read and re-prompt
          try {
            content = await fs.readFile(filePath, "utf8");
            console.log("\n--- after edit ---\n");
            console.log(content);
            console.log("--- end ---\n");
          } catch { /* file deleted while editing — treat as reject */ }
          stats.edited++;
          break;
        case "s": case "skip": case "":
          decision = "skip"; break;
        case "q": case "quit":
          rl.close();
          summarize(stats, entries.length - i);
          return 0;
        default:
          console.log("  Choose one: a / r / e / s / q");
      }
    }

    if (decision === "accept") {
      await fs.mkdir(appliedDir, { recursive: true });
      const dst = path.join(appliedDir, name);
      await fs.rename(filePath, dst);
      console.log(`✓ accepted — moved to ${path.relative(opts.cwd, dst)}`);
      console.log("  Note: skill-edit proposals require manual SKILL.md update for now.");
      console.log("        constitution-add proposals require manual constitution/core.md update.");
      stats.accepted++;
    } else if (decision === "reject") {
      await fs.unlink(filePath);
      console.log("✗ rejected — file deleted");
      stats.rejected++;
    } else {
      console.log("· skipped");
      stats.skipped++;
    }
    console.log("");
  }

  rl.close();
  summarize(stats, 0);
  return 0;
}

function summarize(stats, remaining) {
  console.log(DIVIDER);
  console.log(`Done. accepted=${stats.accepted}  rejected=${stats.rejected}  edited=${stats.edited}  skipped=${stats.skipped}` + (remaining > 0 ? `  remaining=${remaining}` : ""));
}

/**
 * Open a file in the user's $EDITOR (or sensible default).
 * Blocks until the editor process exits.
 *
 * @param {string} filePath
 */
async function openInEditor(filePath) {
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "vi");
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], {
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.on("close", () => resolve());
    child.on("error", (err) => reject(err));
  });
}
