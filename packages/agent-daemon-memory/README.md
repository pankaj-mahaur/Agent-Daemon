# agent-daemon-memory

Local memory for your coding agents. One MCP server brings back the lessons and
corrections from past sessions in the same project, and one command sets it up
in each agent you have.

```sh
npx agent-daemon-memory install
```

It shows what it will change and asks first. Memory stays on your computer
(`~/.agent-daemon/episodic.db`); there is no account, and the memory server sends
nothing anywhere (notes shown to an agent go wherever that agent sends its
context).
Restart each host afterwards.

| Command | What it does |
|---|---|
| `install [--host <id>] [--yes] [--dry-run] [--capture auto\|hooks\|tools]` | add the server to the hosts it finds (backup first) |
| `doctor [--json]` | check each host's entry and talk to the server the way the host does |
| `repair [--host <id>]` | put back an entry the installer owns |
| `status [--json]` | what is installed where |
| `uninstall [--host <id>] [--purge-data]` | remove exactly what it added; memory data stays unless you ask |
| `review [--accept <file>] [--accept-all] [--global]` | accept or reject the notes an agent recorded (run it yourself, in a terminal) |

The installer's hosts: `claude-code` (through `claude mcp add`, user scope),
`codex` (`~/.codex/config.toml`), `cursor` (`~/.cursor/mcp.json`), `vscode`
(`~/.copilot/mcp-config.json`), `gemini` (`~/.gemini/settings.json`). Which are
tested live: [the support matrix](https://github.com/pankaj-mahaur/Agent-Daemon/blob/main/docs/support-matrix.md).

What an agent records waits for your review: until you accept it with
`npx agent-daemon-memory review` (or `ad review`) in your own terminal, the
agent sees it only when it searches, marked unreviewed, and it is never shown
at session start. Accepting refuses inside an agent's shell and asks you to type `accept`.

Part of [agent-daemon](https://github.com/pankaj-mahaur/Agent-Daemon). Needs
Node 22.16 or newer; no native build.
