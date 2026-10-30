// `ad tui` (plan Part 6): the terminal UI on the real engine.
//
//   preflight (TTY, Node) → terminal → engine (login panel if needed) →
//   folder trust → session → header + "since last time" → app → exit hint.
//
// Everything outside the session the app may need (file search, git, memory,
// handing the terminal to another program) is built here as `actions`.

import { spawn, execFile } from "node:child_process";
import { editorCommand, editorInvocation, resolveGit, resolvedArgv } from "../safe-spawn.mjs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliErrorLines, openUrl } from "../harness/io.mjs";
import { closeHarnessEngines, findThreadHome, launchHarness, newestThreadAcrossHomes, removedAccountText, resumeHint, windowTarget } from "../harness/engines.mjs";
import { readRecord, recordSettings } from "../harness/settings-sync.mjs";
import { createTuiAccounts } from "./accounts.mjs";
import { fallbackHost } from "./fallback-editor.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { createSession } from "../harness/session.mjs";
import { engineHome, engineVersion, engineErrorText, engineErrorDetail } from "../engine/index.mjs";
import { createIo } from "./terminal/io.mjs";
import { createRenderer } from "./terminal/renderer.mjs";
import { createFullscreenRenderer } from "./terminal/fullscreen.mjs";
import { appleTerminalOverSsh, explicitIn, mouseDefault, probeTmuxMouse, resolveScreenMode, screenStatus } from "./screen-mode.mjs";
import { colorDepth } from "./terminal/text.mjs";
import { setWidthProfile } from "./terminal/width.mjs";
import { probeWidthProfile, reflowModel, terminalName } from "./terminal/detect.mjs";
import { sanitize } from "./terminal/sanitize.mjs";
import { createApp } from "./app.mjs";
import { createHistory } from "./history.mjs";
import { createAdLayer } from "./ad-layer.mjs";
import { createEngineSettings, createPrefs, DEFAULT_PREFS_FILE } from "./prefs.mjs";
import { createKeymap } from "./keymap.mjs";
import { createPicker, newlineHint, renderHeader } from "./view/chrome.mjs";
import { truncate } from "./terminal/text.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const DEFAULT_STATE_FILE = path.join(homedir(), ".agent-daemon", "tui", "state.json");

export { preflight } from "./preflight.mjs";
import { preflight } from "./preflight.mjs";
import { T } from "./view/theme.mjs";
import { harnessIdentity, skillRoots } from "../harness/setup.mjs";
import { setSyntaxTheme } from "./view/highlight.mjs";
import { homeFolderAllowed, recentProjects } from "../harness/home-folder.mjs";
import { launcherItems, LAUNCHER_TITLE } from "./home-launcher.mjs";
import { projectDataDir } from "../memory/project-dir.mjs";
import { homeFolderRefusal, homeLauncherWhy, homeTrustSkippedNote } from "../engine/attribution.mjs";
import { gatewayReason } from "../harness/gateway-runtime.mjs";

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

/**
 * Gives the terminal to `fn` (a child program) and takes it back.
 *
 * Fullscreen (P2.4) has two kinds. "keep" (the external editor) shows ad's
 * last frame on the alternate screen while the child runs, with no keyboard
 * push or mouse, so a GUI editor leaves ad visible. "restore" (/login, /ad)
 * runs the child on the main screen, so its output stays in the user's
 * scrollback; when waitAfter(result) says so, "Press Enter to return to ad."
 * keeps that output readable before ad repaints. Inline, both are as before.
 */
export async function handoff(io, renderer, fn, app = null, { kind = "restore", waitAfter = () => false, wait = waitForEnter } = {}) {
  app?.holdTitle?.(true); // the child sets its own title; ours comes back after
  renderer.suspend();
  try {
    return await io.handoff(async () => {
      const keep = kind === "keep" && typeof renderer.freeze === "function";
      if (keep) renderer.freeze();
      let result;
      try {
        result = await fn();
      } finally {
        // Before io's modes come back: they belong on the main screen's keyboard stack.
        if (keep) renderer.unfreeze();
      }
      if (renderer.fullscreen && !keep && waitAfter(result)) await wait();
      return result;
    });
  } finally {
    await renderer.resume();
    app?.holdTitle?.(false);
  }
}

/**
 * Ctrl+Z: the renderer leaves its screen, io restores the terminal and stops
 * the process (SIGSTOP); on SIGCONT io re-enters and the renderer repaints.
 * → false where stopping isn't possible (Windows), with nothing changed.
 */
export function suspendTui(io, renderer, app = null) {
  renderer.suspend();
  const back = () => Promise.resolve(renderer.resume()).then(() => app?.draw?.());
  const off = io.onResume((r) => {
    if (r.reason !== "sigcont") return;
    off();
    back();
  });
  if (io.suspend()) return true;
  off();
  back();
  return false;
}

/** Waits for Enter on the main screen (cooked mode: the handoff turned raw mode off). */
function waitForEnter({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve) => {
    stdout.write("\r\nPress Enter to return to ad. ");
    const onData = (d) => {
      if (!/[\r\n]/.test(String(d))) return;
      stdin.off("data", onData);
      stdin.pause?.();
      resolve();
    };
    stdin.on("data", onData);
    stdin.resume?.();
  });
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
/* External editor (Ctrl+G)                                            */
/* ------------------------------------------------------------------ */

