#!/usr/bin/env node
// Runs `ad tui` against the fake Codex app-server, in a throwaway Codex home,
// for the pty smoke test. Never starts the real Codex, and never touches ad's
// real memory, prompt history, state, thread locks or schedules (all under <root>).
//   node testkit/tui-fake.mjs <root> <cwd>

import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmdTui } from "../src/tui/main.mjs";

const FAKE = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const [root, cwd] = process.argv.slice(2);
if (!root || !cwd) {
  console.error("usage: tui-fake.mjs <root> <cwd>");
  process.exit(2);
}
const code = await cmdTui({
  home: path.join(root, "home"),
  cwd,
  command: { cmd: process.execPath, prefix: [FAKE] }, // isolation guard still applies (temp home)
  clientVersion: "test",
  store: { get: () => null }, // never read the real secret store in tests
  memory: false,
  historyFile: path.join(root, "history.jsonl"),
  stateFile: path.join(root, "state.json"),
  lockDir: path.join(root, "locks"),
  adHome: path.join(root, "ad-home"),
});
process.exit(code);
