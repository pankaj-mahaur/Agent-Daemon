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

const MAX_CONCURRENT_AGENTS = 8;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_STDOUT_BYTES = 512 * 1024; // 512KB cap on buffered output
const activeAgents = new Set();

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
 * @property {number} [timeoutMs]    - kill agent after this many ms (default: 15 min)
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
  if (!opts.teamId) throw new Error("spawnAgent: teamId is required");
  if (!opts.role) throw new Error("spawnAgent: role is required");
  if (!opts.task) throw new Error("spawnAgent: task is required");
  if (!opts.cwd) throw new Error("spawnAgent: cwd is required");

  validateName(opts.teamId, "teamId");
  validateName(opts.role, "role");

  if (activeAgents.size >= MAX_CONCURRENT_AGENTS) {
    return { ok: false, agentName: opts.role, error: `concurrent agent limit reached (${MAX_CONCURRENT_AGENTS}). Wait for running agents to finish.` };
  }

  const agentName = opts.agentName || `${opts.role}-${crypto.randomBytes(3).toString("hex")}`;
  const branch = `team/${opts.teamId}/${agentName}`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  await createInbox(opts.teamId, agentName);
  if (opts.leader) {
    await createInbox(opts.teamId, opts.leader);
  }

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
    "--dangerously-skip-permissions",
    "--append-system-prompt", systemPrompt,
    "--input-format", "text"
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.verbose) {
    process.stderr.write(`[spawn] ${agentName} (${opts.role}) in ${worktreePath} [timeout=${Math.round(timeoutMs/1000)}s]\n`);
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

  activeAgents.add(agentName);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeAgents.delete(agentName);
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn("claude", args, {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on("data", c => {
      stdoutBytes += c.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += c.toString();
    });
    child.stderr.on("data", c => {
      stderrBytes += c.length;
      if (stderrBytes <= MAX_STDOUT_BYTES) stderr += c.toString();
    });

    const pid = child.pid;
    updateAgentStatus(opts.teamId, agentName, "running", null, pid).catch(() => {});

    const timer = setTimeout(async () => {
      if (settled) return;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      await updateAgentStatus(opts.teamId, agentName, "error", `killed: timeout after ${Math.round(timeoutMs/1000)}s`);
      if (opts.leader) {
        await sendMessage({
          teamId: opts.teamId, from: agentName, to: opts.leader,
          type: "task-complete",
          payload: { role: opts.role, task: opts.task, status: "error", exitCode: null, branch, worktreePath, summary: `Agent timed out after ${Math.round(timeoutMs/1000)}s` }
        }).catch(() => {});
      }
      finish({ ok: false, agentName, worktreePath, branch, pid, error: `timeout after ${Math.round(timeoutMs/1000)}s` });
    }, timeoutMs);

    child.on("error", async (err) => {
      await updateAgentStatus(opts.teamId, agentName, "error", err.message);
      finish({ ok: false, agentName, error: `spawn failed: ${err.message}` });
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

      finish({
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

function validateName(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (value.length > 128) throw new Error(`${label} too long (max 128 chars)`);
  if (/[\/\\:*?"<>|]/.test(value) && label !== "teamId") throw new Error(`${label} contains invalid path characters`);
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
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const worktreeName = branch.replace(/[/\\:]/g, "-");
  const worktreePath = path.join(home, ".agent-daemon", "worktrees", worktreeName);

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const wtArg = isWin ? `"${worktreePath}"` : worktreePath;
    const args = ["worktree", "add", "-b", branch, wtArg];

    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin
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

async function atomicWriteJson(filepath, data) {
  const tmp = filepath + `.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, filepath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
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
  await atomicWriteJson(p, agents);
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
  await atomicWriteJson(p, agents);
}

export function getActiveAgentCount() {
  return activeAgents.size;
}

export async function removeWorktree(cwd, branch) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn("git", ["worktree", "remove", "--force", branch], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export async function cleanupWorktrees(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const worktreesDir = path.join(home, ".agent-daemon", "worktrees");
  let entries;
  try {
    entries = await fs.readdir(worktreesDir);
  } catch { return { removed: 0 }; }

  let removed = 0;
  for (const entry of entries) {
    const fullPath = path.join(worktreesDir, entry);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const gitHead = path.join(fullPath, ".git");
    const exists = await fs.stat(gitHead).catch(() => null);
    if (!exists) {
      await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
      removed++;
      continue;
    }
  }

  // Also run git worktree prune on the main repo
  await new Promise((resolve) => {
    const child = spawn("git", ["worktree", "prune"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });

  return { removed };
}
