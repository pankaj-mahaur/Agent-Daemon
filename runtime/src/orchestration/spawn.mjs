// Spawn protocol — launch Claude Code instances as team workers.
//
// Each spawned agent runs in an isolated git worktree with role-specific
// instructions injected via --append-system-prompt. On completion, the
// agent writes a task-complete message to the leader's inbox.
//
// This extends the existing claude.mjs headless spawner with:
//   - Git worktree creation per agent
//   - Role/team context injection
//   - Inbox-based completion reporting

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sendMessage, createInbox } from "./inbox.mjs";

/**
 * @typedef {Object} SpawnOptions
 * @property {string} teamId
 * @property {string} role          - role name from team template
 * @property {string} agentName     - unique agent name (default: role + random suffix)
 * @property {string} task          - task description for the agent
 * @property {string} [instructions] - role-specific system prompt
 * @property {string[]} [skills]    - skill names to load
 * @property {string} [model]       - model override
 * @property {string} cwd           - project working directory
 * @property {boolean} [worktree=true] - use git worktree isolation
 * @property {string} [leader]      - leader agent name (for completion reporting)
 * @property {boolean} [verbose=false]
 *
 * @typedef {Object} SpawnResult
 * @property {boolean} ok
 * @property {string} agentName
 * @property {string} [worktreePath]
 * @property {string} [branch]
 * @property {number} [pid]
 * @property {string} [error]
 */

/**
 * Spawn a Claude Code agent as a team worker.
 *
 * @param {SpawnOptions} opts
 * @returns {Promise<SpawnResult>}
 */
export async function spawnAgent(opts) {
  const agentName = opts.agentName || `${opts.role}-${crypto.randomBytes(3).toString("hex")}`;
  const branch = `team/${opts.teamId}/${agentName}`;

  // Ensure inboxes exist
  await createInbox(opts.teamId, agentName);
  if (opts.leader) {
    await createInbox(opts.teamId, opts.leader);
  }

  // Register agent in team manifest
  await registerAgent(opts.teamId, {
    name: agentName,
    role: opts.role,
    task: opts.task,
    status: "spawning",
    branch,
    pid: null,
    startedAt: new Date().toISOString()
  });

  let worktreePath = opts.cwd;
  if (opts.worktree !== false) {
    try {
      worktreePath = await createWorktree(opts.cwd, branch);
    } catch (err) {
      await updateAgentStatus(opts.teamId, agentName, "error", err.message);
      return { ok: false, agentName, error: `worktree creation failed: ${err.message}` };
    }
  }

  const systemPrompt = buildSystemPrompt({
    teamId: opts.teamId,
    agentName,
    role: opts.role,
    task: opts.task,
    instructions: opts.instructions,
    leader: opts.leader,
    skills: opts.skills
  });

  const args = [
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--append-system-prompt", systemPrompt,
    "--input-format", "text"
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.verbose) {
    process.stderr.write(`[spawn] ${agentName} (${opts.role}) in ${worktreePath}\n`);
  }

  const userMessage = [
    `## Task Assignment`,
    ``,
    `You are **${agentName}** (role: ${opts.role}) in team **${opts.teamId}**.`,
    ``,
    `### Your task:`,
    opts.task,
    ``,
    `### Instructions:`,
    `1. Complete the task described above`,
    `2. Work only in your assigned worktree branch: \`${branch}\``,
    `3. Commit your changes with clear commit messages`,
    `4. When done, your completion will be reported automatically`,
    ``
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => { stdout += c.toString(); });
    child.stderr.on("data", c => { stderr += c.toString(); });

    const pid = child.pid;
    updateAgentStatus(opts.teamId, agentName, "running", null, pid).catch(() => {});

    child.on("error", async (err) => {
      await updateAgentStatus(opts.teamId, agentName, "error", err.message);
      resolve({ ok: false, agentName, error: `spawn failed: ${err.message}` });
    });

    child.on("close", async (code) => {
      let result;
      try {
        const envelope = JSON.parse(stdout);
        result = envelope.result;
      } catch {
        result = stdout.slice(0, 500);
      }

      const ok = code === 0;
      const status = ok ? "completed" : "error";
      await updateAgentStatus(opts.teamId, agentName, status, ok ? null : `exit code ${code}`);

      // Report completion to leader's inbox
      if (opts.leader) {
        await sendMessage({
          teamId: opts.teamId,
          from: agentName,
          to: opts.leader,
          type: "task-complete",
          payload: {
            role: opts.role,
            task: opts.task,
            status,
            exitCode: code,
            branch,
            worktreePath,
            summary: typeof result === "string" ? result.slice(0, 1000) : ""
          }
        }).catch(() => {});
      }

      resolve({
        ok,
        agentName,
        worktreePath,
        branch,
        pid,
        error: ok ? undefined : `claude exited ${code}`
      });
    });

    child.stdin.write(userMessage);
    child.stdin.end();
  });
}

