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

const DEFAULT_TIMEOUT_S = 15 * 60;

// The prompt travels as ONE `--prompt=<text>` token: passed as a separate
// argument after -p, a prompt like "--dangerously-skip-permissions" could
// be read as a flag.
export function agyArgs({ prompt, model, edits, timeoutS = DEFAULT_TIMEOUT_S }) {
  const args = [`--prompt=${prompt}`, "--output-format", "json", "--sandbox", "--disable-slash-commands", `--print-timeout=${timeoutS}s`];
  if (model) args.push(`--model=${model}`);
  if (edits) args.push("--mode=accept-edits");
  return args;
}

const errorText = (e) => (typeof e === "string" ? e : e?.message ?? (e ? JSON.stringify(e) : null));

export function runAgy({ prompt, cwd, model, edits, timeoutS = DEFAULT_TIMEOUT_S, command = { cmd: "agy", prefix: [] }, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawnFn(command.cmd, [...command.prefix, ...agyArgs({ prompt, model, edits, timeoutS })], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    // Backstop in case agy ignores --print-timeout (e.g. waiting on a login prompt).
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, error: `agy did not finish within ${timeoutS}s (not logged in? run agy once interactively)` });
    }, (timeoutS + 30) * 1000);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err = (err + c).slice(-4000)));
    child.on("error", (e) => done({ ok: false, error: e.code === "ENOENT" ? "agy not found on PATH (install the Antigravity CLI and run agy once to log in)" : e.message }));
    child.on("close", (code) => {
      let r = null;
      try {
        r = JSON.parse(out);
      } catch {
        // handled below
      }
      if (!r || typeof r !== "object") return done({ ok: false, error: `agy exited ${code} without a JSON result: ${(err || out).trim().slice(-300)}` });
      const ok = r.status === "SUCCESS";
      done({ ok, response: String(r.response ?? ""), conversationId: r.conversation_id, status: r.status, error: ok ? undefined : errorText(r.error) ?? r.status ?? `exit ${code}` });
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
