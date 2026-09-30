// `ad doctor` checks for the Codex engine. Same {name, ok, note} shape as
// the rest of cmdDoctor's checks.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pinnedCodexVersion, resolveCodexCommand } from "./app-server.mjs";
import { defaultCodexHome, isManagedHome } from "./home.mjs";

export function parseCodexVersion(text) {
  return String(text).match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1] ?? null;
}

export function codexChecks({ env = process.env, run = execFileSync } = {}) {
  const checks = [];
  const pinned = pinnedCodexVersion();
  const command = resolveCodexCommand(env);
  let installed = null;
  try {
    installed = parseCodexVersion(run(command.cmd, [...command.prefix, "--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true }));
  } catch (err) {
    checks.push({ name: "Codex engine", ok: false, note: `not runnable (${err.code ?? err.message}) — cd runtime && npm install` });
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
