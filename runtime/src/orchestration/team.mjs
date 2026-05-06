// Team manager — create teams, manage tasks, track status.
//
// A team is a directory under ~/.agent-daemon/teams/{team-id}/ with:
//   team.json     — team metadata (template, description, creation time)
//   tasks.json    — task list with dependency graph
//   agents.json   — registered agents and their statuses
//   inboxes/      — per-agent message directories (managed by inbox.mjs)

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * @typedef {Object} TeamTask
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string} [owner]        - agent name assigned to this task
 * @property {string} status         - pending | in_progress | completed | blocked
 * @property {string[]} [blockedBy]  - task ids that must complete first
 * @property {string} [createdAt]
 * @property {string} [completedAt]
 *
 * @typedef {Object} TeamInfo
 * @property {string} id
 * @property {string} [template]
 * @property {string} description
 * @property {string} createdAt
 * @property {Object[]} roles
 * @property {string[]} flows
 */

function teamsRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".agent-daemon", "teams");
}

function teamDir(teamId) {
  return path.join(teamsRoot(), teamId);
}

/**
 * Create a new team from a template or ad-hoc config.
 *
 * @param {Object} opts
 * @param {string} opts.description - what the team is working on
 * @param {string} [opts.template]  - template name (loaded separately)
 * @param {Object[]} [opts.roles]   - role definitions
 * @param {string[]} [opts.flows]   - communication flows (e.g. "lead > backend")
 * @returns {Promise<TeamInfo>}
 */
export async function createTeam(opts) {
  const id = `team-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = teamDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "inboxes"), { recursive: true });

  const team = {
    id,
    template: opts.template || null,
    description: opts.description,
    createdAt: new Date().toISOString(),
    roles: opts.roles || [],
    flows: opts.flows || []
  };

  await fs.writeFile(path.join(dir, "team.json"), JSON.stringify(team, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "tasks.json"), "[]", "utf8");
  await fs.writeFile(path.join(dir, "agents.json"), "[]", "utf8");

  return team;
}

/**
 * Load team info.
 */
export async function loadTeam(teamId) {
  const p = path.join(teamDir(teamId), "team.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

/**
 * List all teams.
 */
export async function listTeams() {
  const root = teamsRoot();
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const teams = [];
  for (const e of entries) {
    if (e === "templates") continue;
    const teamJsonPath = path.join(root, e, "team.json");
    try {
      const team = JSON.parse(await fs.readFile(teamJsonPath, "utf8"));
      teams.push(team);
    } catch {
      // skip invalid dirs
    }
  }
  return teams.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/**
 * Add a task to the team's task list.
 *
 * @param {string} teamId
 * @param {Object} task
 * @param {string} task.title
 * @param {string} [task.description]
 * @param {string} [task.owner]
 * @param {string[]} [task.blockedBy]
 * @returns {Promise<TeamTask>}
 */
export async function addTask(teamId, task) {
  const p = path.join(teamDir(teamId), "tasks.json");
  let tasks = [];
  try {
    tasks = JSON.parse(await fs.readFile(p, "utf8"));
  } catch { /* new */ }

  const newTask = {
    id: `task-${tasks.length + 1}`,
    title: task.title,
    description: task.description || null,
    owner: task.owner || null,
    status: (task.blockedBy && task.blockedBy.length > 0) ? "blocked" : "pending",
    blockedBy: task.blockedBy || [],
    createdAt: new Date().toISOString(),
    completedAt: null
  };

  tasks.push(newTask);
  await fs.writeFile(p, JSON.stringify(tasks, null, 2), "utf8");
  return newTask;
}

/**
 * Update a task's status. Triggers auto-unblocking of dependent tasks.
 *
 * @param {string} teamId
 * @param {string} taskId
 * @param {string} status
 * @returns {Promise<{task: TeamTask, unblocked: TeamTask[]}>}
 */
export async function updateTaskStatus(teamId, taskId, status) {
  const p = path.join(teamDir(teamId), "tasks.json");
  const tasks = JSON.parse(await fs.readFile(p, "utf8"));

  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`task ${taskId} not found in team ${teamId}`);

  task.status = status;
  if (status === "completed") {
    task.completedAt = new Date().toISOString();
  }

  // Auto-unblock: tasks that were blocked by this task may become unblockable
  const unblocked = [];
  if (status === "completed") {
    for (const t of tasks) {
      if (t.status !== "blocked") continue;
      if (!t.blockedBy || !t.blockedBy.includes(taskId)) continue;

      // Check if ALL blockers are now completed
      const allDone = t.blockedBy.every(bid => {
        const blocker = tasks.find(bt => bt.id === bid);
        return blocker && blocker.status === "completed";
      });
      if (allDone) {
        t.status = "pending";
        unblocked.push(t);
      }
    }
  }

  await fs.writeFile(p, JSON.stringify(tasks, null, 2), "utf8");
  return { task, unblocked };
}

/**
 * Get all tasks for a team.
 */
export async function listTasks(teamId) {
  const p = path.join(teamDir(teamId), "tasks.json");
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Get all agents registered in a team.
 */
export async function listAgents(teamId) {
  const p = path.join(teamDir(teamId), "agents.json");
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Print a kanban-style status board for a team.
 */
export async function formatTeamStatus(teamId) {
  const team = await loadTeam(teamId);
  const tasks = await listTasks(teamId);
  const agents = await listAgents(teamId);

  const lines = [];
  lines.push(`Team: ${team.id}${team.template ? ` (template: ${team.template})` : ""}`);
  lines.push(`Description: ${team.description}`);
  lines.push(`Created: ${team.createdAt}`);
  lines.push(`Roles: ${team.roles.map(r => r.name).join(", ") || "(none)"}`);
  lines.push("");

  // Agents status
  lines.push("Agents:");
  if (agents.length === 0) {
    lines.push("  (no agents spawned yet)");
  } else {
    for (const a of agents) {
      const icon = a.status === "completed" ? "done" :
                   a.status === "running" ? "running" :
                   a.status === "error" ? "ERROR" : a.status;
      lines.push(`  [${icon}] ${a.name} (${a.role}) — ${a.task || "(no task)"}`);
    }
  }
  lines.push("");

  // Kanban board
  const columns = {
    pending: tasks.filter(t => t.status === "pending"),
    in_progress: tasks.filter(t => t.status === "in_progress"),
    completed: tasks.filter(t => t.status === "completed"),
    blocked: tasks.filter(t => t.status === "blocked")
  };

  lines.push("Tasks:");
  for (const [col, items] of Object.entries(columns)) {
    if (items.length === 0) continue;
    lines.push(`  ${col.toUpperCase()} (${items.length}):`);
    for (const t of items) {
      const owner = t.owner ? ` @${t.owner}` : "";
      const blockers = t.blockedBy?.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
      lines.push(`    ${t.id}: ${t.title}${owner}${blockers}`);
    }
  }

  if (tasks.length === 0) {
    lines.push("  (no tasks created yet)");
  }

  return lines.join("\n");
}

/**
 * Check if all tasks in a team are completed.
 */
export async function isTeamComplete(teamId) {
  const tasks = await listTasks(teamId);
  if (tasks.length === 0) return false;
  return tasks.every(t => t.status === "completed");
}
