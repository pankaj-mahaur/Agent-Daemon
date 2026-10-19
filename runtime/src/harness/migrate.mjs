// `ad migrate` (own-harness design D7): renames the engine's folder from its
// older name to ~/.agent-daemon/engine and
// leaves a link with the old name, which older versions of ad need.
// Interactive only; never moves a folder the user chose (AD_ENGINE_DIR).
// It never copies-and-deletes: one rename, and any failure renames back.
// `ad migrate --undo` reverses it. Both hold the `migrate` lock.

import * as realFs from "node:fs";
import { join } from "node:path";
import { LEGACY, migrateMessages, twoHomesRefusal } from "../engine/attribution.mjs";
import { engineHome } from "../engine/index.mjs";
import { acquireLock, liveLocks, sweepDeadLeases } from "../lock.mjs";

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function renameWithRetry(fs, from, to, tries = 5, stepMs = 200) {
  for (let i = 1; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (!BUSY.has(err.code) || i >= tries) throw err;
      await sleep(stepMs);
    }
  }
}

export async function cmdMigrate(opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const fs = opts.fs ?? realFs;
  const root = opts.root ?? engineHome.root();
  const env = opts.env ?? process.env;
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const say = (s) => out.write(`${s}\n`);
  const fail = (s, code = 1) => (err.write(`${s}\n`), code);

  if (!interactive) return fail("ad migrate needs an interactive terminal. In Git Bash, run: winpty ad migrate (or use PowerShell or Windows Terminal).", 2);
  let custom;
  try {
    custom = engineHome.override(env);
  } catch (e) {
    return fail(e.message, 2);
  }
  if (custom) {
    if (!env.AD_ENGINE_DIR && env[LEGACY.envHome]) return say(migrateMessages.customPath({ path: custom })), 0;
    return say(`ad migrate moves only ad's own folder. You chose ${custom} (AD_ENGINE_DIR), so nothing moved.`), 0;
  }

  let release;
  try {
    release = acquireLock("migrate", { dir: opts.lockDir });
  } catch (e) {
    if (e.code === "LOCK_BUSY") return fail("Another ad is moving the engine's folder. Try again in a minute.");
    throw e;
  }
  try {
    const ctx = { fs, root, say, fail, lockDir: opts.lockDir };
    return opts.undo ? await undo(ctx) : await migrate({ ...ctx, platform: opts.platform ?? process.platform, today: opts.today ?? new Date() });
  } finally {
    release();
  }
}

// Why a name can't be used as it is (a file, or a link to nothing), or null.
function notAFolder(p, kind) {
  if (kind === "file") return `${p} is a file, not a folder.`;
  if (kind === "dangling") return `${p} points to ${engineHome.linkTarget(p)}, which doesn't exist.`;
  if (kind === "unreachable") return `${p} points to ${engineHome.linkTarget(p)}, which isn't reachable right now.`;
  return null;
}

// Running sessions keep files open in the folder; on Windows that blocks the
// rename, elsewhere it would split their conversations across two folders.
// Every running ad that could be using the engine's folder: conversation
// locks plus engine leases (a TUI before its first thread, ad run, workers,
// one suspended with Ctrl+Z, a holder killed while its engine lives). Leases
// proven dead are swept first; a lease for a custom home (AD_ENGINE_DIR
// elsewhere) doesn't block. One process holding a lease and a thread lock
// counts once.
function runningSessions(lockDir, command, root) {
  sweepDeadLeases({ dir: lockDir });
  const defaults = root ? [join(root, engineHome.OLD_NAME), join(root, engineHome.NEW_NAME)] : [];
  const isDefault = (home) => !home || !defaults.length || defaults.some((d) => engineHome.sameFolder(home, d) || String(home).toLowerCase() === d.toLowerCase());
  const held = liveLocks({ dir: lockDir, except: ["migrate"] }).filter((h) => h.kind !== "engine" || isDefault(h.home));
  if (held.length === 0) return null;
  const pids = [...new Set(held.map((h) => h.pid))];
  const n = pids.length;
  // An engine lease also names the engine process, which may outlive its holder.
  const engines = [...new Set(held.filter((h) => h.child?.pid).map((h) => h.child.pid))];
  const extra = engines.length ? `; engine pid ${engines.join(", ")}` : "";
  return `Not moved: ${n === 1 ? "an ad session is" : `${n} ad sessions are`} running (pid ${pids.join(", ")}${extra}). Nothing changed. Close ${n === 1 ? "it" : "them"} and run \`${command}\` again.`;
}

