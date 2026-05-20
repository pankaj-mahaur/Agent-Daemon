# Session logs

Local-only working journal of Claude Code sessions for this project.
Tracks timeline, decisions, token usage, deliverables. **Gitignored** — never committed.

## File naming

One file per session: `YYYY-MM-DD_session-NN.md` (e.g. `2026-05-12_session-01.md`).
Incrementing `NN` within a day. Number resets per day.

## Entry format (example)

```markdown
# 2026-05-12 — Session 03

**Started:** 2026-05-12 14:32 IST
**Goal:** Wire SSE streaming for /api/chat

## Timeline

- 14:32 — Started by reading `src/app/api/chat/route.ts`
- 14:48 — User said "log tokens" → cumulative: 12K input / 4K output (cost $0.18)
- 15:10 — Implemented streaming with `ReadableStream`; lint passes
- 15:24 — Wrote 3 tests, all green

## Decisions

- Chose `ReadableStream` over `eventsource-parser` (one less dep)
- Kept JSON fallback for clients without SSE support

## Files touched

- `src/app/api/chat/route.ts` (modified)
- `src/app/api/chat/route.test.ts` (new)

## End of session

**Closed:** 2026-05-12 15:35 IST
**Outcome:** SSE streaming shipped end-to-end on `feat/chat-page`
**Net deliverables:** 1 feature, 3 tests, 0 reverts
**What works:** SSE flushes incrementally, tests cover happy + error paths
**Pending:** Wire frontend consumer in next session
**Next session must start with:** Read `src/components/chat/ChatWindow.tsx` and switch from JSON fetch to SSE consumer

## Tokens (final)

- Input: 18,420
- Output: 6,210
- Cost: $0.27

<!-- Linked digest block (also emitted by Claude at session close) -->

```
<agent-daemon-digest>
  ...
</agent-daemon-digest>
```
```

## Update triggers (what Claude listens for)

- **"log tokens"** + `/cost` output paste → append a timestamped entry to **Tokens** section
- **"close session" / "end session" / "session khatam"** → fill the **End of session** block + emit agent-daemon digest block (mandatory, in the same response)
- **"new session"** → create the next-numbered file; link previous one at the top

Claude cannot read token counts directly — only records what the user pastes.

## Why local-only

Session logs contain in-progress thinking, half-formed ideas, and raw token numbers — useful for *you* but noisy in shared git history. Durable learnings get distilled into `.agent-daemon/memory/*.md` (which IS committed) via the digest pipeline.
