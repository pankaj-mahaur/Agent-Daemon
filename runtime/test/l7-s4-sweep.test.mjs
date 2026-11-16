// L7 S4 (Done-when 13): what an agent's shell can make ad print names no command that lowers
// enforcement. The package CLI's help and usage errors, doctor, status, report, safety and
// config from the agent's shell (AD_TOOL_SHELL=1, no terminal), and ad's own --help. The
// rules CLI, the safety CLI and the learnings CLI have their own sweeps (l7-p4-rules-cli,
// l7b-safety-cli, l8-learnings-cli). A temp home: nothing of the user's is read.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const LOWERING = /\brules\s+(rm|pause|resume|allow-once|add)\b|\bsafety\s+off\b|\bconfig\s+review\s+auto\b/;

function agentShell() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-s4-"));
  made.push(h);
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  const env = { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: path.join(h, ".claude"), CODEX_HOME: path.join(h, ".codex"), AD_ROOT: path.join(h, ".agent-daemon"), AD_TOOL_SHELL: "1", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const run = (file, args) => {
    const r = spawnSync(process.execPath, [path.join(RUNTIME, file), ...args], { env, cwd: h, encoding: "utf8", input: "", timeout: 120_000 });
    return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  };
  return { h, run };
}

test("the package CLI from the agent's shell: help, usage errors, doctor, status, report, safety, config — no lowering command", () => {
  const a = agentShell();
  const outs = {};
  for (const args of [["--help"], ["bogus-verb"], ["doctor"], ["doctor", "--json"], ["status"], ["report"], ["report", "--help"], ["report", "--bogus"], ["safety"], ["config", "review"], ["config", "bogus"]]) {
    outs[args.join(" ")] = a.run("src/memory-install/cli.mjs", args);
  }
  for (const [k, v] of Object.entries(outs)) assert.doesNotMatch(v, LOWERING, `${k}:\n${v.slice(0, 2000)}`);
  assert.match(outs["--help"], /rules list/, "the help names the read-only verbs");
  assert.match(outs["doctor"], /rules\.count|node\.version/, "doctor ran");
});

test("ad's own help and an unknown verb from the agent's shell name no lowering command", () => {
  const a = agentShell();
  for (const args of [["--help"], ["help"], ["no-such-verb"]]) {
    const out = a.run("src/cli.mjs", args);
    assert.doesNotMatch(out, LOWERING, `${args.join(" ")}:\n${out.slice(0, 2000)}`);
  }
});
