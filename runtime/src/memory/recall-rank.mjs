// The recall core's ranking (MCP launch plan L6, design decisions 2, 4, 5): pure.
//
// BM25 over one project's own notes (project-local IDF: another project's notes
// never move this one's scores), against either the repo context (the session
// brief) or the prompt (prompt-time recall, the recall command). A note that a
// much newer note on the same subject replaces is left out everywhere. Numbers
// come from spike S-L6-RANK on the dev set (test/fixtures/recall-dev), never from
// the held-out corpora.

const EN_STOP = "a an the and or but if then else of to in on at by for from with without into onto over under about as is are was were be been being am do does did doing done have has had having it its this that these those there here we our ours us you your yours i me my mine he she they them their what which who whom whose when where why how all any each every some such no not only own same so than too very can could should would will shall may might must just also via per vs etc please pls thanks thank ok okay yes yeah hey hi let lets im ive dont doesnt isnt arent wasnt wont cant cannot".split(" ");
// Hinglish written in Latin script: the words that carry grammar, not the topic.
const HI_STOP = "hai hain ho hota hoti hote kaise kaisa kaisi kya kyu kyun kyon karo kar karna karte karein karu karun ka ki ke ko se me mein main mai ye yeh wo woh vo nahi nhi na bhi aur toh jo kab liye wala wali wale chahiye batao bata dekho dekh kuch sab abhi ek apna apne mera meri mere mujhe hum humko tum aap phir fir sirf pe par tha thi the raha rahi rahe gaya gayi gaye hua hui hue lo lena dena hoga hogi hoge sakta sakti sakte yaar bhai jaldi plz thoda zara wahi yahi kidhar idhar udhar kaha kahan".split(" ");
const DEV_STOP = "use uses using used make makes made get gets got add adds added new thing things stuff way want need needs like just really something anything work works working file files code".split(" ");
const STOP = new Set([...EN_STOP, ...HI_STOP, ...DEV_STOP]);

/** Light stemming: plurals, -ing, -ed, -ation, a final e. Words with digits stay whole. */
export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("ied") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (/(?:s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith("ing") && s.length - 3 >= 3) s = undouble(s.slice(0, -3));
  else if (s.endsWith("ed") && s.length - 2 >= 3) s = undouble(s.slice(0, -2));
  if (s.endsWith("ation") && s.length > 6) s = s.slice(0, -5) + "ate";
  if (s.endsWith("e") && s.length > 4) s = s.slice(0, -1);
  return s;
}
const undouble = (s) => (/([b-df-hj-np-rtv-z])\1$/.test(s) && !/(?:ll|ss|zz)$/.test(s) ? s.slice(0, -1) : s);

