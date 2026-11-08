// A typed remember (MCP launch plan L3, Decision 21):
//   Claude Code  /<plugin>:remember <text>     (the plugin's skill; the prompt arrives as typed)
//   Codex        $<package>-remember <text>    (setup's skill; captured from the pinned engine)
// The prompt hook saves <text> once, as a pending note (the review accepts it), with
// its provenance from the prompt source, and answers with a receipt the user sees
// ("Saved for review: …") and a line the skill's model reads. The extractor never
// sees those words (no double capture).
//
// captureRemember is the one capture path: L5 changes it (provisional on allow-listed
// hosts, a forget command). Until then a remember is never provisional.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRODUCT, pinnedCommand } from "../product.mjs";

export const MAX_REMEMBER = 2000;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The command, then whitespace or the end: "/<plugin>:remembers" is another command.
const FORMS = {
  claude: new RegExp(`^\\s*/${escape(PRODUCT.plugin)}:remember(?=\\s|$)`),
  codex: new RegExp(`^\\s*\\$${escape(PRODUCT.package)}-remember(?=\\s|$)`),
};
const TYPED_FORM = { claude: `/${PRODUCT.plugin}:remember`, codex: `$${PRODUCT.package}-remember` };
// Claude Code also takes a plugin's command by its short name when nothing else has
// that name (2.1.319: UserPromptSubmit gets "/remember …", the skill still runs).
const BARE = /^\s*\/remember(?=\s|$)/;

/** Does the prompt start with the short form (/remember)? Cheap: the check that reads files runs only then. */
export const looksBare = (prompt) => typeof prompt === "string" && BARE.test(prompt);

/**
 * The words after the host's remember command ("" for the command alone), or null when
 * the prompt isn't one. bare: the short /remember counts too (see bareRememberIsOurs).
 */
export function rememberText(prompt, host, { bare = false } = {}) {
  const form = FORMS[host];
  if (!form || typeof prompt !== "string") return null;
  const m = form.exec(prompt) ?? (bare && host === "claude" ? BARE.exec(prompt) : null);
  return m ? prompt.slice(m[0].length).trim() : null;
}

/**
 * Is a typed /remember our plugin's command? Only when the plugin is on in the user's
 * settings and nothing else could own the name: a user or project command or skill
 * called remember, or another enabled plugin's. Unsure: no (the prompt goes to the
 * extractor as any other prompt).
 */
