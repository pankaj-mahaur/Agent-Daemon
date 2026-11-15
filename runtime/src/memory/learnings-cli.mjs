// `learnings list|show|edit|forget|export|import` (MCP launch plan L8, design decisions 1–9),
// for both CLIs: `<pkg> learnings …` and `ad learnings …`.
//
// list, show and export only read. edit and forget are the review service's (D3: your own
// terminal, typed); import only adds notes that wait for review. Run from the agent's shell
// (AD_TOOL_SHELL=1, no TTY, an agent among the ancestors) every note's text is neutralised
// and no command that lowers enforcement is printed (L7 S4).

import path from "node:path";
import fsSync from "node:fs";
import { PRODUCT } from "../product.mjs";

export const LEARNINGS_VERBS = Object.freeze(["list", "show", "edit", "forget", "export", "import"]);

const LABEL_WORDS = Object.freeze({
  accepted: "accepted",
  "forget-requested": "accepted, agent asked to forget",
  provisional: "in use before review",
  pending: "waits for review",
  flagged: "held back",
  hidden: "hidden",
  archived: "archived",
  rejected: "rejected",
  superseded: "replaced",
});

// Control, format and bidi characters never reach the terminal as they are.
const plain = (s) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

async function askLine(q) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

/** Is this the user's own terminal? (the token's checks, without asking for a dialog code) */
export async function ownTerminal({ env = process.env, isTTY, ancestry } = {}) {
  const { inOwnTerminal } = await import("./review-service.mjs");
  return inOwnTerminal({ env, ...(isTTY ? { isTTY } : {}), ...(ancestry ? { ancestry } : {}) });
}

/**
 * How a note's text is shown: in full (control characters replaced) to the user; to an
 * agent with secrets masked and no ad command, and a held-back note's text never at all
 * (as `ad memory held` shows it: the reason only).
 */
export async function shownText(text, { own, max, held = false, reason = null }) {
  if (own) return clip(plain(text), max);
  if (held) return `[held back${reason ? `: ${clip(plain(reason), 60)}` : ""}; its words show in your own terminal]`;
  const { redactSecrets } = await import("../security/secret-patterns.mjs");
  const { neutralText } = await import("../rules/neutral.mjs");
  return neutralText(redactSecrets(String(text ?? "")).text, { max });
}
// Held back by the screen, whatever happened to it since (rejected or hidden rows keep the mark): flaggedSql's test.
const heldOf = (r) => ({ held: r.status === "quarantined" || String(r.applied_to ?? "").startsWith("quarantined") || Boolean(r.quarantine_reason), reason: r.quarantine_reason ?? null });

function parseArgs(argv, spec) {
  const r = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) r._.push(a);
    else if (spec.bool?.includes(a)) r[a.slice(2)] = true;
    else if (spec.value?.includes(a)) {
      if (i + 1 >= argv.length) return { error: `${a} needs a value` };
      r[a.slice(2)] = argv[++i];
    } else return { error: `unknown option ${a}` };
  }
  return r;
}

/**
 * Run one learnings verb. → exit code.
 * @param {string} verb list | show | edit | forget | export | import
 * @param {string[]} argv the words after the verb
 * @param {{out?:Function, ask?:Function, cwd?:string, handle?:object, token?:Function, own?:boolean,
 *   command?:(v:string)=>string, env?:object, now?:Date, keys?:string[]|null}} [o]
 *   own: whether this is the user's own terminal (default: the token's checks);
 *   keys: the project's keys (default: hookProjectKeys(cwd)).
 */
