// `ad tui` (plan Part 6): the terminal UI on the real engine.
//
//   preflight (TTY, Node) → terminal → engine (login panel if needed) →
//   folder trust → session → header + "since last time" → app → exit hint.
//
// Everything outside the session the app may need (file search, git, memory,
// handing the terminal to another program) is built here as `actions`.

import { spawn, execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarnessEngine } from "../harness/start.mjs";
import { createSession } from "../harness/session.mjs";
import { runStockCodex } from "../harness/codex-ui.mjs";
import { pinnedCodexVersion } from "../engine/codex/app-server.mjs";
import { canonicalPath } from "../engine/codex/home.mjs";
import { createIo } from "./terminal/io.mjs";
import { createRenderer } from "./terminal/renderer.mjs";
import { colorDepth } from "./terminal/text.mjs";
import { setWidthProfile } from "./terminal/width.mjs";
import { probeWidthProfile, reflowModel, terminalName } from "./terminal/detect.mjs";
import { sanitize } from "./terminal/sanitize.mjs";
import { createApp } from "./app.mjs";
import { createHistory } from "./history.mjs";
import { createPicker, newlineHint, renderHeader } from "./view/chrome.mjs";
import { truncate } from "./terminal/text.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const DEFAULT_STATE_FILE = path.join(homedir(), ".agent-daemon", "tui", "state.json");

/** Why `ad tui` can't run here, or null. */
export function preflight({ stdin = process.stdin, stdout = process.stdout, platform = process.platform, version = process.versions.node, env = process.env } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) return "ad tui needs an interactive terminal. Use `ad chat` for pipes and scripts.";
  if (env.TERM === "dumb") return "This terminal (TERM=dumb) can't show the UI. Use `ad chat`.";
  const [major, minor] = version.split(".").map(Number);
  if (platform === "win32" && !((major === 22 && minor >= 17) || (major === 24 && minor >= 2) || major >= 25)) {
    return `ad tui needs Node 22.17+ or 24.2+ on Windows (this is ${version}): older versions turn a multi-line paste into one message per line. Upgrade Node within 22.x, or use \`ad chat\`.`;
  }
  if (platform === "win32" && env.TERM_PROGRAM === "mintty") return "mintty (Git Bash's window) can't pass keys to ad. Run `winpty ad tui`, or use Windows Terminal.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Small terminal helpers                                              */
/* ------------------------------------------------------------------ */

/** Shows a picker until the user picks (→ value) or closes it (→ null). */
function pickOnce({ io, renderer, title, items, intro = [] }) {
  return new Promise((resolve) => {
    const picker = createPicker({ items, title });
    const draw = () => renderer.frame({ lines: [...intro, ...picker.render({ width: Math.max(10, io.size().cols - 2), height: Math.min(12, io.size().rows - intro.length - 1) })] });
    const off = io.onInput((ev) => {
      const r = picker.handle(ev);
      if (r?.cancel || r?.select !== undefined) {
        off();
        renderer.frame({ lines: [] });
        resolve(r.cancel ? null : r.select);
      } else draw();
    });
    draw();
  });
}

/** Gives the terminal to `fn` (a child program) and takes it back. */
async function handoff(io, renderer, fn) {
  renderer.suspend();
  try {
    return await io.handoff(fn);
  } finally {
    renderer.resume();
  }
}

function runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Splits "/ad memory search \"a b\"" style arguments. */
export function splitArgs(s) {
  const out = [];
  for (const m of String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}

/** Unified diff text → [{path, kind, diff}] per file. */
export function splitUnifiedDiff(text) {
  const out = [];
  for (const chunk of String(text).split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const pathName = m ? m[2] : "?";
    const kind = /^new file mode/m.test(chunk) ? "add" : /^deleted file mode/m.test(chunk) ? "delete" : "update";
    const at = chunk.indexOf("\n@@");
    out.push({ path: pathName, kind, diff: at >= 0 ? chunk.slice(at + 1) : "", movePath: null });
  }
  return out;
}

/** /diff: tracked changes against HEAD plus untracked files (first 200 lines each). */
export async function gitDiff(cwd) {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { error: "Not a git repo: /diff isn't available here.", changes: [] };
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  const tracked = await git(cwd, head.ok ? ["diff", "--no-color", "--no-ext-diff", "HEAD"] : ["diff", "--no-color", "--no-ext-diff", "--cached"]);
  const changes = splitUnifiedDiff(tracked.stdout);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const f of untracked.stdout.split("\0").filter(Boolean).slice(0, 50)) {
    let content = "";
    try {
      const p = path.join(cwd, f);
      if (statSync(p).size > 1024 * 1024) content = "(large file)";
      else content = readFileSync(p, "utf8").split("\n").slice(0, 200).join("\n");
    } catch {
      content = "(unreadable)";
    }
    changes.push({ path: f, kind: "add", diff: content, movePath: null });
  }
  return { changes };
}

