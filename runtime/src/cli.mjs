#!/usr/bin/env node
// agent-daemon / ad — the launcher (plan D7). It stays at this path so the
// npm bin shims and hook commands keep working, and routes the terminal UI
// (`ad tui`, and bare `ad` once it opens the TUI) before loading
// the full command module (cli-full.mjs), which the rest goes to.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LEGACY } from "./engine/attribution.mjs";
import { TUI_IS_DEFAULT, bareAdChoice } from "./tui/flip.mjs";

const argv = process.argv.slice(2);
const version = () => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0-dev";
  }
};

const TUI_USAGE = `Usage: ad tui ["<first prompt>"] [options]
  --cwd <dir>          the folder to work in (default: this one)
  --account <ref>      the account: provider/label, a label or an id (ad auth list)
  --model <name>       the model to start with;  --effort <e>  its reasoning effort
  --sandbox <mode>     read-only | workspace-write (default) | danger-full-access
  --resume <thread-id> continue a conversation;  --last  the newest one here
  --preview            a minimal preview UI on the same engine instead
  --no-alt-screen      inline mode for this run (no fullscreen)
Guide: docs/tui.md`;
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

async function tui(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${TUI_USAGE}\n`);
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  let parsed;
  try {
    // Strict: a mistyped flag (--sandbx read-only) must not silently become the first prompt.
    parsed = parseArgs({
      args,
      options: {
        cwd: { type: "string" },
        model: { type: "string" },
        account: { type: "string" },
        effort: { type: "string" },
        sandbox: { type: "string" },
        resume: { type: "string" },
        last: { type: "boolean" },
        preview: { type: "boolean" },
        "no-alt-screen": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`ad tui: ${err.message}\n\n${TUI_USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.sandbox !== undefined && !SANDBOX_MODES.includes(values.sandbox)) {
    process.stderr.write(`ad tui: --sandbox must be one of ${SANDBOX_MODES.join(", ")} (got "${values.sandbox}")\n`);
    return 2;
  }
  if (values.preview) {
    const { cmdTuiPreview } = await import("./tui/preview.mjs");
    return cmdTuiPreview({ cwd: values.cwd || process.cwd(), model: values.model, sandbox: values.sandbox, clientVersion: version() });
  }
  const { cmdTui } = await import("./tui/main.mjs");
  return cmdTui({ cwd: values.cwd || process.cwd(), model: values.model, account: values.account, effort: values.effort, sandbox: values.sandbox, resume: values.resume, last: values.last, noAltScreen: values["no-alt-screen"] === true, prompt: positionals.join(" ").trim() || null, clientVersion: version() });
}

async function launch() {
  const [command, ...rest] = argv;
  if (command === "tui") return tui(rest);
  // The hand-off to the engine's own UI left the product in 3.0 (design C4): a tombstone says what replaced it.
  if (command === LEGACY.command) {
    const { tombstoneEngineUiCommand } = await import("./engine/attribution.mjs");
    const { engineHome } = await import("./engine/index.mjs");
    process.stderr.write(`${tombstoneEngineUiCommand({ settingsPath: engineHome.settingsPath() ?? "(see ad doctor)" })}\n`);
    return 2;
  }
  // Maintainers only, never in HELP: the engine's own UI on ad's engine folder.
  if (command === "engine" && rest[0] === "ui" && rest.includes("--debug")) {
    const { engineDebugUi } = await import("./engine/index.mjs");
    try {
      return await engineDebugUi.run({ args: rest.slice(1).filter((a) => a !== "--debug"), cwd: process.cwd() });
    } catch (err) {
      process.stderr.write(`ad engine ui: ${err.message}\n`);
      return 1;
    }
  }
  // Bare `ad` (and `ad --last`) open the TUI unless AD_TUI=0; otherwise the
  // help, with the reason when the TUI was wanted but can't run here.
  // `--no-alt-screen` (P2.5) may come along: `ad --no-alt-screen`, `ad --last --no-alt-screen`.
  const bare = argv.length <= 2 && argv.every((a) => a === "--last" || a === "--no-alt-screen") && new Set(argv).size === argv.length;
  if (bare) {
    const choice = bareAdChoice({ env: process.env, isDefault: TUI_IS_DEFAULT });
    if (choice.tui) return tui(argv);
    // `ad --last` means "reopen the last conversation in the terminal UI": say
    // what to do instead of falling through to "unknown command".
    if (argv.includes("--last")) {
      process.stderr.write(
        choice.reason
          ? `${choice.reason}\n\`ad --last\` reopens the last conversation in the terminal UI; here, use \`ad chat\` and /resume.\n`
          : "The terminal UI is turned off (AD_TUI=0). `ad tui --last` reopens the last conversation in it anyway.\n",
      );
      return 2;
    }
    // `ad --no-alt-screen` asks for the terminal UI (inline): say why it can't open, never "unknown command".
    if (argv.includes("--no-alt-screen")) {
      process.stderr.write(choice.reason ? `${choice.reason}\n` : "The terminal UI is turned off (AD_TUI=0). `ad tui --no-alt-screen` opens it inline anyway.\n");
      return 2;
    }
    if (choice.reason) process.stderr.write(`${choice.reason}\n\n`);
  }
  await import("./cli-full.mjs"); // runs the command and exits
  return undefined;
}

let code;
try {
  code = await launch();
} catch (err) {
  process.stderr.write(`agent-daemon: ${err?.message ?? err}\n`);
  code = 1;
}
if (code !== undefined) process.exit(code || 0);
