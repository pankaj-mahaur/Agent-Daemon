// Filesystem-based inbox for agent-to-agent messaging.
//
// Inspired by ClawTeam's file transport pattern: each agent in a team gets
// a directory. Messages are atomic JSON writes (write to .tmp, rename).
// No central server, no database — just JSON files on disk.
//
// Layout:
//   ~/.agent-daemon/teams/{team-id}/inboxes/{agent-name}/
//     msg-{timestamp}-{random}.json     — pending message
//     acked/msg-{timestamp}-{random}.json — acknowledged (processed)

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * @typedef {Object} InboxMessage
 * @property {string} id         - unique message id
 * @property {string} from       - sender agent name
 * @property {string} to         - recipient agent name
 * @property {string} type       - message type: task-assign | task-complete | status-update | handoff | query | broadcast
 * @property {Object} payload    - arbitrary payload
 * @property {string} timestamp  - ISO 8601
 * @property {string} teamId     - team this message belongs to
 */

function teamsRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".agent-daemon", "teams");
}

function inboxDir(teamId, agentName) {
  return path.join(teamsRoot(), teamId, "inboxes", agentName);
}

function ackedDir(teamId, agentName) {
  return path.join(teamsRoot(), teamId, "inboxes", agentName, "acked");
}

/**
 * Ensure inbox directory exists for an agent.
 */
export async function createInbox(teamId, agentName) {
  const dir = inboxDir(teamId, agentName);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(ackedDir(teamId, agentName), { recursive: true });
  return dir;
}

/**
 * Send a message to an agent's inbox. Atomic write (tmp + rename).
 *
 * @param {Object} opts
 * @param {string} opts.teamId
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {string} opts.type
 * @param {Object} opts.payload
 * @returns {Promise<InboxMessage>}
 */
export async function sendMessage({ teamId, from, to, type, payload }) {
  const dir = inboxDir(teamId, to);
  await fs.mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const rand = crypto.randomBytes(4).toString("hex");
  const id = `msg-${Date.now()}-${rand}`;
  const filename = `${id}.json`;

  /** @type {InboxMessage} */
  const msg = { id, from, to, type, payload, timestamp, teamId };

  const tmpPath = path.join(dir, `.${filename}.tmp`);
  const finalPath = path.join(dir, filename);
  await fs.writeFile(tmpPath, JSON.stringify(msg, null, 2), "utf8");
  await fs.rename(tmpPath, finalPath);

  return msg;
}

/**
 * Read all pending messages from an agent's inbox.
 * Returns sorted by timestamp (oldest first).
 *
 * @param {string} teamId
 * @param {string} agentName
 * @returns {Promise<InboxMessage[]>}
 */
export async function readInbox(teamId, agentName) {
  const dir = inboxDir(teamId, agentName);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const messages = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      messages.push(JSON.parse(raw));
    } catch {
      // skip corrupt messages
    }
  }

  return messages.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
}

/**
 * Acknowledge (mark as processed) a message by moving it to acked/.
 *
 * @param {string} teamId
 * @param {string} agentName
 * @param {string} msgId
 */
export async function ackMessage(teamId, agentName, msgId) {
  const dir = inboxDir(teamId, agentName);
  const acked = ackedDir(teamId, agentName);
  await fs.mkdir(acked, { recursive: true });

  const filename = `${msgId}.json`;
  const src = path.join(dir, filename);
  const dst = path.join(acked, filename);

  try {
    await fs.rename(src, dst);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * Broadcast a message to all agents in a team (except sender).
 *
 * @param {Object} opts
 * @param {string} opts.teamId
 * @param {string} opts.from
 * @param {string} opts.type
 * @param {Object} opts.payload
 * @param {string[]} opts.agents - list of agent names in the team
 * @returns {Promise<InboxMessage[]>}
 */
export async function broadcast({ teamId, from, type, payload, agents }) {
  const sent = [];
  for (const agent of agents) {
    if (agent === from) continue;
    const msg = await sendMessage({ teamId, from, to: agent, type, payload });
    sent.push(msg);
  }
  return sent;
}

/**
 * Count pending messages in an agent's inbox.
 */
export async function inboxCount(teamId, agentName) {
  const dir = inboxDir(teamId, agentName);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(e => e.endsWith(".json") && !e.startsWith(".")).length;
  } catch {
    return 0;
  }
}

/**
 * List all inboxes for a team (all agent names that have inbox dirs).
 */
export async function listInboxes(teamId) {
  const teamDir = path.join(teamsRoot(), teamId, "inboxes");
  try {
    const entries = await fs.readdir(teamDir);
    const agents = [];
    for (const e of entries) {
      const stat = await fs.stat(path.join(teamDir, e));
      if (stat.isDirectory()) agents.push(e);
    }
    return agents;
  } catch {
    return [];
  }
}
