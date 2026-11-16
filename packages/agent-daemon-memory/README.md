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
| `doctor [--json]` | check each host's entry and talk to the server the way the host does; in Codex, whether you trusted the hooks; a Readiness section per host says what works there and what's left to do |
| `repair [--host <id>]` | put back an entry the installer owns |
| `status [--json]` | what is installed where |
| `uninstall [--host <id>] [--purge-data]` | remove exactly what it and `setup` added, keep what you changed, and list both; memory data stays unless you ask |
| `review [--list \| --plain \| --accept-all [--with-agent] \| --proposals]` | decide what waits for review in a checklist (run it yourself, in a terminal) |
| `remember <text>` · `forget <n>` · `restore <n>` | save, remove or bring back a note (accepted or removed at once only in your own terminal) |
| `learnings list\|show <n>\|edit <n>\|forget <n>\|export\|import <file>` | your learnings: where each came from, edit or forget one (in your own terminal), move them between machines |
| `config review [strict\|auto]` | every note waits for review, or a typed correction applies at once where a host can prove it |
| `rules list [--json]` | the rules that ask before or stop a command or file write; `rules --help` in your own terminal for the rest |
| `safety [on\|status]` | a starter safety policy, off by default: ask before four kinds of catastrophic commands |
| `view [--all-projects]` | write a read-only HTML page of your learnings, rules and weekly numbers |
| `report [--days 30] [--weeks 4] [--all-projects] [--json] [--share]` | is memory working here: week by week, what it captured, what waits, what it recalled, how often a rule asked or stopped |
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
