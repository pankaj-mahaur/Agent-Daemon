// Clusters become proposals (MCP launch plan L4b, 02 §6). With the user's consent,
// the corrections they repeated to Claude Code and Codex in this project become
// pending notes for review (provenance `transcript`), and history_clusters records
// what was found (memory/proposal-tables.mjs).
//
// What is stored, and nothing else from the history:
//   - a cluster repeated 2 or more times: its redacted label (L4a's most frequent
//     wording, ≤ 200 characters), as the note's text and in history_clusters;
//   - every cluster: keyed hashes of its wordings, its counts, agents and dates.
// No other wording, no prompt that isn't a correction, no evidence, no session id.
//
// The repeat count is summed per session with at most 3 from one session, so a loop
// can't stand for many repeats. At most 20 new proposals per import (the most repeated
// first); the rest wait in history_clusters for a later import. Every note is `pending`
// (or `quarantined` when the screen flags it): only the review service accepts a note
// (02 §2.2). A note the user already has is linked, never written or reinforced. A
// rejected proposal is never proposed again, even after retention changes its wording.
// Once proposed, the sentence lives only in the note: rejecting or purging the note
// removes the last copy.

import os from "node:os";
import { listSources, readPrompts } from "../mistakes/history.mjs";
import { classifyPrompt } from "../mistakes/classify.mjs";
import { clusterCorrections, clusterLabel } from "../mistakes/cluster.mjs";
import { redactSentence, accountNames } from "../mistakes/redact.mjs";
import { redactSecrets } from "../security/secret-patterns.mjs";
import { screenLearning, neutralizeText } from "../digest/sanitize.mjs";
import { writeLearning, sameNote } from "./episodic.mjs";
import { normKey } from "./sqlite.mjs";
import { idOfKeys, slugOfKeys, projectClause } from "./projects.mjs";
import { pendingSql } from "./trust.mjs";
import { ensureProposalTables, historyHashKey, keyedHash, rejectedHashes } from "./proposal-tables.mjs";
import { purgeLearnings } from "./purge.mjs";

export const MIN_REPEATS = 2;
export const PER_SESSION = 3;
export const MAX_PROPOSED = 20;
export const MAX_MEMBERS = 50;
export const PROVENANCE = "transcript";

/** The L4a clusters of these typed prompts (pure). */
export function historyClusters(prompts) {
  const corrections = [];
  for (const p of prompts) {
    const c = classifyPrompt(p.text);
    if (c.correction) corrections.push({ host: p.host, ts: p.ts ?? null, sentence: c.sentence, session: p.session ?? null });
  }
  return clusterCorrections(corrections);
}

/** Repeats, at most PER_SESSION from one session (all of them when no session is known). */
export function repeatCount(c) {
  const per = Object.values(c.sessions ?? {});
  if (!per.length) return c.count;
  const counted = per.reduce((a, n) => a + Math.min(n, PER_SESSION), 0);
  // Repeats without a session id count one each.
  return counted + Math.max(0, c.count - per.reduce((a, n) => a + n, 0));
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const minIso = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxIso = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);

function json(s, fallback) {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
}

function screen(text) {
  try {
    return screenLearning({ text, evidence_quote: "", tags: [] });
  } catch {
    // a screen error counts as clean: the read-time check (render-safe.mjs) is the second layer
    return { verdict: "clean", reasons: [] };
  }
}

/**
 * Store clusters for one project and propose the most repeated. One transaction.
 * @param {any} handle  an open store (memory/sqlite.mjs open())
 * @param {{clusters:object[], keys:string[], now?:Date, redact?:object, max?:number}} opts
 *   clusters from historyClusters; redact: redactSentence's options (home, names)
 */
