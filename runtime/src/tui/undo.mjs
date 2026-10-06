// Wires checkpoints (harness/checkpoints.mjs) into a session and the app
// (plan Part 10). A turn's "before" is a snapshot started when the prompt is
// sent and finished before the turn starts, so nothing the agent does can be
// in it (the typing snapshot only warms git's caches). Not ready within
// `waitMs`: that turn has no checkpoint, never a guess. Its "after" is a
// snapshot started after it ended. /undo undoes only the last finished
// turn, and only the files the agent's applied edits reported, as those edits
// left them: each is hashed when its edit completes, so a change by the user
// (or a command) during the turn is a conflict, not undone with the turn.

import { realpathSync } from "node:fs";
import path from "node:path";
import { FORCEABLE, UNDO_LIMITS } from "../harness/checkpoints.mjs";

/**
 * The lines an edit's diff adds and removes, as text (a trailing CR dropped),
 * read from Codex's raw diff: hunk lines for an update, the content for an add
 * or a delete (split as git counts lines).
 */
export function diffLines(c) {
  const raw = String(c.diff ?? "");
  const cut = (l) => l.replace(/\r$/, "");
  if (c.kind === "add" || c.kind === "delete") {
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return c.kind === "add" ? { plus: lines.map(cut), minus: [] } : { plus: [], minus: lines.map(cut) };
  }
  const plus = [];
  const minus = [];
  let inHunk = false;
  for (const l of raw.split("\n")) {
    if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && l.startsWith("+")) plus.push(cut(l.slice(1)));
    else if (inHunk && l.startsWith("-")) minus.push(cut(l.slice(1)));
  }
  return { plus, minus };
}

// The real path, in its true case, of a file that may no longer exist (a
// deleted file: its nearest existing folder's real path, plus the rest).
function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const dir = path.dirname(p);
    return dir === p ? p : path.join(realPath(dir), path.basename(p));
  }
}

const unwrapPrivate = (t) => {
  const m = /^<private>([\s\S]*)<\/private>$/.exec(String(t ?? ""));
  return m ? m[1] : t;
};

