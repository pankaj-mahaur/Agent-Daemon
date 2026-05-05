# runtime/

The `agent-daemon` Node CLI that wires the loop together: reads transcripts, runs triage, extracts learnings, persists memory, queues skill proposals.

## v0.2 status

Implemented end-to-end:
- ✅ CLI dispatcher with all subcommands (`session-start`, `digest`, `init`, `status`, `review`, `doctor`, `checkpoint`, `watch`)
- ✅ Claude Code transcript JSONL adapter (normalizes events to a typed schema)
- ✅ Triage gate (deterministic heuristic — no LLM)
- ✅ `session-start`: reads constitution + cross-project user.md + project memory + per-project rules; emits 9KB-capped JSON for the SessionStart hook
- ✅ **`digest`: full pipeline — triage → LLM extract → classify → apply (memory writes + proposal queue)**
- ✅ Headless `claude` wrapper (`--bare --print --output-format json` with JSON Schema validation, cost cap, timeout, ANTHROPIC_API_KEY check)
- ✅ Extraction prompt (`prompts/extract.md`) — production-ready, calibrated for the 4 signal types
- ✅ Classify routing (rules-based, no LLM): low-risk → auto-apply memory; high-risk → proposal queue
- ✅ Apply: writes to project memory (`activeContext.md`) + global memory (`user.md`) + queues skill/constitution proposals
- ✅ `doctor`: validates `claude` CLI, ANTHROPIC_API_KEY, settings.json wiring, project dirs
- ✅ `init`: scaffolds `.agent-daemon/memory/` from templates
- ✅ Pareto selection for GEPA (working, smoke-tested)
- ✅ SQLite + FTS5 schema designed (apply pending native binding)

Stubbed (v0.3):
- 🚧 SQLite read/write (better-sqlite3 native binding wiring — schema is final)
- 🚧 GEPA stages 1–4 LLM wiring (sample/reflect/generate/evaluate — algorithm structure complete)
- 🚧 Interactive `review` (currently lists; v0.3 makes accept/reject/edit interactive)
- 🚧 `watch` (chokidar, v0.3)
- 🚧 Cline / Cursor / Codex transcript adapters

## Install

```bash
cd runtime
npm install   # no runtime deps yet — reserves the install path for later
npm link      # exposes `agent-daemon` on PATH (or use the parent setup.sh --runtime)
agent-daemon doctor
```

### ⚠️ ANTHROPIC_API_KEY is required for the digest pipeline

The digest pipeline calls `claude --bare` to extract learnings from transcripts. `--bare` mode is required to prevent hook recursion (a normal `claude` session would re-fire our SessionStart hook and infinite-loop). But `--bare` deliberately ignores OAuth login + keychain credentials — it only reads `ANTHROPIC_API_KEY`.

Set it once:

```bash
# Linux / macOS
export ANTHROPIC_API_KEY=sk-ant-...
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc   # or ~/.bashrc

# Windows (PowerShell)
setx ANTHROPIC_API_KEY "sk-ant-..."
# then reopen the terminal
```

Get a key at https://console.anthropic.com/settings/keys — billing is independent of your interactive Claude Code login. Cost per session digest is approximately **$0.001–0.01** (Haiku is the default extractor model).

`agent-daemon doctor` will tell you if the key is set.

## Architecture

```
runtime/src/
├── cli.mjs                  # dispatcher; small commands inline (init, status, review, doctor, checkpoint, watch)
├── session-start.mjs        # session-start command (real)
├── adapters/
│   └── claude-code.mjs      # JSONL transcript parser → normalized events
├── digest/
│   ├── triage.mjs           # gate heuristic (real)
│   └── digest.mjs           # pipeline orchestrator (triage + stub extraction)
└── (future)
    ├── digest/extract.mjs   # LLM extractor (next pass)
    ├── digest/classify.mjs
    ├── digest/dedupe.mjs
    ├── digest/apply.mjs
    ├── memory/markdown.mjs
    ├── memory/sqlite.mjs    # episodic store (v0.2)
    └── daemon/watch.mjs     # fswatch (v0.2)
```

## Design notes

- **Zero runtime dependencies for v0.1.** Pure Node ESM, requires Node 22+. `parseArgs`, `fs/promises`, `child_process` are enough.
- **The headless `claude` CLI is the LLM engine.** When extraction lands, we shell out to `claude --print --output-format json` with the extraction prompt + the transcript. Same model context, no API key plumbing.
- **Markdown-first persistence.** v0.1 only writes markdown (proposed reports, memory templates). SQLite for episodic + semantic recall lands in v0.2 along with `sqlite-vec` and `FTS5`.
- **Hook output cap.** `session-start` truncates context to 9KB to stay under Claude Code's 10K hook output cap.

## Subcommand reference

```
agent-daemon session-start [--output-json] [--cwd <path>]
agent-daemon digest        --transcript <path> [--session-id <id>] [--cwd <path>] [--dry-run]
agent-daemon checkpoint    --transcript <path> [--session-id <id>]
agent-daemon init          [--cwd <path>] [--dry-run]
agent-daemon status        [--cwd <path>]
agent-daemon review        [--cwd <path>]
agent-daemon doctor
agent-daemon watch                              # v0.2 stub
agent-daemon --help
agent-daemon --version
```

Common environment variables (set by Claude Code's hooks):

- `CLAUDE_PROJECT_DIR`
- `CLAUDE_SESSION_ID`
- `CLAUDE_TRANSCRIPT_PATH`

## Testing

```bash
npm test    # node --test against test/
```

Test fixtures and the test runner ship in v0.2. For v0.1, smoke-test by:

```bash
agent-daemon doctor
agent-daemon digest --transcript ~/.claude/projects/<encoded>/<session>.jsonl --dry-run --verbose
```
