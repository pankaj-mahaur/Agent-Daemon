// Run the benchmark: plan the episodes, run each in its own process and temp
// home, write the results.
//
//   node runner/run.mjs --driver ad --engine-config provider.toml --models <m> \
//        [--split dev] [--families a,b] [--conditions off,native,static-rules,on-hooks] \
//        [--seeds 1,2,3] [--sessions 3] [--phrasings <dir>] [--out results/dev-<date>] \
//        [--run-seed 1] [--turn-timeout-ms 600000] [--episode-timeout-ms <ms>] [--keep]
//   node runner/run.mjs --driver claude --models <m> [--host-command '["node","<claude code cli.js>"]'] …
//   node runner/run.mjs --split test --tasks <private dir> --phrasings <private dir> …
//        checks both against tasks/test.sha256 and phrasings/test.sha256, and the
//        fixtures against repos.sha256, before anything runs
//   node runner/run.mjs --mock …       the scripted model (CI smoke; proves plumbing, never a result)
//
// Output (--out): run.json (every setting, versions, the plan), episodes.jsonl
// (one record per session). Analyse with analysis/analyze.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, loadSplit } from "../lib/family.mjs";
import { buildPlan, CONDITIONS } from "../lib/plan.mjs";
import { loadDriver } from "./episode.mjs";
import { scrubPaths } from "../lib/scrub.mjs";
import { withoutGitVars } from "../lib/fixture.mjs";
import { verify } from "../lib/archive.mjs";

const EPISODE = path.join(path.dirname(fileURLToPath(import.meta.url)), "episode.mjs");
const REPO_ROOT = path.resolve(BENCH_DIR, "..", "..");
// Never inherited: the episode's home is its own.
const ISOLATE = ["AD_CODEX_HOME", "AD_ENGINE_DIR", "CODEX_HOME", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "AD_PROFILE", "AD_TOOL_SHELL", "AD_WORKER"];

export function episodeEnv(root, base = process.env) {
  const env = withoutGitVars(base);
  for (const k of ISOLATE) delete env[k];
  const home = path.join(root, "home");
  return { ...env, HOME: home, USERPROFILE: home, AD_ROOT: path.join(home, ".agent-daemon"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
}

// The episode, the engine or claude it started, and their children.
function killTree(child) {
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL"); // its own process group (spawned detached)
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function runChild(specFile, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EPISODE, specFile], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: null, timedOut: true, err });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, err });
    });
  });
}

/** The results file's records; a line cut short by a killed episode is skipped, not fatal. */
export function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a partial line
    }
  }
  return out;
}

/** Sessions an episode never reported become timeout or crash records: never silently missing. → how many */
export function fillMissing(results, { runId, driver, episode: e, total, timedOut, error = "" }) {
  const seen = new Set(readRecords(results).filter((x) => x.run === runId && x.family === e.familyId && x.condition === e.condition && x.model === e.model && x.seed === e.seed).map((x) => x.session));
  let added = 0;
  for (let s = 1; s <= total; s++) {
    if (seen.has(s)) continue;
    // A partial line left by a killed episode must not swallow ours.
    const text = fs.existsSync(results) ? fs.readFileSync(results, "utf8") : "";
    const lead = text && !text.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(results, lead + JSON.stringify({ run: runId, driver, model: e.model, family: e.familyId, condition: e.condition, seed: e.seed, phrasing: e.phrasing.id, session: s, status: timedOut ? "timeout" : "crash", error }) + "\n");
    added++;
  }
  return added;
}

/** The private test split must be the one whose hashes were fixed before the dev pilot. */
export function checkTestSplit({ tasks, phrasings, benchDir = BENCH_DIR }) {
  if (!tasks || !phrasings) throw new Error("--split test needs --tasks and --phrasings: the private test archives");
  for (const [dir, file] of [[tasks, "tasks/test.sha256"], [phrasings, "phrasings/test.sha256"], [path.join(benchDir, "repos"), "repos.sha256"]]) {
    const hashFile = path.join(benchDir, file);
    if (!fs.existsSync(hashFile)) throw new Error(`${file} is missing: write the hashes before the dev pilot (PROTOCOL.md)`);
    if (!verify(dir, hashFile).ok) throw new Error(`${dir} does not match ${file}: it changed after the hashes were fixed`);
  }
}

const gitHead = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: BENCH_DIR, encoding: "utf8", env: withoutGitVars() }).stdout?.trim() || null;

