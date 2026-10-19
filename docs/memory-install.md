# Memory in other agents: the installer

ad's memory server gives Claude Code, Codex and Cursor the lessons and
corrections from your past sessions in the same project. One command adds it to
each host you have:

```sh
npx agent-daemon-memory install
```

With ad installed, `ad memory install` does the same, pointing the hosts at your
ad install instead of a copied package.

It shows the plan and asks first:

```
ad memory — install
Found: Claude Code, Cursor. Not found: Codex.
  Claude Code  add the memory server with `claude mcp add` (user scope). ad's hooks already capture here, so the record tools stay off.
  Cursor       add to ~/.cursor/mcp.json (backup first). No ad hooks here, so capture uses the record tools.
Memory stays on this computer: ~/.agent-daemon/episodic.db. No account.
Continue? [Y/n]
```

Then restart each host. Exit code: 0 all set up, 2 some hosts refused, 1 nothing done.

## The hosts

| Host | Where the entry goes | Capture | Project the server serves |
|---|---|---|---|
| Claude Code | `claude mcp add --scope user` (ad never edits `~/.claude.json`, which Claude Code rewrites itself) | ad's hooks when `ad init` set them up, else the record tools | the open project (`CLAUDE_PROJECT_DIR`) |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`), between ad's markers | the record tools | the session's folder |
| Cursor | `~/.cursor/mcp.json` | the record tools | `${workspaceFolder}`, else the working folder if it is a project |

`--host <id>` (`claude-code`, `codex`, `cursor`) picks hosts; `--capture
auto|hooks|tools` overrides the capture mode; `--dry-run` shows the plan and the
snippets and writes nothing; `--yes` skips the question.

Hosts start the server with the absolute path of the Node that ran the
installer (GUI apps often don't have your shell's PATH). The npx install copies
the package to `~/.agent-daemon/memory/pkg/<version>/` and points hosts at a
launcher (`~/.agent-daemon/memory/bin/launch.mjs`), so hosts never run `npx`
and an upgrade only changes which version the launcher starts. It needs Node
22.16 or newer and builds nothing: memory runs on Node's built-in SQLite.

## What it never does

- Change anything in a host's config but its own entry. JSON keeps your
  comments, order and formatting; TOML gets one marked block at the end.
- Edit a file it can't edit safely. It refuses, leaves the file as it is, and
  prints the snippet to add yourself, when: the file doesn't parse; Codex's
  `mcp_servers` isn't a table; `agent-daemon-memory` is already there and
  isn't ad's (in any TOML shape: a table, dotted keys, an inline table), or is
  ad's but you edited it; the file is read-only or isn't UTF-8 text; the file
  changed while it was asking you; or the config is ad's own engine home (also
  through a link).
- Write through a linked config (dotfile managers) without asking you, even
  with `--yes`.
- Touch your memory data on uninstall, unless you ask (`--purge-data`, typed).

Before the first change to a file it keeps the original under
`~/.agent-daemon/memory/backups/<host>/`, and records what it did in
`~/.agent-daemon/memory/install-ledger.json`.

## Doctor, repair, status, uninstall

```sh
npx agent-daemon-memory doctor        # --json for the check codes
npx agent-daemon-memory repair        # put back the entries it owns
npx agent-daemon-memory status
npx agent-daemon-memory uninstall     # --host <id> for one host
```

`doctor` starts each installed entry the way the host does and talks to it with
both MCP handshakes. Its codes: `node.version`, `node.path`, `sqlite.driver`,
`db.open`, `db.schema`, `db.stray`, and per host `config.parse`, `entry`,
`command.exists`, `smoke.legacy`, `smoke.modern`, `capture.double`,
`entry.duplicate`; `pkg.stale` when an older version is installed.

`uninstall` puts a file back exactly as it was when nothing else ever changed
it between ad's writes (or removes it, if ad created it). If anyone else wrote
to the file since the first install, it removes only ad's entry and keeps
everything else; an entry you edited yourself stays, with a message. Claude
Code's entry goes through `claude mcp remove --scope user`; a same-named entry
you added in another scope is never touched. Removing the last host also
removes the launcher, so an entry you copied by hand into another program stops
working.

An `npx agent-daemon-memory install` of a newer version updates the copy the
launcher starts, even when every host is already set up. `--purge-data` also deletes the memory database after you
type `delete my memory`; it refuses while ad itself uses the same memory,
unless you add `--force`.

## Reviewing what agents record

In hosts without ad's hooks, the agent saves corrections with the record tools,
for your review. Accept them in your own terminal:

```sh
npx agent-daemon-memory review     # or: ad review
```

See [the memory server](../mcp/agent-daemon-memory/README.md#recording-lessons-on-hosts-without-hooks).

## Windows notes

- `claude` starts by full path, without a shell: a native `claude.exe`, or the
  script behind npm's `claude.cmd`.
- A config another program has open is retried for a moment, then left
  unchanged with a message.
- Paths with `'` are written as escaped TOML strings.

If something goes wrong: [troubleshooting](troubleshooting.md#53-the-memory-installer-refused-my-config).
