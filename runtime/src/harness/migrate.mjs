// `ad migrate` (own-harness design D7): renames the engine's folder from its
// older name (~/.agent-daemon/codex-home) to ~/.agent-daemon/engine and
// leaves a link with the old name, which older versions of ad need.
// Interactive only; never moves a folder the user chose (AD_ENGINE_DIR).
// It never copies-and-deletes: one rename, and any failure renames back.
// `ad migrate --undo` reverses it. Both hold the `migrate` lock.

import * as realFs from "node:fs";
import { join } from "node:path";
import { LEGACY, migrateMessages, twoHomesRefusal } from "../engine/attribution.mjs";
import { engineHome } from "../engine/index.mjs";
import { acquireLock } from "../lock.mjs";

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
    return opts.undo ? await undo({ fs, root, say, fail }) : await migrate({ fs, root, say, fail, platform: opts.platform ?? process.platform, today: opts.today ?? new Date() });
  } finally {
    release();
  }
}

async function migrate({ fs, root, say, fail, platform, today }) {
  const oldP = join(root, engineHome.OLD_NAME);
  const newP = join(root, engineHome.NEW_NAME);
  const o = engineHome.entryKind(oldP);
  const n = engineHome.entryKind(newP);
  if (o === "dir" && (n === "dir" || n === "link")) return fail(twoHomesRefusal({ oldPath: oldP, newPath: newP }), 2);
  if (n === "dir" || n === "link") return say(`Nothing to move: the engine's folder is already ${newP}.`), 0;
  if (o !== "dir") return say("Nothing to move: ad hasn't created the engine's folder yet."), 0;

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
  const keptBackup = backup ? ` A copy of the sign-in is kept at ${backup}.` : "";

  // 2. The rename. A refusal means something holds a file or a working folder inside.
  try {
    await renameWithRetry(fs, oldP, newP);
  } catch (e) {
    if (BUSY.has(e.code)) return fail(migrateMessages.busy({ oldPath: oldP }) + keptBackup);
    return fail(migrateMessages.failed({ reason: e.message }) + keptBackup);
  }

  // 3. The link with the old name, then 4. a check through it. Any failure: back as it was.
  try {
    (fs.createLink ?? engineHome.createLink)(newP, oldP);
    fs.readdirSync(oldP); // through the link: it resolves to a folder (any content; config.toml may be absent)
  } catch (e) {
    try {
      if (engineHome.entryKind(oldP) !== "missing") (fs.removeLink ?? engineHome.removeLink)(oldP);
      fs.renameSync(newP, oldP);
    } catch (back) {
      return fail(`${migrateMessages.failed({ reason: e.message })} Moving it back also failed (${back.message}): the folder is now ${newP}; nothing was deleted.${keptBackup}`);
    }
    return fail(migrateMessages.failed({ reason: e.message }) + keptBackup);
  }

  // 5. Record it for ad doctor; drop the sign-in copy; done.
  fs.writeFileSync(join(root, "migrate.json"), JSON.stringify({ from: oldP, to: newP, at: today.toISOString() }, null, 2) + "\n");
  if (backup) fs.rmSync(backup, { force: true });
  say(migrateMessages.done({ oldPath: oldP, newPath: newP, unsafeDeleteTool: platform === "win32" ? "Remove-Item -Recurse" : undefined, macos: platform === "darwin" }));
  return 0;
}

async function undo({ fs, root, say, fail }) {
  const oldP = join(root, engineHome.OLD_NAME);
  const newP = join(root, engineHome.NEW_NAME);
  if (engineHome.entryKind(oldP) !== "link" || engineHome.entryKind(newP) !== "dir") return say("Nothing to undo: the engine's folder isn't under its new name with a link."), 0;
  (fs.removeLink ?? engineHome.removeLink)(oldP);
  try {
    await renameWithRetry(fs, newP, oldP);
  } catch (e) {
    (fs.createLink ?? engineHome.createLink)(newP, oldP); // put the link back: as before the undo
    return fail(BUSY.has(e.code) ? migrateMessages.busy({ oldPath: newP }) : migrateMessages.failed({ reason: e.message }));
  }
  fs.rmSync(join(root, "migrate.json"), { force: true });
  say(`Moved ${newP} back to ${oldP}. Nothing was deleted.`);
  return 0;
}