export async function learningsMain(verb, argv = [], o = {}) {
  const out = o.out ?? ((l) => console.log(l));
  const command = o.command ?? ((v) => `npx -y ${PRODUCT.package} ${v}`);
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const env = o.env ?? process.env;
  const reads = `usage: ${command("learnings")} list [--status <label>|all] [--all-projects] [--json] [--limit N] · show <number>`;
  if (!LEARNINGS_VERBS.includes(verb)) {
    // The verbs that change notes are named only in the user's own terminal (L7 S4).
    const mine = o.own ?? (await ownTerminal({ env }));
    out(mine ? `${reads} · edit <number> [--text "<new text>"] · forget <number> · export [--out <file>] [--force] · import <file>` : `${reads} (the user changes, forgets, exports and imports learnings in their own terminal)`);
    return 1;
  }
  const usage = reads;
  if (verb === "forget") {
    // L5's forget path (forget.mjs through memory-cli.mjs): the typed number for an accepted note.
    return forgetVerb(argv, { ...o, out, command, cwd, env });
  }
  const own = o.own ?? (await ownTerminal({ env }));
  const ep = await import("./episodic.mjs");
  const handle = o.handle ?? (await ep.db().catch(() => null));
  if (!handle) {
    out(`${PRODUCT.displayName}: the memory store can't be opened (run ${command("doctor")}).`);
    return 1;
  }
  const keysOf = async () => (o.keys !== undefined ? o.keys : (await import("./scope.mjs")).hookProjectKeys(cwd, { env }));

  if (verb === "list") {
    const a = parseArgs(argv, { bool: ["--all-projects", "--json"], value: ["--status", "--limit"] });
    if (a.error || a._.length) {
      out(a.error ?? usage);
      return 1;
    }
    const L = await import("./learnings.mjs");
    const labels = !a.status ? L.DEFAULT_LABELS : a.status === "all" ? L.LABELS : a.status.split(",");
    if (labels.some((x) => !L.LABELS.includes(x))) {
      out(`--status takes ${L.LABELS.join(", ")} or all`);
      return 1;
    }
    const limit = a.limit === undefined ? 200 : Number(a.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      out("--limit takes a whole number");
      return 1;
    }
    if (a["all-projects"] && !own) {
      out(`${PRODUCT.displayName}: Nothing shown: --all-projects needs your own terminal (agents see this project's learnings only).`);
      return 2;
    }
    const keys = a["all-projects"] ? null : await keysOf();
    const rows = L.listLearnings(handle, { keys, labels, limit });
    if (a.json) {
      const shown = [];
      for (const r of rows) {
        shown.push({
          id: r.id,
          label: r.label,
          scope: r.scope,
          text: await shownText(r.text, { own, max: 2000, ...heldOf(r) }),
          provenance: r.provenance ?? null,
          created_at: r.created_at ?? null,
          accepted_at: r.accepted_at ?? null,
          recalled: r.recalled,
          repeated: r.repeated,
          rules: r.rules.map((x) => ({ id: x.id, kind: x.kind, decision: x.decision })),
        });
      }
      out(JSON.stringify(shown));
      return 0;
    }
    if (!rows.length) {
      out(`${PRODUCT.displayName}: no learnings ${keys === null ? "yet" : "in this project yet"}${a.status ? ` with --status ${a.status}` : ""}.`);
      return 0;
    }
    out(`Learnings ${keys === null ? "in every project" : "in this project"} (${rows.length}${rows.length === limit ? `, newest ${limit}` : ""}):`);
    for (const r of rows) {
      const extra = [r.scope === "all" ? "all projects" : null, r.recalled ? `recalled ${r.recalled}` : null, r.repeated ? `repeated ${r.repeated}` : null, ...r.rules.map((x) => `rule ${x.id}`)].filter(Boolean);
      out(`  #${r.id}  [${LABEL_WORDS[r.label] ?? r.label}]  ${await shownText(r.text, { own, max: 100, ...heldOf(r) })}${extra.length ? `  · ${extra.join(" · ")}` : ""}`);
    }
    out(`Show one: ${command("learnings show <number>")}${a.status ? "" : ` · hidden and archived ones: ${command("learnings list --status all")}`}`);
    return 0;
  }

  if (verb === "show") {
    const a = parseArgs(argv, { bool: ["--all-projects", "--json"] });
    const id = Number(String(a._?.[0] ?? "").replace(/^#/, ""));
    if (a.error || a._.length !== 1 || !Number.isInteger(id) || id <= 0) {
      out(a.error ?? `usage: ${command("learnings show")} <number>`);
      return 1;
    }
    if (a["all-projects"] && !own) {
      out(`${PRODUCT.displayName}: Nothing shown: --all-projects needs your own terminal (agents see this project's learnings only).`);
      return 2;
    }
    const L = await import("./learnings.mjs");
    const r = L.showLearning(handle, id, { keys: a["all-projects"] ? null : await keysOf() });
    if (r.none) {
      out(`${PRODUCT.displayName}: there is no learning #${id}.`);
      return 1;
    }
    if (r.other) {
      out(`${PRODUCT.displayName}: #${id} belongs to another project${own ? ` (${command("learnings show")} ${id} --all-projects shows it)` : ""}.`);
      return 1;
    }
    const n = r.note;
    const text = await shownText(n.text, { own, max: 2000, ...heldOf(n) });
    if (a.json) {
      out(JSON.stringify({ id: n.id, label: n.label, scope: n.scope, text, category: n.category, provenance: n.provenance ?? null, origin: n.origin ?? null, created_at: n.created_at ?? null, accepted_at: n.accepted_at ?? null, status_at: n.status_at ?? null, recalled: n.recalled, last_recalled: n.lastRecalled, repeated: n.repeated, superseded_by: n.superseded_by ?? null, rules: n.rules.map((x) => ({ id: x.id, kind: x.kind, decision: x.decision, scope: x.scope })) }));
      return 0;
    }
    const lines = [`#${n.id}  ${LABEL_WORDS[n.label] ?? n.label} · ${n.scope === "all" ? "all projects" : "this project"}`, `  ${text}`];
    // The checklist's own source words (checklist-rows.mjs), so a note reads the same in both.
    const { sourceWord } = await import("./checklist-rows.mjs");
    const from = [n.provenance === "legacy" ? "saved before review existed" : sourceWord(n.provenance), n.created_at ? `saved ${day(n.created_at)}` : null, n.accepted_at && n.accepted_by ? `accepted ${day(n.accepted_at)}` : null];
    lines.push(`  ${from.filter(Boolean).join(" · ")}`);
    lines.push(`  recalled ${n.recalled} time${n.recalled === 1 ? "" : "s"}${n.lastRecalled ? ` (last ${day(n.lastRecalled)})` : ""} · said again after you accepted it: ${n.repeated}`);
    if (n.superseded_by) lines.push(`  replaced by #${n.superseded_by}`);
    for (const x of n.rules) {
      const verbWord = x.decision === "deny" ? "stops" : "asks before";
      const what = x.kind === "write" ? "writes to" : "the command";
      lines.push(`  rule ${x.id}: ${verbWord} ${what} ${await shownText(patternText(x.pattern), { own, max: 80 })} (${x.scope === "all" ? "all projects" : "this project"})`);
    }
    // From the agent's shell no command that changes a note is named (L7 S4: a forget may
    // also remove a rule once L7's rule verbs land).
    if (["accepted", "forget-requested", "provisional", "pending", "flagged"].includes(n.label)) lines.push(own ? `  Change it: ${command(`learnings edit ${n.id}`)} · forget it: ${command(`learnings forget ${n.id}`)}` : "  The user can change or forget it in their own terminal.");
    for (const l of lines) out(l);
    return 0;
  }

  if (verb === "edit") return editVerb(argv, { ...o, out, command, cwd, env, handle, keysOf, usage });
  if (verb === "export") return exportVerb(argv, { ...o, out, command, cwd, env, handle, keysOf });
  if (verb === "import") return importVerb(argv, { ...o, out, command, cwd, env, handle, keysOf });

  out(`${PRODUCT.displayName}: learnings ${verb} isn't here yet.`);
  return 1;
}

// The token, or why not: the CLI verbs' one way to ask for it (memory-cli.mjs cliToken).
async function tokenOf(o) {
  const { cliToken } = await import("./memory-cli.mjs");
  return cliToken({ token: o.token, ask: o.ask ?? askLine, out: o.out });
}

// A folder that shares its memory with another can't tell their notes apart: nothing changes there.
async function sharedFolder(handle, cwd, env) {
  const ep = await import("./episodic.mjs");
  const { folderPaths } = await import("./forget.mjs");
  const { slugCollides } = await import("./safety.mjs");
  return folderPaths(cwd, { env }).some((p) => slugCollides(handle, ep.projectSlug(p), p));
}

/** Run the user's editor on a note's text with node's spawn (the terminal is handed over). */
async function editInTerminal(text, o) {
  const { editInEditor } = await import("../edit-text.mjs");
  const { spawn } = await import("node:child_process");
  const run = o.run ?? ((cmd, args, verbatim) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false, windowsVerbatimArguments: Boolean(verbatim) });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", reject);
  }));
  return editInEditor(`${text}\n`, { run, env: o.env, platform: o.platform ?? process.platform, resolve: o.resolve, cmdExe: o.cmdExe, now: o.clock, name: "note.txt", prefix: "ad-note-" });
}

