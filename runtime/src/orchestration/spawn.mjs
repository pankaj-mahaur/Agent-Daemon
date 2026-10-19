// Spawn protocol — launch Claude Code instances as team workers.
//
// Each spawned agent runs in an isolated git worktree with role-specific
// instructions injected via --append-system-prompt-file. On completion, the
// agent writes a task-complete message to the leader's inbox.
//
// This extends the existing claude.mjs headless spawner with:
//   - Git worktree creation per agent
//   - Role/team context injection
//   - Inbox-based completion reporting
//
// No child here gets a shell or a bare program name (see safe-spawn.mjs):
// the task text reaches Claude only through stdin and a prompt file, and
// names that end up in git refs and paths are checked first.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { sendMessage, createInbox } from "./inbox.mjs";
import { productValue } from "../product-values.mjs";
import { commitWorktree, runEngineWorker } from "./engine-worker.mjs";
import { acquireLock, liveLocks } from "../lock.mjs";
import { engineHome } from "../engine/index.mjs";
import { homeWorkerNote } from "../engine/attribution.mjs";
import { checkModel, checkName, CLAUDE_TOO_OLD, claudeLacksPromptFile, resolveClaude, resolveGit, spawnResolved, withPromptFile } from "../safe-spawn.mjs";

const MAX_CONCURRENT_AGENTS = 8;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_STDOUT_BYTES = 512 * 1024; // 512KB cap on buffered output
// Running agents across ALL ad processes (each `ad spawn` is its own
// process): one lease per agent in ~/.agent-daemon/running-agents (lock.mjs,
// kind "agent"), held by the ad process supervising it. A holder is judged by
// its process start identity, so a reused pid doesn't count. 3.0's .pid
// files are counted while their pid lives and dropped once it doesn't.
const runningDir = () => path.join(os.homedir(), ".agent-daemon", "running-agents");
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
const agentLeases = new Map();
const activeAgents = {
  add(name) {
    try {
      agentLeases.set(name, acquireLock(`agent-${name}`, { dir: runningDir(), meta: { kind: "agent" } }));
    } catch (e) {
      process.stderr.write(`[spawn] couldn't record ${name} as running: ${e.message}\n`);
    }
  },
  delete(name) {
    agentLeases.get(name)?.();
    agentLeases.delete(name);
  },
  get size() {
    return this.count();
  },
  /** @param {{identityOf?: Function}} [o] identityOf: who holds each lease (lock.mjs; tests pass their own) */
  count({ identityOf } = {}) {
    let legacy = 0;
    let files = [];
    try {
      files = fsSync.readdirSync(runningDir()).filter((f) => f.endsWith(".pid"));
    } catch {
      return 0; // no registry yet
    }
    for (const f of files) {
      const p = path.join(runningDir(), f);
      const pid = Number(fsSync.readFileSync(p, "utf8"));
      if (pid && pidAlive(pid)) legacy++;
      else fsSync.rmSync(p, { force: true });
    }
    return legacy + liveLocks({ dir: runningDir(), ...(identityOf ? { identityOf } : {}) }).filter((h) => h.kind === "agent").length;
  },
};

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

  checkName(opts.teamId, "teamId");
  checkName(opts.role, "role");
  if (opts.model !== undefined && opts.model !== null && opts.model !== "") checkModel(opts.model);

  // Default worker: ad's own engine (sandboxed, no approvals needed); "claude" runs headless Claude Code.
  const engine = productValue(opts.engine ?? process.env.AD_AGENT_ENGINE ?? "ad");
  let claude = null;
  if (engine === "claude") {
    const r = resolveClaude();
    if (r.error) return { ok: false, agentName: opts.agentName || opts.role, error: r.error };
    claude = r.resolved;
  }

  if (activeAgents.size >= MAX_CONCURRENT_AGENTS) {
    return { ok: false, agentName: opts.role, error: `concurrent agent limit reached (${MAX_CONCURRENT_AGENTS}). Wait for running agents to finish.` };
  }

  // The role is cut so "<role>-<6 hex>" stays within the 64-character name limit.
  const agentName = checkName(opts.agentName || `${opts.role.slice(0, 57)}-${crypto.randomBytes(3).toString("hex")}`, "agentName");
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

  if (engine === "ad") {
    let r;
    // A worker in the caller's own folder (worktree: false) that would load the
    // user's own engine home keeps running, with a note (P0.2a, as 3.0 jobs).
    let engineOpts = opts.engineOpts;
    if (opts.worktree === false && engineHome.homeLayerRisk(worktreePath)) {
      process.stderr.write(`[agent-daemon] ${homeWorkerNote(agentName)}\n`);
      engineOpts = { ...(engineOpts ?? {}), allowHomeFolder: true };
    }
    try {
      await updateAgentStatus(opts.teamId, agentName, "running", null, process.pid);
      r = await (opts.runWorker ?? runEngineWorker)({
        worktreePath,
        systemPrompt,
        userMessage,
        model: opts.model,
        account: opts.account,
        timeoutMs,
        engineOpts,
        memoryProject: opts.cwd,
      });
      // The worker can't touch .git (see engine-worker.mjs); commit its work
      // here, outside the sandbox, on its own branch.
      if (r.ok && opts.worktree !== false) {
        try {
          r.commit = (opts.commitWorktree ?? commitWorktree)(worktreePath, `${agentName} (${opts.role}): ${opts.task}`.slice(0, 200));
        } catch (e) {
          r = { ...r, ok: false, error: `work finished but commit failed: ${e.message}` };
        }
      }
    } catch (e) {
      r = { ok: false, error: e.message };
    } finally {
      activeAgents.delete(agentName);
    }
    const status = r.ok ? "completed" : "error";
    await updateAgentStatus(opts.teamId, agentName, status, r.ok ? null : r.error).catch((e) => process.stderr.write(`[spawn] status update failed: ${e.message}\n`));
    if (opts.leader) {
      await sendMessage({
        teamId: opts.teamId,
        from: agentName,
        to: opts.leader,
        type: "task-complete",
        payload: { role: opts.role, task: opts.task, status, exitCode: r.ok ? 0 : 1, branch, worktreePath, threadId: r.threadId, commit: r.commit ?? null, summary: String(r.output ?? r.error ?? "").slice(0, 1000) },
      }).catch((err) => process.stderr.write(`[spawn] could not notify ${opts.leader}: ${err.message}\n`));
    }
    return { ok: r.ok, agentName, worktreePath, branch, threadId: r.threadId, commit: r.commit ?? null, error: r.ok ? undefined : r.error };
  }
  if (engine !== "claude") {
    activeAgents.delete(agentName);
    await updateAgentStatus(opts.teamId, agentName, "error", `unknown engine ${engine}`);
    return { ok: false, agentName, error: `unknown engine "${engine}" (use ad or claude)` };
  }

  // The system prompt (it holds the task) goes in a temp file, removed when
  // the worker ends, times out or fails to start; the user message on stdin.
  // If the temp file can't be written, the slot is freed and the agent marked.
  try {
    return await runClaudeWorker();
  } catch (err) {
    activeAgents.delete(agentName);
    await updateAgentStatus(opts.teamId, agentName, "error", err.message).catch(() => {});
    return { ok: false, agentName, error: `spawn failed: ${err.message}` };
  }

  function runClaudeWorker() {
  return withPromptFile(systemPrompt, (promptFile) => new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeAgents.delete(agentName);
      clearTimeout(timer);
      resolve(result);
    };

    const args = [
      "--print",
      "--output-format", "json",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--append-system-prompt-file", promptFile,
      "--input-format", "text"
    ];
    if (opts.model) args.push("--model", opts.model);

    let child;
    try {
      child = spawnResolved(claude, args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      updateAgentStatus(opts.teamId, agentName, "error", err.message).catch(() => {});
      finish({ ok: false, agentName, error: `spawn failed: ${err.message}` });
      return;
    }

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

    // Status writes are best-effort here: a failed write must not leave the
    // promise unsettled (and the prompt file with the task on disk).
    const setStatus = (...a) => updateAgentStatus(opts.teamId, agentName, ...a).catch((e) => process.stderr.write(`[spawn] status update failed: ${e.message}\n`));

    const pid = child.pid;
    setStatus("running", null, pid);

    timer = setTimeout(async () => {
      if (settled) return;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      await setStatus("error", `killed: timeout after ${Math.round(timeoutMs/1000)}s`);
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
      await setStatus("error", err.message);
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
      const tooOld = !ok && claudeLacksPromptFile(stderr);
      const error = ok ? undefined : tooOld ? CLAUDE_TOO_OLD : `claude exited ${code}`;
      await setStatus(status, ok ? null : tooOld ? CLAUDE_TOO_OLD : `exit code ${code}`);

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
        error
      });
    });

    // A child that exits before reading stdin (EPIPE) is reported by "close".
    child.stdin.on("error", () => {});
    child.stdin.write(userMessage);
    child.stdin.end();
  }));
  }
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

  const git = resolveGit();
  return new Promise((resolve, reject) => {
    const child = spawnResolved(git, ["worktree", "add", "-b", branch, "--", worktreePath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
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

export function getActiveAgentCount(opts) {
  return activeAgents.count(opts);
}

export async function removeWorktree(cwd, branch) {
  let git;
  try { git = resolveGit(); } catch { return; }
  return new Promise((resolve) => {
    const child = spawnResolved(git, ["worktree", "remove", "--force", "--", branch], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/**
 * Worktree paths of agents still marked running, across every team manifest.
 * Used by the TTL sweep so a long-lived but healthy agent never gets flagged.
 *
 * @returns {Promise<Set<string>>} normalized absolute paths
 */
async function runningWorktreePaths() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const teamsDir = path.join(home, ".agent-daemon", "teams");
  const running = new Set();
  let teams;
  try { teams = await fs.readdir(teamsDir); } catch { return running; }
  for (const t of teams) {
    if (t === "templates") continue;
    try {
      const agents = JSON.parse(await fs.readFile(agentsManifestPath(t), "utf8"));
      for (const a of agents) {
        if ((a.status === "running" || a.status === "spawning") && a.worktree) {
          running.add(path.normalize(a.worktree).toLowerCase());
        }
      }
    } catch { /* no manifest — skip */ }
  }
  return running;
}

/**
 * Prune dead worktrees.
 *
 * Always removes dirs that lost their `.git` link (broken worktrees).
 * Dirs past `ttlHours` whose agent is no longer running/spawning are STALE:
 * reported in `stale[]` by default, deleted only with `auto: true` — a
 * worktree may hold uncommitted work, so deletion stays an explicit choice.
 *
 * @param {string} cwd - main repo (for `git worktree prune`)
 * @param {{ ttlHours?: number, auto?: boolean }} [opts]
 * @returns {Promise<{ removed: number, stale: string[], staleRemoved: number }>}
 */
export async function cleanupWorktrees(cwd, opts = {}) {
  const ttlHours = opts.ttlHours ?? 72;
  const auto = opts.auto ?? false;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const worktreesDir = path.join(home, ".agent-daemon", "worktrees");
  let entries;
  try {
    entries = await fs.readdir(worktreesDir);
  } catch { return { removed: 0, stale: [], staleRemoved: 0 }; }

  const running = await runningWorktreePaths();
  const ttlCutoff = Date.now() - ttlHours * 60 * 60 * 1000;

  let removed = 0;
  let staleRemoved = 0;
  const stale = [];
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

    // TTL sweep: old AND its agent is gone → stale candidate
    if (stat.mtimeMs < ttlCutoff && !running.has(path.normalize(fullPath).toLowerCase())) {
      if (auto) {
        await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
        staleRemoved++;
      } else {
        stale.push(fullPath);
      }
    }
  }

  // Also run git worktree prune on the main repo
  let git = null;
  try { git = resolveGit(); } catch (e) { process.stderr.write(`[agent-daemon] git worktree prune skipped: ${e.message}\n`); }
  if (git) await new Promise((resolve) => {
    const child = spawnResolved(git, ["worktree", "prune"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });

  return { removed, stale, staleRemoved };
}
