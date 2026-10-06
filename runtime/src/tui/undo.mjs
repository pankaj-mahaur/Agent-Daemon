// Wires checkpoints (harness/checkpoints.mjs) into a session and the app
// (plan Part 10). A turn's "before" is a snapshot started when the prompt is
// sent (the typing snapshot only warms git's caches), ready within `waitMs`;
// otherwise that turn has no checkpoint, never an older guess. Its "after" is
// a snapshot started after it ended. /undo undoes only the last finished
// turn, and only the files the agent's applied edits reported, as those edits
// left them: each is hashed when its edit completes, so a change by the user
// (or a command) during the turn is a conflict, not undone with the turn.

import path from "node:path";
import { UNDO_LIMITS } from "../harness/checkpoints.mjs";

const unwrapPrivate = (t) => {
  const m = /^<private>([\s\S]*)<\/private>$/.exec(String(t ?? ""));
  return m ? m[1] : t;
};

export function checkpointWiring(cp, { cwd = process.cwd(), waitMs = 1000, typingEveryMs = 5000, now = () => Date.now() } = {}) {
  let pendingBefore = null;
  let undoing = null; // a running /undo: a new turn waits for it
  let lastTyping = -Infinity;
  const befores = new Map(); // turnId → before tree
  const recorded = new Map(); // turnId → {skipped, agentBlobs}
  const written = new Map(); // turnId → [promise of {path: blob}] per applied edit, in order
  let hashing = Promise.resolve(); // one hash run at a time, in edit order
  const missing = new Map(); // turnId → why there is none
  const recording = new Map(); // turnId → promise of the after snapshot + record

  const hooks = {
    async beforeTurn({ input }) {
      if (undoing) await undoing.catch(() => {});
      // Started now, when the prompt is sent: anything the user saved before
      // pressing Enter is in it, so /undo can't take it away.
      const snap = await cp.beforeSnapshot({ since: now(), waitMs }).catch(() => null);
      pendingBefore = snap ? { tree: snap.tree, skipped: snap.skipped ?? [] } : null;
      return input;
    },
    turnStarted({ turn }) {
      if (pendingBefore) befores.set(turn.id, pendingBefore);
      else missing.set(turn.id, cp.lastError ? `snapshots fail here: ${cp.lastError}` : "the snapshot before it wasn't ready in time");
      pendingBefore = null;
    },
    /** An applied edit: hash its files now, as the agent left them. */
    itemCompleted({ item }) {
      if (item?.kind !== "fileChange" || item.status !== "completed" || !item.turnId) return;
      const run = hashing.then(async () => {
        const r = await cp.repo();
        return r ? cp.hashPaths(relPaths(item, r.root)) : {};
      });
      hashing = run.catch(() => {});
      if (!written.has(item.turnId)) written.set(item.turnId, []);
      written.get(item.turnId).push(run);
    },
    turnCompleted({ turn, session }) {
      const ended = now();
      const before = befores.get(turn.id);
      befores.delete(turn.id);
      const threadId = session?.state?.thread?.id;
      const job = (async () => {
        // Started after the turn ended (not one still running from before it).
        const after = await cp.freshSnapshot(ended).catch(() => null);
        if (!before) return;
        if (!after || !threadId) return void missing.set(turn.id, cp.lastError ? `snapshots fail here: ${cp.lastError}` : "the snapshot after it failed");
        // A hash that failed is left out: that path is then a conflict.
        const agentBlobs = {};
        for (const hashes of await Promise.all((written.get(turn.id) ?? []).map((w) => w.catch(() => ({}))))) {
          // Re-inserted, so the latest edit comes last (and wins when case is folded).
          for (const [p, blob] of Object.entries(hashes)) {
            delete agentBlobs[p];
            agentBlobs[p] = blob;
          }
        }
        // What either snapshot left out was never captured on that side.
        const skipped = [...new Set([...(before.skipped ?? []), ...(after.skipped ?? [])])];
        if (await cp.record(threadId, turn.id, { before: before.tree, after: after.tree }).catch(() => false)) recorded.set(turn.id, { skipped, agentBlobs });
      })();
      job.finally(() => written.delete(turn.id));
      recording.set(turn.id, job);
      job.finally(() => recording.delete(turn.id));
      return job;
    },
  };

  // An edit's files, relative to the repo root, "/"-separated.
  function relPaths(item, root) {
    const out = [];
    for (const c of item.changes ?? []) {
      for (const p of [c.path, c.movePath].filter(Boolean)) {
        const rel = path.relative(root, path.resolve(cwd, p)).split(path.sep).join("/");
        if (rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)) out.push(rel);
      }
    }
    return out;
  }

  // Files the turn's edits reported.
  async function agentPaths(session, turn) {
    const r = await cp.repo();
    const out = [];
    for (const id of turn.itemIds) {
      const it = session.state.items.get(id);
      // Only edits that were applied: a declined or failed patch isn't the agent's change.
      if (it?.kind !== "fileChange" || it.status !== "completed") continue;
      out.push(...relPaths(it, r.root));
    }
    return out;
  }

  return {
    hooks,
    /** The user started typing: take the next turn's "before" now, off the critical path. */
    onTyping() {
      if (now() - lastTyping < typingEveryMs) return;
      lastTyping = now();
      cp.snapshot().catch(() => {});
    },
    /** Undoes the last finished turn: its files back, then the thread rewound. {message, prompt?} or {error}. */
    undo(session, opts = {}) {
      const run = undoTurn(session, opts);
      undoing = run.finally(() => {
        if (undoing === tracked) undoing = null;
      });
      const tracked = undoing;
      return run;
    },
  };

  async function undoTurn(session, { force = false } = {}) {
      const st = session.state;
      if (!st.thread) return { error: "Nothing to undo yet." };
      if (st.activeTurnId || st.starting) return { error: "Wait for the turn to finish (or esc), then /undo." };
      await Promise.all([...recording.values()]).catch(() => {});
      const target = st.turns.filter((t) => t.status !== "inProgress").at(-1);
      if (!target) return { error: "Nothing to undo yet." };
      if (!recorded.has(target.id)) return { error: `The last turn has no checkpoint (${missing.get(target.id) ?? "it ran before checkpoints were on"}), so /undo can't put its files back.` };
      if (st.activeTurnId || st.starting) return { error: "A turn started meanwhile: /undo again once it finishes." };
      const { skipped: left, agentBlobs } = recorded.get(target.id);
      const r = await cp.restore(st.thread.id, target.id, { force, agentPaths: await agentPaths(session, target), skipped: left, agentBlobs });
      if (r.error) return { error: r.conflicts?.length && !force ? `${r.error} /undo force puts the agent's files back anyway, discarding the changes made after its edit; the rest are never touched.` : r.error };
      const um = target.itemIds.map((id) => st.items.get(id)).find((i) => i?.kind === "userMessage");
      recorded.delete(target.id);
      try {
        await session.revert(target.id);
      } catch (err) {
        return { error: `Files put back (${r.restored}), but the conversation couldn't be rewound: ${err?.message ?? err}. Esc Esc rewinds it.` };
      }
      const n = r.restored;
      const skipped = r.skipped ? ` ${r.skipped} left alone (not the agent's edit, not in the checkpoint, or a folder is there now).` : "";
      const exact = r.byteExact ? "" : " Git can't skip every attributes file here (git older than 2.40, .git/info/attributes or core.attributesFile): files with eol rules may come back normalized.";
      return { message: `Undid the last turn: ${n} file${n === 1 ? "" : "s"} put back.${skipped} ${UNDO_LIMITS}${exact}`, prompt: um ? unwrapPrivate(um.text) : null };
  }
}
