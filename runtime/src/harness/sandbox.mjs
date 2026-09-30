// Windows sandbox for the harness CODEX_HOME.
//
// Codex confines workspace-write commands on Windows with its own sandbox,
// which needs a one-time setup per CODEX_HOME (verified on codex 0.159.2):
//   - unelevated: restricted token + ACLs, no admin prompt, weaker network isolation
//   - elevated:   dedicated sandbox users + firewall rules, needs one UAC approval
// Setup = config `windows.sandbox = <mode>` + windowsSandbox/setupStart. The
// app-server caches readiness per process, so status is read from a fresh one.
// On macOS/Linux Codex uses Seatbelt/Landlock and nothing is needed here.

import { createEngine } from "../engine/index.mjs";
import { isManagedHome } from "../engine/codex/home.mjs";

export const needsWindowsSandbox = (platform = process.platform) => platform === "win32";

export async function sandboxReadiness(engine) {
  return (await engine.server.request("windowsSandbox/readiness", {})).status;
}

// The mode is written to config only AFTER setup succeeds: written first,
// a failed setup would look configured and never be retried.
export async function setupWindowsSandbox(engine, { mode = "unelevated", cwd, timeoutMs = 10 * 60_000 } = {}) {
  const done = engine.waitForNotification("windowsSandbox/setupCompleted", () => true, { timeoutMs });
  done.catch(() => {}); // observed below; avoid an unhandled rejection if setupStart throws
  const started = await engine.server.request("windowsSandbox/setupStart", { mode, ...(cwd ? { cwd } : {}) });
  if (!started?.started) throw new Error("Codex did not start sandbox setup");
  const r = await done;
  if (!r.success) throw new Error(r.error ?? "sandbox setup failed");
  await engine.writeConfig([["windows.sandbox", mode]]);
  return r;
}

// Status from a fresh app-server (readiness is cached per process).
async function freshReadiness(opts) {
  const e = await createEngine(opts);
  try {
    return await sandboxReadiness(e);
  } finally {
    await e.close();
  }
}

export async function cmdSandbox(sub, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const engineOpts = { home: opts.home, command: opts.command, clientVersion: opts.clientVersion };
  if (!needsWindowsSandbox(opts.platform)) {
    out.write("No setup needed: Codex uses the OS sandbox (Seatbelt / Landlock) on this platform.\n");
    return 0;
  }
  if (sub === "status") {
    out.write(`windows sandbox: ${await freshReadiness(engineOpts)}\n`);
    return 0;
  }
  if (sub !== "setup") {
    err.write("Usage: ad sandbox setup [--elevated] | ad sandbox status\n");
    return 1;
  }
  let engine;
  try {
    engine = await createEngine(engineOpts);
    if (!isManagedHome(engine.home) && !opts.force) {
      err.write(`Refusing to change ${engine.home}: it was not created by ad. Re-run with --force.\n`);
      return 2;
    }
    const mode = opts.elevated ? "elevated" : "unelevated";
    if (mode === "elevated") out.write("Windows will ask for administrator approval (UAC) to create the sandbox users…\n");
    await setupWindowsSandbox(engine, { mode, cwd: opts.cwd });
  } catch (e) {
    err.write(`ad sandbox: ${e.message}\n`);
    return 1;
  } finally {
    await engine?.close();
  }
  const status = await freshReadiness(engineOpts);
  out.write(`windows sandbox: ${status}\n`);
  return status === "ready" ? 0 : 1;
}
