// Group corrections that say the same thing (plan L4a step 3): a normalised
// hash first, then near-duplicate matching on content words. Deterministic:
// the same corrections in the same order always give the same clusters.

import { createHash } from "node:crypto";

// Words that carry no meaning for "is this the same rule". Negations are not
// here: they give the words after them a direction ("use npm" vs "never use npm").
const STOP = new Set(
  (
    "a an the to of in on at for with and or but so is are was were be been being it its it's this that these those " +
    "i me my we us our you your he she they them their there here now then just please pls plz kindly ok okay yeah yes " +
    "hey hi also again still really actually basically literally seriously ugh oh well like same thing things stuff " +
    "can could would should will shall do does did done doing have has had get got make sure one all every each any some " +
    "from now on going forward future next time times always ever anymore more instead rather than over by as into " +
    "project repo codebase code file files " +
    // Hinglish fillers
    // ("main" stays out: in English it's a branch.)
    "yaar yar bhai bro na hai hain ho tha thi the ko ka ki ke se me mein mai ye yeh woh wo is us isko usko " +
    "karo karna kar kare karte karta karti phir fir baar bar hamesha humesha sab saare kya"
  ).split(/\s+/),
);

// Words that turn what follows into "not this": "not npm", "never use var", "instead of a loop".
const NEGATION = /^(?:no|not|don'?t|dont|never|stop|stopped|avoid|quit|without|cannot|can'?t|won'?t|shouldn'?t|insteadof|ratherthan)$/;
// Hinglish puts the negation after the thing: "npm mat use karo".
const POSTFIX_NEGATION = /^(?:mat|nahi|nahin)$/;
// Verbs that say nothing about which rule this is ("use", "run", "add" …).
const GENERIC = new Set(
  "use using used run running add adding make making write writing put keep call create prefer switch try go stick follow need want let do have get give take change set apply start include check mention lagao likho chalao daalo dalo banao".split(" "),
);
// After a negated word, these start the wanted part again ("stop using npm, we use pnpm").
const POSITIVE_RESET = new Set(["use", "using", "prefer", "switch", "try", "go", "stick", "we", "but", "only"]);

/**
 * Content words of a sentence with a direction: "+pnpm" is wanted, "-npm" is
 * not. Lower-cased, stop words and generic verbs out, light stemming.
 */
