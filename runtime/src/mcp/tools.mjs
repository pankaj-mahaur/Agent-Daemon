// The memory server's tools (P5.1): names, arguments and the scope enum are
// unchanged from 3.0; each gains a title, a closed input schema with integer
// ids and bounds, and annotations. Annotations are hints for the client, not
// a security boundary: memory_get bumps retrieval counters and memory_feedback
// writes a usefulness verdict, so neither claims to be read-only.

export const MAX_RESULTS = 5;
export const MAX_TIMELINE = 50;
export const MAX_IDS = 20;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SCOPE = { type: "string", enum: ["project", "global", "any"], description: "default any (this project's notes and notes accepted as global)" };
const LIMIT = (max) => ({ type: "integer", minimum: 1, maximum: max, description: `max results (1–${max})` });
const ID = { type: "integer", minimum: 1, description: "learning id (shown as [id N] in index results)" };
const closed = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

/** In a fixed order. */
export const TOOLS = Object.freeze([
  {
    name: "memory_search",
    title: "Search memory",
    description: "Search this project's memory (BM25 + freshness ranking) for past learnings, corrections, gotchas and decisions. Returns compact [id …] lines, the index layer: drill in with memory_timeline(id), then memory_get(ids). Use when you need project history the current context doesn't show.",
    inputSchema: closed({ query: { type: "string", description: "free-text search query" }, scope: SCOPE, limit: LIMIT(MAX_RESULTS) }, ["query"]),
    annotations: { title: "Search memory", ...READ_ONLY },
  },
  {
    name: "memory_recent",
    title: "Recent learnings",
    description: "The most recent learnings for this project, as index lines; pair with memory_get(ids) for detail.",
    inputSchema: closed({ limit: LIMIT(MAX_RESULTS) }),
    annotations: { title: "Recent learnings", ...READ_ONLY },
  },
  {
    name: "memory_files",
    title: "Learnings about a file",
    description: "Learnings that mention a file (by path or basename): what was learned while working on it. Index layer; drill in with memory_get(ids).",
    inputSchema: closed({ path: { type: "string", description: "file path or basename, e.g. 'src/auth.ts' or 'auth.ts'" }, scope: SCOPE, limit: LIMIT(MAX_RESULTS) }, ["path"]),
    annotations: { title: "Learnings about a file", ...READ_ONLY },
  },
  {
    name: "memory_timeline",
    title: "Learning in context",
    description: "Context layer: given a learning id, its originating session and the other learnings from that session, in order.",
    inputSchema: closed({ id: ID, limit: LIMIT(MAX_TIMELINE) }, ["id"]),
    annotations: { title: "Learning in context", ...READ_ONLY },
  },
  {
    name: "memory_get",
    title: "Get learnings",
    description: "Detail layer: full learnings by id (text, evidence quote, tags, confidence and which session or date they came from). Batch the ids in one call. Reading a learning counts it as retrieved.",
    inputSchema: closed({ ids: { type: "array", items: ID, minItems: 1, maxItems: MAX_IDS, description: `learning ids to expand (up to ${MAX_IDS})` } }, ["ids"]),
    annotations: { title: "Get learnings", ...WRITES },
  },
  {
    name: "memory_profile",
    title: "How this user works",
    description: "A deterministic summary of how this user works in this project: facts and high-confidence stated learnings rolled up into identity, prefers, tools, conventions and watch-outs.",
    inputSchema: closed({}),
    annotations: { title: "How this user works", ...READ_ONLY },
  },
  {
    name: "memory_stats",
    title: "Memory scope and counts",
    description: "Which project this server is bound to, and this project's learning and fact counts.",
    inputSchema: closed({}),
    annotations: { title: "Memory scope and counts", ...READ_ONLY },
  },
  {
    name: "user_facts_list",
    title: "User facts",
    description: "The user facts recorded for this project (preferences and conventions).",
    inputSchema: closed({}),
    annotations: { title: "User facts", ...READ_ONLY },
  },
  {
    name: "memory_feedback",
    title: "Rate a learning",
    description: "Record whether a learning was useful: verdict useful, stale or wrong. Feeds ranking and consolidation.",
    inputSchema: closed({ id: ID, verdict: { type: "string", enum: ["useful", "stale", "wrong"] } }, ["id", "verdict"]),
    annotations: { title: "Rate a learning", ...WRITES },
  },
]);
