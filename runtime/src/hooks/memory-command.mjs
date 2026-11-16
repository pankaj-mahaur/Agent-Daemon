// A typed forget or restore in the prompt hook (L5 design decisions 9 and 12):
//   Claude Code  /<plugin>:forget <ref>, /<plugin>:restore <ref> (the plugin's skills)
//   Codex        $<package>-forget <ref>, $<package>-restore <ref>
// A ref is #12, 12, L12, or `last` (forget only). Who may do what is memory/forget.mjs's
// table; this module only resolves the project, opens the store and words the receipt.
// Also: the agent's hides and forget requests the user hasn't been told about.

import path from "node:path";
import { PRODUCT, pinnedCommand } from "../product.mjs";

const forms = (host) =>
  host === "codex"
    ? { forget: `$${PRODUCT.package}-forget`, restore: `$${PRODUCT.package}-restore` }
    : { forget: `/${PRODUCT.plugin}:forget`, restore: `/${PRODUCT.plugin}:restore` };

const cliForm = (verb, version) => (version ? pinnedCommand(verb, version) : `npx -y ${PRODUCT.package} ${verb}`);

/**
 * Run one typed forget or restore. → { status, receipt: { systemMessage, context } } or null
 * (a prompt nobody typed: nothing happens, nothing is shown).
 * @param {{verb:"forget"|"restore", arg:string, input:object, source:object, host:string, cwd:string, version?:string|null, handle?:object|null, now?:Date}} o
 */
export async function runMemoryVerb({ verb, arg, input, source, host, cwd, version = null, handle = undefined, now = new Date() }) {
  const { askerOf, parseRef, forgetLearning, restoreLearning, commandReceipt } = await import("../memory/forget.mjs");
  const asker = askerOf({ source });
  if (!asker) return null;
  const words = { verb, product: PRODUCT.displayName, ...forms(host), review: cliForm("review", version), terminalForget: (id) => cliForm(`forget ${id}`, version) };
  const say = (line) => ({
    systemMessage: line,
    context: `${PRODUCT.displayName} handled the user's ${verb} command and told them: ${line.replace(`${PRODUCT.displayName}: `, "")} Don't call a memory tool for it and don't diagnose it.`,
  });
  const ep = await import("../memory/episodic.mjs");
  const store = handle === undefined ? await ep.db().catch(() => null) : handle;
  if (!store) return { status: "no-store", receipt: say(`${PRODUCT.displayName}: Nothing changed: the memory store can't be opened right now (busy, or from another version). Try again, or run ${cliForm("doctor", version)}.`) };
  const dir = path.resolve(String(cwd || input?.cwd || process.cwd()));
  // A folder that shares its memory with another can't tell their notes apart: nothing changes.
  // Every name of this folder (the host's cwd and its real path, for a linked folder).
  const { folderPaths } = await import("../memory/forget.mjs");
  const paths = folderPaths(dir, { env: {} });
  const { slugCollides } = await import("../memory/safety.mjs");
  if (paths.some((p) => slugCollides(store, ep.projectSlug(p), p))) return { status: "collides", receipt: say(`${PRODUCT.displayName}: Nothing changed: this folder shares its memory with another folder`) };
  const { projectIdOf } = await import("../memory/projects.mjs");
  const keys = [...new Set(paths.map((p) => ep.projectSlug(p))), projectIdOf(dir)].filter(Boolean);
  const ref = parseRef(arg);
  const opts = { ref, asker, keys, verdict: source, sessionId: input?.session_id, now };
  const r = verb === "restore" ? restoreLearning(store, opts) : await forgetLearning(store, opts);
  const line = commandReceipt(r, words);
  return { status: r.status, receipt: line ? say(line) : null };
}

/**
 * The line about the agent's untold hides and forget requests in this project, marking
 * them told (L5 decision 12: a typed, attended Claude Code prompt shows them). → line or null.
 */
export async function agentActionsNotice({ cwd, version = null, handle = undefined, now = new Date() }) {
  const ep = await import("../memory/episodic.mjs");
  const store = handle === undefined ? await ep.db().catch(() => null) : handle;
  if (!store) return null;
  const { projectIdOf } = await import("../memory/projects.mjs");
  const dir = path.resolve(String(cwd || process.cwd()));
  const { untoldAgentActions, agentActionsLine, folderPaths } = await import("../memory/forget.mjs");
  const paths = folderPaths(dir, { env: {} });
  const { slugCollides } = await import("../memory/safety.mjs");
  if (paths.some((p) => slugCollides(store, ep.projectSlug(p), p))) return null;
  const keys = [...new Set(paths.map((p) => ep.projectSlug(p))), projectIdOf(dir)].filter(Boolean);
  return agentActionsLine(untoldAgentActions(store, { keys, now }), { product: PRODUCT.displayName, review: cliForm("review", version) });
}
