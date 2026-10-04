// `ad doctor` checks for the Codex engine. Same {name, ok, note} shape as
// the rest of cmdDoctor's checks.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MISSING, pinnedCodexVersion, resolveCodexCommand } from "./app-server.mjs";
import { codexEnv, defaultCodexHome, isManagedHome } from "./home.mjs";

export function parseCodexVersion(text) {
  return String(text).match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1] ?? null;
}

export function codexChecks({ env = process.env, run = execFileSync } = {}) {
  const checks = [];
  const pinned = pinnedCodexVersion();
  const command = resolveCodexCommand(env);
  let installed = null;
  if (!command.cmd) {
    checks.push({ name: "Codex engine", ok: false, note: CODEX_MISSING });
  } else {
    // A throwaway CODEX_HOME: without one, Codex falls back to ~/.codex, the user's own install.
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
      checks.push({ name: "Codex engine", ok: false, note: `not runnable (${err.code ?? err.message}) — cd runtime && npm install` });
    } finally {
      if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
    }
  }
  if (installed) {
    const match = installed === pinned;
    checks.push({
      name: "Codex engine",
      ok: match,
      note: match
        ? `codex ${installed} (${command.source}) matches pin`
        : `codex ${installed} (${command.source}) but runtime pins ${pinned} — protocol untested; run: cd runtime && npm install`,
    });
  }
  const home = defaultCodexHome(env);
  checks.push({
    name: "Harness CODEX_HOME",
    ok: true,
    note: existsSync(home)
      ? `${home}${isManagedHome(home) ? "" : " (not created by ad — never auto-modified)"}`
      : `${home} (created on first ad run)`,
  });
  return checks;
}

// Checks that need a running app-server: login, provider, hook trust and
// (Windows) sandbox readiness. Skipped until the harness home exists, so
// doctor never creates it. engineFactory is injectable for tests.
export async function codexLiveChecks({ env = process.env, engineFactory, platform = process.platform } = {}) {
  const home = defaultCodexHome(env);
  if (!existsSync(home)) return [];
  const checks = [];
  let engine;
  try {
    const factory = engineFactory ?? (async (o) => (await import("../index.mjs")).createEngine(o));
    engine = await factory({ home });
    const [acct, cfg] = [await engine.account(), await engine.readConfig()];
    const provider = cfg.model_provider ?? "openai";
    const a = acct.account;
    const loggedIn = Boolean(a) || !acct.requiresOpenaiAuth;
    checks.push({
      name: "Harness login",
      ok: loggedIn,
      note: loggedIn ? (a?.type === "chatgpt" ? `ChatGPT ${a.planType ?? ""}`.trim() : a?.type ?? `provider ${provider}`) : "not logged in — ad auth login chatgpt",
    });
    const hooksFile = join(home, "hooks.json");
    if (existsSync(hooksFile)) {
      const norm = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));
      const ours = (await engine.listHooks([process.cwd()])).filter((h) => norm(h.sourcePath) === norm(hooksFile));
      const trusted = ours.filter((h) => h.trustStatus === "trusted").length;
      checks.push({ name: "Harness hooks", ok: trusted === ours.length, note: `${trusted}/${ours.length} trusted${trusted < ours.length ? " — the next ad run re-trusts them" : ""}` });
    }
    if (platform === "win32") {
      const status = (await engine.server.request("windowsSandbox/readiness", {})).status;
      checks.push({ name: "Windows sandbox", ok: status === "ready", note: status === "ready" ? `ready (${cfg.windows?.sandbox ?? "?"})` : `${status} — ad sandbox setup` });
    }
  } catch (e) {
    checks.push({ name: "Harness engine", ok: false, note: `could not start codex app-server: ${e.message}` });
  } finally {
    await engine?.close();
  }
  return checks;
}
