#!/usr/bin/env node
// S-HOOKS logging hook: appends what the host handed us (argv, stdin payload,
// CLAUDE_*/CODEX_* env, parent pid, shell hints) to $SPIKE_LOG, then answers
// with the JSON stored for this label in $SPIKE_RESPONSES (if any).
//
//   node log-hook.mjs <label>
//
// Behaviour switches, read from $SPIKE_RESPONSES[<label>] when it is an
// object with a "_spike" key: {"_spike": {"exit": 2, "stderr": "…",
// "sleepMs": 5000, "detachedMarker": "path", "childMarker": "path",
// "envFileLine": "export X=1"}, ...rest is printed as JSON}.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const label = process.argv[2] ?? "unlabelled";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { _unparsed: raw.slice(0, 2000) };
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|AD_|SPIKE_)/i.test(k) && !/KEY|TOKEN|SECRET/i.test(k)));
  const record = {
    label,
    at: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    shellHints: { SHELL: process.env.SHELL, ComSpec: process.env.ComSpec, PSModulePath: process.env.PSModulePath ? "set" : undefined, MSYSTEM: process.env.MSYSTEM },
    env,
    payload,
  };
  if (process.env.SPIKE_LOG) appendFileSync(process.env.SPIKE_LOG, JSON.stringify(record) + "\n");

  let responses = {};
  try {
    responses = JSON.parse(readFileSync(process.env.SPIKE_RESPONSES, "utf8"));
  } catch {}
  const event = payload?.hook_event_name;
  const answer = responses[label] ?? responses[event];
  const spike = answer?._spike ?? {};
  if (spike.envFileLine && process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, spike.envFileLine + "\n");
  if (spike.detachedMarker) {
    // A detached grandchild that writes a marker after the host's timeout.
    const c = spawn(process.execPath, ["-e", `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(spike.detachedMarker)}, 'alive '+Date.now()), ${spike.childDelayMs ?? 4000})`], { detached: true, stdio: "ignore", windowsHide: true });
    c.unref();
  }
  if (spike.childMarker) {
    // An ordinary (attached) child with the same job, for comparison.
    spawn(process.execPath, ["-e", `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(spike.childMarker)}, 'alive '+Date.now()), ${spike.childDelayMs ?? 4000})`], { stdio: "ignore", windowsHide: true });
  }
  if (spike.sleepMs) await new Promise((r) => setTimeout(r, spike.sleepMs));
  if (spike.markDone) writeFileSync(spike.markDone, "hook finished " + Date.now());
  if (answer) {
    const { _spike, ...out } = answer;
    if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
  }
  if (spike.stderr) process.stderr.write(spike.stderr);
  process.exitCode = spike.exit ?? 0;
});