export function checkpointWiring(cp, { cwd = process.cwd(), waitMs = 10_000, typingEveryMs = 5000, now = () => Date.now() } = {}) {
  let pendingBefore = null; // {snap}: the "before" of the turn this prompt starts
  let undoing = null; // a running /undo: a new turn waits for it
  let lastTyping = -Infinity;
  const befores = new Map(); // turnId → its "before" snapshot
  const recorded = new Map(); // turnId → {skipped, agentBlobs}
  const written = new Map(); // turnId → [promise of {path: blob}] per applied edit, in order
  let hashing = Promise.resolve(); // one hash run at a time, in edit order
  const missing = new Map(); // turnId → why there is none
  const recording = new Map(); // turnId → promise of the after snapshot + record

  const hooks = {
    async beforeTurn({ input }) {
      if (undoing) await undoing.catch(() => {});
      // Started now, when the prompt is sent: anything the user saved before
      // pressing Enter is in it. Awaited: the turn starts only after it, so no
      // command or edit of the agent's can be in it.
      const snap = await cp.beforeSnapshot({ since: now(), waitMs }).catch(() => null);
      pendingBefore = { snap };
      return input;
    },
    turnStarted({ turn }) {
      if (pendingBefore?.snap) befores.set(turn.id, pendingBefore.snap);
      else missing.set(turn.id, !pendingBefore ? "it wasn't started from a prompt here" : cp.lastError ? `snapshots fail here: ${cp.lastError}` : "the snapshot before it wasn't ready in time");
      pendingBefore = null;
    },
    /** The prompt's turn/start failed: its "before" must not go to a turn the server starts later (a review, a goal). */
    turnStartFailed() {
      pendingBefore = null;
    },
    /** An applied edit: hash its files now, as the agent left them. */
    itemCompleted({ item }) {
      if (item?.kind !== "fileChange" || item.status !== "completed" || !item.turnId) return;
      const run = hashing.then(async () => {
        const r = await cp.repo();
        return r ? editResult(item, r.root) : { hashes: {}, chain: [] };
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
        const agentChain = [];
        for (const { hashes = {}, chain = [] } of await Promise.all((written.get(turn.id) ?? []).map((w) => w.catch(() => ({ chain: [{ src: null }] }))))) {
          agentChain.push(...chain);
          // Re-inserted, so the latest edit comes last (and wins when case is folded).
          for (const [p, blob] of Object.entries(hashes)) {
            delete agentBlobs[p];
            agentBlobs[p] = blob;
          }
        }
        // What either snapshot left out was never captured on that side.
        const skipped = [...new Set([...(before.skipped ?? []), ...(after.skipped ?? [])])];
        // An edit whose result couldn't be read breaks the chain: no checkpoint rather than a guess.
        if (agentChain.some((e) => !e.src)) return void missing.set(turn.id, "an edit's result couldn't be read");
        if (await cp.record(threadId, turn.id, { before: before.tree, after: after.tree }).catch(() => false)) recorded.set(turn.id, { skipped, agentBlobs, agentChain });
      })();
      job.finally(() => written.delete(turn.id));
      recording.set(turn.id, job);
      job.finally(() => recording.delete(turn.id));
      return job;
    },
  };

  // An applied edit as it landed: each file's blob (hashed now), and per change
  // {src, dst, plus, minus, blob}: the lines its diff says it changed, for the chain check.
  async function editResult(item, root) {
    const changes = [];
    const foreign = [];
    for (const c of item.changes ?? []) {
      const [src] = relPaths({ changes: [{ path: c.path }] }, root);
      const to = c.movePath ?? c.kind?.move_path;
      const [dst] = to ? relPaths({ changes: [{ path: to }] }, root) : [src];
      // Moved in from outside the repo: its only copy is here, never something to delete.
      if (!src && dst) foreign.push(dst);
      if (!src || !dst) continue;
      changes.push({ src, dst, ...diffLines(c), kind: c.kind });
    }
    const hashes = await cp.hashPaths([...new Set(changes.flatMap((c) => [c.src, c.dst]))]);
    const chain = [
      ...changes.map(({ src, dst, plus, minus, kind }) => ({ src, dst, plus, minus, blob: kind === "delete" ? null : (hashes[dst] ?? null) })),
      ...foreign.map((dst) => ({ src: dst, dst, foreign: true })),
    ];
    return { hashes, chain };
  }

  // An edit's files, relative to the repo root, "/"-separated.
  function relPaths(item, root) {
    const out = [];
    const top = realPath(root);
    for (const c of item.changes ?? []) {
      for (const p of [c.path, c.movePath].filter(Boolean)) {
        // Both real: Codex may name the folder by an 8.3 short name, a junction
        // or a subst drive (C:\Users\RUNNER~1\…) while git names it by its long path.
        const rel = path.relative(top, realPath(path.resolve(cwd, p))).split(path.sep).join("/");
        if (rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)) out.push(rel);
      }
    }
    return out;
  }

  // Files the turn's edits reported.
  // Files the turn's applied edits reported in this repo, and how many were outside it.
  async function agentPaths(session, turn) {
    const r = await cp.repo();
    const out = [];
    let outside = 0;
    for (const id of turn.itemIds) {
      const it = session.state.items.get(id);
      // Only edits that were applied: a declined or failed patch isn't the agent's change.
      if (it?.kind !== "fileChange" || it.status !== "completed") continue;
      const named = (it.changes ?? []).flatMap((c) => [c.path, c.movePath].filter(Boolean)).length;
      const inside = relPaths(it, r.root);
      outside += named - inside.length;
      out.push(...inside);
    }
    return { paths: out, outside };
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
      const { skipped: left, agentBlobs, agentChain } = recorded.get(target.id);
      const { paths, outside } = await agentPaths(session, target);
      const r = await cp.restore(st.thread.id, target.id, { force, agentPaths: paths, skipped: left, agentBlobs, agentChain });
      // The force hint only where force can do something.
      const forceable = !force && (r.conflicts ?? []).some((c) => FORCEABLE.has(c.why) && c.why !== "a folder is there now");
      if (r.error) return { error: forceable ? `${r.error} /undo force puts the agent's files back anyway, discarding the changes made after its edit; the rest are never touched.` : r.error };
      const um = target.itemIds.map((id) => st.items.get(id)).find((i) => i?.kind === "userMessage");
      recorded.delete(target.id);
      try {
        await session.revert(target.id);
      } catch (err) {
        return { error: `Files put back (${r.restored}), but the conversation couldn't be rewound: ${err?.message ?? err}. Esc Esc rewinds it.` };
      }
      const n = r.restored;
      const skipped = `${r.skipped ? ` ${r.skipped} left alone (not the agent's edit, not in the checkpoint, or a folder is there now).` : ""}${outside ? ` ${outside} edit${outside === 1 ? " outside this repo wasn't" : "s outside this repo weren't"} touched.` : ""}`;
      const exact = r.byteExact ? "" : " Git can't skip every attributes file here (git older than 2.40, .git/info/attributes or core.attributesFile): files with eol rules may come back normalized.";
      return { message: `Undid the last turn: ${n} file${n === 1 ? "" : "s"} put back.${skipped} ${UNDO_LIMITS}${exact}`, prompt: um ? unwrapPrivate(um.text) : null };
  }
}
