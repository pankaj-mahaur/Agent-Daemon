// The guards.json snapshot, projected from the rules store (MCP launch plan L7, design D3).
// The hook (tool.before) never opens SQLite: it reads this file. The projection never
// changes the store and never drops a rule early:
//   - a rule is emitted while its learning was ever accepted (accepted, forget-requested,
//     superseded, archived, quarantined …) or after its learning was deleted (orphaned) —
//     only the review service with the user's confirmation (removeRule, maintainRules)
//     ends a rule;
//   - a rebuild without a review token is one-way (S1): it refuses a store whose id isn't
//     the one the snapshot was built from, and keeps every rule, project, root and pause-
//     free state the previous snapshot had — it may add, and may drop what has expired
//     (allow-once tokens, pauses), both of which only raise enforcement;
//   - pause state is copied with its `until`; readers decide at read time whether it holds;
//   - allow-once tokens outlive their expiry by a grace period, and so do their consumed
//     markers, so neither a hook holding the old snapshot nor guards.last-good.json can
//     revive a consumed token.
// guards.active exists while rules do: both snapshot files unreadable then means
// "can't check" (the hook's failure path), never "no rules".

import fs from "node:fs";
import path from "node:path";
import { readRegistry } from "./projects.mjs";
import { isReviewToken } from "./review-service.mjs";
import { pausedState } from "./rules-service.mjs";
import { noRulesTable, rulesRev, storeId } from "./rules-tables.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { activePath, consumedDir, loadGuards, readActive, writeGuards } from "../hooks/guards.mjs";

/** Seconds an allow-once token (and its marker) is kept past its expiry. */
export const ALLOW_ONCE_GRACE_MS = 60_000;

const realOf = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null; // a folder that is gone keeps its logical path only
  }
};

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The rules the hook enforces: every rule whose learning was ever accepted, or that has no learning (L7b). */
function emittedRules(handle) {
  try {
    return handle.all(
      `SELECT r.* FROM rules r LEFT JOIN learnings l ON l.id = r.learning_id
        WHERE (r.learning_id IS NULL AND (r.source <> 'learning' OR r.orphaned_at IS NOT NULL)) OR (l.id IS NOT NULL AND l.accepted_by IS NOT NULL)
        ORDER BY r.id`
    );
  } catch (e) {
    // Only an older store with no rules table means "no rules"; a read error is an error
    // (turning it into zero rules would drop every rule and the sentinel).
    if (noRulesTable(e)) return [];
    throw e;
  }
}

const asGuard = (r) => {
  const rule = parse(r.pattern);
  return rule ? { id: r.id, kind: r.kind, decision: r.decision === "deny" ? "deny" : "ask", reason: r.reason, scope: r.scope, project: r.project_id, rule } : null;
};

const fold = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
const sep = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
/** Does one folder hold the other (either way)? */
const nests = (a, b) => {
  const x = fold(path.resolve(a));
  const y = fold(path.resolve(b));
  return x === y || x.startsWith(sep(y)) || y.startsWith(sep(x));
};

/**
 * Build the snapshot (not written). → the snapshot object.
 * @param {any} handle the store
 * @param {{root:string, now?:Date, cmd?:string, previous?:object|null, token?:object|null, addAllowOnce?:object[]}} o
 */
const otherStore = () => {
  const e = new Error("rebuildGuards: this isn't the store the rules snapshot was built from; run review in your own terminal to rebuild it");
  e.code = "OTHER_STORE";
  return e;
};

