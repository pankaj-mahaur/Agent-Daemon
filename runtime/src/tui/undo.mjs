// Wires checkpoints (harness/checkpoints.mjs) into a session and the app
// (plan Part 10): a snapshot when the user starts typing and when a turn
// ends; a turn waits at most 150 ms for one in flight, else it falls back to
// the last turn's "after" tree (best effort); /undo puts files back and
// rewinds the thread.

import { UNDO_LIMITS } from "../harness/checkpoints.mjs";

export function checkpointWiring(cp, { waitMs = 150, typingEveryMs = 5000, now = () => Date.now() } = {}) {
  let pendingBefore = null;
  let lastAfter = null;
  let lastTyping = -Infinity;
  const befores = new Map(); // turnId → {tree, bestEffort}
  const recorded = new Map(); // turnId → bestEffort
  let threadId = null;

  const hooks = {
    async beforeTurn({ input }) {
      const snap = await cp.snapshotWithin(waitMs).catch(() => null);
      pendingBefore = snap ? { tree: snap.tree, bestEffort: false } : lastAfter ? { tree: lastAfter, bestEffort: true } : null;
      return input;
    },
    turnStarted({ turn, session }) {
      threadId = session?.state?.thread?.id ?? threadId;
      if (pendingBefore) befores.set(turn.id, pendingBefore);
      pendingBefore = null;
    },
    async turnCompleted({ turn, session }) {
      threadId = session?.state?.thread?.id ?? threadId;
      const before = befores.get(turn.id);
      befores.delete(turn.id);
      const after = await cp.snapshot().catch(() => null);
      if (after) lastAfter = after.tree;
      if (before && after && threadId) {
        if (await cp.record(threadId, turn.id, { before: before.tree, after: after.tree }).catch(() => false)) recorded.set(turn.id, before.bestEffort);
      }
    },
  };

  return {
    hooks,
    /** The user started typing: take the next turn's "before" now, off the critical path. */
    onTyping() {
      if (now() - lastTyping < typingEveryMs) return;
      lastTyping = now();
      cp.snapshot().catch(() => {});
    },
    /**
     * Undoes a turn (the latest with a checkpoint by default): files back,
     * then the thread rewound. Returns {message, prompt?} or {error}.
     */
    async undo(session, { turnId = null, force = false } = {}) {
      const st = session.state;
      if (!st.thread) return { error: "Nothing to undo yet." };
      if (st.activeTurnId || st.starting) return { error: "Wait for the turn to finish (or esc), then /undo." };
      const done = st.turns.filter((t) => t.status !== "inProgress" && recorded.has(t.id));
      const target = turnId ? done.find((t) => t.id === turnId) : done.at(-1);
      if (!target) return { error: "No turn with a checkpoint to undo (checkpoints are taken while ad tui runs, in a git repo)." };
      const r = await cp.restore(st.thread.id, target.id, { force });
      if (r.error) return { error: r.conflicts?.length && !force ? `${r.error} /undo force puts them back anyway.` : r.error };
      const um = target.itemIds.map((id) => st.items.get(id)).find((i) => i?.kind === "userMessage");
      const bestEffort = recorded.get(target.id);
      await session.revert(target.id);
      recorded.delete(target.id);
      const n = r.restored;
      const best = bestEffort ? " (best effort: the snapshot before it was taken late)" : "";
      return { message: `Undid the last turn: ${n} file${n === 1 ? "" : "s"} put back${best}. ${UNDO_LIMITS}`, prompt: um?.text ?? null };
    },
  };
}
