// doctor's recall rows (MCP launch plan L6, design decision 15): what recall sends from
// this folder and what else loads next to it. Read-only: the store is opened read-only,
// and only the pure builders run (never session start, the drain, the adopting folder
// lookup or the reminder). Coexistence rows are information, never failures.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRODUCT } from "../product.mjs";

const fmt = (n) => n.toLocaleString("en-US");

/** A read-only view of the store with the get/all the recall readers use, or null. */
async function readOnlyStore(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const { openDatabase } = await import("./driver.mjs");
    const raw = await openDatabase(dbPath, { readonly: true });
    if (!raw) return null;
    return {
      get: (sql, params = []) => raw.prepare(sql).get(...params),
      all: (sql, params = []) => raw.prepare(sql).all(...params),
      run: () => {
        throw new Error("read-only");
      },
      transaction: () => {
        throw new Error("read-only");
      },
      close: () => raw.close(),
    };
  } catch {
    return null;
  }
}

/**
 * The recall rows for one folder.
 * @param {{cwd: string, home?: string, env?: object, platform?: string, dbPath?: string, keys?: string[], command?: (verb: string) => string}} o
 *   keys: the folder's project keys (the caller resolves them as the hooks do)
 * @returns {Promise<{code: string, ok: boolean, info?: boolean, note: string, host?: string}[]>}
 */
export async function recallChecks({ cwd, home = os.homedir(), env = process.env, platform = process.platform, dbPath, keys = [], command = (v) => `npx -y ${PRODUCT.package} ${v}` }) {
  const rows = [];
  const add = (code, note, extra = {}) => rows.push({ code, ok: true, info: true, note, ...extra });
  const { estimateTokens } = await import("./recall-render.mjs");
  const tokensOfFile = (f) => {
    try {
      return estimateTokens(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };

  // What the brief would send now, built read-only.
  const { adRoot } = await import("../ad-root.mjs");
  const store = await readOnlyStore(dbPath ?? path.join(adRoot({ env }), "episodic.db"));
  try {
    if (!store || !keys.length) {
      add("recall.tokens", keys.length ? "no memory store yet: nothing is sent" : "this folder isn't a project: nothing is sent here");
    } else {
      const { recallMode } = await import("./recall-mode.mjs");
      const { isProjectId } = await import("./projects.mjs");
      const mode = recallMode(store, keys.find(isProjectId) ?? null);
      if (mode === "off") {
        add("recall.tokens", `recall is off in this project: agents get none of your learnings (turn on: ${command("config recall on")})`);
      } else {
        const { buildBrief } = await import("./recall-brief.mjs");
        const b = buildBrief(store, { cwd, keys, product: PRODUCT.displayName, home, spawn: false });
        const parts = [];
        if (b.text) parts.push(`≈ ${fmt(b.tokens)} tokens of your learnings enter your agent's context at each session start here, sent to its model like the rest of the chat (limit 1,200 tokens for everything memory sends); learnings ${b.ids.map((id) => `#${id}`).join(", ")}`);
        else {
          const { pendingRows } = await import("./recall.mjs");
          const waiting = pendingRows(store, keys).length;
          parts.push(b.notes ? `no learnings match this work right now (${fmt(b.notes)} in use)` : waiting ? `nothing in use yet: ${fmt(waiting)} learning${waiting === 1 ? "" : "s"} wait for your OK: ${command("review")}` : "no learnings in use here yet");
        }
        parts.push("per prompt ≤ 400 tokens");
        const last = (() => {
          try {
            return store.get("SELECT injected_bytes AS b FROM retrieval_events WHERE source = 'session-start' AND project_slug IN (" + keys.map(() => "?").join(",") + ") ORDER BY id DESC LIMIT 1", keys);
          } catch {
            return null;
          }
        })();
        if (last?.b) parts.push(`last session start sent ≈ ${fmt(Math.ceil(last.b / 3))} tokens`);
        add("recall.tokens", parts.join(" · "));
      }
    }
  } finally {
    store?.close();
  }

  // What the host loads itself, next to these.
  const { autoMemoryState, claudeMemState, mirrorBlocks } = await import("./recall-coexist.mjs");
  const also = [];
  const claudeMd = tokensOfFile(path.join(cwd, "CLAUDE.md"));
  if (claudeMd) also.push(`CLAUDE.md (${fmt(claudeMd)} tokens)`);
  const am = autoMemoryState({ env, home, cwd, platform });
  if (am.on && am.memory) also.push(`auto memory MEMORY.md (${fmt(tokensOfFile(am.memory.file) ?? 0)} tokens)`);
  if (also.length) add("recall.host", `Claude Code also loads ${also.join(" and ")} at each session start`);

  if (am.on) {
    const where = am.file ?? path.join(env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude"), "settings.json");
    add("coexist.auto-memory", `Claude Code auto memory is on${am.why === "default" ? " (default)" : ` (${am.why})`}: it keeps its own notes${am.memory ? ` (MEMORY.md, ${am.memory.lines} lines)` : ""}, loaded each session next to these, so a learning you forget here can still arrive from there. Keep both, or turn it off with "autoMemoryEnabled": false in ${where}; its existing notes then stop loading.`);
  } else {
    add("coexist.auto-memory", `Claude Code auto memory is off (${am.why}): only these learnings are loaded`);
  }
  let parseToml;
  try {
    parseToml = (await import("smol-toml")).parse;
  } catch {
    parseToml = undefined;
  }
  const cm = claudeMemState({ env, home, cwd, platform, parseToml });
  if (cm.claude || cm.codex) {
    const hosts = [cm.claude ? "Claude Code" : null, cm.codex ? "Codex" : null].filter(Boolean).join(" and ");
    add("coexist.claude-mem", `claude-mem is on in ${hosts}: it also adds notes at session start and captures prompts, so a correction can arrive twice. Both can stay on; its session-start notes are set by CLAUDE_MEM_CONTEXT_OBSERVATIONS in ${path.join(cm.dataDir, "settings.json")}, ours by ${command("config recall")}.`);
  }
  for (const m of mirrorBlocks(cwd)) {
    add("coexist.mirror", `${path.basename(m.file)} still holds an agent-daemon:learnings block (${m.lines} line${m.lines === 1 ? "" : "s"}) from ad 3.x. Claude Code loads it, so these arrive twice and forgotten ones stay. Delete the lines between <!-- agent-daemon:learnings:start --> and <!-- agent-daemon:learnings:end --> (the file may be committed to your repo).`);
  }
  return rows;
}

/**
 * The rows for a folder, its project keys looked up read-only (no project id created,
 * no store opened read-write): the doctors' entry point.
 */
export async function recallDoctorRows({ cwd = process.cwd(), home = os.homedir(), env = process.env, command } = {}) {
  const { neverValid } = await import("./scope.mjs");
  const { projectIdOf } = await import("./projects.mjs");
  const { projectSlug } = await import("./episodic.mjs");
  const dir = path.resolve(cwd);
  const keys = neverValid(dir, { env, home }) ? [] : [projectSlug(dir), projectIdOf(dir)].filter(Boolean);
  return recallChecks({ cwd: dir, home, env, keys, ...(command ? { command } : {}) });
}
