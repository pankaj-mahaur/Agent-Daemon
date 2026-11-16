// A typed remember (MCP launch plan L3, Decision 21):
//   Claude Code  /<plugin>:remember <text>     (the plugin's skill; the prompt arrives as typed)
//   Codex        $<package>-remember <text>    (setup's skill; captured from the pinned engine)
// The prompt hook saves <text> once through L5's capture library (memory/capture-prompt.mjs:
// screened, deduplicated, written straight to a current store, else to the journal) and
// answers with a receipt the user sees and a line the skill's model reads. The extractor
// never sees those words (no double capture). Provisional only on an allow-listed host
// (none yet); provenance `prompt` for a typed one (a host can't prove it was typed),
// `user-prompt` only with a first-party verdict, and a journaled one drains `buffered`.

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

// forget and restore (L5 decision 9): the same three forms as remember.
const VERB_FORMS = {
  claude: new RegExp(`^\\s*/${escape(PRODUCT.plugin)}:(forget|restore)(?=\\s|$)`),
  codex: new RegExp(`^\\s*\\$${escape(PRODUCT.package)}-(forget|restore)(?=\\s|$)`),
};
const BARE_VERB = /^\s*\/(forget|restore)(?=\s|$)/;

/** The short /forget or /restore's verb, or null. */
export const bareVerb = (prompt) => (typeof prompt === "string" ? BARE_VERB.exec(prompt)?.[1] ?? null : null);

/**
 * A typed forget or restore → { verb, arg }, or null. bare: the short /forget, /restore
 * count too (only when bareRememberIsOurs, given the name, says it can only be ours).
 */
export function memoryVerb(prompt, host, { bare = false } = {}) {
  const form = VERB_FORMS[host];
  if (!form || typeof prompt !== "string") return null;
  const m = form.exec(prompt) ?? (bare && host === "claude" ? BARE_VERB.exec(prompt) : null);
  return m ? { verb: m[1], arg: prompt.slice(m[0].length).trim() } : null;
}

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
export function bareRememberIsOurs({ env = process.env, home, cwd, name = "remember" } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home ?? os.homedir(), ".claude");
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };
  const has = (root) => fs.existsSync(path.join(root, "commands", `${name}.md`)) || fs.existsSync(path.join(root, "skills", name, "SKILL.md"));
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
 * Where the note came from (L5 decision 14): the user's proven words only with a
 * first-party verdict; a typed prompt a host can't prove is `prompt`; headless is
 * `headless`; anything else is the agent's.
 */
export function provenanceOf(source) {
  if (source?.firstParty) return "user-prompt";
  if (source?.why === "headless") return "headless";
  return source?.typed ? "prompt" : "agent";
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the user sees (systemMessage) and the line the skill's model reads (context). */
export function rememberReceipt({ text, saved, why, version, host = "claude" }) {
  const review = version ? pinnedCommand("review", version) : `npx -y ${PRODUCT.package} review`;
  if (saved) {
    const shown = clip(text.replace(/\s+/g, " "), 120);
    return {
      systemMessage: `${PRODUCT.displayName}: Saved for review: "${shown}" · run \`${review}\` in your own terminal to accept it`,
      context: `${PRODUCT.displayName} saved the note "${shown}" for review (once: don't record it again). The user accepts it with \`${review}\` in their own terminal.`,
    };
  }
  const reason = why === "empty" ? `type ${TYPED_FORM[host] ?? TYPED_FORM.claude} followed by what to remember` : why === "too long" ? `the note is too long (${text.length} characters; up to ${MAX_REMEMBER})` : why;
  return {
    systemMessage: `${PRODUCT.displayName}: Nothing saved: ${reason}`,
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
 * Save a typed remember once (L5's capture path). → { saved, status, id, receipt }
 * @param {{text: string, input: object, source: object, host: string, cwd: string, version?: string|null, handle?: object|null}} o
 */
export async function captureRemember({ text, input, source, host, cwd, version, handle }) {
  const review = version ? pinnedCommand("review", version) : `npx -y ${PRODUCT.package} review`;
  if (!text) return { saved: false, status: "empty", id: null, receipt: rememberReceipt({ text: "", saved: false, why: "empty", version, host }) };
  if (text.length > MAX_REMEMBER) return { saved: false, status: "too-long", id: null, receipt: rememberReceipt({ text, saved: false, why: "too long", version, host }) };
  try {
    const { capturePrompt, captureReceipt } = await import("../memory/capture-prompt.mjs");
    const r = await capturePrompt(input, { source, host, cwd, remember: text, ...(handle !== undefined ? { handle } : {}) });
    if (r.status === "collides") return { saved: false, status: r.status, id: null, receipt: rememberReceipt({ text, saved: false, why: "this folder shares its memory with another folder, so nothing is saved here", version, host }) };
    const saved = ["pending", "provisional", "journal", "quarantined", "said-again"].includes(r.status);
    const forget = host === "codex" ? `$${PRODUCT.package}-forget` : `/${PRODUCT.plugin}:forget`;
    const line = captureReceipt({ ...r, text: r.text ?? text, review, product: PRODUCT.displayName, remember: TYPED_FORM[host] ?? TYPED_FORM.claude, terminalRemember: version ? pinnedCommand("remember", version) : `npx -y ${PRODUCT.package} remember`, forget });
    const shown = clip(String(r.text ?? text).replace(/\s+/g, " "), 120);
    const context = saved
      ? `${PRODUCT.displayName} saved the note "${shown}"${r.id ? ` as #${r.id}` : ""} ${r.status === "provisional" ? "and it is in use now" : "for review"} (once: don't record it again). The user accepts it with \`${review}\` in their own terminal.`
      : `${PRODUCT.displayName} answered the user in a line of its own; don't record this with a memory tool and don't diagnose it.`;
    return { saved, status: r.status, id: r.id, receipt: { systemMessage: line ?? `Nothing saved.`, context } };
  } catch (e) {
    return { saved: false, status: "error", id: null, receipt: rememberReceipt({ text, saved: false, why: `couldn't save it (${e?.message ?? e})`, version, host }) };
  }
}
