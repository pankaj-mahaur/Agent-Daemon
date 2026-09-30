// `ad agy "<prompt>"` — hand one prompt to the user's own Antigravity CLI
// (`agy`, Google AI Pro/Ultra subscription) and print its answer.
//
// This is the ONLY way the harness touches a Google subscription: agy runs
// with its own cached login; ad never reads, stores or forwards Google
// credentials (reusing them in a third-party client is against Google's
// terms and has led to account suspensions). Whether driving agy from a
// script is itself allowed is not settled, so it is opt-in: the first run
// needs --accept-risk, recorded in ~/.agent-daemon/agy-consent.json.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const AGY_NOTICE = `ad agy runs your own Antigravity CLI (agy) with its own login. Agent Daemon
never touches your Google credentials, but Google's terms for scripting agy
are not settled — use at your own risk. Re-run with --accept-risk to continue.`;

const consentFile = (home) => path.join(home, ".agent-daemon", "agy-consent.json");

export function agyArgs({ prompt, model, edits }) {
  const args = ["-p", prompt, "--output-format", "json", "--sandbox", "--disable-slash-commands"];
  if (model) args.push("--model", model);
  if (edits) args.push("--mode", "accept-edits");
  return args;
}

export function runAgy({ prompt, cwd, model, edits, command = { cmd: "agy", prefix: [] }, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const child = spawnFn(command.cmd, [...command.prefix, ...agyArgs({ prompt, model, edits })], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err = (err + c).slice(-4000)));
    child.on("error", (e) => resolve({ ok: false, error: e.code === "ENOENT" ? "agy not found on PATH (install the Antigravity CLI and run agy once to log in)" : e.message }));
    child.on("close", (code) => {
      let r;
      try {
        r = JSON.parse(out);
      } catch {
        return resolve({ ok: false, error: `agy exited ${code} without JSON output: ${(err || out).trim().slice(-300)}` });
      }
      const ok = r.status === "SUCCESS";
      resolve({ ok, response: r.response ?? "", conversationId: r.conversation_id, status: r.status, error: ok ? undefined : r.error?.message ?? r.error ?? r.status });
    });
  });
}

export async function cmdAgy(prompt, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const home = opts.userHome ?? homedir();
  if (!prompt?.trim()) {
    err.write('Usage: ad agy "<prompt>" [--cwd <dir>] [--model <m>] [--edits] [--accept-risk]\n');
    return 1;
  }
  if (!existsSync(consentFile(home))) {
    if (!opts.acceptRisk) {
      err.write(AGY_NOTICE + "\n");
      return 2;
    }
    mkdirSync(path.dirname(consentFile(home)), { recursive: true });
    writeFileSync(consentFile(home), JSON.stringify({ acceptedAt: new Date().toISOString() }) + "\n");
  }
  const r = await runAgy({ prompt, cwd: opts.cwd ?? process.cwd(), model: opts.model, edits: opts.edits, command: opts.command, spawnFn: opts.spawnFn });
  if (!r.ok) {
    err.write(`ad agy: ${r.error}\n`);
    return 1;
  }
  out.write(r.response.endsWith("\n") ? r.response : r.response + "\n");
  return 0;
}
