// The recall command (MCP launch plan L6, design decision 12), answered by the prompt
// hook like remember and forget:
//   Claude Code  /<plugin>:recall [topic]   (bare /recall when only ours can own it)
//   Codex        $<package>-recall [topic]
// With a topic: the recall core on the topic (a lower threshold, up to 5) — the model
// gets the block, the user (Claude Code) the same list with the command that works for
// each line. Matching notes that wait for review go only to the user's line; the model
// gets their count. Without a topic: what this session already received.

import { PRODUCT, pinnedCommand } from "../product.mjs";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FORMS = {
  claude: new RegExp(`^\\s*/${escape(PRODUCT.plugin)}:recall(?=\\s|$)`),
  codex: new RegExp(`^\\s*\\$${escape(PRODUCT.package)}-recall(?=\\s|$)`),
};
const BARE = /^\s*\/recall(?=\s|$)/;

/** Does the prompt start with the short form (/recall)? */
export const looksBareRecall = (prompt) => typeof prompt === "string" && BARE.test(prompt);

/** A typed recall → its topic ("" for none), or null when the prompt isn't one. */
export function recallTopic(prompt, host, { bare = false } = {}) {
  const form = FORMS[host];
  if (!form || typeof prompt !== "string") return null;
  const m = form.exec(prompt) ?? (bare && host === "claude" ? BARE.exec(prompt) : null);
  return m ? prompt.slice(m[0].length).replace(/\s+/g, " ").trim().slice(0, 200) : null;
}

const clip = (t, n = 60) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// The note's own words for the terms that matched (the ranker's are stems).
function matchedWords(text, shared, terms) {
  const want = new Set(shared);
  const seen = new Set();
  const out = [];
  for (const w of String(text).match(/[\p{L}\p{N}_:-]+/gu) ?? []) {
    const t = terms(w)[0];
    if (t && want.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(w);
    }
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Answer a typed recall.
 * @param {object} handle  an open store
 * @param {{keys: string[], topic: string, sessionId?: string|null, host: string, version?: string|null, plugin?: boolean, now?: number}} o
 * @returns {{context: string, systemMessage: string|null}}
 */
export async function answerRecall(handle, { keys, topic, sessionId = null, host, version = null, plugin = false, now = Date.now() }) {
  const { recallRows, pendingRows } = await import("./recall.mjs");
  const { selectPrompt, TOPIC, terms } = await import("./recall-rank.mjs");
  const { renderRecall, ageLabel } = await import("./recall-render.mjs");
  const { recallMode } = await import("./recall-mode.mjs");
  const { isProjectId } = await import("./projects.mjs");
  const { tagOf } = await import("./trust.mjs");
  const cmd = (verb) => (version ? pinnedCommand(verb, version) : `npx -y ${PRODUCT.package} ${verb}`);
  const product = PRODUCT.displayName;
  if (!keys?.length) return { context: `## ${product} recall\nThis folder isn't a project, so there are no learnings to recall here.`, systemMessage: host === "claude" ? `${product}: this folder isn't a project; nothing to recall.` : null };
  if (recallMode(handle, keys.find(isProjectId) ?? null) === "off") {
    const line = `${product}: recall is off in this project (${cmd("config recall on")}).`;
    return { context: `## ${product} recall\nRecall is off in this project: the user turned it off.`, systemMessage: host === "claude" ? line : null };
  }
  const rows = recallRows(handle, keys, { now, global: true });
  let picked;
  let why;
  let pendingPicked = [];
  if (topic) {
    picked = selectPrompt(rows, topic, { opts: TOPIC });
    why = new Map(picked.map((r) => [r.note.id, `matched ${matchedWords(r.note.text, r.shared, terms).join(", ") || "your words"}`]));
    pendingPicked = selectPrompt(pendingRows(handle, keys), topic, { opts: TOPIC });
  } else {
    const { injectedThisSession } = await import("../query-retrieve.mjs");
    const sent = injectedThisSession(handle, sessionId);
    picked = rows.filter((r) => sent.has(r.id)).slice(0, 10).map((note) => ({ note }));
    why = new Map(picked.map((r) => [r.note.id, r.note.standing ? `every session: from your prompts, ${ageLabel(r.note.created, now)} old` : "matched this work or a prompt"]));
  }
  const block = renderRecall({ notes: picked.map((r) => r.note), pending: pendingPicked.length, product, topic, now });
  if (host !== "claude") return { context: block.text, systemMessage: null };
  // The user's own list (Claude Code shows a systemMessage), with the command that works.
  const forgetFor = (n) => {
    const tag = tagOf(n);
    if (tag === "provisional") return plugin ? `/${PRODUCT.plugin}:forget ${n.id}` : cmd(`forget ${n.id}`);
    if (tag === "agent asked to forget") return `decide in ${cmd("review")}`;
    return `forget in your terminal: ${cmd(`forget ${n.id}`)}`;
  };
  const shown = new Set(block.ids);
  const lines = picked.filter((r) => shown.has(r.note.id)).map((r) => `#${r.note.id} "${clip(r.note.text)}" · ${why.get(r.note.id)} · ${forgetFor(r.note)}`);
  for (const r of pendingPicked) lines.push(`#${r.note.id} "${clip(r.note.text)}" · saved, not in use until you OK it: ${cmd("review")}`);
  const head = topic ? `${product} recall "${clip(topic, 40)}":` : `${product}: this session received:`;
  const systemMessage = lines.length ? [head, ...lines].join("\n") : topic ? `${product}: no learnings match "${clip(topic, 40)}" (recall matches words, not meaning: try another word).` : `${product}: no learnings were sent to this session yet.`;
  return { context: block.text, systemMessage };
}
