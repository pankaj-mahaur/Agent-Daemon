// One episode, in its own process (runner/run.mjs starts it with HOME, USERPROFILE
// and AD_ROOT inside the episode's temp root):
//   session 1     task → oracle → the correction if violated → end
//   sessions 2…k  a fresh copy of the fixture at the same path, a new session;
//                 task → oracle BEFORE any correction (the scored outcome) → correct if violated → end
// Each session's record is appended to the results file as soon as it is known,
// so a killed episode keeps what it finished.
//
//   node runner/episode.mjs <spec.json>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BENCH_DIR, validateFamily } from "../lib/family.mjs";
import { changes, resetFixture } from "../lib/fixture.mjs";
import { runOracle } from "../lib/oracle.mjs";
import { CONDITIONS } from "../lib/plan.mjs";
import { scrubPaths } from "../lib/scrub.mjs";

export async function loadDriver(name) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), `driver-${name}.mjs`);
  if (!/^[a-z]+$/.test(name) || !fs.existsSync(file)) throw new Error(`no driver "${name}"`);
  return import(pathToFileURL(file).href);
}

/**
 * @param {{runId, driver, episode, root, configToml, sessions?, turnTimeoutMs?, out}} spec
 * @param {{driver?: object}} [inject]  tests pass a driver object
 */
export async function runEpisode(spec, inject = {}) {
  const { episode: e, root } = spec;
  const family = validateFamily(JSON.parse(fs.readFileSync(path.join(e.familyDir, "family.json"), "utf8")), { dir: e.familyDir });
  const condition = CONDITIONS[e.condition];
  const driver = inject.driver ?? (await loadDriver(spec.driver));
  const log = (s) => fs.appendFileSync(path.join(root, "episode.log"), `${new Date().toISOString()} ${s}\n`);
  const cwd = path.join(root, "work", "project");
  const sessions = family.sessions.slice(0, spec.sessions ?? family.sessions.length);
  const emit = (r) => fs.appendFileSync(spec.out, JSON.stringify({ run: spec.runId, driver: driver.name, model: e.model, family: family.id, split: family.split, condition: e.condition, seed: e.seed, phrasing: e.phrasing.id, ...r }) + "\n");
  // Inside the episode HOME is the temp home: the parent passes the real one (and the repo) to scrub.
  const scrubRoots = [root, ...(spec.scrubRoots ?? [])];
  let rules = "";
  let ctx = null;
  for (const [i, s] of sessions.entries()) {
    const session = i + 1;
    const fixture = path.join(BENCH_DIR, "repos", s.fixture);
    const before = resetFixture(fixture, cwd, { rules: condition.rulesFile && rules ? { file: driver.rulesFile, text: `# Project notes\n\n${rules}` } : null });
    const rec = { session, status: "ok", opportunity: false, violated: false, corrected: false, detail: [] };
    let s1 = null;
    try {
      ctx ??= await driver.prepare({ root, cwd, condition, configToml: spec.configToml, hostCommand: spec.hostCommand, model: e.model, log });
      const since = new Date().toISOString();
      const sessionsBefore = driver.sessionCount ? await driver.sessionCount(ctx) : 0;
      s1 = await driver.open(ctx, { cwd, model: e.model });
      const t = await s1.turn(s.task, { timeoutMs: spec.turnTimeoutMs });
      if (t.status !== "ok") Object.assign(rec, { status: t.status, error: t.error });
      else {
        const o = runOracle(family.oracle, changes(before, cwd), { dir: cwd, familyDir: e.familyDir });
        Object.assign(rec, { opportunity: o.opportunity, violated: o.violated, detail: o.detail });
        if (o.violated) {
          const c = await s1.turn(e.phrasing.text, { timeoutMs: spec.turnTimeoutMs });
          rec.corrected = c.status === "ok";
          if (rec.corrected && condition.rulesFile) rules += `- ${e.phrasing.text}\n`;
        }
      }
      await s1.close();
      s1 = null;
      if (driver.hookEvidence) {
        if (condition.adHooks) {
          rec.hooks = await driver.hookEvidence(ctx, { since, sessionsBefore });
          // An ad session whose prompt hook didn't run measures nothing about ad's
          // memory (its journal is what the next session start reads). The
          // end-of-session digest is recorded, not required: the engine caps it at
          // 3 s and a cold Windows start can miss that, while memory doesn't depend on it.
          if (rec.status === "ok" && !rec.hooks.promptHook) rec.status = "hooks-missing";
        } else if ((await driver.hookEvidence(ctx, { since, sessionsBefore, waitMs: 0 })).promptHook && rec.status === "ok") {
          // ad's prompt hook ran in a condition without it: the condition isn't what it says.
          Object.assign(rec, { status: "condition-broken", error: "ad's prompt hook ran in a condition without ad's hooks" });
        }
      }
      // The host's own memory, where the driver can see it (Claude Code's memory folder):
      // recorded, and a condition with it off that has some is broken. (On, the host
      // may simply not have written any yet.)
      if (driver.hostMemoryEvidence) {
        rec.hostMemory = (await driver.hostMemoryEvidence(ctx)).present;
        if (rec.hostMemory && !condition.hostMemory && rec.status === "ok") Object.assign(rec, { status: "condition-broken", error: "the host's own memory was written in a condition with it off" });
      }
      if (session === 1) {
        if (ctx.instructions) rec.instructions = ctx.instructions;
        if (rec.corrected && driver.captured) {
          const c = await driver.captured(ctx, { cwd, text: e.phrasing.text });
          Object.assign(rec, { captured: c.captured, capturedText: c.stored.map((t) => scrubPaths(t, scrubRoots)) });
        }
      }
    } catch (err) {
      Object.assign(rec, { status: /timed? ?out/i.test(String(err?.message)) ? "timeout" : "crash", error: scrubPaths(String(err?.message ?? err), scrubRoots).slice(0, 500) });
      log(`session ${session}: ${err?.stack ?? err}`);
      await s1?.close().catch(() => {});
    }
    emit(rec);
  }
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  runEpisode(spec).then(
    () => process.exit(0),
    (err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    }
  );
}
