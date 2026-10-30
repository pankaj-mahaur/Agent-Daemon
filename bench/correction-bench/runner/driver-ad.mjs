// Driver for ad's own engine: one engine process per session, so every session
// starts fresh and ends with the engine's SessionEnd hooks.
//
// The episode process runs with HOME, USERPROFILE and AD_ROOT inside the episode's
// temp root (runner/run.mjs sets them), so ad's hooks and memory store never touch
// a real home. The engine's settings file is the run's provider settings plus the
// condition's memory settings; nothing is read from the user's own engine folder.
//
// Conditions:
//   off, static-rules  no ad setup (no hooks, no memory server); engine memories off
//   native             no ad setup; engine memories on
//   on-hooks           ad's harness setup (hooks, memory server, instructions); engine memories off
//   on-tools           ad's harness setup, then an empty hooks file (memory server only)
// Approvals, the same in every condition: file changes are accepted, commands and
// extra permissions are declined (nobody is at the keyboard).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime");
const imp = (rel) => import(pathToFileURL(path.join(RUNTIME, rel)).href);

export const name = "ad";
export const rulesFile = "AGENTS.md";

// Seen in the engine binary (0.163): a [memories] table with these keys. Every
// run reads them back from the engine's effective settings (prepare → check).
export const ENGINE_MEMORIES_KEYS = ["generate_memories", "use_memories"];

export function settings(condition) {
  return {
    host: "ad (its engine, one process per session)",
    adHooks: condition.adHooks,
    adTools: condition.adTools,
    engineMemories: { table: "memories", keys: ENGINE_MEMORIES_KEYS, value: condition.hostMemory },
    rulesFile: condition.rulesFile ? rulesFile : null,
    instructions: `ad's instruction block in the engine's AGENTS.md, the same in every condition; its Memory section ${condition.adTools ? "included" : "removed"} (the hash is in each episode's session-1 record)`,
    sandbox: process.platform === "win32" ? "workspace-write (Windows sandbox, unelevated)" : "workspace-write",
    approvals: "file changes accepted; commands and extra permissions declined",
  };
}

const onApproval = (req) => (req.kind === "approval-patch" ? "accept" : "decline");

