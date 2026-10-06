// ad's own capabilities inside the terminal UI (plan Part 9): memory you can
// see and edit, rows for what ad learned, GEPA proposals, a background loop,
// the team board and the scheduler. Everything that touches ad's stores comes
// in through `memory` (the episodic module) and file paths, so tests run on
// temp folders and fakes.
//
//   createAdLayer({cwd, home, memory, cli, spawnFn, now}) → {
//     memory(sub, arg), learnedSince(threadId, sinceIso), proposals(),
//     loop: {start(objective), stop(), poll(), state}, team(id), schedules(), schedulerWarning()
//   }

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sanitize } from "./terminal/sanitize.mjs";

const clean = (t) => sanitize(String(t ?? ""), "transcript").replace(/\s*\n\s*/g, " ").replace(/\t/g, " ");
const short = (t, n = 140) => {
  const s = clean(t);
  return s.length > n ? `${s.slice(0, n - 1)}\u{2026}` : s;
};

export function createAdLayer({ cwd, home = homedir(), memory = null, cli = null, spawnFn = spawn, now = () => Date.now() } = {}) {
  const slug = memory?.projectSlug ? memory.projectSlug(cwd) : null;
  const adDir = path.join(cwd, ".agent-daemon");

  /* ------------------------------------------------------------ */
  /* Memory                                                        */
  /* ------------------------------------------------------------ */

  const row = (l) => `#${l.id} [${clean(l.category)}] ${short(l.text)}`;

  async function memoryCmd(sub = "", arg = "") {
    if (!memory) return ["ad memory isn't available here."];
    const s = String(sub).toLowerCase();
    if (s === "search") {
      if (!arg.trim()) return ["/memory search <words>"];
      const rows = await memory.searchLearnings(arg, { limit: 10, projectSlug: slug });
      return rows.length ? [`Memory matching \u{201c}${short(arg, 60)}\u{201d}:`, ...rows.map(row)] : [`Nothing in memory matches \u{201c}${short(arg, 60)}\u{201d}.`];
    }
    if (s === "recent") {
      const rows = await memory.listRecentLearnings({ limit: 10, projectSlug: slug });
      return rows.length ? ["Recent learnings:", ...rows.map(row)] : ["No learnings yet for this project."];
    }
    if (s === "forget") {
      const id = Number(String(arg).replace(/^#/, ""));
      if (!Number.isInteger(id) || id <= 0) return ["/memory forget <id> (the #number from /memory search or recent)"];
      const handle = await memory.db();
      if (!handle) return ["ad memory isn't set up (ad doctor)."];
      // Archived, not deleted: `ad memory` can still show it, and nothing else depends on the row going away.
      // Only this project's (or global) learnings: an id from another project is left alone.
      const r = handle.run("UPDATE learnings SET status = 'archived' WHERE id = ? AND status = 'active' AND (project_slug = ? OR project_slug IS NULL)", [id, slug]);
      return [r.changes ? `Forgot #${id}: it won't be recalled again.` : `No active learning #${id}.`];
    }
    if (s === "profile") {
      const profile = await memory.buildUserRepresentation({ projectSlug: slug });
      const md = memory.representationToMarkdown(profile, { compact: true });
      const lines = clean(md) ? sanitize(md, "transcript").split("\n").filter((l) => l.trim()) : [];
      return lines.length ? lines.slice(0, 30) : ["No profile yet: ad builds one as you work."];
    }
    const st = await memory.stats();
    if (!st.driver) return ["ad memory isn't set up (ad doctor)."];
    return [`ad memory: ${st.counts.learnings} learnings, ${st.counts.sessions} sessions.`, "/memory search <words> \u{b7} /memory recent \u{b7} /memory forget <id> \u{b7} /memory profile", "(Codex's own /memories is separate.)"];
  }

  /** Learnings recorded for this thread since `sinceIso` (the "learned" row). */
  async function learnedSince(threadId, sinceIso) {
    if (!memory || !threadId) return [];
    const handle = await memory.db();
    if (!handle) return [];
    try {
      return handle.all("SELECT id, text FROM learnings WHERE session_id = ? AND created_at > ? AND status = 'active' ORDER BY id", [threadId, sinceIso]);
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------ */
  /* Proposals                                                     */
  /* ------------------------------------------------------------ */

  function proposals() {
    const dir = path.join(adDir, "proposed");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
    if (!files.length) return ["No skill proposals waiting."];
    const out = [`${files.length} proposal${files.length === 1 ? "" : "s"} waiting (review them with /ad review):`];
    for (const f of files.slice(0, 15)) {
      let title = "";
      try {
        title = readFileSync(path.join(dir, f), "utf8").split("\n").find((l) => l.trim()) ?? "";
      } catch {
        // unreadable: the name will do
      }
      out.push(`  ${clean(f)}${title ? ` \u{2014} ${short(title.replace(/^#+\s*/, ""), 80)}` : ""}`);
    }
    return out;
  }

  /* ------------------------------------------------------------ */
  /* Loop                                                          */
  /* ------------------------------------------------------------ */

  const loopsDir = path.join(adDir, "loops");
  const stopFile = path.join(adDir, "STOP");
  const loop = { child: null, file: null, seen: 0, startedAt: 0, ownStop: false, exit: null, iterations: 0, last: null };

  const loopApi = {
    get state() {
      return { running: Boolean(loop.child && loop.exit === null), iterations: loop.iterations, last: loop.last, exit: loop.exit, log: loop.file };
    },
    /** Starts `ad loop "<objective>"` in the background, with its own engine and brakes. */
    start(objective, { maxIterations } = {}) {
      if (!cli) return { error: "Loops aren't available here." };
      if (loop.child && loop.exit === null) return { error: "A loop is already running: /loop stop first." };
      if (!String(objective ?? "").trim()) return { error: '/loop "<objective>"' };
      // A STOP file this TUI wrote to stop the last loop would stop the next one at once.
      if (loop.ownStop && existsSync(stopFile)) rmSync(stopFile, { force: true });
      loop.ownStop = false;
      if (existsSync(stopFile)) return { error: `A STOP file exists (${stopFile}): remove it to start a loop.` };
      const homeStop = path.join(home, ".agent-daemon", "STOP");
      if (existsSync(homeStop)) return { error: `A STOP file exists (${homeStop}): it stops every loop; remove it to start one.` };
      mkdirSync(adDir, { recursive: true });
      const logPath = path.join(adDir, "loop-tui.log");
      loop.logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
      loop.logPath = logPath;
      const out = openSync(logPath, "a");
      const args = [cli, "loop", ...(maxIterations ? ["--max-iterations", String(maxIterations)] : []), "--cwd", cwd, "--", objective];
      // Detached: the loop keeps working when the TUI quits (it is a background
      // job with its own brakes; /loop stop or a STOP file ends it).
      loop.child = spawnFn(process.execPath, args, { cwd, stdio: ["ignore", out, out], env: { ...process.env, AD_WORKER: "1" }, windowsHide: true, detached: true });
      loop.child.unref?.();
      loop.exit = null;
      loop.startedAt = now();
      loop.file = null;
      loop.seen = 0;
      loop.iterations = 0;
      loop.last = null;
      loop.child.on?.("exit", (code) => {
        loop.exit = code ?? 1;
        // The STOP this TUI wrote did its job: leave no STOP behind for the next `ad loop`.
        if (loop.ownStop) {
          rmSync(stopFile, { force: true });
          loop.ownStop = false;
        }
      });
      loop.child.on?.("error", () => (loop.exit = 1));
      return { ok: true };
    },
    /** Writes the STOP file: the loop ends after its current turn. */
    stop() {
      if (!loop.child || loop.exit !== null) return { error: "No loop is running." };
      mkdirSync(adDir, { recursive: true });
      writeFileSync(stopFile, "stopped from ad tui\n");
      loop.ownStop = true;
      return { ok: true };
    },
    /** New iteration records since the last poll: [{iteration, turnStatus, progress, tokens}]. */
    poll() {
      if (!loop.child) return [];
      // The loop prints its thread id ("ad loop — thread <id>") into our log: that names its file.
      if (!loop.file && loop.logPath && existsSync(loop.logPath)) {
        const text = readFileSync(loop.logPath, "utf8").slice(loop.logOffset ?? 0);
        const m = /thread (\S+)/.exec(text);
        if (m) loop.file = path.join(loopsDir, `${m[1]}.jsonl`);
      }
      if (!loop.file || !existsSync(loop.file)) return [];
      const lines = readFileSync(loop.file, "utf8").split("\n").filter(Boolean);
      const fresh = [];
      for (let i = loop.seen; i < lines.length; i++) {
        try {
          const r = JSON.parse(lines[i]);
          fresh.push({ iteration: r.iteration ?? i + 1, turnStatus: clean(r.turnStatus), progress: r.status?.progress ? short(r.status.progress, 100) : null, tokens: r.tokens ?? 0 });
        } catch {
          break; // a line still being written: read it next time
        }
        loop.seen = i + 1;
      }
      if (fresh.length) {
        loop.iterations = fresh.at(-1).iteration;
        loop.last = fresh.at(-1);
      }
      return fresh;
    },
  };

  /* ------------------------------------------------------------ */
  /* Team and schedules                                            */
  /* ------------------------------------------------------------ */

  async function team(id) {
    const t = await import("../orchestration/team.mjs");
    const teams = await t.listTeams().catch(() => []);
    if (!teams.length) return ["No teams. Create one with /ad team create --template <name> --task \"…\"."];
    const want = id ? teams.find((x) => (x.id ?? x.teamId ?? x) === id) : teams.at(-1);
    if (!want) return [`No team ${clean(id)}.`];
    const text = await t.formatTeamStatus(want.id ?? want.teamId ?? want).catch((e) => `Couldn't read the team: ${e.message}`);
    return sanitize(String(text), "transcript").split("\n");
  }

  async function loadJobs() {
    const { loadJobs: load } = await import("../harness/schedule.mjs");
    try {
      return load(home);
    } catch {
      return [];
    }
  }

  async function schedules() {
    const jobs = await loadJobs();
    if (!jobs.length) return ["No scheduled jobs. Add one with /ad schedule add \"<cron>\" run \"<prompt>\"."];
    return ["Scheduled jobs:", ...jobs.map((j) => `  ${clean(j.id)}  ${clean(j.cron)}  ${j.enabled ? "" : "(disabled) "}${clean(j.kind)} \u{201c}${short(j.prompt, 50)}\u{201d}  last: ${clean(j.lastStatus ?? "never")}`)];
  }

  /** A warning when an enabled job is overdue: nothing is running the scheduler. */
  async function schedulerWarning() {
    const jobs = await loadJobs();
    const overdue = jobs.filter((j) => j.enabled && j.nextRun && now() - Date.parse(j.nextRun) > 5 * 60_000);
    return overdue.length ? `${overdue.length} scheduled job${overdue.length === 1 ? " is" : "s are"} overdue: the scheduler isn't running (start it with /ad service install, or run ad watch).` : null;
  }

  return { memory: memoryCmd, learnedSince, proposals, loop: loopApi, team, schedules, schedulerWarning };
}
