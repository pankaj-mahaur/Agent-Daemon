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

const MAX_TEXT = 20_000;

/** Content terms of a text, in order, repeats kept (term frequency). */
export function terms(text) {
  const raw = String(text ?? "")
    .normalize("NFKC")
    .slice(0, MAX_TEXT)
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

// A path in a prompt ("common/src/dto/Line.java", "C:\\app\\x.cs") names a place, not
// the topic: its words count half and its folder noise not at all (dev set: matches
// made only through "src", "java", "com" were false positives). A path: a token with
// two separators, or one and a file extension, or one at its start ("./x", "~/x",
// "/x"). "and/or" and a URL stay text. Token by token, so a long paste stays linear.
const isPath = (tok) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return false;
  const seps = tok.match(/[/\\]/g)?.length ?? 0;
  if (!seps || !/\p{L}/u.test(tok)) return false;
  return seps >= 2 || /^(?:[.~]|[A-Za-z]:)?[/\\]/.test(tok) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tok);
};
const OPEN = new Set("\"'`(<[{\u201c\u2018*");
const CLOSE = new Set("\"'`)>]},;:.!?\u201d\u2019*");
// Quotes and brackets around a token, and a trailing ":line" or ":line:col" (a stack trace).
function trimPunct(tok) {
  let a = 0;
  let b = tok.length;
  while (a < b && OPEN.has(tok[a])) a++;
  for (let pass = 0; pass < 3; pass++) {
    while (b > a && CLOSE.has(tok[b - 1])) b--;
    let d = b;
    while (d > a && tok[d - 1] >= "0" && tok[d - 1] <= "9") d--;
    if (d < b && d > a && tok[d - 1] === ":") b = d - 1;
    else break;
  }
  return tok.slice(a, b);
}
function splitPaths(text) {
  const rest = [];
  const paths = [];
  // terms() reads the first 20,000 characters only; so does this.
  for (const tok of String(text ?? "").slice(0, MAX_TEXT).split(/\s+/)) {
    (isPath(trimPunct(tok)) ? paths : rest).push(tok);
  }
  return { rest: rest.join(" "), paths: paths.join(" ") };
}
const pathTerms = (text) => terms(text).filter((t) => !PATH_NOISE.has(t));

/**
 * Query terms of a prompt: the user's own words first (weight 1, a repeated word at
 * most 2), then words only found in paths or pasted parts (code, quotes, logs) at half
 * weight, folder noise out, at most 64 distinct terms in all. own: the prompt's own
 * words (the caller strips the pasted parts: mistakes/classify.mjs ownWords); omitted,
 * the whole prompt counts as own.
 */
