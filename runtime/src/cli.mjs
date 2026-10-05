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

async function tui(args) {
  const { values, positionals } = parseArgs({
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
    strict: false,
  });
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
  // Bare `ad` (and `ad --last`) open the TUI once it is the default (FC3),
  // or now with AD_TUI=1; otherwise the help, with the reason when the TUI
  // was wanted but can't run here.
  const bare = argv.length === 0 || (argv.length === 1 && argv[0] === "--last");
  if (bare) {
    const choice = bareAdChoice({ env: process.env, isDefault: TUI_IS_DEFAULT });
    if (choice.tui) return tui(argv);
    if (choice.reason) process.stderr.write(`${choice.reason}\n\n`);
  }
  await import("./cli-full.mjs"); // runs the command and exits
  return undefined;
}

const code = await launch();
if (code !== undefined) process.exit(code || 0);
