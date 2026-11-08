// L3 P4's live gate, opt-in (AD_REAL_CLAUDE=1; needs the `claude` CLI, 2.1.314+):
//   1. the built marketplace tree installs into a real Claude Code in a temp home
//      (`claude plugin marketplace add` + `claude plugin install`), passes
//      `claude plugin validate` (the plugin directory's profile) and our `doctor`;
//   2. a real headless session through the installed plugin, against the S-HOOKS mock
//      Messages API (fake key, loopback, nothing billed): the env-file line reaches the
//      Bash tool, and a typed /<plugin>:remember is saved once, pending, with a receipt.
// The temp root must sit outside the user profile (Claude Code reads CLAUDE.md from
// parent folders): set AD_LIVE_TMP on Windows, where the temp folder is in the profile.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(RUNTIME, "..");
const wanted = process.env.AD_REAL_CLAUDE === "1";
const CLAUDE = process.env.SPIKE_CLAUDE_BIN ?? "claude";
const base = process.env.AD_LIVE_TMP || os.tmpdir();
const insideProfile = path.resolve(base).toLowerCase().startsWith(path.resolve(os.homedir()).toLowerCase() + path.sep);
const skip = !wanted ? "set AD_REAL_CLAUDE=1 to install the built plugin into a real Claude Code (temp home)" : insideProfile ? "the temp root is inside your profile: set AD_LIVE_TMP to a folder outside it" : false;

const { build, NAME } = await import("../scripts/build-host-packages.mjs");
const { PRODUCT } = await import("../src/product.mjs");
const ID = `${NAME}@${PRODUCT.marketplace}`;

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function liveEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI|AD)_/i.test(k) && k !== "CLAUDECODE"));
  return { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}
const claude = (args, env, cwd) => spawnSync(CLAUDE, args, { env, cwd, encoding: "utf8", timeout: 120_000 });
function installPlugin(market, env, cwd) {
  const add = claude(["plugin", "marketplace", "add", market], env, cwd);
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const inst = claude(["plugin", "install", ID], env, cwd);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const records = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json"), "utf8"));
  return [records.plugins[ID]].flat()[0];
}

test("a marketplace install in a temp home passes validate (directory profile) and doctor", { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(base, "ad-plugin-live-"));
  made.push(tmp);
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const env = liveEnv(home);
  const { built } = build({ out: path.join(tmp, "out"), targets: ["claude-code"] });
  const market = built["claude-code"];
  const plugin = path.join(market, "plugins", NAME);
  const v = claude(["plugin", "validate", "--profile", "directory", plugin], env, home);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout + v.stderr, /found nothing to report/, "no problem and no warning (README, LICENSE, author, icon)");
  assert.equal(claude(["plugin", "validate", market], env, home).status, 0, "the marketplace manifest");
  const rec = installPlugin(market, env, home);
  assert.ok(fs.existsSync(path.join(rec.installPath, "server", "bin", "hook.mjs")), "installed with its dispatcher");
  const hooks = JSON.parse(fs.readFileSync(path.join(rec.installPath, "hooks", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].command, "node", "the exec form survived the install");
  const d = spawnSync(process.execPath, [path.join(RUNTIME, "src", "memory-install", "cli.mjs"), "doctor", "--json"], { env: { ...env, AD_ROOT: path.join(home, ".agent-daemon") }, cwd: home, encoding: "utf8", timeout: 120_000 });
  const rows = JSON.parse(d.stdout);
  assert.equal(d.status, 0, JSON.stringify(rows.filter((r) => !r.ok)));
  const row = (code) => rows.find((r) => r.code === code);
  assert.ok(row("plugin.installed")?.ok && row("plugin.installed").note.startsWith(ID), JSON.stringify(row("plugin.installed")));
  assert.ok(row("plugin.version")?.ok, JSON.stringify(row("plugin.version")));
});

test("a real session through the installed plugin: the env-file line reaches Bash; a typed remember is saved once, pending, with a receipt", { skip, timeout: 300_000 }, async () => {
  const { runScenario } = await import(pathToFileURL(path.join(REPO, "tools", "spikes", "s-hooks", "run-claude.mjs")).href);
  const tmpRoot = fs.mkdtempSync(path.join(base, "ad-plugin-session-"));
  made.push(tmpRoot);
  const { built } = build({ out: path.join(tmpRoot, "out"), targets: ["claude-code"] });
  const said = "use pnpm, not npm";
  const r = await runScenario(
    "plugin-remember",
    {
      prompt: `/${NAME}:remember ${said}`,
      // Log what UserPromptSubmit and SessionStart receive, next to the plugin's own hooks.
      events: ["SessionStart", "UserPromptSubmit", "UserPromptExpansion"],
      setup: (tmp) => installPlugin(built["claude-code"], liveEnv(path.join(tmp, "home")), tmp),
      // runScenario writes settings.json afresh: keep the plugin on.
      settings: { enabledPlugins: { [ID]: true } },
      // The first rule fires only when the hook's line ("saved the note") is in the request.
      rules: [
        { match: "saved the note", anywhere: true, toolUse: { name: "Bash", input: { command: 'echo "[line seen] [AD_TOOL_SHELL=$AD_TOOL_SHELL]"', description: "env" } } },
        { match: `${PRODUCT.displayName}: remember`, anywhere: true, toolUse: { name: "Bash", input: { command: 'echo "[line unseen] [AD_TOOL_SHELL=$AD_TOOL_SHELL]"', description: "env" } } },
      ],
      args: ["--allowedTools", "Bash"],
    },
    { outDir: tmpRoot },
  );
  assert.equal(r.code, 0, r.stderr.slice(0, 600));
  const ups = r.hooks.find((h) => h.label === "UserPromptSubmit");
  assert.equal(ups?.payload?.prompt, `/${NAME}:remember ${said}`, "the prompt arrives as typed");
  const toolResults = r.requests.flatMap((q) => q.toolResults);
  assert.ok(toolResults.some((t) => t.includes("[AD_TOOL_SHELL=1]")), `the plugin's env-file line reached Bash: ${toolResults.join(" | ").slice(0, 300)}`);
  assert.ok(toolResults.some((t) => t.includes("[line seen]")), `the model read the hook's line: ${toolResults.join(" | ").slice(0, 300)}`);
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  const journal = walk(path.join(r.home, ".agent-daemon", "projects")).filter((f) => /learning-journal/.test(f)).flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  // `claude -p` is headless: saved once, marked as not proven the user's (D21).
  assert.deepEqual(journal.map((e) => [e.text, e.provenance, e.prompt_source, e.remember]), [[said, "agent", "headless", true]], "saved once, by the plugin's hook");
  assert.match(r.stdout, /Saved for review/, "the receipt reached the session's output");
  if (process.env.AD_LIVE_FIXTURE) {
    const { saveFixture } = await import(pathToFileURL(path.join(REPO, "tools", "spikes", "s-hooks", "run-claude.mjs")).href);
    saveFixture(r, process.env.AD_LIVE_FIXTURE, claude(["--version"], process.env).stdout.split(" ")[0]);
  }
});