// The editor command ($VISUAL, $EDITOR, notepad / vi) lives in safe-spawn.mjs,
// shared with `ad review`.
export { editorCommand };

// How the editor starts: by full path, through cmd.exe only for a .cmd/.bat
// editor (safe-spawn.mjs editorInvocation).

/**
 * Edits `text` in the user's editor (the terminal is handed over) and returns
 * the result, or null when the editor failed. The temp file is private and removed.
 */
export async function editInEditor(text, { run, env = process.env, platform = process.platform, now = () => Date.now(), resolve, cmdExe } = {}) {
  const { mkdtempSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "ad-prompt-"));
  const file = path.join(dir, "prompt.md");
  try {
    writeFileSync(file, text, { mode: 0o600 });
    const { cmd, args } = editorCommand(env, platform);
    const spawnAs = editorInvocation(cmd, [...args, file], { platform, env, resolve, cmdExe });
    const t0 = now();
    const code = await run(spawnAs.cmd, spawnAs.args, spawnAs.verbatim);
    if (code !== 0) return null;
    const out = read(file, "utf8");
    // Back at once with nothing changed: the editor didn't wait (it opened the
    // file in an existing window). Keep the prompt rather than lose the edit.
    if (out === text && now() - t0 < 1500) throw new Error("The editor returned at once without waiting. Set EDITOR to one that waits (e.g. \"code --wait\"); your prompt is unchanged.");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

// git by its full path from PATH, so a git.exe in the project never runs.
function git(cwd, args, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let argv;
    try {
      argv = resolvedArgv(resolveGit(), args);
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: e.message });
      return;
    }
    execFile(argv[0], argv[1], { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout, shell: false }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
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
      if (!(at > since) || (j.cwd && engineHome.canonical(j.cwd) !== engineHome.canonical(cwd))) continue;
      parts.push(`schedule ${j.id} ${j.lastExit === 0 || j.lastStatus === "ok" ? "ran" : "failed"}`);
    }
  } catch {
    // no schedules
  }
  try {
    const dir = path.join(projectDataDir(cwd), "proposed");
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
  if (engineHome.canonical(run.sourcePath) !== engineHome.canonical(hooksFile)) return [];
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

/* ------------------------------------------------------------------ */
/* The command                                                         */
/* ------------------------------------------------------------------ */

export async function cmdTui(opts = {}) {
  const err = opts.stderr ?? process.stderr;
  const out = opts.stdout ?? process.stdout;
  // The folder ad works in; /cd changes it (every helper below reads it when used).
  let cwd = path.resolve(opts.cwd ?? process.cwd());
  // A relative --home means relative to where ad started, also after /cd.
  if (opts.home) opts = { ...opts, home: path.resolve(cwd, opts.home) };
  const why = preflight();
  if (why) {
    err.write(`${why}\n`);
    return 2;
  }
  const setupNotes = [];
  const setupDetails = [];
  const keepStartupError = (e) => {
    const detail = engineErrorDetail(e);
    if (detail) setupDetails.push(String(detail));
    return engineErrorText(e);
  };
  const sink = { write: (s) => {
    for (const line of String(s).split("\n")) {
      if (line.startsWith("  details: ")) setupDetails.push(line.slice("  details: ".length));
      else if (line.trim()) setupNotes.push(line.trim());
    }
    return true;
  } };
  let io;
  let renderer;
  let adPrefs;
  let engine;
  let launched = null; // launchHarness's answer for this window's engine
  let session;
  let ledger = null; // the session ledger's coordinator (P4.1)
  let switchRunnerRef = null; // its switch runner (P4.2), closed with the window
  let fallbackRef = null; // its automatic fallback (P4.5), stopped with the window
  let app;
  let exitHint = null;
  try {
    io = createIo();
    const caps = await io.enter();
    setWidthProfile(await probeWidthProfile({ io }));
    // The prompt sits on the screen's last rows unless prefs.json says "prompt.atBottom": false.
    adPrefs = createPrefs({ file: opts.prefsFile ?? DEFAULT_PREFS_FILE });
    const inlineRenderer = () => createRenderer({ io, caps, depth: colorDepth({ isTTY: true }), reflow: reflowModel(), pinBottom: adPrefs.get("prompt.atBottom", true) !== false, resizeSource: process.stdout, hyperlinks: terminalName() !== "unknown" });
    // stderr while fullscreen (it would land on the frame): held, written out on exit, and said once here.
    let stderrSaid = false;
    const fullscreenRenderer = (mouse) =>
      createFullscreenRenderer({ io, caps, depth: colorDepth({ isTTY: true }), resizeSource: process.stdout, hyperlinks: terminalName() !== "unknown", mouse, stderrSink: () => {
        if (stderrSaid || !app) return;
        stderrSaid = true;
        app.notice("warn", "ad wrote an error message; it is printed when ad exits.");
      } });
    const mousePref = adPrefs.get("screen.mouse", null);
    // Path A (P2.1): last time was fullscreen, so start there; nothing touches the shell's screen.
    // Inside tmux, whether its mouse is on (P2.5): asked now, read when the mode is resolved.
    const tmuxMouse = probeTmuxMouse({ execFile });
    if (adPrefs.get("screen.lastMode", null) === "fullscreen" && !opts.noAltScreen) {
      renderer = fullscreenRenderer(typeof mousePref === "boolean" ? mousePref : mouseDefault());
      renderer.start();
    } else {
      renderer = inlineRenderer();
      await renderer.start();
    }
    renderer.frame({ lines: [[{ text: "Starting the engine\u{2026}", style: T.dim }]] });

    // A folder that would load the user's own engine home (P0.2a): pick a project
    // folder first, unless an override allows it (flag, AD_ALLOW_HOME_FOLDER, pref).
    let allowHomeFolder = homeFolderAllowed({ flag: opts.allowHomeFolder === true, prefsFile: opts.prefsFile }).allowed;
    // → false when the user left (Esc); else cwd or allowHomeFolder is updated.
    const pickHomeFolder = async (risk) => {
      const recent = recentProjects(readState(opts.stateFile ?? DEFAULT_STATE_FILE), { exclude: [cwd] });
      const choice = await pickOnce({ io, renderer, title: LAUNCHER_TITLE, intro: [[{ text: homeLauncherWhy(risk), style: T.dim }]], items: launcherItems({ recent, risk }) });
      if (!choice) {
        renderer.frame({ lines: [] });
        exitHint = homeFolderRefusal(risk);
        return false;
      }
      if (choice.cwd) cwd = path.resolve(choice.cwd);
      else {
        allowHomeFolder = true;
        if (choice.always) adPrefs.set("allowHomeFolder", true);
      }
      return true;
    };
    // Before the engine starts: skills (and settings with no trust) need no engine.
    const homeRisk = engineHome.homeLayerRisk(cwd);
    if (homeRisk && !allowHomeFolder && !(await pickHomeFolder(homeRisk))) return 2;
    // The account first (P3.4): the engine that serves it starts; this window holds it.
    const start = async () => {
      const r = await launchHarness({ cwd, account: opts.account, model: opts.model, effort: opts.effort, home: opts.home, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, err: sink, detached: true, experimental: true, interactive: true, allowHomeFolder, idleMs: 5 * 60_000 });
      if (r.engine) launched = r;
      return r;
    };
    let started = await start();
    while (!started.engine && started.code === 2 && /Not logged in/.test(started.error ?? "")) {
      const choice = await pickOnce({
        io,
        renderer,
        title: "Sign in",
        intro: [[{ text: "ad isn't signed in yet.", style: T.bold }]],
        items: [
          { label: "OpenAI API key", hint: "kept in ad's own folder", value: ["auth", "login", "openai"] },
          { label: "OpenRouter", hint: "API key + model", value: ["auth", "login", "openrouter"] },
          { label: "ChatGPT", hint: "sign in with your ChatGPT plan (browser)", value: ["auth", "login", "chatgpt"] },
        ],
      });
      if (!choice) break;
      // A failed sign-in keeps its output on screen until Enter (fullscreen; P2.4).
      await handoff(io, renderer, () => runChild(process.execPath, [CLI, ...choice], { cwd }), null, { waitAfter: (code) => code !== 0 });
      started = await start();
    }
    if (!started.engine) {
      renderer.frame({ lines: [] });
      exitHint = started.error;
      return started.code ?? 2;
    }
    engine = started.engine;
    // Again with ad's real settings: a trusted folder under a git home applies the home's settings.
    // Another folder picked here: the engine starts again there (its default
    // folder and setup follow the work folder), and that folder is checked too.
    while (!allowHomeFolder) {
      const late = await engine.homeFolderRisk(cwd);
      if (!late) break;
      const before = cwd;
      if (!(await pickHomeFolder(late))) return 2;
      if (allowHomeFolder) {
        engine.allowHomeFolder = true;
        break;
      }
      if (cwd === before) continue;
      // Another folder: its engine starts there (the old one is stopped, not kept).
      if (launched?.lease) await closeHarnessEngines();
      else await engine.close();
      engine = null;
      launched = null;
      started = await start();
      if (!started.engine) {
        renderer.frame({ lines: [] });
        exitHint = started.error;
        return started.code ?? 2;
      }
      engine = started.engine;
    }

    // Folder trust (S3): asked once per folder, kept in ad's engine home. Never
    // offered where trusting would also apply the user's own engine settings (P0.2a).
    const config = await engine.readConfig().catch(() => ({}));
    const projects = config.projects ?? {};
    const known = Object.keys(projects).find((k) => engineHome.canonical(k) === engineHome.canonical(cwd));
    const trustLoadsHome = engineHome.homeLayerRisk(cwd, { trusted: [cwd] })?.loads.includes("settings") && !allowHomeFolder;
    if (trustLoadsHome && !known) setupNotes.push(homeTrustSkippedNote);
    if (!known && !trustLoadsHome && engineHome.canonical(cwd) !== engineHome.canonical(homedir())) {
      const trust = await pickOnce({
        io,
        renderer,
        title: "Trust",
        intro: [[{ text: `Do you trust ${sanitize(cwd, "transcript")}?`, style: T.bold }], [{ text: "Trusted folders can run their own hooks, skills and settings. Trust only projects you know.", style: T.dim }]],
        items: [
          { label: "Yes, trust this folder", value: "trusted" },
          { label: "No", hint: "ignore its hooks and settings", value: "untrusted" },
        ],
      });
      if (trust) {
        await engine
          .writeConfig([["projects", { [cwd]: { trust_level: trust } }, "upsert"]])
          // The settings record learns it too: every home gets the answer (P3.4).
          // Not for a home a command chose: its answers stay in it.
          .then(() => (opts.home ? null : recordSettings([[`projects.${JSON.stringify(cwd)}.trust_level`, trust]], { engine, written: true })))
          .catch((e) => setupNotes.push(`trust not saved: ${keepStartupError(e)}`));
      }
    }

    // The same home's engine again (the manager's restart; a chosen home starts anew).
    const restart = () => launched.restart();
    // Checkpoints for /undo, in a git repo only (plan Part 10).
    const { createCheckpoints } = await import("../harness/checkpoints.mjs");
    const { checkpointWiring } = await import("./undo.mjs");
    let cp = createCheckpoints({ cwd });
    let undoKit = (await cp.repo().catch(() => null)) ? checkpointWiring(cp, { cwd }) : null;
    // Settings: the engine's own (its config.toml in ad's home) and ad's (prefs.json).
    // [tui] comes from the settings record when this window runs on another home (P3.4).
    const onDefaultHome = () => engineHome.canonical(session.engine.home) === engineHome.canonical(engineHome.defaultPath());
    const settings = {
      engine: createEngineSettings({
        engine: () => session.engine,
        record: () => (opts.home || onDefaultHome() ? null : readRecord().tui),
        write: opts.home ? null : (edits) => recordSettings(edits, { engine: session.engine }),
      }),
      ad: adPrefs,
    };
    // modes: the plan mode, on the experimental allowlist this engine opted into (parity P0).
    // Default's mask keeps the configured effort, as the engine's own Default mode does.
    // The session ledger (P4.1): which account and model ran each turn, what each tool did.
    const { createCoordinator, ledgerEnabled, ledgerHome, ledgerTarget } = await import("../sessions/coordinator.mjs");
    const { fromChatgpt, recordObservations } = await import("../providers/quota.mjs");
    const { classifyTurnFailure, lastUpstreamFailureForThread } = await import("../harness/gateway-runtime.mjs");
    const isChatgpt = (a) => a?.method === "engine-login" || a?.credential?.kind === "engine-home";
    let ledgerAccount = () => launched?.target?.account ?? null;
    ledger = createCoordinator({
      cwd,
      origin: "tui",
      root: opts.adRoot,
      enabled: ledgerEnabled(opts),
      homeKey: () => ledgerHome(session?.state.config.homeKey),
      targetOf: () => {
        const c = session.state.config;
        return ledgerTarget({ account: ledgerAccount(), provider: c.provider, model: c.model, effort: c.effort });
      },
      // A failed turn's class (P4.3): the gateway's observation of this account's route during
      // the turn wins (API accounts); a ChatGPT account's limits come from its own reads.
      classify: ({ error, status, threadId, startedAt }) => classifyTurnFailure({ error, status, threadId, startedAt, account: ledgerAccount(), rateLimits: session?.state.rateLimits ?? null, rateLimitsAt: session?.state.rateLimitsAt ?? null }),
    });
    // A switch (P4.2) sees the same events first; the app shows its notices and choices.
    let switchRunner = null;
    const switchUi = { notify: () => {}, ask: () => {} };
    // Automatic fallback (P4.5): acts at turn boundaries, after the switch runner saw the event.
    let fallbackController = null;
    let fallbackWindowOn = () => true; // the app's /fallback off, once the app exists
    // The session's hooks: /undo's, plus fallback's turn-end hook, which must run before the
    // session drains its queue (a queued prompt never starts on the target that just failed).
    const sessionHooks = () => ({
      ...(undoKit?.hooks ?? {}),
      turnCompleted: (x) => {
        undoKit?.hooks?.turnCompleted?.(x);
        fallbackController?.turnCompleted(x);
      },
    });
    const observer = (ev) => {
      switchRunner?.onEvent(ev);
      fallbackController?.onEvent(ev);
      // A ChatGPT account's limits, as the engine reports them, to the QuotaStore (P4.3).
      if (ev.type === "rateLimits" && ledger) {
        const a = ledgerAccount();
        if (isChatgpt(a)) void recordObservations(fromChatgpt(ev.limits, { accountId: a.id, source: ev.source })).catch(() => {});
      }
      return ledger.observer(ev);
    };
    session = createSession({ observer, engine, cwd, model: started.params.model, modelProvider: started.params.modelProvider, homeKey: launched?.homeKey ?? null, provider: launched?.target?.account?.provider ?? null, release: launched?.release ?? null, sandbox: opts.sandbox, restart, maxRestarts: 3, hooks: sessionHooks(), modes: true, planEffort: () => settings.engine.get("plan_mode_reasoning_effort") ?? null, configEffort: () => settings.engine.get("model_reasoning_effort") ?? null, ...(opts.lockDir ? { lockDir: opts.lockDir } : {}), identity: engineHome.isManaged(engine.home) ? null : await harnessIdentity(engine).catch(() => null) }); // no identity: the session starts without it
    await session.init();
    if (launched?.params?.effort) session.setNextTurn({ effort: launched.params.effort });
    await settings.engine.load();
    // The screen mode follows the engine's settings; only a value the user set counts (explicitIn).
    const layers = await engine.config.read({ includeLayers: true }).then((r) => r?.layers ?? null, () => null);
    const screen = resolveScreenMode({
      noAltScreen: opts.noAltScreen === true,
      appleTerminalOverSsh: appleTerminalOverSsh(caps),
      tmuxMouse: await tmuxMouse,
      altScreen: settings.engine.get("tui.alternate_screen") ?? "auto",
      fullscreenTranscript: settings.engine.get("tui.fullscreen_transcript"),
      fullscreenExplicit: explicitIn(layers, "tui.fullscreen_transcript"),
      mousePref: typeof mousePref === "boolean" ? mousePref : null,
      mouseDefault: mouseDefault(),
    });
    adPrefs.set("screen.lastMode", screen.mode);

    const term = terminalName();
    const newline = newlineHint({ terminal: term, csiU: Boolean(caps.kitty) });
    const st = session.state;
    // The account by its name, with where the choice came from when it isn't the user's own (P3.8b).
    const source = { project: " (project)", env: " (from AD_ACCOUNT)" }[launched?.target?.source] ?? "";
    const acct = launched?.target?.account ? `${accountName(launched.target.account)}${source}` : st.account?.type === "chatgpt" ? `ChatGPT ${st.account.planType ?? ""}`.trim() : st.account?.type ?? "provider key";
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
    const engineVersionText = engineVersion.pinned() ?? "?";
    // No model configured: name the one the engine will use (its default), not "default".
    let modelName = launched?.params?.model ?? config.model ?? opts.model ?? null;
    if (!modelName) {
      const listed = await Promise.race([engine.models.list().catch(() => null), new Promise((r) => setTimeout(() => r(null), 2000).unref?.())]);
      const def = listed?.find((m) => m.isDefault);
      modelName = def?.model ?? def?.id ?? "default";
    }
    const header = renderHeader(
      {
        title: `>_ Agent Daemon (v${opts.clientVersion ?? "?"})`,
        rows: [
          { label: "model", value: `${modelName}${config.model_reasoning_effort ? ` ${config.model_reasoning_effort}` : ""} \u{b7} ${acct}`, hint: "/model to change" },
          { label: "directory", value: `${cwd}${branch ? ` \u{b7} git: ${branch}` : ""}`, path: true },
          { label: "memory", value: memoryLine, hint: "/memory" },
          { label: "sandbox", value: `${st.config.sandbox} \u{b7} ${st.config.approvalPolicy === "never" ? "never asks" : "asks first"}` },
        ],
      },
      { width: Math.max(10, io.size().cols - 2) },
    );
    const stateFile = opts.stateFile ?? DEFAULT_STATE_FILE;
    const state = readState(stateFile);
    const key = engineHome.canonical(cwd);
    const since = await sinceLastTime({ cwd, since: state[key]?.lastSeen ?? Date.now(), home: opts.adHome });
    const intro = [...header];
    if (since.length) intro.push(truncate([{ text: `  Since last time: ${since.join(" \u{b7} ")}`, style: T.dim }], Math.max(10, io.size().cols - 2)));
    intro.push([], [{ text: "  Try /review \u{b7} /goal \u{b7} /resume \u{b7} /memory \u{b7} ? for shortcuts", style: T.dim }], []);
    for (const n of setupNotes.filter(Boolean)) intro.push([{ text: `  ${sanitize(n, "transcript")}`, style: T.warning }]);

    if (opts.resume || opts.last) {
      const couldNot = (text) => intro.push([{ text: `  Could not resume: ${sanitize(text, "transcript")}`, style: T.warning }]);
      let id = opts.resume;
      let home = launched?.homeKey ?? null;
      // --last: the newest conversation for this folder in any home (P3.4).
      if (!id) ({ threadId: id = null, homeKey: home = home } = (await newestThreadAcrossHomes({ currentKey: launched?.homeKey ?? null, engine, cwd, profile: launched?.profile }).catch(() => null)) ?? {});
      // In another home: this window moves to that home's engine, then continues there.
      const moveTo = async (found) => {
        const removedThere = removedAccountText(found.thread?.modelProvider);
        if (removedThere) {
          await found.release();
          return couldNot(removedThere);
        }
        return session.useEngine({ engine: found.engine, release: found.release, restart: found.restart }, { homeKey: found.homeKey, ...windowTarget(found.thread?.modelProvider) }, { threadId: id });
      };
      if (id) {
        const here = await session.engine.threads.read(id).catch(() => null);
        const removed = removedAccountText(here?.modelProvider);
        if (removed) couldNot(removed);
        else if (home !== (launched?.homeKey ?? null)) {
          const found = await findThreadHome(id, { currentKey: launched?.homeKey ?? null, cwd, profile: launched?.profile }).catch(() => null);
          if (found) await moveTo(found).catch((e) => couldNot(keepStartupError(e)));
          else couldNot("that conversation wasn't found");
        } else {
          await session.resume(id).catch(async (e) => {
            // Not in this home: look in the others (--resume <tid> without --account).
            const found = launched?.lease ? await findThreadHome(id, { currentKey: launched.homeKey, cwd, profile: launched.profile }).catch(() => null) : null;
            if (found) await moveTo(found).catch((e2) => couldNot(keepStartupError(e2)));
            else couldNot(keepStartupError(e));
          });
        }
      }
    }

    for (const detail of setupDetails.slice(-50)) session.state.notices.push({ level: "info", code: "startup.details", message: "Engine startup details. Details: /warnings", detail, at: Date.now() });
    if (session.state.notices.length > 50) session.state.notices.splice(0, session.state.notices.length - 50);

    const adMemory = opts.memory === false ? null : await import("../memory/episodic.mjs").catch(() => null);
    let ad = createAdLayer({ cwd, home: opts.adHome ?? homedir(), memory: adMemory, cli: CLI });
    const overdue = await ad.schedulerWarning().catch(() => null);
    if (overdue) intro.push(truncate([{ text: `  ${overdue}`, style: T.warning }], Math.max(10, io.size().cols - 2)));
    let focused = true;
    io.onInput((ev) => {
      if (ev.type === "focus") focused = ev.focused;
    });
    const hooksFile = path.join(engine.home, "hooks.json");
    // Accounts in the UI (P3.8b): only for ad's own homes (a home a command chose has none).
    const accounts = launched?.lease
      ? createTuiAccounts({
          session,
          store: opts.store ?? createSecretStore(),
          clientVersion: opts.clientVersion,
          openBrowser: openUrl,
          // Another account's engine, started the same way as this window's.
          launch: (a) => launchHarness({ cwd, account: a.id, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, err: sink, detached: true, experimental: true, interactive: true, allowHomeFolder, idleMs: 5 * 60_000 }),
        })
      : null;
    if (accounts) ledgerAccount = () => accounts.current() ?? launched?.target?.account ?? null;
    // Switching a conversation to another account or provider (P4.2): only with ad's accounts.
    if (accounts) {
      const { createSwitchRunner } = await import("../sessions/switch-runner.mjs");
      const shortstat = async () => (await git(cwd, ["diff", "--shortstat", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
      const num = (s, re) => Number(re.exec(s)?.[1] ?? 0);
      switchRunner = createSwitchRunner({
        session,
        ledger,
        current: () => accounts.currentTarget(),
        prepare: (t) => accounts.prepare(t),
        git: async () => {
          const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
          if (!branch) return null;
          const s = await shortstat();
          return { branch, files: num(s, /(\d+) files? changed/), added: num(s, /(\d+) insertion/), deleted: num(s, /(\d+) deletion/) };
        },
        // /undo's snapshot (uncommitted edits included) when the folder has checkpoints, else HEAD.
        checkpoint: async () => {
          const snap = undoKit ? await cp.snapshot().catch(() => null) : null;
          const ref = snap?.tree ?? (await git(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
          return ref ? { ref, diffStat: (await shortstat()) || null } : null;
        },
        notify: (...a) => switchUi.notify(...a),
        ask: (...a) => switchUi.ask(...a),
      });
      // Automatic fallback (P4.5): the user's order, at turn boundaries, through the switch runner.
      const { createFallbackController } = await import("../sessions/fallback-controller.mjs");
      const { readPolicy } = await import("../routing/store.mjs");
      const { routingContext } = await import("../routing/context.mjs");
      const { readLedger } = await import("../sessions/ledger.mjs");
      const { benchProvider, benchKey } = await import("../providers/quota.mjs");
      const { classifyUpstream } = await import("../providers/errors.mjs");
      fallbackRef = fallbackController = createFallbackController({
        session,
        ledger,
        runner: switchRunner,
        policy: () => readPolicy({ lenient: true }),
        routing: () => routingContext(),
        current: () => {
          const t = accounts.currentTarget();
          return t?.account ? { account: t.account, model: t.model ?? null, effort: t.effort ?? null, label: t.label } : null;
        },
        toSwitchTarget: async (rt) => {
          const a = routingContext().accounts.find((x) => x.id === rt.account);
          return a ? accounts.targetFor(a, rt.model ?? null, rt.effort ?? null) : null;
        },
        classify: ({ error, status, threadId, startedAt, fallbackInterrupt }) => classifyTurnFailure({ error, status, threadId, startedAt, fallbackInterrupt, account: ledgerAccount(), rateLimits: session?.state.rateLimits ?? null, rateLimitsAt: session?.state.rateLimitsAt ?? null }),
        // A retry notice's cause: the gateway's last failed answer for this conversation, if it came in this turn.
        retryObservation: (threadId, sinceMs) => {
          const o = lastUpstreamFailureForThread(threadId);
          return o && Number.isFinite(sinceMs) && Date.parse(o.at) >= sinceMs ? classifyUpstream(o) : null;
        },
        bench: ({ provider, accountId, until, reason }) => benchProvider(benchKey(provider, accountId), { until, reason, accountId }),
        events: () => (ledger?.sessionId?.() ? readLedger(ledger.sessionId(), opts.adRoot ? { root: opts.adRoot } : {}) : []),
        notify: (level, text, o) => {
          switchUi.notify(level, text, o);
          if (o?.line) actions?.bell?.({ unfocusedOnly: true });
        },
        windowOn: () => fallbackWindowOn(),
      });
    }
    const { quotaView } = await import("../providers/quota-view.mjs");
    const { markNoticed, noticesShown, readStore } = await import("../providers/quota.mjs");
    const { refreshOpenRouterKey } = await import("../providers/upstream.mjs");
    let quotaAt = -Infinity;
    let quotaDoc = null;
    let keyReadAt = -Infinity;
    const quotaStore = () => {
      if (Date.now() - quotaAt > 2000) {
        quotaAt = Date.now();
        quotaDoc = readStore();
      }
      return quotaDoc;
    };
    let factsAt = -Infinity;
    let facts = { on: false, next: null };
    const fallbackFacts = () => {
      if (fallbackController && Date.now() - factsAt > 5000) {
        factsAt = Date.now();
        try {
          facts = { on: fallbackController.gateOn(), next: fallbackController.nextLabel() };
        } catch {
          facts = { on: false, next: null };
        }
      }
      return facts;
    };
    const actions = {
      accounts,
      ledger: () => ledger?.status() ?? null,
      // Another model on the same account: the same thread on a new binding (P4.2 nextTurn).
      onModelChange: () => ledger?.rebind("nextTurn"),
      switching: (switchRunnerRef = switchRunner) ? { runner: switchRunner, ui: switchUi } : null,
      gatewayReason: (threadId, sinceMs) => gatewayReason({ threadId, sinceMs }),
      bell: (o = {}) => {
        if (!o.unfocusedOnly || !focused) io.write("\x07");
      },
      searchFiles: async (q) => {
        return (await session.engine.files.search(q, [cwd], { token: "ad-mention" })).map((f) => f.path);
      },
      gitDiff: () => gitDiff(cwd),
      // The user's own words: stored active in this project (never global).
      remember: opts.memory === false ? undefined : async (text) => {
        const { insertLearning, projectSlug } = await import("../memory/episodic.mjs");
        const { redactSecrets } = await import("../security/secret-patterns.mjs");
        const r = redactSecrets(text);
        await insertLearning({ category: "pattern", text: r.text, projectSlug: projectSlug(cwd), confidence: 0.9, evidence: "ad tui /remember", tags: ["remember"], origin: "user" });
        return r;
      },
      ad,
      // /fallback (P4.4): ~/.agent-daemon/fallback.json, ad's own accounts and catalogs.
      fallback: fallbackHost(),
      // Automatic fallback (P4.5): /retry, the pause, and whether a failed turn was ad's to explain.
      fallbackRun: {
        paused: () => Boolean(fallbackController?.state().paused),
        retry: () => fallbackController?.retry() ?? false,
        resume: () => fallbackController?.resume(),
        handled: (turnId) => fallbackController?.handled(turnId) ?? false,
        beforePrompt: () => fallbackController?.beforePrompt() ?? null,
        status: () => (fallbackController ? fallbackController.state() : null),
        // For the status line and the limit notices (P4.6): read the policy at most every 5 s.
        on: () => fallbackFacts().on,
        nextLabel: () => fallbackFacts().next,
      },
      // Limits as last seen (P4.6): the current account's view over the QuotaStore (re-read at
      // most every 2 s), the notices already shown, and OpenRouter's /key read for /usage.
      quota: accounts
        ? {
            view: () => {
              const a = accounts.current();
              return a ? quotaView(a.id, { store: quotaStore(), provider: a.provider }) : null;
            },
            name: () => {
              const a = accounts.current();
              return a ? accountName(a) : null;
            },
            seen: () => noticesShown(),
            mark: (keys) => markNoticed(keys).catch(() => {}),
            refresh: async () => {
              const a = accounts.current();
              if (!a || Date.now() - keyReadAt < 30_000) return false;
              keyReadAt = Date.now();
              const done = await refreshOpenRouterKey(a, { store: opts.store ?? createSecretStore(), clientVersion: opts.clientVersion }).catch(() => false);
              if (done) quotaAt = -Infinity;
              return done;
            },
          }
        : null,
      ...(undoKit ? { undo: (o) => undoKit.undo(session, o), onTyping: () => undoKit.onTyping() } : {}),
      // /cd: ad's memory project and /undo's checkpoints follow the new folder.
      setCwd: async (dir) => {
        cwd = dir;
        actions.ad = ad = createAdLayer({ cwd, home: opts.adHome ?? homedir(), memory: adMemory, cli: CLI });
        cp = createCheckpoints({ cwd });
        undoKit = (await cp.repo().catch(() => null)) ? checkpointWiring(cp, { cwd }) : null;
        session.setHooks(sessionHooks());
        if (undoKit) {
          actions.undo = (o) => undoKit.undo(session, o);
          actions.onTyping = () => undoKit.onTyping();
        } else {
          delete actions.undo;
          delete actions.onTyping;
        }
        // The project's own skills (<folder>/.claude/skills) are the new folder's now.
        // Preserve RPC error codes and raw details for /warnings.
        await session.engine.setSkillRoots(skillRoots({ cwd, engineHome: session.engine.home }));
      },
      login: async (arg) => {
        const code = await handoff(io, renderer, () => runChild(process.execPath, [CLI, "auth", "login", ...splitArgs(arg || "chatgpt")], { cwd }), app, { waitAfter: (c) => c !== 0 });
        if (code !== 0) return `Sign-in didn't finish (exit ${code}). Nothing changed.`;
        // Keys reach the engine when it starts, and a new login is read at start too: restart it.
        const ok = await session.restartEngine().catch(() => false);
        return ok ? "Signed in; the engine restarted with it." : "Signed in, but the engine didn't restart: /quit and start ad again to use the new sign-in.";
      },
      runAd: async (arg) => {
        if (!arg) return "Usage: /ad <command>, e.g. /ad doctor";
        const code = await handoff(io, renderer, () => runChild(process.execPath, [CLI, ...splitArgs(arg)], { cwd }), app, { waitAfter: () => true });
        return `ad ${sanitize(arg, "transcript")} exited ${code}.`;
      },
      hookRows: (run) => hookRows(run, { hooksFile }),
      // The status line's and title's git facts (timed out, no console window).
      gitInfo: async () => {
        const opts = { timeout: 5000 };
        const root = (await git(cwd, ["rev-parse", "--show-toplevel"], opts)).stdout.trim() || null;
        if (!root) return { root: null, branch: null, changes: null };
        const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], opts)).stdout.trim() || null;
        let added = 0;
        let removed = 0;
        for (const l of (await git(cwd, ["diff", "--numstat", "HEAD"], opts)).stdout.split(/\r?\n/)) {
          const [a, r] = l.split("\t");
          if (/^\d+$/.test(a)) added += Number(a);
          if (/^\d+$/.test(r)) removed += Number(r);
        }
        return { root, branch, changes: { added, removed } };
      },
      // /delete: the conversation's /undo snapshots go with it.
      forgetCheckpoints: (threadId) => (undoKit ? cp.forget(threadId) : Promise.resolve(0)),
      editText: (text) => handoff(io, renderer, () => editInEditor(text, { run: (cmd, args, verbatim) => runChild(cmd, args, { cwd, windowsVerbatimArguments: Boolean(verbatim) }) }), app, { kind: "keep" }),
      // Ctrl+Z (POSIX; P2.4): leave ad's screen, stop; `fg` brings it back repainted.
      suspend: () => suspendTui(io, renderer, app),
    };

    // Path B (P2.1): swap renderers just before the app, so the inline "Starting the engine…"
    // frame covered the slow part. The inline erase must reach the terminal before ?1049h.
    if (screen.mode === "fullscreen" && !renderer.fullscreen) {
      renderer.frame({ lines: [] });
      renderer.dispose();
      await new Promise((r) => process.stdout.write("", r));
      renderer = fullscreenRenderer(screen.mouse);
      renderer.start();
    } else if (screen.mode === "inline" && renderer.fullscreen) {
      renderer.dispose(); // ?1049l puts the cursor back where the shell left it
      renderer = inlineRenderer();
      await renderer.start();
    }
    app = createApp({ io, renderer, session, cwd, header: intro, newline, history: createHistory(opts.historyFile ? { file: opts.historyFile } : {}), actions, settings, keymap: createKeymap({ overrides: settings.engine.get("tui.keymap") }), statusInfo: { engineVersion: engineVersionText, hostname: hostname(), home: homedir(), screen: screenStatus(screen) }, info: { compat: `${engineVersionText} (tested)`, terminal: term } });
    // /fallback off is the app's: fallback asks it at every turn.
    fallbackWindowOn = () => app.state.fallbackHere !== false;
    // `ad tui "<prompt>"`: the first prompt is sent right away.
    if (opts.prompt) app.send(opts.prompt);
    await app.done;
    state[key] = { lastSeen: Date.now(), path: cwd }; // path: as typed, for the launcher's list
    await writeState(stateFile, state);
    const tid = session.state.thread?.id;
    const total = session.state.tokens?.total?.total;
    exitHint = tid ? `To continue: ${resumeHint(tid, session.state.thread?.modelProvider ?? session.state.config.modelProvider)}${total ? `   (${total.toLocaleString("en-US")} tokens)` : ""}` : null;
    if (ad.loop.state.running) {
      const loopNote = "A loop is still working in the background (log: .agent-daemon/loop-tui.log). To stop it, create .agent-daemon/STOP.";
      exitHint = exitHint ? `${exitHint}\n${loopNote}` : loopNote;
    }
    return 0;
  } catch (e) {
    io?.restore();
    err.write(cliErrorLines("tui", e));
    return 1;
  } finally {
    app?.dispose();
    // Fullscreen: leaving the alternate screen is the erase (and after a crash-path release the renderer is inert).
    if (!renderer?.fullscreen) renderer?.frame({ lines: [] });
    renderer?.dispose();
    const live = session?.engine;
    fallbackRef?.dispose();
    session?.close();
    await switchRunnerRef?.dispose().catch(() => {});
    await ledger?.close().catch(() => {});
    await io?.close();
    if (launched?.lease) await closeHarnessEngines().catch(() => {});
    else {
      if (live && live !== engine) await live.close().catch(() => {});
      await engine?.close();
    }
    if (exitHint) out.write(`${exitHint}\n`);
  }
}
