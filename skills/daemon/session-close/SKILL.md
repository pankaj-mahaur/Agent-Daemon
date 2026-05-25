---
name: session-close
description: Use when the user signals end-of-session. Trigger phrases (English + Hinglish, substring-matched): "bye", "session khatam", "aaj ka kaam ho gaya", "done for today", "end session", "close session", "wrapping up", "session done", "kal milte hain", "chalo bye", "session band karo", "that's it for today", "ho gaya kaam", "session ending", "ending this session", "I'm done". Runs the daemon's session-close protocol — session log + digest block + handoff + GEPA queue — without needing any API key.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable-model-invocation: false
---

# Session close — the no-API daemon protocol

When the user signals end of session, you must close the loop. The agent-daemon depends on you emitting the right artifacts now so the next session starts smarter.

Do all five steps below **in the same response** — don't ask for confirmation, don't ask the user to choose, just do it. Short prep-only sessions still emit all five — they produce signal too.

## Phase 1 — Read the protocol from CLAUDE.md

The project's `CLAUDE.md` has an `<!-- agent-daemon:start --> ... <!-- agent-daemon:end -->` managed block with the session-close protocol details (digest block schema, file paths, etc.). Read it once to ground yourself:

```bash
grep -A 80 "agent-daemon:start" CLAUDE.md 2>/dev/null | head -100
```

If the block is missing, the project wasn't `ad init`-ed. Tell the user briefly and fall back to default behavior (steps 2–5 below).

## Phase 2 — Idempotency check

Before doing file writes, check `.agent-daemon/last-session-close.flag`:

```bash
test -f .agent-daemon/last-session-close.flag && find .agent-daemon/last-session-close.flag -mmin -5 -print
```

If the flag exists AND was modified less than 5 minutes ago → this is a re-trigger (user said "bye" twice in quick succession). Skip steps 3 (session log) and 5 (handoff), but **still re-emit the digest block** (step 4) — Claude Code may have missed the first one.

After phase 5 completes, update the flag:

```bash
mkdir -p .agent-daemon && touch .agent-daemon/last-session-close.flag
```

## Phase 3 — Update session-logs

Find the current session-log file (latest by mtime in `session-logs/`):

```bash
ls -t session-logs/*.md 2>/dev/null | head -1
```

If no file exists, create today's: `session-logs/$(date +%Y-%m-%d)_session-01.md`.

Append (or fill) the **End of session** block:

```markdown
## End of session

- **Closed:** <ISO timestamp UTC>
- **Outcome:** <one-line — feature shipped / bug fixed / planning done / etc.>
- **Net deliverables:**
  - <bullet — commit hashes, branches, files of meaningful work>
- **What works now:**
  - <bullet — observable wins>
- **What's pending:**
  - <bullet — open threads, blocked items>
- **Next session must start with:**
  - <bullet — the very first thing to look at>
- **Files touched:**
  - `<path>` — <brief reason>
```

If a previous `## End of session` heading exists in the same file, rename the new one to `## End of session (continued)` to satisfy MD024.

## Phase 4 — Emit the digest block

Append this at the END of your final assistant response (after the normal user-facing text):

```
<agent-daemon-digest>
{
  "learnings": [
    {
      "type": "correction" | "confirmation" | "pattern" | "tool",
      "text": "1-3 sentences written for a FUTURE session that doesn't have this transcript",
      "evidence_quote": "exact quote from the user supporting this lesson (≤200 chars)",
      "evidence_speaker": "user" | "agent",
      "scope": "project" | "global",
      "confidence": 0.0,
      "tags": ["filepath/component/keyword", ...]
    }
  ],
  "session_summary": "≤2 sentences: what the session accomplished + the most important lesson"
}
</agent-daemon-digest>
```

Schema details:
- Tags `<agent-daemon-digest>` are HTML-style → invisible in markdown to user
- Valid JSON only (no trailing commas, double-quoted keys/strings, ASCII safe)
- Cap at **8 learnings**. Quality > quantity. Daemon dedupes across sessions
- `confidence`: ≥0.9 if user explicitly stated; 0.6-0.8 strong inference; <0.3 → drop
- `scope`: "project" when in doubt (lower bar than "global")
- Skip restating the user's request, project-trivial paths, self-praise
- If nothing meaningful: emit empty `"learnings": []` — still produces signal

Refer to `constitution/ending-protocol.md` for the canonical schema.

## Phase 5 — Write handoff (invoke handoff skill)

The `handoff` skill (in `skills/handoff/`) writes a dual-location handoff doc:
- **Per-project:** `<cwd>/.agent-daemon/handoffs/handoff-<ISO-timestamp>.md` (commitable)
- **Global:** `~/.agent-daemon/handoffs/<project-slug>/handoff-<ISO-timestamp>.md` (your trail)

