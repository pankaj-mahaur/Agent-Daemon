// Wires checkpoints (harness/checkpoints.mjs) into a session and the app
// (plan Part 10). Snapshots are taken when the user starts typing and when a
// turn ends. A turn's "before" must be a snapshot from after the previous
// turn ended, ready within 150 ms of the prompt; otherwise that turn has no
// checkpoint (never a guess). /undo undoes only the last finished turn, and
// only the files the agent's edits reported.

import path from "node:path";
import { UNDO_LIMITS } from "../harness/checkpoints.mjs";

const unwrapPrivate = (t) => {
  const m = /^<private>([\s\S]*)<\/private>$/.exec(String(t ?? ""));
  return m ? m[1] : t;
};

export function checkpointWiring(cp, { cwd = process.cwd(), waitMs = 150, typingEveryMs = 5000, now = () => Date.now() } = {}) {
  let lastTurnEnd = 0;
  let pendingBefore = null;
  let lastTyping = -Infinity;
  const befores = new Map(); // turnId → before tree
  const recorded = new Set(); // turnIds with a checkpoint
  const missing = new Map(); // turnId → why there is none
  const recording = new Map(); // turnId → promise of the after snapshot + record

  const hooks = {
    async beforeTurn({ input }) {
      const snap = await cp.beforeSnapshot({ since: lastTurnEnd, waitMs }).catch(() => null);
      pendingBefore = snap?.tree ?? null;
      return input;
    },
    turnStarted({ turn }) {
      if (pendingBefore) befores.set(turn.id, pendingBefore);
      else missing.set(turn.id, cp.lastError ? `snapshots fail here: ${cp.lastError}` : "the snapshot before it wasn't ready in time");
      pendingBefore = null;
    },
    turnCompleted({ turn, session }) {
      lastTurnEnd = now();
      const before = befores.get(turn.id);
      befores.delete(turn.id);
      const threadId = session?.state?.thread?.id;
      const job = (async () => {
        const after = await cp.snapshot().catch(() => null);
        if (!before) return;
        if (!after || !threadId) return void missing.set(turn.id, cp.lastError ? `snapshots fail here: ${cp.lastError}` : "the snapshot after it failed");
        if (await cp.record(threadId, turn.id, { before, after: after.tree }).catch(() => false)) recorded.add(turn.id);
      })();
      recording.set(turn.id, job);
      job.finally(() => recording.delete(turn.id));
      return job;
    },
  };

  // Files the turn's edits reported, relative to the repo root, "/"-separated.
  async function agentPaths(session, turn) {
    const r = await cp.repo();
    const out = [];
    for (const id of turn.itemIds) {
      const it = session.state.items.get(id);
      if (it?.kind !== "fileChange") continue;
      for (const c of it.changes ?? []) {
        for (const p of [c.path, c.movePath].filter(Boolean)) {
          const rel = path.relative(r.root, path.resolve(cwd, p)).split(path.sep).join("/");
          if (rel && !rel.startsWith("..")) out.push(rel);
        }
      }
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
    async undo(session, { force = false } = {}) {
      const st = session.state;
      if (!st.thread) return { error: "Nothing to undo yet." };
      if (st.activeTurnId || st.starting) return { error: "Wait for the turn to finish (or esc), then /undo." };
      await Promise.all([...recording.values()]).catch(() => {});
      const target = st.turns.filter((t) => t.status !== "inProgress").at(-1);
      if (!target) return { error: "Nothing to undo yet." };
      if (!recorded.has(target.id)) return { error: `The last turn has no checkpoint (${missing.get(target.id) ?? "it ran before checkpoints were on"}), so /undo can't put its files back.` };
      const r = await cp.restore(st.thread.id, target.id, { force, agentPaths: await agentPaths(session, target) });
      if (r.error) return { error: r.conflicts?.length && !force ? `${r.error} /undo force overrides "changed since the turn" (files the agent didn't edit and folders are never touched).` : r.error };
      const um = target.itemIds.map((id) => st.items.get(id)).find((i) => i?.kind === "userMessage");
      await session.revert(target.id);
      recorded.delete(target.id);
      const n = r.restored;
      const skipped = r.skipped ? ` ${r.skipped} left alone (not the agent's edit, or a folder is there now).` : "";
      const exact = r.byteExact ? "" : " This git is older than 2.40: files with .gitattributes eol rules may come back normalized.";
      return { message: `Undid the last turn: ${n} file${n === 1 ? "" : "s"} put back.${skipped} ${UNDO_LIMITS}${exact}`, prompt: um ? unwrapPrivate(um.text) : null };
    },
  };
}
