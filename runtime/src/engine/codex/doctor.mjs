// `ad doctor`'s checks of the engine, as codes and data; the façade (`engineDoctor` in `../index.mjs`) owns the words.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedCodexVersion, resolveCodexCommand } from "./app-server.mjs";
import { codexEnv, defaultCodexHome, isManagedHome } from "./home.mjs";

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

export function engineChecks({ env = process.env, run = execFileSync } = {}) {
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
  const home = defaultCodexHome(env);
  const exists = existsSync(home);
  checks.push({ code: "engine.home", ok: true, data: { path: home, exists, managed: exists && isManagedHome(home) } });
  const compat = codexCompat();
  if (installed === pinned && compat.whatChanged?.[pinned]) checks.push({ code: "engine.compat", ok: true, data: { tested: compat.tested, note: compat.whatChanged[pinned] } });
  return checks;
}

// Checks that need a running engine: sign-in, provider, hook trust and
// (Windows) sandbox readiness. Skipped until the home exists, so doctor never
// creates it. engineFactory is injected (the façade passes createEngine).
export async function engineLiveChecks({ env = process.env, engineFactory, platform = process.platform } = {}) {
  const home = defaultCodexHome(env);
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