Filename format: `handoff-2026-05-21T14-32-08Z.md` (colons → hyphens, Windows-safe).

Content sections in order:
1. **Context** — 2-3 sentences. What was this session about?
2. **State** — done/in-progress/blocked. Reference paths + commits, don't restate.
3. **Next action** — single most important first step. Be specific.
4. **Open questions** — items that needed user input.
5. **Suggested skills** — 1-3 skill names matching the next-action.
6. **Files touched** — bullet list of paths, no diffs.

Write the same content to BOTH locations. The `handoff` skill's body has full template.

## Phase 6 — GEPA candidates → queue (zero-API)

Check for skills that have been failing repeatedly. Query the episodic DB:

```bash
sqlite3 ~/.agent-daemon/episodic.db "SELECT skill_name, COUNT(*) as failures FROM skill_executions WHERE outcome = 'failure' AND created_at > datetime('now', '-30 days') GROUP BY skill_name HAVING failures >= 3 ORDER BY failures DESC LIMIT 5;" 2>/dev/null
```

For each result, write a queue stub:

```bash
mkdir -p .agent-daemon/gepa-queue
for skill in <candidates>; do
  cat > ".agent-daemon/gepa-queue/${skill}.md" <<EOF
# GEPA evolve queue: ${skill}

Queued: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Failures (last 30d): N

To process in a Claude Code session, say: "evolve skill ${skill}"
The \`gepa-evolve-inline\` skill will read traces inline and propose changes.
No API key needed.
EOF
done
```

If the DB doesn't exist or query fails — skip silently. GEPA queueing is best-effort.

## Phase 7 — Touch the idempotency flag

Final step:

```bash
mkdir -p .agent-daemon && touch .agent-daemon/last-session-close.flag
```

This protects against rapid double-trigger.

## Communication style

Just close out. Don't be ceremonial. After completing phases 2–7, your assistant response should:

1. Confirm in 1-2 short sentences what was done ("Session-log updated, handoff written, digest emitted")
2. Mention any GEPA candidates ("3 skills queued for evolution — run `ad review` or say 'evolve skill X' next session")
3. End with the digest block

Don't ask the user "is there anything else?" — they said bye. Honor it.

## Anti-patterns

- **Skipping the digest block** — continuous local correction capture still runs, but the richer session summary and handoff are lost. `--fallback-to-llm` is opt-in only; never assume it will repair a missed digest.
- **Asking for confirmation before each step** — the trigger phrases imply the user already decided. Just execute.
- **Duplicating handoff content into the session-log** — they have different purposes. Session-log is the journal (what happened, when); handoff is the next-session brief (do this first). Keep separate.
- **Forgetting the idempotency flag** — without it, a casual second "bye" 30 seconds later re-writes the same files (timestamps shift, content stays same).
- **Inventing learnings to hit a quota** — empty `"learnings": []` is fine. 8 garbage ones poisons the memory.

## Verification

After Phase 7, in a verification step:

```bash
ls -la .agent-daemon/last-session-close.flag                                # exists, mtime = now
ls -t session-logs/*.md | head -1 | xargs grep -l "End of session"          # latest session-log has end block
ls -t .agent-daemon/handoffs/*.md | head -1                                  # latest handoff written
ls .agent-daemon/gepa-queue/ 2>/dev/null                                     # any queued GEPA candidates
```

The digest block itself is in your assistant response — verify by looking at your own output.

## Examples

### Example 1: Standard "bye" close

User: *"bye, aaj ka kaam ho gaya"*

You:
1. Read CLAUDE.md (verify protocol section present)
2. Check flag — not present
3. Append `## End of session` block to today's session-log
4. Write handoff (per-project + global, same content)
5. Query GEPA candidates — none found
6. Touch idempotency flag
7. Emit `<agent-daemon-digest>` with 3 learnings from this session

Final response: *"Session closed. Log + handoff written. No GEPA candidates this session. See you tomorrow. \[digest block\]"*

### Example 2: Re-trigger within 5 minutes

User says "bye" → you close cleanly. Then 90 seconds later user says *"chalo bye"*.

You:
1. Read CLAUDE.md
2. Check flag — present, mtime 90s ago → **re-trigger mode**
3. Skip session-log update (already done)
4. **Re-emit digest block** (Claude Code may have missed first one)
5. Skip handoff (already written)
6. Skip GEPA query (already queued)

Final response: *"Already closed 90s ago. Re-emitting digest just in case. \[digest block\]"*
