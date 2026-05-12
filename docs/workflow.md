# Daily workflow

Two commands cover 99% of daily use: **`ad watch`** for autopilot, **`ad digest-latest`** for manual one-shot. Use either, or both — they're idempotent.

---

## TL;DR

```sh
# Set-and-forget: leave running in a background terminal
ad watch --verbose --force

# Or manual: run after a session ends, in the project directory
cd /path/to/your/project
ad digest-latest --verbose
```

The agent must emit an `<agent-daemon-digest>` block during the session for either to capture learnings. See [the ending protocol](#the-ending-protocol) below.

---

## Setup (once per project)

```sh
cd /path/to/your/project
ad init --profile developer
```

That scaffolds:
- `.agent-daemon/memory/` — 7 markdown templates ready for the digest pipeline to fill
- `AGENTS.md` — multi-agent orchestration guide (loaded into every session)
- `session-logs/` — local-only (gitignored) journal directory with a README
- Adds an `## agent-daemon` managed section to `CLAUDE.md`
- Merges hook entries into `~/.claude/settings.json`

All idempotent — safe to re-run.

## Bootstrap (once, after init)

In your first Claude Code session in the project, tell Claude:

> *"bootstrap the daemon memory using the bootstrap-daemon skill"*

Claude reads `package.json`, key folders, recent commits, and populates all 7 memory files with real project context (stack, conventions, in-flight work, gotchas). Cost ~$0.05–0.10 in tokens. One-time.

You can also skip bootstrap and let the digest pipeline fill memory organically across the next 3–5 sessions. Bootstrap just gives future sessions a rich starting point on day one.

## Session logs (`session-logs/`)

A local-only journal of each Claude Code session. Gitignored — never committed. Sits alongside `.agent-daemon/memory/` (which IS committed and contains durable distilled learnings).

Format: one file per session, named `YYYY-MM-DD_session-NN.md`. See `session-logs/README.md` (scaffolded by `ad init`) for the full template.

**Update triggers** — Claude responds to these phrases without any extra prompting:

- *"log tokens"* + paste `/cost` output → appends a timestamped token entry
- *"close session" / "end session" / "session khatam"* → fills the **End of session** block (closing time, outcome, deliverables, pending work, what next session must start with) **and** emits the agent-daemon digest block in the same response. Both happen automatically — no confirmation asked.
- *"new session"* → creates the next-numbered file and links the previous one

Why two log systems?
- `session-logs/*.md` — your **personal working journal**. Verbose. Token usage. Half-formed ideas.
- `.agent-daemon/memory/*.md` — **shared, distilled knowledge**. Committed. Lessons that survive across sessions.

---

## Option A — `ad watch` (autopilot)

Open a dedicated terminal window:

```sh
ad watch --verbose --force
```

Flags:

| Flag | Effect |
|---|---|
| `--verbose` | Log every file event (`+ add`, `~ change`) and every digest fire |
| `--force` | Bypass the triage threshold — digest every session, even short ones |
| `--once-on-existing` | Also digest transcripts that already exist when the watcher starts |
| `--fallback-to-llm` | If no agent-emitted digest block is found, run LLM extraction (requires `claude` CLI) |

The watcher:

1. Monitors `~/.claude/projects/**/*.jsonl` (Claude Code) and `~/.codex/sessions/**/*.jsonl` (Codex)
2. Waits for a file to be "stable" — no writes for ~30 seconds, size unchanged across two 5-second polls
3. Reads the `cwd` field from inside the transcript so memory lands in the right project
4. Fires `ad digest` with the right transcript + cwd

Minimize the window. Daemon silently runs in the background. Check progress with `ad status` or by tailing `.agent-daemon/sessions.jsonl`.

**Stop with Ctrl+C.**

### Known issue on Windows

On some Windows configurations, `chokidar` (the underlying file-watch library) misses new-file events even in polling mode. If `ad watch` runs but never logs `+ add` lines:

- Confirm new transcripts ARE being created in `~/.claude/projects/<encoded>/` (check `LastWriteTime`)
- If yes — fall back to **Option B** (`ad digest-latest`) for that session, then file a bug

Polling can also be forced on with `AGENT_DAEMON_WATCH_POLL=1`.

---

## Option B — `ad digest-latest` (one-shot)

After a session ends:

```sh
cd /path/to/your/project
ad digest-latest --verbose
```

This:

1. Encodes your current directory the way Claude Code does (e.g. `D:\Program Files\Mobiux\redseer-frontend` → `d--Program-Files-Mobiux-redseer-frontend`)
2. Finds the newest `.jsonl` under `~/.claude/projects/<encoded>/`
3. Forces digest on it (bypasses triage — short test sessions still get captured)
4. Writes learnings to `.agent-daemon/memory/` + SQLite + `sessions.jsonl`

**Idempotent:** running `digest-latest` twice on the same transcript is harmless. The episodic SQLite store dedupes.

### Flags

| Flag | Effect |
|---|---|
| `--verbose` | Print extract / classify / apply steps |
| `--cwd <path>` | Digest the latest transcript for a *different* project |
| `--dry-run` | Preview without writing |
| `--fallback-to-llm` | LLM extraction if no agent block found |

### Composable workflow

If you run `ad watch` AND occasionally `ad digest-latest`, the second run will detect "already digested" via SQLite and skip. **Safe to use both.**

---

## The ending protocol

Both commands need the agent to emit a `<agent-daemon-digest>` block in its final response. The block format lives in [`constitution/ending-protocol.md`](../constitution/ending-protocol.md) and is loaded into every Claude Code session via the `SessionStart` hook.

The agent **does not always remember** to emit it. To guarantee capture:

> Before the session ends, ask the agent: *"emit the agent-daemon digest block before ending"*

The agent will then write a JSON block like:

```
<agent-daemon-digest>
{
  "learnings": [
    {
      "type": "pattern",
      "text": "1–3 sentence lesson written for a future session",
      "evidence_quote": "exact quote from the user or codebase",
      "evidence_speaker": "user" | "agent",
      "scope": "project" | "global",
      "confidence": 0.0,
      "tags": ["keyword", ...]
    }
  ],
  "session_summary": "≤2 sentences: what the session accomplished"
}
</agent-daemon-digest>
```

The tags render as nothing in markdown — invisible to you, parseable by the daemon.

---

## Verifying it worked

```sh
# Per-session audit ledger (one line per digest run):
tail -n 5 .agent-daemon/sessions.jsonl | jq .

# Memory file growth over time:
git log --since="7 days ago" --oneline -- .agent-daemon/memory/

# Anything queued for your review (high-risk diffs):
ad status

# Token + cache stats (after a few real sessions):
ad doctor --tokens
```

### What a healthy `sessions.jsonl` line looks like

```json
{
  "ts": "2026-05-12T14:32:00.123Z",
  "session_id": "abc-...",
  "adapter": "claude-code",
  "duration_min": 23.4,
  "user_turns": 8,
  "assistant_turns": 11,
  "tool_calls": 17,
  "edits": 3,
  "triage": "above-threshold",
  "digested": true,
  "learnings_extracted": 4,
  "learnings_applied": 8,
  "learnings_queued": 1,
  "extract_source": "agent-emitted",
  "extract_cost_usd": 0
}
```

`digested: true` + `learnings_extracted >= 1` = the loop is working.

`digested: false` with `triage: "below threshold..."` = session was too short; if you want it captured anyway, run `ad digest-latest` (force is default-on) or re-run with `--force`.

---

## Reviewing high-risk learnings (`ad status`)

Low-confidence or large diffs land in `.agent-daemon/proposals/` instead of being auto-applied. Review them:

```sh
ad status        # list queued proposals
ad review        # interactive accept / reject
```

---

## Multi-project workflow

`ad watch` watches **all** Claude Code transcripts. It detects each transcript's project via the `cwd` field inside the JSONL, so memory always lands in the right project's `.agent-daemon/memory/`.

For `ad digest-latest`, run it from each project's root.

---

## Decision matrix — which command to use when

| Situation | Use |
|---|---|
| Daily work, leave terminal running | `ad watch --verbose --force` |
| One important session you want captured **now** | `ad digest-latest --verbose` |
| Watch missed a session (Windows quirk) | `ad digest-latest` |
| Verifying daemon end-to-end after install | `ad digest-latest --dry-run --verbose` |
| Multiple projects open in parallel | `ad watch` (handles all) |
| Want to see the LLM fallback path | `ad digest --transcript <path> --cwd <path> --fallback-to-llm --force --verbose` |

---

## See also

- [Architecture](./architecture.md) — how the digest pipeline works internally
- [Troubleshooting](./troubleshooting.md) — common failures and fixes
- [Installation](./installation-guide.md) — first-time setup
- [Manual test checklist](./manual-test-v0.2.0.md) — full end-to-end verification
