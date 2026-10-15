// `ad doctor`'s checks of the engine, as codes and data; the façade (`engineDoctor` in `../index.mjs`) owns the words.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinnedCodexVersion, resolveCodexCommand } from "./app-server.mjs";
import { codexEnv, homeOverride, isManagedHome } from "./home.mjs";
import { entryKind, homeFacts, OLD_HOME_NAME, resolveHomeState } from "./home-resolve.mjs";

export function parseCodexVersion(text) {
  return String(text).match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1] ?? null;
}

/** The tested Codex versions and what changed in each (compat.json). */
export function codexCompat() {
  try {
    return JSON.parse(readFileSync(new URL("./compat.json", import.meta.url), "utf8"));
  } catch {
    return { pinned: null, tested: [], whatChanged: {} };
  }
}

export function engineChecks({ env = process.env, run = execFileSync, root } = {}) {
  const checks = [];
  const pinned = pinnedCodexVersion();
  const command = resolveCodexCommand(env);
  let installed = null;
  if (!command.cmd) {
    checks.push({ code: "engine.missing", ok: false, data: {} });
  } else {
    // A throwaway home: without one, the engine falls back to the user's own install.
    let scratchHome = null;
    try {
      scratchHome = mkdtempSync(join(tmpdir(), "ad-codex-version-"));
      installed = parseCodexVersion(run(command.cmd, [...command.prefix, "--version"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: codexEnv({ home: scratchHome, base: env }),
      }));
    } catch (err) {
      checks.push({ code: "engine.notRunnable", ok: false, data: { error: err.code ?? err.message } });
    } finally {
      if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
    }
  }
  if (installed) checks.push({ code: "engine.version", ok: installed === pinned, data: { installed, pinned, source: command.source } });
  let state;
  try {
    const custom = homeOverride(env);
    state = custom ? { path: custom, state: "custom" } : resolveHomeState({ root });
  } catch (err) {
    checks.push({ code: "engine.homeError", ok: false, data: { message: err.message } });
  }
  if (state?.state === "two-folders") {
    const oldPath = join(dirname(state.path), OLD_HOME_NAME);
    checks.push({ code: "engine.twoFolders", ok: false, data: { oldPath, newPath: state.path } });
    checks.push({ code: "engine.folderFacts", ok: true, data: { which: "older name", ...homeFacts(oldPath) } });
    checks.push({ code: "engine.folderFacts", ok: true, data: { which: "new name", ...homeFacts(state.path) } });
  } else if (state) {
    const exists = existsSync(state.path);
    checks.push({ code: "engine.home", ok: true, data: { path: state.path, exists, managed: exists && isManagedHome(state.path), state: state.state } });
    if (state.state === "new") {
      const link = join(dirname(state.path), OLD_HOME_NAME);
      checks.push({ code: "engine.link", ok: true, data: { link, kind: entryKind(link), migratedAt: readMigrated(dirname(state.path)) } });
    }
  }
  const compat = codexCompat();
  if (installed === pinned && compat.whatChanged?.[pinned]) checks.push({ code: "engine.compat", ok: true, data: { tested: compat.tested, note: compat.whatChanged[pinned] } });
  return checks;
}

/** When ad migrate last moved the folder (root/migrate.json), or null. */
function readMigrated(root) {
  try {
    return JSON.parse(readFileSync(join(root, "migrate.json"), "utf8"))?.at ?? null;
  } catch {
    return null;
  }
}

// Checks that need a running engine: sign-in, provider, hook trust and
// (Windows) sandbox readiness. Skipped until the home exists, so doctor never
// creates it. engineFactory is injected (the façade passes createEngine).
export async function engineLiveChecks({ env = process.env, engineFactory, platform = process.platform, root } = {}) {
  let home;
  try {
    const custom = homeOverride(env);
    const s = custom ? { path: custom, state: "custom" } : resolveHomeState({ root });
    if (s.state === "two-folders") return []; // never start an engine in one of two folders
    home = s.path;
  } catch {
    return []; // engineChecks already shows the engine.homeError row
  }
  if (!existsSync(home)) return [];
  const checks = [];
  let engine;
  try {
    engine = await engineFactory({ home });
    const [acct, cfg] = [await engine.account(), await engine.readConfig()];
    const provider = cfg.model_provider ?? "openai";
    const a = acct.account;
    const loggedIn = Boolean(a) || !acct.requiresOpenaiAuth;
    const label = a?.type === "chatgpt" ? `ChatGPT ${a.planType ?? ""}`.trim() : a?.type ?? `provider ${provider}`;
    checks.push({ code: "engine.login", ok: loggedIn, data: { loggedIn, label } });
    const hooksFile = join(home, "hooks.json");
    if (existsSync(hooksFile)) {
      const norm = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));
      const ours = (await engine.listHooks([process.cwd()])).filter((h) => norm(h.sourcePath) === norm(hooksFile));
      const trusted = ours.filter((h) => h.trustStatus === "trusted").length;
      checks.push({ code: "engine.hooks", ok: trusted === ours.length, data: { trusted, total: ours.length } });
    }
    if (platform === "win32") {
      const status = await engine.sandbox.readiness();
      checks.push({ code: "engine.windowsSandbox", ok: status === "ready", data: { status, mode: cfg.windows?.sandbox ?? null } });
    }
  } catch (e) {
    checks.push({ code: "engine.unreachable", ok: false, data: { error: e.message } });
  } finally {
    await engine?.close();
  }
  return checks;
}
