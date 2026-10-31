# L0 spikes

Scripts behind the L0 spikes of the MCP + plugin platform plan (spike table in the plan's `06-RISKS-SPIKES-LATER.md` §1). Each one runs in throwaway homes and never touches the real `~/.claude` or `~/.codex`. The Windows results are recorded in the plan; macOS and Linux runs are still open.

| Script | Spike | What it measures |
|---|---|---|
| `s-perf.mjs` | S-PERF | Spawned-hook latency per event (p50/p95 over `--runs`), the ratio to `node -e 0`, and the memory server's `tools/list` and first `tools/call` |
| `s-hooks/run-claude.mjs` | S-HOOKS | The real `claude` binary against a local mock Messages API, with a logging hook on every event: payloads, prompt sources, permission modes, `onFailure`, `systemMessage`, `CLAUDE_ENV_FILE`, exec form, children of a killed hook |
| `s-hooks/run-codex.mjs` | S-HOOKS, S-BIND | The real `codex` CLI against the repo's mock Responses server: payloads, `/hooks` trust, deny/ask/exit codes, timeouts, the `[mcp_servers]` working folder |
| `s-history.mjs` | S-HISTORY | `bench`: reading 2,000 synthetic Claude Code transcripts and Codex rollouts; `sample`: a shape-preserving, scrubbed copy of a captured transcript |
| `s-review-tty.mjs` | S-REVIEW-TTY | The cost of one process snapshot and the ancestry shapes of every running shell (process names only) |

## Running them

```bash
node tools/spikes/s-perf.mjs --runs 20 --json s-perf.json
node tools/spikes/s-review-tty.mjs --runs 10
node tools/spikes/s-history.mjs bench --sessions 2000
node tools/spikes/s-hooks/run-claude.mjs batch '^mode-' --fixtures runtime/test/fixtures/hosts/claude-code --version "$(claude --version | cut -d' ' -f1)"
node tools/spikes/s-hooks/run-codex.mjs batch '.' --fixtures runtime/test/fixtures/hosts/codex --version "$(codex --version | cut -d' ' -f2)"
```

- The host runners need `claude` and `codex` installed; they use a fake key and a loopback mock, so nothing is billed or sent anywhere. `SPIKE_CLAUDE_BIN` and `SPIKE_CODEX_JS` override the binaries.
- **Run them from a folder outside your user profile** (for example set `TMPDIR`/`TEMP` to `D:\spike-tmp` on Windows). Claude Code walks parent folders for `CLAUDE.md`, so a temp project under `C:\Users\<you>\AppData\Local\Temp` loads your own `~/.claude/CLAUDE.md` as project memory. Fixtures are scrubbed either way (`s-hooks/sanitize.mjs --scrub`), but the session still reads the file.
- Headless only: `claude -p` and `codex exec`. Interactive prompt sources (typed versus pasted, `/loop`, plan hand-off) and interactive `ask` prompts need a person at the terminal.
