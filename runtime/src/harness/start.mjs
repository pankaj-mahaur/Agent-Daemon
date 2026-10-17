// Start the harness engine the way every entry point needs it:
// create → check login → wire memory/hooks/skills (setup.mjs) → restart once
// if setup changed something the running app-server caches (Windows sandbox).
// Used by `ad run`, `ad chat` and team workers.

import { createEngine, engineVersion, engineErrorText, engineErrorDetail } from "../engine/index.mjs";
import { envRenameNote, LEGACY, migrateMessages } from "../engine/attribution.mjs";
import { providerEnv } from "../auth/providers.mjs";
import { noteOnce } from "./notes.mjs";
import { ensureHarnessSetup } from "./setup.mjs";
import { needsWindowsSandbox, sandboxReadiness } from "./sandbox.mjs";

export const NOT_LOGGED_IN = "Not logged in. Run: ad auth login openai | ad auth login openrouter --model <slug> | ad auth login chatgpt";

// env: extra variables for the engine and the hooks it runs (e.g. AD_WORKER=1).
// detached: run the engine in its own process group on POSIX (the terminal UI).
export async function startHarnessEngine({ cwd, home, command, clientVersion, store, onApproval, err = process.stderr, setup = true, platform, env, requireSandbox = false, detached = false, engineArgs, experimental = false, interactive = false, notesFile } = {}) {
  const e = { ...process.env, ...(env ?? {}) };
  const notesFileFinal = notesFile ?? (process.env.NODE_TEST_CONTEXT ? null : undefined);
  if (notesFileFinal !== null) {
    const notes = { err, ...(notesFileFinal ? { file: notesFileFinal } : {}) };
    if (e[LEGACY.envHome] && !e.AD_ENGINE_DIR) noteOnce("env.legacyHome", migrateMessages.customPath({ path: e[LEGACY.envHome] }), notes);
    if (e[LEGACY.envBin] && !e.AD_ENGINE_BIN) noteOnce("env.legacyBin", envRenameNote(LEGACY.envBin, "AD_ENGINE_BIN"), notes);
    if (e[LEGACY.envModel] && !e.AD_ENGINE_MODEL) noteOnce("env.legacyModel", envRenameNote(LEGACY.envModel, "AD_ENGINE_MODEL"), notes);
  }
  const v = engineVersion.check({ installed: engineVersion.installed().version });
  if (v.code === "untested") err.write(`[agent-daemon] the engine is version ${v.installed}; ad was tested with ${v.tested.join(", ")}. Run: cd runtime && npm install\n`);
  const engineOpts = { cwd, home, command, clientVersion, detached, engineArgs, experimental, interactive, env: { ...providerEnv(store), ...(env ?? {}) }, onApproval };
  let engine = await createEngine(engineOpts);
  try {
    reportHomeEvents(engine.homeEvents, err, notesFileFinal);
    const acct = await engine.account();
    if (acct.requiresOpenaiAuth && !acct.account) {
      await engine.close();
      return { engine: null, error: NOT_LOGGED_IN, code: 2 };
    }
    if (setup) {
      let report = await safeSetup(engine, { cwd, platform }, err);
      if (report?.restartEngine) {
        await engine.close();
        engine = await createEngine(engineOpts);
        report = await safeSetup(engine, { cwd, platform }, err);
      }
    }
    // Unattended runs (loops, workers) rely on the sandbox instead of a
    // human; on Windows, refuse to start them without a ready one.
    if (requireSandbox && needsWindowsSandbox(platform ?? process.platform)) {
      const status = await sandboxReadiness(engine).catch((e) => {
        const detail = engineErrorDetail(e);
        if (detail) for (const line of String(detail).split("\n").slice(0, 8)) err.write(`  details: ${line}\n`);
        return `unknown (${engineErrorText(e, { details: null })})`;
      });
      if (status !== "ready") {
        await engine.close();
        return { engine: null, error: `Windows sandbox is ${status}; unattended runs need it. Run: ad sandbox setup`, code: 2 };
      }
    }
    return { engine };
  } catch (e) {
    await engine.close();
    throw e;
  }
}

// What the start did to the engine's folders. A set-aside folder is said every
// time it happens; a link that can't be made (a drive without links) once.
export function reportHomeEvents(events = [], err, notesFile) {
  for (const ev of events) {
    if (ev.type === "setAside") err.write(`[agent-daemon] ${migrateMessages.oneEmpty({ name: ev.path })}\n`);
    if (ev.type === "linkFailed") {
      const text = `couldn't make ${ev.link}, the link older versions of ad need (${ev.error}). ad works without it; \`ad doctor\` shows it.`;
      if (notesFile === null) err.write(`[agent-daemon] ${text}\n`);
      else noteOnce("home.linkFailed", text, { err, ...(notesFile ? { file: notesFile } : {}) });
    }
  }
}

async function safeSetup(engine, opts, err) {
  try {
    const report = await ensureHarnessSetup(engine, opts);
    for (const w of report.warnings) err.write(`[agent-daemon] harness setup: ${w}\n`);
    for (const d of report.details ?? []) for (const line of String(d.detail).split("\n").slice(0, 8)) err.write(`  details: ${line}\n`);
    if (report.sandboxConfigured) err.write(`[agent-daemon] set up the Windows sandbox (${report.sandboxConfigured}); for stronger isolation run: ad sandbox setup --elevated\n`);
    return report;
  } catch (e) {
    // Memory/hooks are an enhancement; a setup failure must not block the run.
    err.write(`[agent-daemon] harness setup incomplete: ${engineErrorText(e, { details: null })}\n`);
    const detail = engineErrorDetail(e);
    if (detail) for (const line of String(detail).split("\n").slice(0, 8)) err.write(`  details: ${line}\n`);
    return null;
  }
}