export function tokens(sentence) {
  const text = String(sentence)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\bdo not\b/g, "dont")
    .replace(/\binstead of\b/g, "insteadof")
    .replace(/\brather than\b/g, "ratherthan");
  const prefers = /\bprefer/.test(text);
  const out = new Set();
  const verbs = new Map(); // generic verb → negated?
  let neg = false;
  let since = []; // content words since the last clause break (for a postfix negation)
  let negContent = false; // a content word was taken while negated
  // Punctuation ends a phrase only when a space or the end follows (".env.local" stays one word).
  for (const raw of text.split(/(?=[,.;:!?](?:\s|$))|\s+/)) {
    if (/^[,.;:!?]+$/.test(raw)) {
      neg = false;
      since = [];
      continue;
    }
    const w = raw.replace(/^['._/-]+|['._/-]+$/g, "").replace(/[^a-z0-9@#'.+_/-]/g, "");
    if (!w) continue;
    if (NEGATION.test(w) || (w === "over" && prefers)) {
      neg = true;
      negContent = false;
      continue;
    }
    if (POSTFIX_NEGATION.test(w)) {
      for (const t of since) {
        out.delete(`+${t}`);
        out.add(`-${t}`);
      }
      for (const v of verbs.keys()) verbs.set(v, true);
      continue;
    }
    if (neg && negContent && POSITIVE_RESET.has(w)) neg = false;
    if (STOP.has(w)) continue;
    const t = stem(w); // "adding" → "add": generic verbs are checked after stemming
    if (GENERIC.has(t)) {
      verbs.set(t, neg);
      continue;
    }
    out.add(`${neg ? "-" : "+"}${t}`);
    since.push(t);
    if (neg) negContent = true;
  }
  // With one content word left, the verb is what tells the rules apart ("write
  // tests" vs "run tests"); verb tokens are marked "v:" and never merge alone.
  if (out.size < 2) for (const [v, n] of verbs) out.add(`${n ? "-" : "+"}v:${v}`);
  // Nothing at all: the sentence itself, so identical ones still group.
  if (out.size === 0) out.add(`=${text.replace(/\s+/g, " ").trim()}`);
  return out;
}

/** Do two token sets share a word that isn't a verb? */
function sharesContent(a, b) {
  for (const t of a) if (t[1] !== "v" && b.has(t)) return true;
  return false;
}

function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length <= 4) return w;
  for (const suf of ["ings", "ing", "edly", "ed", "es", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const flip = (t) => (t[0] === "+" ? "-" : t[0] === "-" ? "+" : "") + t.slice(1);
function conflicts(a, b) {
  for (const t of a) if (t[0] !== "=" && b.has(flip(t))) return true;
  return false;
}

const keyOf = (set) => [...set].sort().join(" ");
const hashOf = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export const NEAR = 0.5;

/**
 * Cluster corrections.
 * @param {{sentence:string, host:string, ts:number|null, session?:string}[]} items  in time order
 * @returns {{id:string, key:string, count:number, hosts:Record<string,number>, sessions:Record<string,number>, memberKeys:string[],
 *   firstTs:number|null, lastTs:number|null, sentences:string[]}[]}
 *   largest first; ties by first seen. sessions: repeats per session id (items with one);
 *   memberKeys: the token key of each distinct wording, the first wording's first
 */
export function clusterCorrections(items, { near = NEAR } = {}) {
  const clusters = [];
  const byKey = new Map();
  for (const it of items) {
    const tok = tokens(it.sentence);
    if (tok.size === 0) continue;
    const key = keyOf(tok);
    let c = byKey.get(key);
    if (!c) {
      let best = null;
      let bestSim = 0;
      for (const cand of clusters) {
        // Opposite rules never merge: one wants what the other doesn't.
        if (cand.memberTokens.some((m) => conflicts(tok, m))) continue;
        let sim = 0;
        for (const m of cand.memberTokens) if (sharesContent(tok, m)) sim = Math.max(sim, jaccard(tok, m));
        if (sim >= near && sim > bestSim) {
          best = cand;
          bestSim = sim;
        }
      }
      c = best;
      if (!c) {
        c = { key, tokens: tok, memberTokens: [], count: 0, hosts: {}, sessions: {}, keys: new Set(), firstTs: it.ts ?? null, lastTs: it.ts ?? null, sentences: [], order: clusters.length };
        clusters.push(c);
      }
      if (c.memberTokens.length < 20) c.memberTokens.push(tok);
      byKey.set(key, c);
    }
    c.count++;
    c.hosts[it.host] = (c.hosts[it.host] ?? 0) + 1;
    // L4b: repeats per session (a loop can't stand for many) and each wording's key (the
    // cluster's identity when the first wording leaves the history).
    if (it.session != null) c.sessions[it.session] = (c.sessions[it.session] ?? 0) + 1;
    c.keys.add(key);
    if (it.ts != null) {
      c.firstTs = c.firstTs == null ? it.ts : Math.min(c.firstTs, it.ts);
      c.lastTs = c.lastTs == null ? it.ts : Math.max(c.lastTs, it.ts);
    }
    c.sentences.push(it.sentence);
  }
  return clusters
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((c) => ({ id: hashOf(c.key), key: c.key, count: c.count, hosts: c.hosts, sessions: c.sessions, memberKeys: [...c.keys], firstTs: c.firstTs, lastTs: c.lastTs, sentences: c.sentences }));
}

/** The sentence that names a cluster: the most frequent wording, then the shortest, then the first. */
export function clusterLabel(sentences) {
  const counts = new Map();
  sentences.forEach((s, i) => {
    const k = s.trim();
    const e = counts.get(k) ?? { n: 0, first: i };
    e.n++;
    counts.set(k, e);
  });
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0].length - b[0].length || a[1].first - b[1].first)[0]?.[0] ?? "";
}
