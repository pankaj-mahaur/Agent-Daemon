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

Run it in your own terminal (it refuses in the agent's own shell): at the end
it runs `setup`, which adds the memory hooks to Codex (trust them once with
`/hooks`) and, in Claude Code, completes the `agent-daemon-memory` plugin
(`/plugin install`, which brings the hooks) or, with `--no-plugin`, adds the
hooks itself. Without a terminal (a script, a pipe) it adds the server only and
prints the `setup` command to finish with.

| Command | What it does |
|---|---|
| `install [--host <id>] [--yes] [--dry-run] [--capture auto\|hooks\|tools] [--no-plugin] [--no-setup]` | add the server to the hosts it finds (backup first), then run `setup` |
| `setup [--host claude-code\|codex] [--no-plugin] [--dry-run]` | add the memory hooks to Codex, and to Claude Code with the plugin or `--no-plugin` (in your own terminal) |
| `doctor [--json]` | check each host's entry and talk to the server the way the host does; in Codex, whether you trusted the hooks |
| `repair [--host <id>]` | put back an entry the installer owns |
| `status [--json]` | what is installed where |
| `uninstall [--host <id>] [--purge-data]` | remove exactly what it and `setup` added, keep what you changed, and list both; memory data stays unless you ask |
| `review [--list \| --plain \| --accept-all [--with-agent] \| --proposals]` | decide what waits for review in a checklist (run it yourself, in a terminal) |
| `remember <text>` · `forget <n>` · `restore <n>` | save, remove or bring back a note (accepted or removed at once only in your own terminal) |
| `config review [strict\|auto]` | every note waits for review, or a typed correction applies at once where a host can prove it |
| `report [--days 30] [--json]` | is memory working here: what it captured, what waits, what it recalled |
| `mistakes [--save]` | the corrections you keep typing (read-only, offline); `--save` puts them up for review |

The installer's hosts: `claude-code` (through `claude mcp add`, user scope),
`codex` (one line in `~/.codex/config.toml`), `cursor` (`~/.cursor/mcp.json`), `vscode`
(`~/.copilot/mcp-config.json`), `gemini` (`~/.gemini/settings.json`). Which are
tested live: [the support matrix](https://github.com/pankaj-mahaur/Agent-Daemon/blob/main/docs/support-matrix.md).

What your hooks capture and what an agent records wait for your review: until
you accept them with `npx agent-daemon-memory review` (or `ad review`) in your
own terminal, the agent sees them only when it searches, marked unreviewed, and
they are never shown at session start. Review is a checklist: `a`, `enter`, `y`
accepts the new notes from your prompts on the page; flagged notes are decided one at a
time. It refuses inside an agent's shell. More: [capture, review and forget](https://github.com/pankaj-mahaur/Agent-Daemon/blob/main/docs/memory/review.md).

Part of [agent-daemon](https://github.com/pankaj-mahaur/Agent-Daemon). Needs
Node 22.16 or newer; no native build.