export function promptQuery(prompt, { own = null, maxTerms = MAX_QUERY_TERMS } = {}) {
  const q = new Map();
  const mine = splitPaths(own ?? prompt);
  for (const t of terms(mine.rest)) {
    if (!q.has(t) && q.size >= maxTerms) continue;
    q.set(t, Math.min(2, (q.get(t) ?? 0) + 1));
  }
  const half = (list) => {
    for (const t of list) {
      if (q.size >= maxTerms) break;
      if (!q.has(t)) q.set(t, 0.5);
    }
  };
  half(pathTerms(mine.paths));
  if (own !== null) {
    const pasted = splitPaths(prompt);
    half(terms(pasted.rest));
    half(pathTerms(pasted.paths));
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

// A commit subject's leading scope ("chat: …", "fix(api)!: …") names an area, as a folder does.
const COMMIT_SCOPE = /^\s*[\w./-]+(?:\([^)]*\))?!?:\s+/;
const withoutScope = (c) => String(c ?? "").replace(COMMIT_SCOPE, "");

export const BRIEF = Object.freeze({ relative: 0.25, offTopic: 0.5, coverage: 0.15, maxWork: 10, maxStanding: 5, fallback: 5, swap: true });

const MAX_HOPS = 4;
// A replacement the ranking didn't select must say things changed (a change cue, ≥ 180
// days later, the same subject): shared generic words alone ("config", "CI") made an
// unrelated note replace a current one on the dev set, and the any-age near-duplicate
// rule (an overlap coefficient: a long note containing a short one's words scores 1)
// applies only between selected notes.
const SWAP_RULE = Object.freeze({ ...SUPERSEDE, overlap: Infinity, nearDuplicate: Infinity });
/**
 * The work tier after the cap: a selected note that a newer note replaces gives its slot
 * to that note, which the ranking alone left below the bar — the current version of
 * something that fits the work (dev set: stale notes stayed because their replacement
 * wasn't selected). The replacement must itself share a word with the work, say things
 * changed (SWAP_RULE; an unrestricted rule dropped current notes for unrelated ones in
 * spike S-L6-RANK) and pass supersededNotes' other rules (standing, the user's own
 * words, the creation date). Followed up to 4 replacements; a
 * replacement already shown, or sent every session, isn't shown twice. Records each note
 * swapped out in `swapped`. O(k·n).
 */
function swapInReplacers(ix, pick, candidates, standingIds, swapped, swappedIn) {
  const others = new Set(candidates.map((r) => r.note.id).filter((id) => !standingIds.has(id)));
  const rowOf = new Map(candidates.map((r) => [r.note.id, { note: r.note, score: r.score, shared: r.shared }]));
  const taken = new Set(pick.map((r) => r.note.id));
  const out = [];
  for (const r of pick) {
    let cur = r;
    for (let hop = 0; cur && hop < MAX_HOPS; hop++) {
      const by = supersededNotes(ix, { only: new Set([cur.note.id]), by: others, opts: SWAP_RULE }).get(cur.note.id);
      if (!by) break;
      swapped.set(cur.note.id, by);
      cur = taken.has(by.by) ? null : rowOf.get(by.by);
      if (cur) {
        taken.add(by.by);
        swappedIn.add(by.by);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

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
  let candidates = [];
  let fallback = false;
  if (!q.size) {
    // No context: the freshest notes. Only these and the every-session ones are checked
    // for supersession below, so this stays O(k·n).
    fallback = true;
    const inStanding = new Set(eligible.slice(0, opts.maxStanding).map((n) => n.id));
    work = notes.filter((n) => !inStanding.has(n.id)).sort(newest).map((note) => ({ note, score: 0, shared: [] }));
  } else {
    // A note that shares only area words with the work (the recent paths, a commit's
    // leading scope; no word of the branch or of the commit subjects) needs half the top
    // score: an area's folders are shared by its unrelated notes too. When no note shares
    // a branch or subject word (a ticket-number branch), every note gets the plain bar,
    // so the branch alone never thins the brief.
    const topic = contextQuery({ branch: context?.branch, commits: (context?.commits ?? []).map(withoutScope) });
    const matched = scoreNotes(ix, q)
      .filter((r) => r.matched > 0)
      .map((r) => ({ note: r.note, score: r.bm25 * freshness(r.note, now), shared: r.shared, covD: r.covD, onTopic: r.shared.some((t) => topic.has(t)) }));
    candidates = matched;
    const rows = matched.filter((r) => r.covD >= opts.coverage).sort((a, b) => b.score - a.score);
    const top = rows[0]?.score ?? 0;
    const anyOnTopic = rows.some((r) => r.onTopic);
    work = rows
      .filter((r) => r.score >= (r.onTopic || !anyOnTopic ? opts.relative : opts.offTopic) * top)
      .map(({ note, score, shared }) => ({ note, score, shared }));
  }
  // A note is dropped only where its replacement is shown: the capped selection first,
  // then supersession inside it (no refill, so a replacer can't be cut after it acted).
  const pickStanding = eligible.slice(0, opts.maxStanding);
  const standingIds = new Set(pickStanding.map((n) => n.id));
  const swapped = new Map();
  const swappedIn = new Set();
  let pickWork = work.filter((r) => !standingIds.has(r.note.id)).slice(0, fallback ? opts.fallback : opts.maxWork);
  if (opts.swap && !fallback) pickWork = swapInReplacers(ix, pickWork, candidates, standingIds, swapped, swappedIn);
  const shown = new Set([...standingIds, ...pickWork.map((r) => r.note.id)]);
  // Selected notes replace one another by the full rule; a swapped-in note, which the
  // ranking didn't select, replaces another shown note only by the swap's rule.
  const selected = new Set([...shown].filter((id) => !swappedIn.has(id)));
  const gone = supersededNotes(ix, { only: shown, by: selected });
  if (swappedIn.size) {
    const left = new Set([...shown].filter((id) => !gone.has(id)));
    for (const [id, by] of supersededNotes(ix, { only: left, by: swappedIn, opts: SWAP_RULE })) gone.set(id, by);
  }
  return {
    standing: pickStanding.filter((n) => !gone.has(n.id)).map((note) => ({ note, score: freshness(note, now), shared: [] })),
    work: pickWork.filter((r) => !gone.has(r.note.id)),
    fallback,
    superseded: new Map([...swapped, ...gone]),
  };
}

export const PROMPT = Object.freeze({ threshold: 0.32, oneTerm: 0.7, manyTerms: 3, max: 3 });
export const TOPIC = Object.freeze({ threshold: 0.2, oneTerm: 0.7, manyTerms: 3, max: 5 });

/**
 * The relevance of a scored note to a short query, 0–1: query coverage × √(note
 * coverage), × 0.7 for a one-word match. A note that three or more distinct words of
 * the query reach counts its note coverage twice: a long note says more than the prompt
 * asks, and several shared words are evidence a single shared word never is (dev set
 * v1 and v2: recall 0.376 → 0.484 at the same precision, 0.90).
 */
export const promptScore = (r, opts = PROMPT) => {
  if (!r.matched) return 0;
  const covD = r.matched >= (opts.manyTerms ?? Infinity) ? Math.min(1, 2 * r.covD) : r.covD;
  return Math.min(1, Math.min(1, r.covQ) * (r.matched >= 2 ? 1 : opts.oneTerm) * Math.sqrt(covD));
};

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
