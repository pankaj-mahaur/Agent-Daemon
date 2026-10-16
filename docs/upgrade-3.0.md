# Upgrading to 3.0

3.0 says "the engine" everywhere ad's screens, docs and skills used to say Codex. `ad about` says what ad runs on.

## What changes

- ad's screens say "the engine"; `ad about` shows the engine's name, version, license, URL, process name, home and settings path, and the tested engine versions.
- `docs/codex-parity.md` is now `docs/commands.md`.
- The `codex-upgrade` skill and workflow are now `engine-upgrade`.
- New files: `THIRD_PARTY_NOTICES.md` (the engine's notices and license) and this guide.

## Your data

Nothing moves: the folder keeps its name until you run `ad migrate`.

- `ad migrate` (interactive terminal only) renames `codex-home/` to `engine/` and leaves a link named `codex-home` pointing at it; `ad migrate --undo` reverses it. In Git Bash run `winpty ad migrate` (or use PowerShell or Windows Terminal).
- A folder you chose with `AD_ENGINE_DIR` is never touched.

## Renamed

The old env var names keep working; new installs use the new ones. The old product values work at least until 3.1.

| Old | New |
|---|---|
| `AD_CODEX_HOME` | `AD_ENGINE_DIR` |
| `AD_CODEX_BIN` | `AD_ENGINE_BIN` |
| `AD_CODEX_LLM_MODEL` | `AD_ENGINE_MODEL` |
| `--engine codex` | `--engine ad` |
| `--llm codex` | `--llm ad` |
| `AD_HOOK_HOST=codex` | `AD_HOOK_HOST=ad` |

`AD_ENGINE_HOME` is not a setting and is refused: the marker ad stamps on the engine processes it starts is `AD_INTERNAL_ENGINE_HOME`. Don't set it yourself.

## Removed: `ad codex` and `/codex`

The hand-off to the engine's own UI is gone. Typing either prints what to use instead.

| Instead of | Use |
|---|---|
| resume a conversation in the stock UI | `ad --last` or `/resume` |
| `ad codex login` | `ad auth login` |
| `ad codex mcp …` | MCP servers in the engine's settings file (`[mcp_servers]`), `/mcp` to list |
| `ad codex features …` | `[features]` in the engine's settings file |
| plugins | not planned |
| apps | not planned |
| voice | not planned |
| `/import` | not planned |
| the keymap editor | `[tui.keymap]` in the settings file (`/keymap` shows an example) |

## Rolling back to 2.2.0

1. If you ran `ad migrate` and want the old layout back, run `ad migrate --undo` while still on 3.0. This is optional: 2.2.0 follows the `codex-home` link.
2. `git checkout v2.2.0`
3. `cd runtime && npm install`
4. The `codex-home` link lets 2.2.0 find your folder.

## Something wrong?

Run `ad doctor`, then read [troubleshooting.md](troubleshooting.md).
