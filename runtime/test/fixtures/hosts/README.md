# Host hook fixtures (L0 spike S-HOOKS)

Payloads captured from the **real** host binaries on 1 Nov 2026, Windows 11:
- Claude Code **2.1.314**, run headless (`claude -p`, stream-json);
- Codex **0.164.0**, run as `codex exec --json`.

Each run used a throwaway HOME, USERPROFILE and `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, a loopback mock of the model API (fake key, no login, no network) and a logging hook on every event. The scripts are in `tools/spikes/` (see its README). L2 replays these fixtures.

## Layout

- `claude-code/<scenario>.json` and `codex/<scenario>.json` hold:
  - `host`, `version`, `scenario`, `os`;
  - `outcome`: did the tool run, what the model saw, whether `systemMessage` reached the output;
  - `hooks[]`: `{label, env, payload}` per hook call, in order.

  Codex files also carry the `hooks/list` trust listing.
- `claude-code/transcripts/*.jsonl` and `codex/rollouts/*.jsonl` (S-HISTORY): shape-preserving copies. Every string is cut at 160 characters, and instruction attachments are dropped.
- **Placeholders:** `<TMP>` / `-TMP-` (the run's temp root), `<HOME>`, `<user>`, `<REPO>`.

## Scenarios

| Fixture | What it shows |
|---|---|
| `claude-code/scheduled` | A `ScheduleWakeup` prompt fires UserPromptSubmit with the same fields as a typed prompt. Its text was visible earlier in the ScheduleWakeup tool input and in Stop's `session_crons` |
| `claude-code/transcripts/sources-*` | A background subagent's completion arrives as a UserPromptSubmit whose prompt starts with `<task-notification>`. In the transcript, the user entry has `promptSource: "system"`, `origin.kind: "task-notification"` |
| `claude-code/misc` | `/spike hello` reaches UserPromptSubmit raw, then UserPromptExpansion (`command_source: "projectSettings"`). `CLAUDE_ENV_FILE` (SessionStart only) reaches Bash. An exec-form hook (`command` + `args`) runs on Windows. `systemMessage` shows in the output |
| `claude-code/powershell` | The PowerShell tool (`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`) sees a plain `NAME=value` line from `CLAUDE_ENV_FILE` |
| `claude-code/mode-<mode>-<decision>` | PreToolUse decision × `--permission-mode`. Headless: `deny` blocks in every mode, bypass included. `ask` never runs the tool in any mode. `allow` and no decision run it where the mode permits. `--permission-mode auto` reports `default` on this setup |
| `claude-code/fail-<default\|block>-<exit1\|timeout>` | Without `onFailure` a crashed or timed-out hook fails open (the tool runs). With `onFailure: "block"` the tool is blocked |
| `claude-code/detach-control` | A hook that exits at once after spawning a detached and an attached child: whether the children outlive it |
| `codex/basic`, `codex/untrusted` | Hooks need `hooks.state."<hooks.json path>:<event>:<group>:<handler>".trusted_hash`. Untrusted hooks are skipped silently in `codex exec` |
| `codex/deny-*`, `codex/ask-*` | A JSON `deny` blocks with its reason. `ask` fails open (the command runs) |
| `codex/exit2-never`, `codex/crash-never` | Exit 2 with a reason on stderr did **not** block on Windows: the hook runs under `pwsh -Command`, which loses the exit code. Use JSON decisions. Exit 1 fails open |
| `codex/timeout-never` | Codex stops waiting at the timeout and runs the tool. The hook's own node process and both its children kept running |
| `codex/pm-*` | `permission_mode` is `bypassPermissions` in every `codex exec` run: exec forces approval `never` |
| `codex/sessionend-cap` | A slow SessionEnd hook's process finishes after Codex exits |

**Not covered here:** interactive sessions (typed versus pasted text, `/loop`, plan hand-off, interactive `ask` prompts), macOS and Linux.