/* ------------------------------------------------------------------ */
/* ad layer                                                            */
/* ------------------------------------------------------------------ */

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(file, state) {
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Not important enough to fail on.
  }
}

/** "Since last time" for this folder: loops, schedules, proposals (file reads only). */
export async function sinceLastTime({ cwd, since = 0, home } = {}) {
  const parts = [];
  try {
    const { recentLoops } = await import("../harness/web.mjs");
    for (const l of recentLoops(cwd, 5)) {
      const ts = Date.parse(l.last?.ts ?? "");
      if (!(ts > since)) continue;
      parts.push(`loop ${l.last?.turnStatus === "completed" ? "ran" : (l.last?.turnStatus ?? "ran")} (${l.iterations} iter)${l.last?.progress ? `: ${l.last.progress}` : ""}`);
    }
  } catch {
    // no loops
  }
  try {
    const { loadJobs } = await import("../harness/schedule.mjs");
    for (const j of loadJobs(home)) {
      const at = Date.parse(j.lastRun ?? j.lastRunAt ?? "");
      if (!(at > since) || (j.cwd && canonicalPath(j.cwd) !== canonicalPath(cwd))) continue;
      parts.push(`schedule ${j.id} ${j.lastExit === 0 || j.lastStatus === "ok" ? "ran" : "failed"}`);
    }
  } catch {
    // no schedules
  }
  try {
    const dir = path.join(cwd, ".agent-daemon", "proposed");
    const n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
    if (n) parts.push(`${n} skill proposal${n === 1 ? "" : "s"} to review (/ad review)`);
  } catch {
    // none
  }
  // Loop logs live in the folder, so a cloned repo could ship one: never trust their text.
  return parts.map((p) => sanitize(p, "transcript").replace(/\s+/g, " ").slice(0, 160));
}

/** ad rows for a hook run of ad's own hooks.json (recalled memory, guard blocks). */
export function hookRows(run, { hooksFile }) {
  if (run?.phase !== "completed" || !run.sourcePath || !hooksFile) return [];
  if (canonicalPath(run.sourcePath) !== canonicalPath(hooksFile)) return [];
  const first = (kind) => run.entries.find((e) => e.kind === kind)?.text ?? "";
  const line = (t) => sanitize(t, "transcript").split("\n").find((l) => l.trim()) ?? "";
  if (run.status === "blocked") return [{ kind: "guard", text: line(first("feedback") || first("stop") || first("error")) || run.event }];
  if (run.status === "failed") return [{ kind: "hook", text: `${run.event} hook failed${first("error") ? `: ${line(first("error"))}` : ""}` }];
  const ctx = run.entries.filter((e) => e.kind === "context").map((e) => e.text).join("\n");
  if (ctx && (run.event === "UserPromptSubmit" || run.event === "SessionStart")) {
    const n = (ctx.match(/^\s*[-*] /gm) ?? []).length;
    return [{ kind: "recalled", text: n ? `${n} learning${n === 1 ? "" : "s"}` : line(ctx).slice(0, 80) }];
  }
  return run.entries.filter((e) => e.kind === "warning").map((e) => ({ kind: "hook", text: line(e.text) }));
}