export function bareRememberIsOurs({ env = process.env, home, cwd } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home ?? os.homedir(), ".claude");
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };
  const has = (root) => fs.existsSync(path.join(root, "commands", "remember.md")) || fs.existsSync(path.join(root, "skills", "remember", "SKILL.md"));
  // On or off per settings file, the project's (shared, then local) over the user's.
  const merged = {};
  for (const f of [path.join(dir, "settings.json"), ...(cwd ? [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")] : [])]) Object.assign(merged, readJson(f)?.enabledPlugins ?? {});
  const enabled = Object.entries(merged).filter(([, v]) => v === true).map(([k]) => k);
  if (!enabled.some((k) => k.startsWith(`${PRODUCT.plugin}@`))) return false;
  if (has(dir) || (cwd && has(path.join(cwd, ".claude")))) return false;
  const records = readJson(path.join(dir, "plugins", "installed_plugins.json"))?.plugins ?? {};
  for (const id of enabled.filter((k) => !k.startsWith(`${PRODUCT.plugin}@`))) {
    for (const rec of [records[id]].flat()) if (typeof rec?.installPath === "string" && has(rec.installPath)) return false;
  }
  return true;
}

/**
 * Where the note came from (schema v5's provenance): the user's prompt only when
 * they typed it (D21). Anything else is the agent's: a subagent, a scheduled prompt,
 * ad's worker, and a headless run too (an agent's shell can start `claude -p`); its
 * prompt_source stays on the journal line.
 */
export function provenanceOf(source) {
  return source?.typed ? "user-prompt" : "agent";
}

/** The journal line for a remember: the drain stores it pending, like every capture at L3. */
export function rememberEntry(text, { source, sessionId = "" } = {}) {
  const provenance = provenanceOf(source);
  return {
    type: "pattern",
    text,
    evidence_quote: text,
    confidence: 0.9,
    rule_id: "remember-command",
    tags: ["remember"],
    sessionId: String(sessionId ?? ""),
    source_speaker: provenance === "user-prompt" ? "user" : "agent",
    prompt_source: source?.why ?? "unknown",
    // Never provisional here, whatever the host (L5 decides that on allow-listed hosts).
    provisional_eligible: false,
    provenance,
    remember: true,
  };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the user sees (systemMessage) and the line the skill's model reads (context). */
export function rememberReceipt({ text, saved, why, version, host = "claude" }) {
  const review = version ? pinnedCommand("review", version) : `npx -y ${PRODUCT.package} review`;
  if (saved) {
    const shown = clip(text.replace(/\s+/g, " "), 120);
    return {
      systemMessage: `Saved for review: "${shown}" · run \`${review}\` in your own terminal to accept it`,
      context: `${PRODUCT.displayName} saved the note "${shown}" for review (once: don't record it again). The user accepts it with \`${review}\` in their own terminal.`,
    };
  }
  const reason = why === "empty" ? `type ${TYPED_FORM[host] ?? TYPED_FORM.claude} followed by what to remember` : why === "too long" ? `the note is too long (${text.length} characters; up to ${MAX_REMEMBER})` : why;
  return {
    systemMessage: `Nothing saved: ${reason}`,
    context: `${PRODUCT.displayName} saved nothing: ${reason}.`,
  };
}

/**
 * When the plugin hands the extractor to ad's own Claude Code entry (ad init), does
 * that ad know a remember? An older ad would extract the same prompt as well (two
 * notes). Its dispatcher's copy says: <script>/../../src/hooks/remember.mjs. ad's
 * pre-dispatcher command entries never do; launcher entries run the memory product's
 * own copy (written with this plugin's setup), so they count as knowing.
 */
export async function adEntriesKnowRemember(opts = {}) {
  const { claudeHookSources, entryAlive, ourHandlers } = await import("./routes.mjs");
  for (const s of claudeHookSources(opts)) {
    for (const o of ourHandlers(s.hooks)) {
      if (o.info.plugin || o.handler.if !== undefined || !entryAlive(o.info) || !o.info.steps.includes("user-prompt-extract")) continue;
      if (o.info.launcher) continue;
      if (!o.info.script || !fs.existsSync(path.join(path.dirname(o.info.script), "..", "src", "hooks", "remember.mjs"))) return false;
    }
  }
  return true;
}

export const OLDER_AD = "ad's own hooks here are from an older ad, which would capture this prompt too: update ad and run `ad init` again, then remember it again";

/**
 * Save a typed remember once, pending. → { saved, receipt }
 * @param {{text: string, input: object, source: object, host: string, cwd: string, version?: string|null}} o
 */
export async function captureRemember({ text, input, source, host, cwd, version }) {
  const done = (saved, why) => ({ saved, receipt: rememberReceipt({ text, saved, why, version, host }) });
  if (!text) return done(false, "empty");
  if (text.length > MAX_REMEMBER) return done(false, "too long");
  try {
    // A folder sharing its memory key with another folder captures nothing (as the extractor).
    const { db, projectSlug } = await import("../memory/episodic.mjs");
    const { slugCollides } = await import("../memory/safety.mjs");
    const handle = await db().catch(() => null);
    if (handle && slugCollides(handle, projectSlug(cwd), cwd)) return done(false, "this folder shares its memory with another folder, so nothing is saved here");
    const { appendLearnings } = await import("./journal.mjs");
    const r = await appendLearnings({ cwd, entries: [rememberEntry(text, { source, sessionId: input?.session_id })] });
    return r.ok ? done(true) : done(false, `couldn't write the journal (${r.error})`);
  } catch (e) {
    return done(false, `couldn't save it (${e?.message ?? e})`);
  }
}