export async function main(argv = process.argv.slice(2)) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      driver: { type: "string", default: "ad" },
      "engine-config": { type: "string" },
      "host-command": { type: "string" },
      mock: { type: "boolean", default: false },
      models: { type: "string" },
      split: { type: "string", default: "dev" },
      families: { type: "string" },
      conditions: { type: "string", default: "off,native,static-rules,on-hooks" },
      seeds: { type: "string", default: "1" },
      sessions: { type: "string" },
      phrasings: { type: "string" },
      tasks: { type: "string" },
      out: { type: "string" },
      "run-seed": { type: "string", default: "1" },
      "episode-timeout-ms": { type: "string" },
      "turn-timeout-ms": { type: "string", default: "600000" },
      keep: { type: "boolean", default: false },
    },
  });
  if (!a.mock && !a["engine-config"] && a.driver === "ad") throw new Error("--engine-config <provider.toml> (or --mock): the engine's provider settings for this run");
  const models = (a.models ?? (a.mock ? "mock-model" : "")).split(",").filter(Boolean);
  if (!models.length) throw new Error("--models: at least one model id");
  if (a.split === "test") checkTestSplit({ tasks: a.tasks, phrasings: a.phrasings });
  let split = loadSplit(a.split, { tasksDir: a.tasks, phrasingsDir: a.phrasings });
  if (a.families) {
    const want = new Set(a.families.split(","));
    split = split.filter((s) => want.has(s.family.id));
    if (split.length !== want.size) throw new Error(`unknown family in --families ${a.families}`);
  }
  const conditions = a.conditions.split(",");
  const seeds = a.seeds.split(",").map(Number);
  const plan = buildPlan(split, { conditions, models, seeds, runSeed: Number(a["run-seed"]) });
  const runId = `${a.split}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const out = path.resolve(a.out ?? path.join(BENCH_DIR, "results", runId));
  fs.mkdirSync(out, { recursive: true });
  const results = path.join(out, "episodes.jsonl");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-bench-"));
  const driver = await loadDriver(a.driver);
  const turnMs = Number(a["turn-timeout-ms"]);
  const hostCommand = a["host-command"] ? JSON.parse(a["host-command"]) : undefined;
  let model = null;
  try {
    if (a.mock) {
      const { startBenchModel } = await import("./mock-model.mjs");
      model = await startBenchModel(split, BENCH_DIR, tmp);
    }
    const configToml = model ? model.configToml : a["engine-config"] ? fs.readFileSync(a["engine-config"], "utf8") : "";
    fs.writeFileSync(
      path.join(out, "run.json"),
      JSON.stringify(
        {
          runId,
          started: new Date().toISOString(),
          bench: { commit: gitHead(), split: a.split, families: split.map((s) => s.family.id), phrasingWriters: [...new Set(split.flatMap((s) => s.phrasings.map((p) => p.writer)))] },
          driver: a.driver,
          mock: a.mock,
          models,
          seeds,
          conditions: Object.fromEntries(conditions.map((c) => [c, { ...CONDITIONS[c], settings: driver.settings(CONDITIONS[c]) }])),
          sessions: a.sessions ? Number(a.sessions) : "all",
          turnTimeoutMs: turnMs,
          platform: { os: process.platform, node: process.version },
          plan: plan.map((e) => e.id),
        },
        null,
        2
      ) + "\n"
    );
    for (const [n, e] of plan.entries()) {
      const root = path.join(tmp, `ep${n}`);
      fs.mkdirSync(path.join(root, "home"), { recursive: true });
      const total = a.sessions ? Number(a.sessions) : split.find((s) => s.family.id === e.familyId).family.sessions.length;
      // Two turns a session, plus starts, setup and end-of-session capture.
      const episodeMs = a["episode-timeout-ms"] ? Number(a["episode-timeout-ms"]) : total * (2 * turnMs + 120_000) + 600_000;
      const spec = { runId, driver: a.driver, episode: e, root, configToml, hostCommand, sessions: a.sessions ? Number(a.sessions) : undefined, turnTimeoutMs: turnMs, out: results, scrubRoots: [REPO_ROOT, os.homedir()] };
      const specFile = path.join(root, "spec.json");
      fs.writeFileSync(specFile, JSON.stringify(spec));
      const r = await runChild(specFile, episodeEnv(root), episodeMs);
      fillMissing(results, { runId, driver: a.driver, episode: e, total, timedOut: r.timedOut, error: scrubPaths(r.err.trim().split("\n").slice(-3).join(" | "), [tmp, REPO_ROOT]).slice(0, 500) });
      if (a.keep && fs.existsSync(path.join(root, "episode.log"))) {
        fs.mkdirSync(path.join(out, "logs"), { recursive: true });
        fs.writeFileSync(path.join(out, "logs", `${e.id}.log`), scrubPaths(fs.readFileSync(path.join(root, "episode.log"), "utf8"), [root, tmp, REPO_ROOT]));
      }
      process.stderr.write(`[${n + 1}/${plan.length}] ${e.id}${r.timedOut ? " (timed out)" : r.code ? ` (exit ${r.code})` : ""}\n`);
    }
    return { out, results, runId };
  } finally {
    await model?.close();
    if (!a.keep) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const same = (x, y) => (process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y);
if (process.argv[1] && same(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  main().then(
    (r) => console.log(`results: ${r.results}`),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(2);
    }
  );
}