async function migrate({ fs, root, say, fail, platform, today, lockDir }) {
  const oldP = join(root, engineHome.OLD_NAME);
  const newP = join(root, engineHome.NEW_NAME);
  const o = engineHome.entryKind(oldP);
  const n = engineHome.entryKind(newP);
  const broken = notAFolder(newP, n) ?? notAFolder(oldP, o);
  if (broken) return fail(`${broken} Reconnect it, or move it away, and run \`ad migrate\` again. Nothing changed.`, 2);
  if (n === "link" && o === "dir" && engineHome.sameFolder(newP, oldP)) return say(`Nothing to move: ${newP} is a link to ${oldP}, so both names open the same folder.`), 0;
  if ((o === "dir" || (o === "link" && !engineHome.sameFolder(oldP, newP))) && (n === "dir" || n === "link")) return fail(twoHomesRefusal({ oldPath: oldP, newPath: newP }), 2);
  if (n === "dir" || n === "link") {
    if (o !== "missing") return say(`Nothing to move: the engine's folder is already ${newP}.`), 0;
    // Moved, but the link older versions need is missing (a crash, or a failed first start): make it.
    try {
      (fs.createLink ?? engineHome.createLink)(newP, oldP);
    } catch (e) {
      return fail(`The engine's folder is already ${newP}, but making the link ${oldP} failed (${e.message}). Nothing changed; ad works without it.`);
    }
    return say(`Nothing to move: the engine's folder is already ${newP}. Made the link ${oldP} that older versions of ad need.`), 0;
  }
  if (o === "link") return say(`Nothing to move: ${oldP} is your own link to ${engineHome.linkTarget(oldP)}; ad leaves a folder you placed where it is.`), 0;
  if (o !== "dir") return say("Nothing to move: ad hasn't created the engine's folder yet."), 0;
  const running = runningSessions(lockDir, "ad migrate", root);
  if (running) return fail(running);

  // 1. A copy of the sign-in, kept until the move is verified.
  let backup = null;
  const auth = join(oldP, "auth.json");
  if (fs.existsSync(auth)) {
    const dir = join(root, "backup");
    fs.mkdirSync(dir, { recursive: true });
    backup = join(dir, `auth-${today.toISOString().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(auth, backup);
    fs.chmodSync(backup, 0o600);
  }
  // Back where it was, nothing moved: the copy isn't needed.
  const dropBackup = () => backup && fs.rmSync(backup, { force: true });

  // 2. The rename. A refusal means something holds a file or a working folder inside.
  try {
    await renameWithRetry(fs, oldP, newP);
  } catch (e) {
    dropBackup();
    if (BUSY.has(e.code)) return fail(migrateMessages.busy({ oldPath: oldP }));
    return fail(migrateMessages.failed({ reason: e.message }));
  }

  // 3. The link with the old name, then 4. a check through it. Any failure: back as it was.
  try {
    (fs.createLink ?? engineHome.createLink)(newP, oldP);
    fs.readdirSync(oldP); // through the link: it resolves to a folder (any content; config.toml may be absent)
  } catch (e) {
    try {
      // removeLink refuses a real folder: one that appeared meanwhile ends here, in "moving it back failed".
      if (engineHome.entryKind(oldP) !== "missing") (fs.removeLink ?? engineHome.removeLink)(oldP);
      fs.renameSync(newP, oldP);
    } catch (back) {
      const keptBackup = backup ? ` A copy of the sign-in is kept at ${backup}.` : "";
      return fail(`${migrateMessages.failed({ reason: e.message })} Moving it back also failed (${back.message}): the folder is now ${newP}; nothing was deleted.${keptBackup}`);
    }
    dropBackup();
    return fail(migrateMessages.failed({ reason: e.message }));
  }

  // 5. Record it for ad doctor; drop the sign-in copy; done.
  fs.writeFileSync(join(root, "migrate.json"), JSON.stringify({ from: oldP, to: newP, at: today.toISOString() }, null, 2) + "\n");
  dropBackup();
  say(migrateMessages.done({ oldPath: oldP, newPath: newP, unsafeDeleteTool: platform === "win32" ? "Remove-Item -Recurse" : undefined, macos: platform === "darwin" }));
  return 0;
}

const KIND_WORDS = { missing: "gone", dir: "a folder", link: "a link", dangling: "a link to nothing", unreachable: "an unreachable link", file: "a file" };

async function undo({ fs, root, say, fail, lockDir }) {
  const oldP = join(root, engineHome.OLD_NAME);
  const newP = join(root, engineHome.NEW_NAME);
  const o = engineHome.entryKind(oldP);
  const n = engineHome.entryKind(newP);
  if (n !== "dir") return say("Nothing to undo: the engine's folder isn't under its new name."), 0;
  const broken = notAFolder(oldP, o);
  if (broken) return fail(`${broken} Nothing changed; ad leaves links it didn't make alone.`, 2);
  if (o === "dir") return fail(twoHomesRefusal({ oldPath: oldP, newPath: newP }), 2);
  if (o === "link" && !engineHome.sameFolder(oldP, newP)) return fail(`${oldP} is a link to ${engineHome.linkTarget(oldP)}, not to ${newP}. Nothing changed; ad leaves links it didn't make alone.`, 2);
  const running = runningSessions(lockDir, "ad migrate --undo", root);
  if (running) return fail(running);
  const hadLink = o === "link";
  if (hadLink) (fs.removeLink ?? engineHome.removeLink)(oldP);
  try {
    await renameWithRetry(fs, newP, oldP);
  } catch (e) {
    const why = BUSY.has(e.code) ? migrateMessages.busy({ oldPath: newP }) : migrateMessages.failed({ reason: e.message });
    if (!hadLink) return fail(why);
    try {
      (fs.createLink ?? engineHome.createLink)(newP, oldP); // put the link back: as before the undo
    } catch (back) {
      return fail(`${why.replace(/ Nothing changed\./, "")} Putting the link back also failed (${back.message}): the folder is ${newP} and ${oldP} is ${KIND_WORDS[engineHome.entryKind(oldP)] ?? "unknown"}; nothing was deleted. Run \`ad migrate\` to make the link again.`);
    }
    return fail(why);
  }
  fs.rmSync(join(root, "migrate.json"), { force: true });
  say(`Moved ${newP} back to ${oldP}. Nothing was deleted.`);
  return 0;
}