export function buildSnapshot(handle, { root, now = new Date(), cmd = null, previous = null, token = null, addAllowOnce = [] } = {}) {
  const trusted = isReviewToken(token);
  const id = storeId(handle);
  // S1: a tokenless rebuild from another store (an empty one, AD_MEMORY_DB, a job given
  // another path) would drop every rule.
  if (!trusted && previous?.store_id && previous.store_id !== id) throw otherStore();
  if (!trusted && addAllowOnce.length) throw new Error("rebuildGuards: allow-once needs a review token");
  let registry = { projects: [] };
  try {
    registry = readRegistry({ env: { AD_ROOT: root } });
  } catch {
    // a newer ad's registry: roots come from the previous snapshot only
  }
  const nowMs = now.getTime();
  const live = (p) => p && (p.until === null || Date.parse(p.until) > nowMs);
  const stored = pausedState(handle);
  // Pauses lower enforcement: a tokenless rebuild keeps one only where the previous
  // snapshot had it too (and drops it once it ends).
  // Without the token a pause comes only from the previous snapshot, still in the store,
  // not yet ended, and never longer than either says (S1).
  const earliest = (a, b) => (a === null ? b : b === null ? a : Date.parse(a) <= Date.parse(b) ? a : b);
  const keepPause = (fromStore, fromPrev) => {
    if (trusted) return fromStore ?? false;
    if (!fromStore || !fromPrev || !live(fromPrev) || !live(fromStore)) return false;
    return { at: fromPrev.at, until: earliest(fromPrev.until ?? null, fromStore.until ?? null) };
  };
  const pausedAll = keepPause(stored.all, previous?.pausedAll ?? null) || null;
  const projects = {};
  const global = { rules: [] };
  const seen = new Set();
  const add = (g) => {
    if (!g) return;
    // A rule without a numeric id (no writer of ours makes one) is kept, never deduplicated away.
    if (Number.isInteger(g.id)) {
      if (seen.has(g.id)) return;
      seen.add(g.id);
    }
    if (g.scope === "all") {
      global.rules.push(g);
      return;
    }
    if (!g.project) return;
    projects[g.project] ??= { roots: [], paused: false, rules: [] };
    projects[g.project].rules.push(g);
  };
  if (!trusted && previous) {
    // One-way (S1): every rule the previous snapshot enforced stays exactly as it was —
    // added first, so a store row with the same id (a laxer decision, a narrower pattern,
    // a smaller scope) can't replace it without the token.
    for (const g of previous.global?.rules ?? []) add({ ...g, scope: "all" });
    for (const [pid, p] of Object.entries(previous.projects ?? {})) {
      for (const g of p?.rules ?? []) add({ ...g, scope: "project", project: pid });
      projects[pid] ??= { roots: [], paused: false, rules: [] };
    }
  }
  for (const r of emittedRules(handle)) add(asGuard(r));
  for (const pid of Object.keys(stored.projects)) if (trusted) projects[pid] ??= { roots: [], paused: false, rules: [] };
  for (const [pid, p] of Object.entries(projects)) {
    p.paused = keepPause(stored.projects[pid], previous?.projects?.[pid]?.paused) || false;
    const entry = registry.projects?.find((e) => e.id === pid);
    const roots = new Set();
    for (const x of entry?.paths ?? []) {
      if (!x?.path) continue;
      roots.add(path.resolve(x.path));
      const real = realOf(x.path);
      if (real) roots.add(real);
    }
    p.roots = [...roots];
  }
  if (!trusted) {
    // Without the token (S1): a root the last snapshot had stays (the registry needs no token
    // to change), and a new root may not nest inside or around another project's root — the
    // longest-prefix lookup would hand that folder to a project with fewer rules.
    const before = (pid) => previous?.projects?.[pid]?.roots ?? [];
    const others = (pid) => Object.entries(previous?.projects ?? {}).filter(([o]) => o !== pid).flatMap(([, q]) => q?.roots ?? []);
    for (const [pid, p] of Object.entries(projects)) {
      const kept = new Set(before(pid));
      for (const r of p.roots) if (kept.has(r) || !others(pid).some((o) => nests(r, o))) kept.add(r);
      p.roots = [...kept];
    }
  }
  const allowOnce = [...(Array.isArray(previous?.allowOnce) ? previous.allowOnce : []), ...addAllowOnce].filter(
    (t) => t && typeof t.nonce === "string" && /^[0-9a-f]{32}$/.test(t.nonce) && Date.parse(t.expires) + ALLOW_ONCE_GRACE_MS > nowMs
  );
  const ruleCount = Object.values(projects).reduce((n, p) => n + p.rules.length, 0) + global.rules.length;
  return {
    version: 1,
    projects,
    global,
    pausedAll,
    allowOnce,
    ruleCount,
    rules_rev: rulesRev(handle),
    store_id: id ?? previous?.store_id ?? null,
    cmd: cmd ?? previous?.cmd ?? "ad",
  };
}

/** Delete consumed markers whose token left the snapshot (expired past the grace). */
function sweepMarkers(root, keep) {
  let names = [];
  try {
    names = fs.readdirSync(consumedDir(root));
  } catch {
    return; // none yet
  }
  for (const f of names) {
    if (/^[0-9a-f]{32}$/.test(f) && !keep.has(f)) fs.rmSync(path.join(consumedDir(root), f), { force: true });
  }
}

/**
 * Rebuild guards.json from the store, under the guards lock. Tokenless callers (repair, the
 * session-start refresh job) get the never-shrink-roots rule. → {generation, ruleCount}
 * @param {any} handle
 * @param {{root:string, token?:object|null, now?:Date, cmd?:string|null, addAllowOnce?:object[], waitMs?:number}} o
 */
export async function rebuildGuards(handle, { root, token = null, now = new Date(), cmd = null, addAllowOnce = [], waitMs = 10_000 } = {}) {
  if (!root) throw new Error("rebuildGuards: no root");
  const release = await acquireLockWithin("guards", { dir: path.join(root, "locks"), waitMs });
  try {
    const loaded = loadGuards({ root });
    const active = readActive({ root });
    if (!isReviewToken(token) && active) {
      // S1: while rules exist, a tokenless rebuild needs the current snapshot to build on (a
      // last-good copy is older; none at all would read as "no rules") and the same store.
      if (loaded.source !== "current") {
        const e = new Error("rebuildGuards: the rules snapshot can't be read; run review in your own terminal to rebuild it");
        e.code = "NO_SNAPSHOT";
        throw e;
      }
      if (active.store_id && active.store_id !== storeId(handle)) throw otherStore();
    }
    const previous = loaded.snapshot;
    const snap = buildSnapshot(handle, { root, now, cmd, previous, token, addAllowOnce });
    // The sentinel goes first when rules exist and last when they don't: a reader that finds
    // both snapshot files unreadable must never mistake rules for none. Only a token run
    // removes it (a tokenless one keeps every rule, so its count never reaches 0 from >0).
    if (snap.ruleCount > 0) fs.writeFileSync(activePath(root), `${JSON.stringify({ ruleCount: snap.ruleCount, store_id: snap.store_id })}\n`);
    const generation = writeGuards(snap, { root, now: now.getTime() });
    if (snap.ruleCount === 0 && isReviewToken(token)) fs.rmSync(activePath(root), { force: true });
    sweepMarkers(root, new Set(snap.allowOnce.map((t) => t.nonce)));
    return { generation, ruleCount: snap.ruleCount };
  } finally {
    release();
  }
}
