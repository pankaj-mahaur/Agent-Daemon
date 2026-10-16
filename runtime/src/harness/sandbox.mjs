// Windows sandbox for the harness home.
//
// The engine confines workspace-write commands on Windows with its own sandbox,
// which needs a one-time setup per home (verified on 0.159.2):
//   - unelevated: restricted token + ACLs, no admin prompt, weaker network isolation
//   - elevated:   dedicated sandbox users + firewall rules, needs one UAC approval
// Setup = config `windows.sandbox = <mode>` + windowsSandbox/setupStart. The
// app-server caches readiness per process, so status is read from a fresh one.
// On macOS/Linux the engine uses Seatbelt/Landlock and nothing is needed here.

import { createEngine, engineHome } from "../engine/index.mjs";
import { sandboxConsent } from "../engine/attribution.mjs";

export const needsWindowsSandbox = (platform = process.platform) => platform === "win32";

// y/N on a terminal → true/false; null when there is no terminal to ask on.
export async function confirmOnTty({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY) return null;
  stdout.write("> ");
  const line = await new Promise((resolve) => {
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.once("data", (d) => {
      stdin.pause();
      resolve(String(d));
    });
  });
  return /^\s*y(es)?\s*$/i.test(line);
}

export async function sandboxReadiness(engine) {
  return engine.sandbox.readiness();
}

// The mode is written to config only AFTER setup succeeds: written first,
// a failed setup would look configured and never be retried.
export async function setupWindowsSandbox(engine, { mode = "unelevated", cwd, timeoutMs = 10 * 60_000 } = {}) {
  const r = await engine.sandbox.setup({ mode, cwd, timeoutMs });
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
    out.write("No setup needed: on this platform the engine uses the operating system's sandbox (Seatbelt or Landlock).\n");
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
    if (!engineHome.isManaged(engine.home) && !opts.force) {
      err.write(`Refusing to change ${engine.home}: it was not created by ad. Re-run with --force.\n`);
      return 2;
    }
    const mode = opts.elevated ? "elevated" : "unelevated";
    if (mode === "elevated") {
      out.write(`${sandboxConsent}\n`);
      const answer = opts.yes === true ? true : await (opts.confirm ?? confirmOnTty)({ stdin: opts.stdin ?? process.stdin, stdout: out });
      if (answer === null) {
        err.write("ad sandbox setup --elevated asks before it changes this machine. Run it in a terminal, or add --yes.\n");
        return 2;
      }
      if (!answer) {
        out.write("Not changed.\n");
        return 1;
      }
    }
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
