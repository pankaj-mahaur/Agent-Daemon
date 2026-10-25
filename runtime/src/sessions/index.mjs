// The index of logical sessions (P4.1): ~/.agent-daemon/sessions/index.json. Which session a
// thread belongs to, each session's current binding and state. Changed only at a session's
// creation, a binding change, a pause and close, under the lock "sessions-index", re-read
// first so two windows never lose each other's changes.
//
//   readIndex({ root }) → { schemaVersion, revision, sessions: {id: {...}}, threads: {"home|thread": id} }
//   updateIndex(mutate, { root, waitMs }) → mutate's result (mutate gets the fresh copy)
//   sessionForThread(index, home, threadId) → session id | null

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { writeJsonAtomicSync } from "../atomic-json.mjs";
import { sessionsDir } from "./ledger.mjs";

const empty = () => ({ schemaVersion: 1, revision: 0, sessions: {}, threads: {} });
const indexFile = (root) => path.join(sessionsDir(root), "index.json");

export function readIndex({ root = adRoot() } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(root), "utf8"));
    if (j && typeof j === "object" && j.sessions && j.threads) return j;
  } catch {
    // missing, or unreadable (a crash before the rename can't leave half a file)
  }
  return empty();
}

export async function updateIndex(mutate, { root = adRoot(), waitMs = 5000 } = {}) {
  const dir = sessionsDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = await acquireLockWithin("sessions-index", { dir: path.join(dir, ".locks"), waitMs });
  try {
    const next = readIndex({ root });
    const result = await mutate(next);
    next.revision = (next.revision ?? 0) + 1;
    writeJsonAtomicSync(indexFile(root), next);
    return result;
  } finally {
    release();
  }
}

export const threadKey = (home, threadId) => `${home}|${threadId}`;
export const sessionForThread = (index, home, threadId) => index.threads?.[threadKey(home, threadId)] ?? null;
