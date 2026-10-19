// MemoryService (P5.1): what the memory server's tools return, as data.
// Visibility, promotion states, collisions and the unbound rule come from the
// scope (memory/scope.mjs) and episodic.mjs's readers (plan §M); this layer
// adds input validation. The MCP layer turns its results into text.

import {
  buildUserRepresentation,
  getLearningsByIds,
  learningTimeline,
  listRecentLearnings,
  listUserFacts,
  markRetrieved,
  projectStats,
  recordFeedback,
  searchLearnings,
  searchLearningsByFile,
} from "./episodic.mjs";

/** An integer 1..max; anything else (negative, NaN, a string, huge) → dflt or max. */
export function clampLimit(v, max, dflt = max) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return Math.min(dflt, max);
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

const scopeArg = (s) => (["project", "global", "any"].includes(s) ? s : "any");
const ids = (list, max) => (Array.isArray(list) ? list : []).filter((v) => Number.isInteger(v) && v > 0).slice(0, max);

/**
 * scope: a bound project scope from resolveMemoryScope ({kind: "project", keys}), or
 * {kind: "cross-project"} from --allow-cross-project. Every reader gets those keys;
 * nothing here widens them.
 */
export function createMemoryService({ scope, maxResults = 5, maxTimeline = 50, maxIds = 20 }) {
  // --allow-cross-project (launch config only): keys null = every project's non-quarantined notes.
  if (scope?.kind !== "project" && scope?.kind !== "cross-project") throw new Error("the memory service needs a project scope");
  const projectKeys = scope.kind === "cross-project" ? null : scope.keys;
  return {
    search: ({ query, scope: s, limit } = {}) => searchLearnings(String(query ?? ""), { projectKeys, scope: scopeArg(s), limit: clampLimit(limit, maxResults) }),
    recent: ({ limit } = {}) => listRecentLearnings({ projectKeys, limit: clampLimit(limit, maxResults) }),
    files: ({ path, scope: s, limit } = {}) => searchLearningsByFile(String(path ?? ""), { projectKeys, scope: scopeArg(s), limit: clampLimit(limit, maxResults) }),
    timeline: ({ id, limit } = {}) => (Number.isInteger(id) && id > 0 ? learningTimeline(id, { limit: clampLimit(limit, maxTimeline, 10), projectKeys }) : null),
    /** Reading a learning in full counts it as retrieved (ranking signal). */
    async get({ ids: list } = {}) {
      const rows = await getLearningsByIds(ids(list, maxIds), { projectKeys });
      if (rows.length) {
        try {
          await markRetrieved(rows.map((r) => r.id));
        } catch {
          // a ranking signal only: never fails the read
        }
      }
      return rows;
    },
    profile: () => buildUserRepresentation({ projectKeys }),
    stats: () => projectStats({ projectKeys }),
    userFacts: () => listUserFacts({ projectKeys }),
    /** → {changed} ; throws on bad input (the tool's message). */
    async feedback({ id, verdict } = {}) {
      if (!Number.isInteger(id) || id < 1 || !["useful", "stale", "wrong"].includes(verdict)) throw new Error("memory_feedback needs a whole-number id and a verdict: useful, stale or wrong.");
      return recordFeedback({ id, verdict, projectKeys });
    },
  };
}