export function storeClusters(handle, { clusters, keys, now = new Date(), redact = {}, max = MAX_PROPOSED }) {
  const projectId = idOfKeys(keys);
  const slug = slugOfKeys(keys);
  if (!projectId && !slug) return { skipped: "no-project" };
  const t = now.toISOString();
  const out = { clusters: clusters.length, repeats: 0, singles: 0, proposed: 0, quarantined: 0, linked: 0, waiting: 0, rejectedBefore: 0 };
  handle.transaction(() => {
    ensureProposalTables(handle);
    const hk = historyHashKey();
    const rejected = rejectedHashes(handle, keys);
    const scope = projectClause("", keys);
    const rows = handle.all(`SELECT * FROM history_clusters WHERE ${scope.sql} ORDER BY id`, scope.params).map((r) => ({ ...r, members: json(r.member_hashes, []) }));
    const byMember = new Map();
    for (const r of rows) for (const m of r.members) if (!byMember.has(m)) byMember.set(m, r);
    // Sentences proposed here before: one the user rejected (its note deleted, its
    // sentence cleared) stays rejected whatever its cluster id or wording became.
    const proposedKeys = new Set(rows.filter((r) => r.proposed_at && r.sentence_key).map((r) => r.sentence_key));

    const touched = new Set();
    for (const c of clusters) {
      const members = c.memberKeys?.length ? c.memberKeys.map((k) => keyedHash(hk, k)) : [keyedHash(hk, c.key ?? c.id)];
      // A tombstoned match (proposed before) wins when the wordings match several rows.
      const matches = members.map((m) => byMember.get(m)).filter(Boolean);
      let row = matches.find((x) => x.proposed_at) ?? matches[0];
      if (!row) {
        row = { id: null, cluster_id: members[0], members: [], sentence: null, sentence_key: null, count: 0, sessions: 0, hosts: "{}", first_ts: null, last_ts: null, learning_id: null, proposed_at: null };
        rows.push(row);
      }
      for (const m of members) {
        if (row.members.length < MAX_MEMBERS && !row.members.includes(m)) row.members.push(m);
        if (!byMember.has(m)) byMember.set(m, row);
      }
      // Retention only removes history, so nothing goes down.
      row.count = Math.max(row.count, repeatCount(c));
      row.sessions = Math.max(row.sessions, Object.keys(c.sessions ?? {}).length);
      const hosts = json(row.hosts, {});
      for (const [h, n] of Object.entries(c.hosts ?? {})) hosts[h] = Math.max(Number(hosts[h] ?? 0), n);
      row.hosts = JSON.stringify(hosts);
      row.first_ts = minIso(row.first_ts, iso(c.firstTs));
      row.last_ts = maxIso(row.last_ts, iso(c.lastTs));
      // The text only for a repeat, and never back for one already proposed (a rejected
      // one's sentence was cleared on purpose).
      if (row.count >= MIN_REPEATS && !row.sentence && !row.proposed_at) {
        // Redacted as the note will store it (writeLearning redacts secrets again: a no-op).
        const label = redactSecrets(redactSentence(clusterLabel(c.sentences), redact)).text;
        if (label) {
          row.sentence = label;
          row.sentence_key = keyedHash(hk, normKey(label));
        }
      }
      touched.add(row);
    }

    // Propose the most repeated waiting clusters, up to the cap (counting the history
    // proposals still waiting for review).
    const lk = projectClause("", keys);
    const waiting = handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE provenance = ? AND (${pendingSql()} OR status = 'quarantined') AND ${lk.sql}`, [PROVENANCE, ...lk.params]).n;
    let room = Math.max(0, max - waiting);
    const candidates = rows.filter((r) => r.count >= MIN_REPEATS && !r.proposed_at && r.sentence).sort((a, b) => b.count - a.count || cmp(b.last_ts, a.last_ts) || cmp(a.cluster_id, b.cluster_id));
    for (const r of candidates) {
      if (proposedKeys.has(r.sentence_key) || rejected.has(r.sentence_key) || r.members.some((m) => rejected.has(m))) {
        // Rejected before under another wording or id: keep only the hashes.
        r.proposed_at = t;
        r.sentence = null;
        out.rejectedBefore++;
        touched.add(r);
        continue;
      }
      if (room <= 0) {
        out.waiting++;
        continue;
      }
      r.learning_id = propose(handle, { text: r.sentence, count: r.count, slug, projectId, out });
      r.proposed_at = t;
      proposedKeys.add(r.sentence_key);
      room--;
      touched.add(r);
    }
    for (const r of rows) {
      if (r.count >= MIN_REPEATS && r.proposed_at && r.learning_id != null) bumpPending(handle, r.learning_id, r.count);
    }
    for (const r of touched) {
      if (r.count >= MIN_REPEATS) out.repeats++;
      else out.singles++;
      // The text stays here only while the cluster waits; once proposed it lives in the note.
      const values = [projectId, slug, r.cluster_id, JSON.stringify(r.members), r.count >= MIN_REPEATS && !r.proposed_at ? r.sentence : null, r.count >= MIN_REPEATS ? r.sentence_key : null, r.count, r.sessions, r.hosts, r.first_ts, r.last_ts, r.learning_id, r.proposed_at, t];
      if (r.id == null) {
        r.id = Number(
          handle.run(
            `INSERT INTO history_clusters (project_id, project_slug, cluster_id, member_hashes, sentence, sentence_key, count, sessions, hosts, first_ts, last_ts, learning_id, proposed_at, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            values
          ).lastInsertRowid
        );
      } else {
        handle.run(
          `UPDATE history_clusters SET project_id = ?, project_slug = ?, cluster_id = ?, member_hashes = ?, sentence = ?, sentence_key = ?, count = ?, sessions = ?, hosts = ?,
             first_ts = ?, last_ts = ?, learning_id = ?, proposed_at = ?, imported_at = ? WHERE id = ?`,
          [...values, r.id]
        );
      }
    }
  });
  return out;
}

