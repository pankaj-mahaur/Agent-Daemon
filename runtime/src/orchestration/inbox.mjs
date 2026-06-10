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

const MAX_MESSAGE_BYTES = 64 * 1024; // 64KB per message
const MAX_INBOX_MESSAGES = 500;
const ACKED_PURGE_AGE_DAYS  = 7;   // delete acked messages older than this
const ACKED_PURGE_THROTTLE_MS = 6 * 60 * 60 * 1000; // re-scan at most every 6h

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
  if (!teamId || !from || !to || !type) {
    throw new Error("sendMessage: teamId, from, to, and type are all required");
  }

  const dir = inboxDir(teamId, to);
  await fs.mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const rand = crypto.randomBytes(4).toString("hex");
  const id = `msg-${Date.now()}-${rand}`;
  const filename = `${id}.json`;

  /** @type {InboxMessage} */
  const msg = { id, from, to, type, payload, timestamp, teamId };

  const serialized = JSON.stringify(msg, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} byte limit`);
  }

  const tmpPath = path.join(dir, `.${filename}.tmp`);
  const finalPath = path.join(dir, filename);
  try {
    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // Clean up orphan tmp file on failure
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

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
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const messages = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    if (messages.length >= MAX_INBOX_MESSAGES) break;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), "utf8");
      messages.push(JSON.parse(raw));
    } catch {
      // skip corrupt messages
    }
  }

  // Non-blocking acked-purge — runs throttled (every 6h max). Fire-and-forget
  // so readInbox() stays cheap even on hot polling loops.
  setImmediate(() => {
    purgeAckedOlderThan(teamId, agentName).catch(() => { /* best-effort */ });
  });

  return messages.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
}

/**
 * Purge acknowledged messages older than `ageDays`. Best-effort, throttled
 * via a `.last-purge` marker so multiple `readInbox()` calls in quick
 * succession don't repeatedly stat every acked message.
 *
 * @param {string} teamId
 * @param {string} agentName
 * @param {{ ageDays?: number, force?: boolean }} [opts]
 * @returns {Promise<{ scanned: number, purged: number }>}
 */
export async function purgeAckedOlderThan(teamId, agentName, opts = {}) {
  const ageDays = opts.ageDays ?? ACKED_PURGE_AGE_DAYS;
  const force   = opts.force ?? false;
  const dir     = ackedDir(teamId, agentName);
  const markerPath = path.join(dir, ".last-purge");

  // Throttle — skip if we ran in the last 6 hours (unless force=true)
  if (!force) {
    try {
      const st = await fs.stat(markerPath);
      const since = Date.now() - st.mtimeMs;
      if (since < ACKED_PURGE_THROTTLE_MS) {
        return { scanned: 0, purged: 0 };
      }
    } catch { /* no marker — first run, proceed */ }
  }

  let entries;
  try { entries = await fs.readdir(dir); }
  catch (err) {
    if (err.code === "ENOENT") return { scanned: 0, purged: 0 };
    return { scanned: 0, purged: 0 };  // best-effort
  }

  const cutoff = Date.now() - (ageDays * 24 * 60 * 60 * 1000);
  let scanned = 0, purged = 0;
  for (const name of entries) {
    if (name === ".last-purge" || !name.endsWith(".json")) continue;
    scanned++;
    const filePath = path.join(dir, name);
    try {
      const st = await fs.stat(filePath);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(filePath);
        purged++;
      }
    } catch { /* file vanished between stat and unlink — fine */ }
  }

  // Touch marker to update throttle
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(markerPath, new Date().toISOString(), "utf8");
  } catch { /* non-fatal */ }

  return { scanned, purged };
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