/** ad's instruction block without its "## Memory" section (everything up to "## Skills"). */
export const withoutMemorySection = (block) => block.replace(/## Memory\n[\s\S]*?(?=## Skills)/, "");

/** Write the engine home's AGENTS.md for a condition → { sha256, memorySection }. */
export function writeInstructions(engineHome, block, { memory }) {
  const text = (memory ? block : withoutMemorySection(block)) + "\n";
  fs.writeFileSync(path.join(engineHome, "AGENTS.md"), text);
  // The exact heading: ad's constitution has a "## Memory retrieval" section of its own (the same in every condition).
  return { sha256: crypto.createHash("sha256").update(text).digest("hex"), memorySection: /^## Memory$/m.test(text) };
}

/**
 * @param {{root: string, cwd: string, condition: object, configToml: string, log?: (s: string) => void}} o
 */
export async function prepare({ root, cwd, condition, configToml, log = () => {} }) {
  const engineHome = path.join(root, "engine");
  fs.mkdirSync(engineHome, { recursive: true });
  const memories = `\n[memories]\n${ENGINE_MEMORIES_KEYS.map((k) => `${k} = ${condition.hostMemory ? "true" : "false"}`).join("\n")}\n`;
  fs.writeFileSync(path.join(engineHome, "config.toml"), `${configToml.trimEnd()}\n${memories}`);
  fs.writeFileSync(path.join(engineHome, ".agent-daemon-managed"), "correction-bench\n");
  const ctx = { engineHome, condition, log, err: { write: (s) => log(String(s).trimEnd()) } };
  const { startHarnessEngine } = await imp("src/harness/start.mjs");
  const started = await startHarnessEngine({ cwd, home: engineHome, clientVersion: "correction-bench", onApproval, err: ctx.err, setup: condition.adTools || condition.adHooks, notesFile: null });
  if (!started.engine) throw new Error(`the engine did not start: ${started.error}`);
  try {
    // The same sandbox in every condition: ad's setup makes the Windows one, so
    // the other conditions get it here (without it no file change can be applied).
    const { needsWindowsSandbox, setupWindowsSandbox } = await imp("src/harness/sandbox.mjs");
    if (needsWindowsSandbox(process.platform) && !(await started.engine.readConfig()).windows?.sandbox) await setupWindowsSandbox(started.engine, { mode: "unelevated", cwd });
    // The memory settings the condition promises, read back from the engine itself.
    const cfg = await started.engine.readConfig();
    const seen = Object.fromEntries(ENGINE_MEMORIES_KEYS.map((k) => [k, cfg?.memories?.[k]]));
    if (ENGINE_MEMORIES_KEYS.some((k) => seen[k] !== condition.hostMemory)) throw new Error(`engine memories are ${JSON.stringify(seen)}, the condition needs ${condition.hostMemory}`);
    ctx.engineMemoriesSeen = seen;
    // The same instructions in every condition: ad's block (identity, skills, its
    // coding rules), with the Memory section only where ad's memory is on. Without
    // this, on-* would differ from off by coding guidance too, not memory alone.
    const { harnessIdentity, renderHarnessBlock } = await imp("src/harness/setup.mjs");
    ctx.instructions = writeInstructions(engineHome, renderHarnessBlock(undefined, { identity: await harnessIdentity(started.engine) }), { memory: condition.adTools });
    // If ad's block changes its headings, removing the section would silently do nothing.
    if (ctx.instructions.memorySection !== condition.adTools) throw new Error(`the instructions ${ctx.instructions.memorySection ? "still have" : "lack"} ad's Memory section in a condition with ad's memory ${condition.adTools ? "on" : "off"} (did renderHarnessBlock's headings change?)`);
  } finally {
    await started.engine.close();
  }
  if (condition.adTools && !condition.adHooks) fs.writeFileSync(path.join(engineHome, "hooks.json"), JSON.stringify({ description: "correction-bench on-tools: no hooks", hooks: {} }, null, 2) + "\n");
  return ctx;
}

/** One session: a fresh engine and thread. */
export async function open(ctx, { cwd, model }) {
  const { startHarnessEngine } = await imp("src/harness/start.mjs");
  const started = await startHarnessEngine({ cwd, home: ctx.engineHome, clientVersion: "correction-bench", onApproval, err: ctx.err, setup: false, notesFile: null });
  if (!started.engine) throw new Error(`the engine did not start: ${started.error}`);
  const engine = started.engine;
  let threadId;
  try {
    ({ threadId } = await engine.startThread({ cwd, model }));
  } catch (e) {
    await engine.close();
    throw e;
  }
  return {
    async turn(text, { timeoutMs = 300_000 } = {}) {
      const r = await engine.turn({ threadId, text, timeoutMs });
      return { status: r.status === "completed" ? "ok" : "crash", error: r.error?.message ?? null };
    },
    async close() {
      const t0 = Date.now();
      await engine.close();
      ctx.log(`engine closed in ${Date.now() - t0} ms`);
    },
  };
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Did ad store something from this correction? Its store and journals are the episode's own. */
export async function captured(ctx, { cwd, text }) {
  const { jaccard } = await imp("src/memory/metrics.mjs");
  const stored = [];
  const ep = await imp("src/memory/episodic.mjs");
  try {
    const h = await ep.db();
    for (const r of h?.all("SELECT text FROM learnings") ?? []) stored.push(r.text);
  } finally {
    ep.closeDb();
  }
  const dirs = [path.join(cwd, ".agent-daemon"), ...listDirs(path.join(process.env.AD_ROOT ?? "", "projects"))];
  for (const d of dirs)
    for (const f of safeList(d).filter((n) => /^learning-journal.*\.jsonl$/.test(n)))
      for (const line of fs.readFileSync(path.join(d, f), "utf8").split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e?.text) stored.push(e.text);
        } catch {
          // a partial line
        }
      }
  const n = norm(text);
  const hits = stored.filter((s) => (norm(s).length >= 8 && n.includes(norm(s))) || jaccard(s, text) >= 0.5);
  return { captured: hits.length > 0, stored: [...new Set(hits)].slice(0, 3) };
}

/** How many session rows ad's store has (SessionEnd's digest adds one per session). */
export async function sessionCount() {
  const ep = await imp("src/memory/episodic.mjs");
  try {
    return (await ep.db())?.get("SELECT COUNT(*) AS n FROM sessions")?.n ?? 0;
  } catch {
    return 0;
  } finally {
    ep.closeDb();
  }
}

/**
 * Evidence this session's hooks ran: the prompt hook's heartbeat since `since`,
 * and a new session row from SessionEnd's digest (a detached process: waited for).
 */
export async function hookEvidence(ctx, { since, sessionsBefore, waitMs = 60_000 }) {
  const ep = await imp("src/memory/episodic.mjs");
  const read = async () => {
    try {
      const h = await ep.db();
      return {
        promptHook: (h?.get("SELECT COUNT(*) AS n FROM capture_heartbeats WHERE last_seen >= ?", [since])?.n ?? 0) > 0,
        sessionEnd: (h?.get("SELECT COUNT(*) AS n FROM sessions")?.n ?? 0) > sessionsBefore,
      };
    } catch {
      return { promptHook: false, sessionEnd: false };
    } finally {
      ep.closeDb();
    }
  };
  const until = Date.now() + waitMs;
  let r = await read();
  while (!(r.promptHook && r.sessionEnd) && Date.now() < until) {
    await new Promise((res) => setTimeout(res, 500));
    r = await read();
  }
  return r;
}

function safeList(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}
const listDirs = (d) => safeList(d).map((n) => path.join(d, n)).filter((p) => fs.statSync(p).isDirectory());
