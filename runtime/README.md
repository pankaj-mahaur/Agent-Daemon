# runtime/

The `agent-daemon` Node CLI that wires the loop together: reads transcripts, runs triage, extracts learnings, persists memory, queues skill proposals.

## v0.2 status

Implemented end-to-end:
- ✅ CLI dispatcher with all subcommands (`session-start`, `digest`, `init`, `status`, `review`, `doctor`, `checkpoint`, `watch`)
- ✅ Claude Code transcript JSONL adapter (normalizes events to a typed schema)
- ✅ Triage gate (deterministic heuristic — no LLM)
- ✅ `session-start`: prioritizes active project memory + SQLite learnings before compact guidance; emits current 9KB-capped Claude hook JSON
- ✅ **`digest`: full pipeline — triage → LLM extract → classify → apply (memory writes + proposal queue)**
- ✅ Headless `claude` wrapper (`--bare --print --output-format json` with JSON Schema validation, cost cap, timeout, ANTHROPIC_API_KEY check)
- ✅ Extraction prompt (`prompts/extract.md`) — production-ready, calibrated for the 4 signal types
- ✅ Classify routing (rules-based, no LLM): low-risk → auto-apply memory; high-risk → proposal queue
- ✅ Apply: writes to project memory (`activeContext.md`) + global memory (`user.md`) + queues skill/constitution proposals
- ✅ `doctor`: validates Claude hook wiring, managed `CLAUDE.md`, memory quality, context budget, and local skill traces
- ✅ `init`: scaffolds `.agent-daemon/memory/`, creates/refreshed managed `CLAUDE.md`, and installs no-API Claude hooks
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

### ✅ No API key required for normal digest

Ordinary Claude operation does **not** require `ANTHROPIC_API_KEY`: prompt-time deterministic extraction and retrieval persist local memory, while an optional `<agent-daemon-digest>` JSON block enriches session-close memory. The installed SessionEnd hook does not opt into model extraction.

**API key is required ONLY for:**
- `agent-daemon evolve <skill>` — GEPA skill self-evolution (batch op, opt-in)
- `AGENT_DAEMON_FALLBACK_LLM=1 agent-daemon digest ...` — opt-in LLM fallback when an agent didn't emit a digest block

If you want either of those:

```bash
# Linux / macOS
export ANTHROPIC_API_KEY=sk-ant-...
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc

# Windows (PowerShell)
setx ANTHROPIC_API_KEY "sk-ant-..."
```

Get a key at https://console.anthropic.com/settings/keys.

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