/** Footer meters: context left and the usage window, amber from 80 % used. */
export function meters(st) {
  const out = [];
  const u = st.tokens;
  if (u?.contextWindow && u.last) {
    const used = Math.min(100, Math.round((u.last.total / u.contextWindow) * 100));
    out.push({ text: `ctx ${100 - used}%`, warn: used >= 80 });
  }
  const p = st.rateLimits?.primary;
  if (p?.usedPercent != null) {
    const label = p.windowDurationMins ? `${Math.round(p.windowDurationMins / 60)}h` : "usage";
    out.push({ text: `${label} ${Math.round(p.usedPercent)}%`, warn: p.usedPercent >= 80 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The command                                                         */
/* ------------------------------------------------------------------ */

export async function cmdTui(opts = {}) {
  const err = opts.stderr ?? process.stderr;
  const out = opts.stdout ?? process.stdout;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const why = preflight();
  if (why) {
    err.write(`${why}\n`);
    return 2;
  }
  const setupNotes = [];
  const sink = { write: (s) => (setupNotes.push(String(s).trim()), true) };
  let io;
  let renderer;
  let engine;
  let session;
  let app;
  let exitHint = null;
  try {
    io = createIo();
    const caps = await io.enter();
    setWidthProfile(await probeWidthProfile({ io }));
    renderer = createRenderer({ io, caps, depth: colorDepth({ isTTY: true }), reflow: reflowModel(), resizeSource: process.stdout, hyperlinks: terminalName() !== "unknown" });
    await renderer.start();
    renderer.frame({ lines: [[{ text: "Starting Codex\u{2026}", style: { dim: true } }]] });

    const start = () => startHarnessEngine({ cwd, home: opts.home, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, err: sink, detached: true });
    let started = await start();
    while (!started.engine && started.code === 2 && /Not logged in/.test(started.error ?? "")) {
      const choice = await pickOnce({
        io,
        renderer,
        title: "Sign in",
        intro: [[{ text: "ad isn't signed in to Codex yet.", style: { bold: true } }]],
        items: [
          { label: "ChatGPT", hint: "sign in with your ChatGPT plan (browser)", value: ["auth", "login", "chatgpt"] },
          { label: "OpenAI API key", hint: "stored in ad's secret store", value: ["auth", "login", "openai"] },
          { label: "OpenRouter", hint: "API key + model", value: ["auth", "login", "openrouter"] },
        ],
      });
      if (!choice) break;
      await handoff(io, renderer, () => runChild(process.execPath, [CLI, ...choice], { cwd }));
      started = await start();
    }
    if (!started.engine) {
      renderer.frame({ lines: [] });
      exitHint = started.error;
      return started.code ?? 2;
    }
    engine = started.engine;

    // Folder trust (S3): asked once per folder, kept in ad's Codex home.
    const config = await engine.readConfig().catch(() => ({}));
    const projects = config.projects ?? {};
    const known = Object.keys(projects).find((k) => canonicalPath(k) === canonicalPath(cwd));
    if (!known && canonicalPath(cwd) !== canonicalPath(homedir())) {
      const trust = await pickOnce({
        io,
        renderer,
        title: "Trust",
        intro: [[{ text: `Do you trust ${sanitize(cwd, "transcript")}?`, style: { bold: true } }], [{ text: "Trusted folders may load their own .codex config, hooks and skills.", style: { dim: true } }]],
        items: [
          { label: "Yes, trust this folder", value: "trusted" },
          { label: "No", hint: "ignore its .codex config", value: "untrusted" },
        ],
      });
      if (trust) await engine.writeConfig([["projects", { [cwd]: { trust_level: trust } }, "upsert"]]).catch((e) => setupNotes.push(`trust not saved: ${e.message}`));
    }

    const restart = async () => {
      const again = await start();
      if (!again.engine) throw new Error(again.error);
      return again.engine;
    };
    session = createSession({ engine, cwd, model: opts.model, sandbox: opts.sandbox, restart, maxRestarts: 3, ...(opts.lockDir ? { lockDir: opts.lockDir } : {}) });
    await session.init();

    const term = terminalName();
    const newline = newlineHint({ terminal: term, csiU: Boolean(caps.kitty) });
    const st = session.state;
    const acct = st.account?.type === "chatgpt" ? `ChatGPT ${st.account.planType ?? ""}`.trim() : st.account?.type ?? "provider key";
    const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    let memoryLine = "not set up";
    try {
      if (opts.memory === false) throw new Error("off");
      const { stats } = await import("../memory/episodic.mjs");
      const s = await stats();
      if (s.driver) memoryLine = `${s.counts.learnings} learnings`;
    } catch {
      // memory is optional
    }
    const codexVersion = pinnedCodexVersion() ?? "?";
    const header = renderHeader(
      {
        title: `>_ Agent Daemon (v${opts.clientVersion ?? "?"}) \u{b7} on Codex ${codexVersion} (tested)`,
        rows: [
          { label: "model", value: `${config.model ?? opts.model ?? "default"}${config.model_reasoning_effort ? ` ${config.model_reasoning_effort}` : ""} \u{b7} ${acct}`, hint: "/model to change" },
          { label: "directory", value: `${cwd}${branch ? ` \u{b7} git: ${branch}` : ""}`, path: true },
          { label: "memory", value: memoryLine, hint: "/memory" },
          { label: "sandbox", value: `${st.config.sandbox} \u{b7} ${st.config.approvalPolicy === "never" ? "never asks" : "asks first"}` },
        ],
      },
      { width: Math.max(10, io.size().cols - 2) },
    );
    const stateFile = opts.stateFile ?? DEFAULT_STATE_FILE;
    const state = readState(stateFile);
    const key = canonicalPath(cwd);
    const since = await sinceLastTime({ cwd, since: state[key]?.lastSeen ?? Date.now(), home: opts.adHome });
    const intro = [...header];
    if (since.length) intro.push(truncate([{ text: `  Since last time: ${since.join(" \u{b7} ")}`, style: { dim: true } }], Math.max(10, io.size().cols - 2)));
    intro.push([], [{ text: "  Try /review \u{b7} /goal \u{b7} /resume \u{b7} /codex = stock Codex UI \u{b7} ? for shortcuts", style: { dim: true } }], []);
    for (const n of setupNotes.filter(Boolean)) intro.push([{ text: `  ${sanitize(n, "transcript")}`, style: { fg: "yellow" } }]);

    if (opts.resume || opts.last) {
      let id = opts.resume;
      if (!id) {
        const r = await engine.server.request("thread/list", { cwd, limit: 1, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"] }).catch(() => null);
        id = r?.data?.[0]?.id ?? null;
      }
      if (id) await session.resume(id).catch((e) => intro.push([{ text: `  Could not resume: ${sanitize(e.message, "transcript")}`, style: { fg: "yellow" } }]));
    }

    let focused = true;
    io.onInput((ev) => {
      if (ev.type === "focus") focused = ev.focused;
    });
    const hooksFile = path.join(engine.home, "hooks.json");
    const actions = {
      bell: (o = {}) => {
        if (!o.unfocusedOnly || !focused) io.write("\x07");
      },
      searchFiles: async (q) => {
        const r = await session.engine.server.request("fuzzyFileSearch", { query: q, roots: [cwd], cancellationToken: "ad-mention" });
        return (r?.files ?? []).map((f) => f.path);
      },
      gitDiff: () => gitDiff(cwd),
      remember: opts.memory === false ? undefined : async (text) => {
        const { insertLearning, projectSlug } = await import("../memory/episodic.mjs");
        await insertLearning({ category: "pattern", text, projectSlug: projectSlug(cwd), confidence: 0.9, evidence: "ad tui /remember", tags: ["remember"] });
      },
      memorySummary: opts.memory === false ? undefined : async () => {
        const { stats } = await import("../memory/episodic.mjs");
        const s = await stats();
        return s.driver ? `ad memory: ${s.counts.learnings} learnings, ${s.counts.sessions} sessions. Codex's own /memories is separate.` : "ad memory isn't set up (ad doctor).";
      },
      login: async (arg) => {
        const code = await handoff(io, renderer, () => runChild(process.execPath, [CLI, "auth", "login", ...splitArgs(arg || "chatgpt")], { cwd }));
        if (code !== 0) return `Sign-in didn't finish (exit ${code}). Nothing changed.`;
        // Keys reach Codex when it starts, and a new login is read at start too: restart it.
        await session.restartEngine();
        return "Signed in; Codex restarted with it.";
      },
      runAd: async (arg) => {
        if (!arg) return "Usage: /ad <command>, e.g. /ad doctor";
        const code = await handoff(io, renderer, () => runChild(process.execPath, [CLI, ...splitArgs(arg)], { cwd }));
        return `ad ${sanitize(arg, "transcript")} exited ${code}.`;
      },
      openCodex: async (arg, { threadId }) => {
        // One writer per thread: ad lets go of it while the stock UI has it.
        if (threadId) session.newThread();
        const code = await handoff(io, renderer, () => runStockCodex({ args: splitArgs(arg), threadId, cwd, home: engine.home, store: opts.store }));
        if (threadId) await session.resume(threadId);
        return `Back from the stock Codex UI (exit ${code}).`;
      },
      hookRows: (run) => hookRows(run, { hooksFile }),
    };

    app = createApp({ io, renderer, session, cwd, header: intro, newline, history: createHistory(opts.historyFile ? { file: opts.historyFile } : {}), actions, meters, info: { compat: `${codexVersion} (tested)` } });
    await app.done;
    state[key] = { lastSeen: Date.now() };
    await writeState(stateFile, state);
    const tid = session.state.thread?.id;
    const total = session.state.tokens?.total?.total;
    exitHint = tid ? `To continue: ad tui --resume ${tid}${total ? `   (${total.toLocaleString("en-US")} tokens)` : ""}` : null;
    return 0;
  } catch (e) {
    io?.restore();
    err.write(`ad tui: ${e.message}\n`);
    return 1;
  } finally {
    app?.dispose();
    renderer?.frame({ lines: [] });
    renderer?.dispose();
    const live = session?.engine;
    session?.close();
    await io?.close();
    if (live && live !== engine) await live.close().catch(() => {});
    await engine?.close();
    if (exitHint) out.write(`${exitHint}\n`);
  }
}
