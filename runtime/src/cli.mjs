#!/usr/bin/env node
// agent-daemon / ad — the launcher (plan D7). It stays at this path so the
// npm bin shims and hook commands keep working, and routes the terminal UI
// (`ad tui`, `ad codex`, and bare `ad` once it opens the TUI) before loading
// the full command module (cli-full.mjs), which the rest goes to.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
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
  --model <name>       the model to start with
  --sandbox <mode>     read-only | workspace-write (default) | danger-full-access
  --resume <thread-id> continue a conversation;  --last  the newest one here
  --preview            a minimal preview UI on the same engine instead
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
        sandbox: { type: "string" },
        resume: { type: "string" },
        last: { type: "boolean" },
        preview: { type: "boolean" },
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
  return cmdTui({ cwd: values.cwd || process.cwd(), model: values.model, sandbox: values.sandbox, resume: values.resume, last: values.last, prompt: positionals.join(" ").trim() || null, clientVersion: version() });
}

async function launch() {
  const [command, ...rest] = argv;
  if (command === "tui") return tui(rest);
  if (command === "codex") {
    const { cmdCodex } = await import("./harness/codex-ui.mjs");
    return cmdCodex(rest);
  }
  // Bare `ad` (and `ad --last`) open the TUI unless AD_TUI=0; otherwise the
  // help, with the reason when the TUI was wanted but can't run here.
  const bare = argv.length === 0 || (argv.length === 1 && argv[0] === "--last");
  if (bare) {
    const choice = bareAdChoice({ env: process.env, isDefault: TUI_IS_DEFAULT });
    if (choice.tui) return tui(argv);
    // `ad --last` means "reopen the last conversation in the terminal UI": say
    // what to do instead of falling through to "unknown command".
    if (argv[0] === "--last") {
      process.stderr.write(
        choice.reason
          ? `${choice.reason}\n\`ad --last\` reopens the last conversation in the terminal UI; here, use \`ad chat\` and /resume.\n`
          : "The terminal UI is turned off (AD_TUI=0). `ad tui --last` reopens the last conversation in it anyway.\n",
      );
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