function buildSystemPrompt({ teamId, agentName, role, task, instructions, leader, skills }) {
  const lines = [
    `# Team Agent Context`,
    ``,
    `You are agent **${agentName}** with role **${role}** in team **${teamId}**.`,
    leader ? `Your team leader is **${leader}**. Report issues or blockers to them.` : "",
    ``,
    `## Your Assignment`,
    task,
    ``
  ];

  if (instructions) {
    lines.push(`## Role Instructions`, ``, instructions, ``);
  }

  if (skills && skills.length > 0) {
    lines.push(`## Recommended Skills`, ``, `Load these skills if relevant: ${skills.join(", ")}`, ``);
  }

  lines.push(
    `## Coordination Protocol`,
    ``,
    `- Work within your branch. Do not modify files outside your task scope.`,
    `- Commit your changes with descriptive messages.`,
    `- If blocked, describe the blocker clearly — it will be relayed to the leader.`,
    ``
  );

  return lines.filter(l => l !== undefined).join("\n");
}

async function createWorktree(cwd, branch) {
  return new Promise((resolve, reject) => {
    const worktreeName = branch.replace(/[/\\:]/g, "-");
    const worktreePath = path.join(cwd, ".git", "agent-worktrees", worktreeName);

    const child = spawn("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let stderr = "";
    child.stderr.on("data", c => { stderr += c.toString(); });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(worktreePath);
      } else {
        reject(new Error(stderr.trim() || `git worktree add failed (code ${code})`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`git worktree add spawn error: ${err.message}`));
    });
  });
}

function agentsManifestPath(teamId) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".agent-daemon", "teams", teamId, "agents.json");
}

async function registerAgent(teamId, agent) {
  const p = agentsManifestPath(teamId);
  await fs.mkdir(path.dirname(p), { recursive: true });

  let agents = [];
  try {
    agents = JSON.parse(await fs.readFile(p, "utf8"));
  } catch { /* new file */ }

  agents = agents.filter(a => a.name !== agent.name);
  agents.push(agent);
  await fs.writeFile(p, JSON.stringify(agents, null, 2), "utf8");
}

async function updateAgentStatus(teamId, agentName, status, error, pid) {
  const p = agentsManifestPath(teamId);
  let agents = [];
  try {
    agents = JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return; }

  const agent = agents.find(a => a.name === agentName);
  if (agent) {
    agent.status = status;
    if (error) agent.error = error;
    if (pid) agent.pid = pid;
    if (status === "completed" || status === "error") {
      agent.finishedAt = new Date().toISOString();
    }
  }
  await fs.writeFile(p, JSON.stringify(agents, null, 2), "utf8");
}

/**
 * Clean up a git worktree after agent completes.
 */
export async function removeWorktree(cwd, branch) {
  return new Promise((resolve) => {
    const child = spawn("git", ["worktree", "remove", "--force", branch], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
