#!/usr/bin/env node
// S-L3P (L3 packaging): a plugin loaded with --plugin-dir, against the real
// `claude` binary and the S-HOOKS mock Messages API, in a throwaway home.
// It answers four questions:
//   1. Do exec-form plugin hooks (command "node", args with ${CLAUDE_PLUGIN_ROOT}) run?
//   2. Does an exec-form plugin SessionStart hook get CLAUDE_ENV_FILE, and does a
//      line it appends reach the Bash tool?
//   3. What does UserPromptSubmit receive for a typed `/<plugin>:<skill> args`
//      (and does UserPromptExpansion fire)?
//   4. Does `claude plugin validate` accept the plugin?
//
//   node s-l3p.mjs --out <temp root OUTSIDE the user profile>
//
// Claude Code reads CLAUDE.md files from parent folders, so the temp root must
// sit outside the user profile. Nothing here reads or writes ~/.claude.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runScenario } from "./s-hooks/run-claude.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_HOOK = path.join(HERE, "s-hooks", "log-hook.mjs");
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const out = arg("--out");
if (!out) {
  console.error("usage: node s-l3p.mjs --out <temp root outside the user profile>");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const PLUGIN = "spikeplug";
const exec = (label) => ({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/log.mjs", label], timeout: 30 });
let pluginDir = null;

const scenario = {
  prompt: `/${PLUGIN}:remember use pnpm, not npm`,
  events: [], // no settings.json hooks: only the plugin's
  setup: (tmp) => {
    pluginDir = path.join(tmp, "plugin");
    fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "skills", "remember"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN, version: "0.0.1", description: "S-L3P spike plugin" }, null, 2));
    fs.copyFileSync(LOG_HOOK, path.join(pluginDir, "log.mjs"));
    const hooks = {};
    for (const ev of ["SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse"]) {
      hooks[ev] = [{ ...(ev === "PreToolUse" ? { matcher: "Bash" } : {}), hooks: [exec(`Plugin${ev}`)] }];
    }
    fs.writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), JSON.stringify({ hooks }, null, 2));
    fs.writeFileSync(
      path.join(pluginDir, "skills", "remember", "SKILL.md"),
      ["---", "description: Remember a correction for later sessions.", "argument-hint: <what to remember>", "disable-model-invocation: true", "---", "", "SPIKE_ENV the user asked to remember: $ARGUMENTS", ""].join("\n"),
    );
  },
  rules: [{ match: "SPIKE_ENV", anywhere: true, toolUse: { name: "Bash", input: { command: "echo \"[AD_TOOL_SHELL=$AD_TOOL_SHELL]\"", description: "env" } } }],
  responses: { PluginSessionStart: { _spike: { envFileLine: "export AD_TOOL_SHELL=1" } } },
  get args() {
    return ["--plugin-dir", pluginDir, "--allowedTools", "Bash"];
  },
};

const r = await runScenario("l3p", scenario, { outDir: out });
const toolResults = r.requests.flatMap((q) => q.toolResults);
const byLabel = (l) => r.hooks.filter((h) => h.label === l);
const ss = byLabel("PluginSessionStart")[0];
const ups = byLabel("PluginUserPromptSubmit")[0];
const upe = byLabel("PluginUserPromptExpansion")[0];
const CLAUDE = process.env.SPIKE_CLAUDE_BIN ?? (process.platform === "win32" ? path.join(os.homedir(), ".local", "bin", "claude.exe") : "claude");
const validate = spawnSync(CLAUDE, ["plugin", "validate", pluginDir], { encoding: "utf8", env: { ...process.env, HOME: r.home, USERPROFILE: r.home, CLAUDE_CONFIG_DIR: path.join(r.home, ".claude") }, timeout: 60_000 });
console.log(
  JSON.stringify(
    {
      code: r.code,
      ms: r.ms,
      hooksFired: r.hooks.map((h) => h.label),
      q1_execFormRan: Boolean(ss || ups),
      q1_pluginRootInEnv: ss?.env?.CLAUDE_PLUGIN_ROOT ? "set" : "missing",
      q1_argv: ss?.argv,
      q2_envFileGiven: Boolean(ss?.env?.CLAUDE_ENV_FILE),
      q2_bashSawMarker: toolResults.some((t) => t.includes("AD_TOOL_SHELL=1")),
      q2_toolResult: (toolResults[0] ?? "").slice(0, 160),
      q3_promptSubmitPrompt: ups?.payload?.prompt,
      q3_expansion: upe ? { fired: true, keys: Object.keys(upe.payload ?? {}), command: upe.payload?.command_name ?? upe.payload?.command, prompt: upe.payload?.prompt } : { fired: false },
      q4_validate: { status: validate.status, out: (validate.stdout + validate.stderr).trim().slice(0, 600) },
      stderr: r.stderr.slice(0, 400),
      tmp: r.tmp,
    },
    null,
    1,
  ),
);
