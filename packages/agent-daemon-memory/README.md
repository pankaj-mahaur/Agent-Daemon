# agent-daemon-memory

Local memory for your coding agents. One MCP server gives Claude Code, Codex and
Cursor the lessons and corrections from past sessions in the same project, and
one command sets it up in each of them.

```sh
npx agent-daemon-memory install
```

It shows what it will change and asks first. Memory stays on your computer
(`~/.agent-daemon/episodic.db`); there is no account and no network use. Restart
each host afterwards.

| Command | What it does |
|---|---|
| `install [--host <id>] [--yes] [--dry-run] [--capture auto\|hooks\|tools]` | add the server to the hosts it finds (backup first) |
| `doctor [--json]` | check each host's entry and talk to the server the way the host does |
| `repair [--host <id>]` | put back an entry the installer owns |
| `status [--json]` | what is installed where |
| `uninstall [--host <id>] [--purge-data]` | remove exactly what it added; memory data stays unless you ask |
| `review [--accept <file>] [--accept-all] [--global]` | accept or reject the notes an agent recorded (run it yourself, in a terminal) |

Hosts: `claude-code` (through `claude mcp add`, user scope), `codex`
(`~/.codex/config.toml`), `cursor` (`~/.cursor/mcp.json`).

What an agent records is held for your review: it reaches your sessions after
you accept it with `npx agent-daemon-memory review` (or `ad review`) in your own
terminal. Accepting refuses inside an agent's shell and asks you to type `accept`.

Part of [agent-daemon](https://github.com/pankaj-mahaur/Agent-Daemon). Needs
Node 22.16 or newer; no native build.
