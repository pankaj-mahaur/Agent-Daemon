#!/usr/bin/env node
// Runs `ad tui --preview` against the fake Codex app-server, in a throwaway
// Codex home, for the pty smoke test. Never starts the real Codex.
//   node testkit/tui-preview-fake.mjs <codex-home> <cwd>

import { fileURLToPath } from "node:url";
import { cmdTuiPreview } from "../src/tui/preview.mjs";

const FAKE = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const [home, cwd] = process.argv.slice(2);
if (!home || !cwd) {
  console.error("usage: tui-preview-fake.mjs <codex-home> <cwd>");
  process.exit(2);
}
const code = await cmdTuiPreview({
  home,
  cwd,
  command: { cmd: process.execPath, prefix: [FAKE] }, // isolation guard still applies (temp home)
  clientVersion: "test",
  store: { get: () => null }, // never read the real secret store in tests
});
process.exit(code);