const cmp = (a, b) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);

// A pending note's repeat count follows the history (never down): MAX, not a sum, since
// the history may hold the very repeat a capture already counted.
// Only the import's own proposals: a note the user saved keeps its own count (the queue
// shows the history's count beside it).
function bumpPending(handle, id, count) {
  handle.run(`UPDATE learnings SET observed_count = MAX(observed_count, ?) WHERE id = ? AND provenance = ? AND ${pendingSql()}`, [count, id, PROVENANCE]);
}

function propose(handle, { text, count, slug, projectId, out }) {
  // What the note will hold (a flagged sentence neutralised; secrets were redacted with
  // the sentence): the lookup and the fallback use it, so nothing goes through
  // writeLearning's reinforce path.
  const s = screen(text);
  const flagged = s.verdict === "suspicious";
  const stored = flagged ? neutralizeText(text) : text;
  const same = sameNote(handle, slug, stored, normKey(stored), projectId);
  if (same) {
    // The user already has this note (pending, accepted, hidden or dropped): link it,
    // write nothing (writeLearning would reinforce it).
    out.linked++;
    return same.id;
  }
  const id = writeLearning(handle, {
    projectSlug: slug,
    projectId,
    category: "correction",
    text: stored,
    confidence: 0.7,
    origin: "user",
    status: flagged ? "quarantined" : "pending",
    quarantineReason: flagged ? `injection:${s.reasons.join(",")}` : null,
    appliedTo: flagged ? "quarantined" : "proposed:history",
  });
  if (id == null) {
    // The store held this text under a key sameNote doesn't look at (a 3.0 row).
    out.linked++;
    return sameNote(handle, slug, stored, normKey(stored), projectId)?.id ?? null;
  }
  // Never accepted here: the status was written pending or quarantined above; the
  // provenance and the repeat count are the only columns this sets.
  handle.run("UPDATE learnings SET provenance = ?, observed_count = ? WHERE id = ? AND accepted_by IS NULL", [PROVENANCE, count, id]);
  if (flagged) out.quarantined++;
  else out.proposed++;
  return Number(id);
}

/**
 * Read this project's Claude Code and Codex history and propose its repeated corrections.
 * Nothing is listed or read unless consent is exactly true.
 * @param {{handle:any, keys:string[], root:string, consent:boolean, env?:object, home?:string, now?:Date,
 *          list?:typeof listSources, read?:typeof readPrompts, max?:number}} opts
 *   root: the project folder (L4a's findProject root); keys: its memory keys
 */
export function importHistory({ handle, keys, root, consent, env = process.env, home = os.homedir(), now = new Date(), list = listSources, read = readPrompts, max }) {
  if (consent !== true) return { skipped: "no-consent" };
  if (!handle) return { skipped: "no-store" };
  if (!(idOfKeys(keys) ?? slugOfKeys(keys)) || !root) return { skipped: "no-project" };
  // Only sessions started in the project folder itself: memory is kept per folder, so a
  // subfolder's sessions belong to that folder's notes, not these.
  const sources = { ...list({ env, home, cwd: root }), exactFolder: true };
  const { prompts } = read(sources);
  const clusters = historyClusters(prompts);
  return storeClusters(handle, { clusters, keys, now, max, redact: { home, names: accountNames({ home, env }) } });
}

/**
 * Forget what the history import found in this project (L8's `report --purge` calls
 * this): its rows, and its proposals still waiting for review (hard deleted, the store
 * compacted). Accepted notes stay; so do the user's rejections (hashes only).
 * → { rows, notes }
 */
export function purgeHistory(handle, keys) {
  const p = projectClause("", keys);
  if (!handle.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'history_clusters'")) return { rows: 0, notes: 0 };
  const ids = handle.all(`SELECT id FROM learnings WHERE provenance = ? AND (${pendingSql()} OR status = 'quarantined') AND ${p.sql}`, [PROVENANCE, ...p.params]).map((r) => r.id);
  const rows = handle.run(`DELETE FROM history_clusters WHERE ${p.sql}`, p.params).changes;
  purgeLearnings(handle, ids);
  return { rows, notes: ids.length };
}
