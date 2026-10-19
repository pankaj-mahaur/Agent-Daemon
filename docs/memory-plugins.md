# Memory as host plugins

ad's memory reaches other agents two ways:

- **The installer** (`npx agent-daemon-memory install`, see [the installer guide](memory-install.md)) writes one entry into each host's settings. It works for every supported host and always knows which project is open.
- **A plugin** from the host's own plugin gallery. One build makes every package from the same code, so they behave the same.

| Host | Plugin | Capture | Which project | Use it when |
|---|---|---|---|---|
| Claude Code | marketplace plugin (MCP server, hooks, skill) | the plugin's hooks | the open project (`${CLAUDE_PROJECT_DIR}`) | you'd rather install from `/plugin` than run a command |
| VS Code, Copilot, Kiro, OpenHands | Agent Plugins 1.0 package (MCP server, skill) | the record tools | **none**: these hosts start plugin servers in the plugin's own folder, so memory shows and stores nothing | only if the host tells the server which folder is open; otherwise use the installer |
| Cursor, Gemini CLI, Codex | planned (P5.4b) | | | use the installer |

## The Claude Code plugin

```
/plugin marketplace add <the agent-daemon marketplace repository>
/plugin install agent-daemon-memory@agent-daemon
```

- **The MCP server:** `node ${CLAUDE_PLUGIN_ROOT}/server/server.mjs serve --host claude-code --capture hooks --project ${CLAUDE_PROJECT_DIR}`.
- **The hooks:**
  - on each prompt, the user's corrections go to the capture journal, and notes relevant to the prompt are added;
  - at session start, the journal is drained and this project's notes are shown.

  There is no end-of-session digest: that needs ad itself.
- **Where capture files go:** ad's own folder (`~/.agent-daemon/projects/<project>/`), so a repository without `ad init` gets no folder.
- **No double capture.** If `ad init` already put ad's own hook for a step in Claude Code's settings (`~/.claude/settings.json`, or the project's `.claude/settings.json` or `settings.local.json`), the plugin's hook for that step does nothing.
  - Only ad's own commands count (`ad …`, `agent-daemon …`, or node with ad's `cli.mjs`), never another tool's `session-start.sh`.
  - A hook with an `if` condition doesn't count either, since it may not run.
- **Session start shows memory only:** what came in since last time, this project's memory file, notes about the files you're changing, recent lessons and how you work. It adds no CLAUDE.md, no other tools' rules and no ad setup hints; the host loads its own.
- **One route per host.** Use the plugin or the installer for Claude Code, not both, or the memory tools appear twice.
  - With the plugin enabled (`enabledPlugins` in `~/.claude/settings.json`), `npx agent-daemon-memory install` leaves Claude Code alone.
  - If the installer's entry came first, `doctor` reports both routes (`route.double`) and says how to keep one.
- **The skill** `agent-daemon-memory` tells the agent when to search, what to record and that results are notes, not instructions.

## Limits

- **`node` must be on the host's PATH.** Plugins name a bare `node`: a host started from a desktop icon may not see the PATH your shell has. If the memory tools don't appear, start the host from a terminal, or use the installer, which writes the absolute path of the Node that ran it.
- **Node 22.16 or newer** (memory runs on Node's built-in SQLite, with full-text search from 22.16).
- **A host that doesn't expand a variable.**
  - If a host leaves `${PLUGIN_ROOT}` as it is (Cursor does), Node can't find the server script, and the host shows the server as failed: use the installer for that host.
  - Any other argument left unexpanded stops the server with `agent-daemon-memory: the host didn't expand …; this host needs the installer route.` instead of reading a wrong path. An unexpanded `--project` is only skipped.
- **Agent Plugins hosts** start the server in the plugin's folder. It never binds to that folder, or to a repository around it, so it serves no notes unless the host passes a project.
- **The installer's VS Code entry** goes in `~/.copilot/mcp-config.json`, which the Copilot CLI reads too: there the server runs with `--host vscode` as well. A `~/.copilot` folder made by the CLI alone also counts as VS Code being installed.

## Building the packages

```bash
node runtime/scripts/build-host-packages.mjs --out <dir>              # every target
node runtime/scripts/build-host-packages.mjs --out <dir> --target claude-code
```

- **What gets written:**
  - `<dir>/claude-code`: a marketplace repository tree.
  - `<dir>/agent-plugin/agent-daemon-memory`: the Agent Plugins folder.
- **The `server/` folder** carries only the memory server, the hook runner and what they import: Node built-ins, nothing to install.
- **Versions:** every manifest carries the package version, which must equal the runtime's.
- **Checked by `runtime/test/host-packages.test.mjs`:**
  - the Agent Plugins manifests against the vendored 1.0.0 schemas;
  - Claude Code's rules;
  - one version everywhere;
  - no personal or test files;
  - the built server answering both protocol shapes;
  - the guard against unexpanded variables;
  - the duplicate guard.