/** Content terms of a text, in order, repeats kept (term frequency). */
export function terms(text) {
  const raw = String(text ?? "")
    .normalize("NFKC")
    .slice(0, 20_000)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/['’]/g, "");
  const out = [];
  for (const tok of raw.split(/[^\p{L}\p{N}]+/u)) {
    if (!tok) continue;
    // "postgres16" is kept whole and as its parts.
    const parts = /\d/.test(tok) && /\p{L}/u.test(tok) ? [tok, ...tok.split(/(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/u)] : [tok];
    for (const p of parts) {
      if (p.length < 2 || STOP.has(p)) continue;
      out.push(stem(p));
    }
  }
  return out;
}

// Folder names every project has: they match notes without telling anything.
const PATH_NOISE = new Set("src lib dist build internal pkg cmd app apps package packages index main mod init util utils helper helpers common shared core".split(" ").map(stem));
const BRANCH_TYPE = /^(?:feat|feature|fix|bugfix|hotfix|chore|docs|doc|refactor|build|ci|perf|style|test|tests|release|wip|dev|exp|spike)$/;
// A default branch's name says nothing about the work on it.
const DEFAULT_BRANCH = /^(?:main|master|develop|development|dev|trunk|default|stable)$/;

/**
 * Weighted query terms from the repo context: the branch's words (its type prefix
 * dropped) weigh 3, a path word 1.5 × (1 + ln of the paths sharing it), a commit word
 * 1 × (1 + ln of the subjects sharing it).
 * @param {{branch?: string|null, paths?: string[], commits?: string[]}} ctx
 * @returns {Map<string, number>}
 */
export function contextQuery({ branch = null, paths = [], commits = [] } = {}) {
  const q = new Map();
  const add = (t, x) => q.set(t, (q.get(t) ?? 0) + x);
  const segs = String(branch ?? "").split("/");
  const words = DEFAULT_BRANCH.test(String(branch ?? "")) ? "" : segs.filter((s, i) => !(i === 0 && segs.length > 1 && BRANCH_TYPE.test(s))).join(" ");
  for (const t of new Set(terms(words))) add(t, 3);
  const count = (list, strip) => {
    const n = new Map();
    for (const item of list ?? []) for (const t of new Set(terms(strip(String(item))))) if (!PATH_NOISE.has(t)) n.set(t, (n.get(t) ?? 0) + 1);
    return n;
  };
  for (const [t, n] of count(paths, (p) => p.replace(/\.[A-Za-z0-9]+$/, ""))) add(t, 1.5 * (1 + Math.log(n)));
  for (const [t, n] of count(commits, (c) => c)) add(t, 1 + Math.log(n));
  return q;
}

export const MAX_QUERY_TERMS = 64;

/**
 * Query terms of a prompt: the user's own words first (weight 1, a repeated word at
 * most 2), then words only found in pasted parts (code, quotes, logs) at half weight,
 * at most 64 distinct terms in all. own: the prompt's own words (the caller strips the
 * pasted parts: mistakes/classify.mjs ownWords); omitted, the whole prompt counts as own.
 */
export function promptQuery(prompt, { own = null, maxTerms = MAX_QUERY_TERMS } = {}) {
  const q = new Map();
  for (const t of terms(own ?? prompt)) {
    if (!q.has(t) && q.size >= maxTerms) continue;
    q.set(t, Math.min(2, (q.get(t) ?? 0) + 1));
  }
  if (own !== null) {
    for (const t of terms(prompt)) {
      if (q.size >= maxTerms) break;
      if (!q.has(t)) q.set(t, 0.5);
    }
  }
  return q;
}

/**
 * Index one project's notes.
 * @param {{id: number|string, text: string, created?: string}[]} notes
 */
export function indexNotes(notes) {
  const docs = notes.map((note) => {
    const ts = terms(note.text);
    const tf = new Map();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { note, tf, len: ts.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, N);
  const idf = (t) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  for (const d of docs) {
    d.weight = 0;
    for (const t of d.tf.keys()) d.weight += idf(t);
  }
  return { docs, df, N, avg, idf };
}

const K1 = 1.2;
const B = 0.75;

/**
 * Score every note against a query.
 * → [{note, bm25, covQ, covD, matched, shared}] in index order. covQ: the share of the
 * query's weight (over terms the project's notes know) the note matches; covD: the
 * share of the note's own weight the query matches.
 */
export function scoreNotes(ix, q) {
  let qKnown = 0;
  for (const [t, w] of q) if (ix.df.get(t)) qKnown += w * ix.idf(t);
  return ix.docs.map((d) => {
    let bm25 = 0;
    let mq = 0;
    let md = 0;
    const shared = [];
    for (const [t, w] of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const i = ix.idf(t);
      bm25 += w * i * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / Math.max(1e-9, ix.avg))));
      mq += w * i;
      md += i;
      shared.push(t);
    }
    return { note: d.note, bm25, covQ: qKnown ? mq / qKnown : 0, covD: d.weight ? md / d.weight : 0, matched: shared.length, shared };
  });
}

const DAY = 86_400_000;
const time = (s) => {
  const t = Date.parse(String(s ?? ""));
  return Number.isFinite(t) ? t : NaN;
};
/** Days since a note was written (0 when unknown). */
export const ageDays = (note, now) => {
  const t = time(note.created);
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : 0;
};
/** 1 for a new note, ½ at an infinite age: freshness breaks ties, it never decides alone. */
export const freshness = (note, now, halfLife = 365) => 0.5 + 0.5 * Math.pow(0.5, ageDays(note, now) / halfLife);

// The newer note says things changed. (Never a negation in the older note: nearly every
// correction has one.)
const CHANGE_CUE = /\b(?:now|no longer|not anymore|anymore|instead|replac\w*|moved?|migrat\w*|switch\w*|upgrad\w*|deprecat\w*|supersed\w*|since v?\d[\w.]*|as of|gone|removed|dropped|retired|ignored)\b/i;

export const SUPERSEDE = Object.freeze({ overlap: 0.25, overlapWithCue: 0.2, minDays: 180, nearDuplicate: 0.85 });

// Standing in the trust model (02 §2): an accepted note may replace an accepted or a
// provisional one, a provisional note only a provisional one; a note the agent asked
// to forget, or anything not in use, replaces nothing. A note without a status (the
// corpora) counts as accepted.
const LEVEL = { active: 2, "forget-requested": 2, provisional: 1 };
const levelOf = (n) => (n.status === undefined ? 2 : LEVEL[n.status] ?? 0);
const replacerLevel = (n) => (n.status === undefined || n.status === "active" ? 2 : n.status === "provisional" ? 1 : 0);

/**
 * Notes that a newer note of the same project replaces → Map(id → {by, overlap}).
 * Same subject = the idf-weighted overlap coefficient of their terms. A note written
 * ≥ 180 days later (by `written`, the creation time, never the accept time) replaces
 * it at ≥ 0.25, or at ≥ 0.2 when it says things changed; a near-duplicate replaces it at
 * any age. Only a note of the same or higher standing replaces another, and a note in
 * the user's own words (`own`) only by a near-duplicate or a newer own-words note.
 * only: the ids to check; by: the notes allowed to replace them — the ones shown, so a
 * note is dropped only where its replacement is shown instead (spike S-L6-RANK: an
 * unrestricted rule dropped 8 of 72 current notes in a set with no stale ones). O(k·n).
 */
export function supersededNotes(ix, { only = null, by = null, opts = SUPERSEDE } = {}) {
  const out = new Map();
  const written = (n) => time(n.written ?? n.created);
  for (const a of ix.docs) {
    if (only && !only.has(a.note.id)) continue;
    const ta = written(a.note);
    const need = levelOf(a.note);
    for (const b of ix.docs) {
      if (a === b) continue;
      if (by && !by.has(b.note.id)) continue;
      const rl = replacerLevel(b.note);
      if (!rl || rl < need) continue;
      const tb = written(b.note);
      if (!(tb > ta)) continue;
      let inter = 0;
      for (const t of a.tf.keys()) if (b.tf.has(t)) inter += ix.idf(t);
      const overlap = inter / Math.max(1e-9, Math.min(a.weight, b.weight));
      if (overlap < opts.nearDuplicate) {
        // The user's own correction gives way only to their own newer words.
        if (a.note.own && !b.note.own) continue;
        const days = (tb - ta) / DAY;
        if (!(days >= opts.minDays && (overlap >= opts.overlap || (CHANGE_CUE.test(b.note.text) && overlap >= opts.overlapWithCue)))) continue;
      }
      out.set(a.note.id, { by: b.note.id, overlap });
      break;
    }
  }
  return out;
}

export const BRIEF = Object.freeze({ relative: 0.25, coverage: 0.15, maxWork: 10, maxStanding: 5, fallback: 5 });

/**
 * The session brief's notes, best first in each tier.
 * notes: {id, text, created, written?, status?, own?, standing?}. standing marks the notes
 * sent every session (the store adapter decides: provisional, recent own words).
 * @returns {{standing: object[], work: object[], fallback: boolean, superseded: Map}}
 *   rows: {note, score, shared}
 */
export function selectBrief(notes, context, { now = Date.now(), opts = BRIEF } = {}) {
  const ix = indexNotes(notes);
  const q = contextQuery(context ?? {});
  const newest = (a, b) => time(b.created) - time(a.created);
  // Every session: provisional notes and the user's own corrections accepted in the last
  // 14 days, newest first (the adapter marks them). Never by a repeat count: re-writes bump it.
  const eligible = notes.filter((n) => n.standing).sort(newest);
  let work;
  let fallback = false;
  if (!q.size) {
    // No context: the freshest notes. Only these and the every-session ones are checked
    // for supersession below, so this stays O(k·n).
    fallback = true;
    const inStanding = new Set(eligible.slice(0, opts.maxStanding).map((n) => n.id));
    work = notes.filter((n) => !inStanding.has(n.id)).sort(newest).map((note) => ({ note, score: 0, shared: [] }));
  } else {
    const rows = scoreNotes(ix, q)
      .filter((r) => r.matched > 0 && r.covD >= opts.coverage)
      .map((r) => ({ note: r.note, score: r.bm25 * freshness(r.note, now), shared: r.shared }))
      .sort((a, b) => b.score - a.score);
    const top = rows[0]?.score ?? 0;
    work = rows.filter((r) => r.score >= opts.relative * top);
  }
  // A note is dropped only where its replacement is shown: the capped selection first,
  // then supersession inside it (no refill, so a replacer can't be cut after it acted).
  const pickStanding = eligible.slice(0, opts.maxStanding);
  const standingIds = new Set(pickStanding.map((n) => n.id));
  const pickWork = work.filter((r) => !standingIds.has(r.note.id)).slice(0, fallback ? opts.fallback : opts.maxWork);
  const shown = new Set([...standingIds, ...pickWork.map((r) => r.note.id)]);
  const gone = supersededNotes(ix, { only: shown, by: shown });
  return {
    standing: pickStanding.filter((n) => !gone.has(n.id)).map((note) => ({ note, score: freshness(note, now), shared: [] })),
    work: pickWork.filter((r) => !gone.has(r.note.id)),
    fallback,
    superseded: gone,
  };
}

export const PROMPT = Object.freeze({ threshold: 0.35, oneTerm: 0.7, max: 3 });
export const TOPIC = Object.freeze({ threshold: 0.2, oneTerm: 0.7, max: 5 });

/** The relevance of a scored note to a short query, 0–1. */
export const promptScore = (r, opts = PROMPT) => (r.matched ? Math.min(1, r.covQ) * (r.matched >= 2 ? 1 : opts.oneTerm) * Math.sqrt(r.covD) : 0);

/**
 * Prompt-time recall (and, with TOPIC, the recall command): the top notes above
 * the threshold, never a superseded one.
 * @returns {{note, score, shared}[]}
 */
export function selectPrompt(notes, prompt, { own = null, opts = PROMPT } = {}) {
  const q = promptQuery(prompt, { own });
  if (!q.size || !notes.length) return [];
  const ix = indexNotes(notes);
  const above = scoreNotes(ix, q)
    .map((r) => ({ note: r.note, score: promptScore(r, opts), shared: r.shared }))
    .filter((r) => r.score >= opts.threshold)
    .sort((a, b) => b.score - a.score);
  // Dropped only where its replacement is shown too: the top notes first, then
  // supersession inside them (no refill).
  const top = above.slice(0, opts.max);
  const ids = new Set(top.map((r) => r.note.id));
  const gone = supersededNotes(ix, { only: ids, by: ids });
  return top.filter((r) => !gone.has(r.note.id));
}