const EDIT_WORDS = {
  same: "Nothing changed: the words are the same.",
  empty: "Nothing changed: the new text is empty.",
  "too-long": "Nothing changed: the note is too long (up to 2000 characters).",
  "refused-secret": "Nothing changed: the new text looks like it holds a secret. Say it without it.",
  none: "Nothing changed: there is no such learning.",
  other: "Nothing changed: that learning belongs to another project.",
};

async function editVerb(argv, o) {
  const { out, command, handle } = o;
  const a = parseArgs(argv, { value: ["--text"] });
  const id = Number(String(a._?.[0] ?? "").replace(/^#/, ""));
  if (a.error || a._.length !== 1 || !Number.isInteger(id) || id <= 0) {
    out(a.error ?? `usage: ${command("learnings edit")} <number> [--text "<new text>"]`);
    return 1;
  }
  const t = await tokenOf(o);
  if (!t.token) {
    out(`${PRODUCT.displayName}: Nothing changed: editing a learning needs your own terminal (${t.refused}).`);
    return 2;
  }
  if (await sharedFolder(handle, o.cwd, o.env)) {
    out(`${PRODUCT.displayName}: Nothing changed: this folder shares its memory with another folder.`);
    return 1;
  }
  const row = handle.get("SELECT id, text FROM learnings WHERE id = ?", [id]);
  if (!row) {
    out(`${PRODUCT.displayName}: ${EDIT_WORDS.none}`);
    return 1;
  }
  // Another project's note is never opened in the editor.
  if ((await import("./learnings.mjs")).showLearning(handle, id, { keys: await o.keysOf() }).other) {
    out(`${PRODUCT.displayName}: ${EDIT_WORDS.other}`);
    return 1;
  }
  let text = a.text;
  if (text === undefined) {
    const tty = o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
    if (!tty()) {
      out(`usage: ${command("learnings edit")} <number> --text "<new text>" (the editor needs a terminal)`);
      return 1;
    }
    try {
      text = await (o.editText ?? ((x) => editInTerminal(x, o)))(row.text);
    } catch (e) {
      out(`${PRODUCT.displayName}: Nothing changed: ${e.message}`);
      return 1;
    }
    if (text === null || text === undefined) {
      out(`${PRODUCT.displayName}: Nothing changed: the editor didn't finish.`);
      return 1;
    }
  }
  const svc = await import("./review-service.mjs");
  const keys = await o.keysOf();
  const r = await svc.editLearning(handle, t.token, id, text, { keys, now: o.now ?? new Date() });
  if (r.status === "flagged") {
    const { FLAG_PHRASES } = await import("./prompt-screen.mjs");
    out(`${PRODUCT.displayName}: Nothing changed: the new text mentions ${FLAG_PHRASES[r.flags[0]] ?? "something to check"}. Save it with ${command("remember")} and decide in review.`);
    return 1;
  }
  if (r.status === "duplicate") {
    out(`${PRODUCT.displayName}: Nothing changed: #${r.twin} already has these words.`);
    return 1;
  }
  if (r.status === "closed") {
    out(`${PRODUCT.displayName}: Nothing changed: #${id} is ${r.label === "superseded" ? "replaced by a newer note" : r.label}; restore it first.`);
    return 1;
  }
  if (r.status === "edited") {
    out(`${PRODUCT.displayName}: Changed #${id}. It waits for your review: ${command("review")}`);
    return 0;
  }
  if (r.status === "replaced") {
    // The old words' line in the memory files gets the new ones (as ad review's reword does).
    try {
      const { resolveProjectMemoryPath } = await import("../digest/apply.mjs");
      const { rewordInFile } = await import("./metrics.mjs");
      const fsp = await import("node:fs/promises");
      const file = await resolveProjectMemoryPath(o.cwd);
      const next = rewordInFile(await fsp.readFile(file, "utf8"), row.text, r.text);
      if (next !== null) await fsp.writeFile(file, next);
    } catch {
      // no memory file: nothing to update
    }
    // ~/.agent-daemon/user.md, where older ad wrote cross-project notes: session start injects it.
    try {
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const { dropFromFile } = await import("./metrics.mjs");
      const user = path.join(o.home ?? os.homedir(), ".agent-daemon", "user.md");
      const next = dropFromFile(await fsp.readFile(user, "utf8"), row.text);
      if (next !== null) await fsp.writeFile(user, next);
    } catch {
      // no user.md
    }
    // Its rules move to the new note, and the rules snapshot follows (L7 rules-finish).
    let moved = [];
    try {
      const { afterReview } = await import("./rules-finish.mjs");
      moved = (await afterReview(handle, t.token, { now: o.now ?? new Date(), ...(o.root ? { root: o.root } : {}) }))?.moved ?? [];
    } catch (e) {
      out(`${PRODUCT.displayName}: the rules snapshot couldn't be rebuilt (${e.message}); it is rebuilt at the next review.`);
    }
    out(`${PRODUCT.displayName}: #${id} is now #${r.newId}${moved.length ? ` (rule ${moved.join(", rule ")} moved with it)` : ""}. Your agents use the new words from their next session.`);
    // A rule keeps the reason it was approved with (its own words reach the agent when it asks or stops).
    if (moved.length) out(`Rule ${moved.join(", rule ")} keeps the reason it was approved with.`);
    return 0;
  }
  out(`${PRODUCT.displayName}: ${EDIT_WORDS[r.status] ?? `Nothing changed (${r.status}).`}`);
  return 1;
}

// A rule's pattern is JSON (L7 D1): show its readable part.
function patternText(p) {
  try {
    const v = JSON.parse(p);
    if (v?.type === "command") return [v.program, ...(v.subcommands ?? []), ...(v.flags ?? [])].join(" ") + (v.branches?.length ? ` on ${v.branches.join(", ")}` : "");
    if (v?.type === "write") return (v.globs ?? []).join(", ");
  } catch {
    // a plain pattern
  }
  return String(p ?? "");
}

async function forgetVerb(argv, o) {
  const { out } = o;
  const ref = argv.join(" ").trim().replace(/^#/, "");
  const id = Number(ref);
  if (!Number.isInteger(id) || id <= 0) {
    const mine = o.own ?? (await ownTerminal({ env: o.env }));
    out(mine ? `usage: ${o.command("learnings forget")} <number>` : `${PRODUCT.displayName}: the user forgets learnings in their own terminal.`);
    return 1;
  }
  const ep = await import("./episodic.mjs");
  const handle = o.handle ?? (await ep.db().catch(() => null));
  let rules = [];
  try {
    rules = handle ? handle.all("SELECT id FROM rules WHERE learning_id = ? ORDER BY id", [id]).map((r) => r.id) : [];
  } catch {
    rules = []; // an older store: no rules table
  }
  const { memoryVerbMain } = await import("./memory-cli.mjs");
  const code = await memoryVerbMain("forget", [String(id)], { ...o, ask: o.ask ?? askLine, handle: handle ?? undefined });
  if (code === 0 && rules.length && handle && !handle.get("SELECT 1 AS x FROM learnings WHERE id = ?", [id])) {
    out(`Rule ${rules.join(", rule ")} stays: it keeps asking or stopping until you remove it.`);
  }
  return code;
}

// Where an export may not go: ad's own state and the hosts' config folders (memory-install/hosts.mjs).
let hostDirs = () => [];
function forbiddenTarget(file, { home, root, env }) {
  const real = (d) => {
    try {
      return fsSync.realpathSync(d);
    } catch {
      return path.resolve(d);
    }
  };
  const inside = (dir) => {
    const rel = path.relative(real(dir), file);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  return [root, path.join(home, ".agent-daemon"), ...hostDirs({ env, home })].some((d) => d && inside(d));
}

async function exportVerb(argv, o) {
  const { out, command, handle } = o;
  const a = parseArgs(argv, { bool: ["--force"], value: ["--out"] });
  if (a.error || a._.length) {
    out(a.error ?? `usage: ${command(`learnings export`)} [--out <file>] [--force]`);
    return 1;
  }
  const t = await tokenOf(o);
  if (!t.token) {
    out(`${PRODUCT.displayName}: Nothing written: exporting your learnings needs your own terminal (${t.refused}).`);
    return 2;
  }
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { adRoot } = await import("../ad-root.mjs");
  let file = path.resolve(o.cwd, a.out ?? "ad-learnings.json");
  // Judge where it really lands: a linked folder that points into ~/.claude is ~/.claude.
  try {
    file = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    // the folder doesn't exist: the write below says so
  }
  const H = await import("../memory-install/hosts.mjs");
  hostDirs = ({ env, home }) => H.hostConfigDirs({ env, home });
  if (forbiddenTarget(file, { home: o.home ?? os.homedir(), root: o.root ?? adRoot(), env: o.env ?? process.env })) {
    out(`${PRODUCT.displayName}: Nothing written: ${file} is inside ad's or an agent's own folder. Choose another place.`);
    return 1;
  }
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    st = null;
  }
  if (st?.isDirectory()) {
    out(`${PRODUCT.displayName}: Nothing written: ${file} is a folder. Name a file (--out <file>).`);
    return 1;
  }
  if (st && !a.force) {
    out(`${PRODUCT.displayName}: Nothing written: ${file} exists. Add --force to replace it.`);
    return 1;
  }
  const L = await import("./learnings-file.mjs");
  const { screenPrompt } = await import("./prompt-screen.mjs");
  const { notes, skipped } = L.exportNotes(handle, { keys: await o.keysOf(), screen: (t) => screenPrompt(t, { userWords: false }), ...(o.home ? { home: o.home } : {}) });
  // Private from the first byte (mode 0600 at creation), then renamed into place.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, L.buildFile(notes, { now: o.now ?? new Date() }), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    out(`${PRODUCT.displayName}: Nothing written: ${e.message}`);
    return 1;
  }
  out(`${PRODUCT.displayName}: Wrote ${notes.length} accepted note${notes.length === 1 ? "" : "s"} to ${file}. It holds your notes' words: keep it private.`);
  if (skipped) out(`${skipped} note${skipped === 1 ? " was" : "s were"} left out: still holding a secret-shaped value.`);
  const { insideWorkTree } = await import("./git-tracked.mjs");
  if (insideWorkTree(path.dirname(file))) out("This file is inside a git repository: push it only to a private one.");
  out(`Bring them into another machine or project with ${command(`learnings import`)} <file> (they wait for your review there).`);
  return 0;
}

async function importVerb(argv, o) {
  const { out, command, handle } = o;
  const a = parseArgs(argv, {});
  if (a.error || a._.length !== 1) {
    out(a.error ?? `usage: ${command(`learnings import`)} <file>`);
    return 1;
  }
  const t = await tokenOf(o);
  if (!t.token) {
    out(`${PRODUCT.displayName}: Nothing imported: importing learnings needs your own terminal (${t.refused}).`);
    return 2;
  }
  if (await sharedFolder(handle, o.cwd, o.env)) {
    out(`${PRODUCT.displayName}: Nothing imported: this folder shares its memory with another folder.`);
    return 1;
  }
  const fs = await import("node:fs");
  const L = await import("./learnings-file.mjs");
  const file = path.resolve(o.cwd, a._[0]);
  let text;
  try {
    if (fs.statSync(file).size > L.MAX_FILE_BYTES) throw new Error("the file is larger than 2 MB");
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    out(`${PRODUCT.displayName}: Nothing imported: ${e.code === "ENOENT" ? `there is no file ${file}` : e.message}.`);
    return 1;
  }
  const parsed = L.parseFile(text);
  if (parsed.error) {
    out(`${PRODUCT.displayName}: Nothing imported: ${parsed.error}.`);
    return 1;
  }
  const keys = await o.keysOf();
  const { slugOfKeys, idOfKeys } = await import("./projects.mjs");
  const ep = await import("./episodic.mjs");
  const projectSlug = slugOfKeys(keys) ?? ep.projectSlug(o.cwd);
  const r = await L.importNotes(handle, parsed.notes, { projectSlug, projectId: idOfKeys(keys), now: o.now ?? new Date() });
  const skipped = [r.same && `${r.same} you already have`, r.deleted && `${r.deleted} you deleted before`, r.secret && `${r.secret} holding a secret-shaped value`].filter(Boolean);
  out(`${PRODUCT.displayName}: ${r.added + r.flagged} note${r.added + r.flagged === 1 ? "" : "s"} wait for your review${r.flagged ? ` (${r.flagged} held back for a closer look)` : ""}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}. Review: ${command("review")}`);
  if (r.rulesHeld) out(`${r.rulesHeld} rule${r.rulesHeld === 1 ? " was" : "s were"} held back: accept the notes, then propose their rules in review.`);
  return 0;
}

