---
name: agent-self-improve
description: Meta-skill — the discipline an agent follows so that each session produces clean, distill-able signal for the agent-daemon digest pipeline. Use whenever the user mentions "memory", "improve over time", "learn from this session", or when ending a session that did meaningful work and you want to leave behind durable lessons. Encodes how to leave breadcrumbs, when to surface uncertainty, and what to write into activeContext / progress before the session closes.
license: MIT
allowed-tools: mcp__qmd__*, Bash
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Be a session that the next session learns from

`agent-daemon` runs a digest pipeline at session end that extracts learnings from the transcript and persists them. The pipeline is good — but it's only as good as the signal you leave behind. An agent that mumbles, hedges, and never names its decisions leaves nothing to extract.

This is the discipline. It's small but compounding: every session that follows this leaves the next session smarter.

---

## The four signals the digest pipeline looks for

The extractor scans the transcript for these patterns specifically. If your session contains them clearly, they get distilled. If not, the session is silent.

### 1. Corrections from the user

When the user says *"no, do X instead"*, *"don't use Y"*, *"actually we use Z here"* — that's gold. The pipeline tags it as a feedback memory.

**To leave a clean signal:**
- When you take a correction, state in one line what changed: *"Got it — switching to Z. (Earlier I assumed Y because of …)"* The "earlier I assumed" line tells the extractor what the false belief was.
- Don't argue. Take the correction. Argument-trees confuse the extractor.

### 2. Confirmed-good decisions

When the user accepts an unusual choice without pushback, or explicitly confirms ("yes, that's right", "perfect"), that's also gold — it teaches the agent which judgment calls land well.

**To leave a clean signal:**
- When you make a non-obvious choice, name it. *"I'm bundling these into one commit because they all came from the same root cause."* If the user accepts silently, the extractor catches the pattern.

### 3. Recurring patterns / gotchas

When you hit the same trap twice in a session (or recall hitting it in a previous session), call it out. *"This is the third time we've hit a stale-cache issue on this list — worth a `cache.delete_pattern` call in the mutation handler."*

**To leave a clean signal:**
- Use the phrase *"recurring pattern"* or *"gotcha"* explicitly. The extractor's prompt is tuned to those words.
- Reference the file:line where the pattern lives.

### 4. New tools / commands that worked

When you discover a useful command or tool the user didn't already know — flag it as new.

**To leave a clean signal:**
- *"`ripgrep --multiline` solves this — adding to the toolkit."*
- Quotes around the command help the extractor regex-match it.

---

## What to emit before the session ends — the digest block

If the session did real work (≥1 file edit, OR ≥5 tool calls, OR ≥5 minutes, OR explicit "done/thanks/perfect" from the user), append a structured JSON block to your final response. The full schema and rules are in [constitution/ending-protocol.md](../../constitution/ending-protocol.md) — that file is loaded into your context every session, treat it as authoritative.

**Quick format reference:**

```
<agent-daemon-digest>
{
  "learnings": [
    {
      "type": "correction" | "confirmation" | "pattern" | "tool",
      "text": "...",
      "evidence_quote": "...",
      "evidence_speaker": "user" | "agent",
      "scope": "project" | "global",
      "confidence": 0.0,
      "tags": ["..."]
    }
  ],
  "session_summary": "..."
}
</agent-daemon-digest>
```

The `<agent-daemon-digest>` tags render as nothing in markdown — invisible to the user, parsed by the daemon's `SessionEnd` hook.

**Why this matters:** the daemon's digest pipeline reads this block from the transcript. No separate LLM call, no separate API key — the extraction work happens inside YOUR session, paid for by the user's existing subscription. If you don't emit the block, that session leaves no durable memory.

You may skip the block for trivial sessions; the daemon's triage gate would also skip them. But emitting an empty block (`"learnings": []`) is preferred — it confirms you saw the protocol.

---

## What NOT to do

- **Don't write a "session log" mid-stream.** The transcript IS the log. Padding it with "now I'm doing X, now I'm doing Y" is noise to both the user and the extractor.
- **Don't claim certainty you don't have.** The extractor amplifies whatever confidence you express. A confident wrong claim becomes a confident wrong memory.
- **Don't reference memory as if you remember it.** Memory loaded at session start is loaded *via the hook*, not via your weights. Cite it: *"Per the project's `activeContext.md`, X is the active branch."* Don't say *"I remember X is the active branch."*
- **Don't try to write directly to memory files mid-session.** The pipeline writes them. If you edit `activeContext.md` mid-stream, you'll fight the pipeline.
- **Don't generate fake "lessons learned" to make the close summary look thorough.** A session where nothing was learned should say so. The pipeline will skip.

---

## The relationship to the constitution

The constitution sets the floor. This skill sets the loop:

- Constitution: "Verify before reporting done" → forces honest report.
- This skill: end with a structured close → makes that honest report machine-readable.

A session that follows the constitution but skips the close is fine — the pipeline will still extract corrections and confirmations from the transcript. A session that follows both is faster to extract from and produces higher-quality memory entries.

---

## Detecting "session done"

The pipeline triggers automatically (via Claude Code's `SessionEnd` hook or the cross-agent fswatch daemon). You don't need to do anything to fire it.

You DO need to make sure the session actually ends cleanly:

- Don't leave the session by force-quitting the terminal — that fires `SessionEnd` with `reason: other` which the pipeline still handles, but slow.
- Use `/exit` (Claude Code) or the agent's normal end command.
- Wait for the *"agent-daemon: digested session …"* line to appear before closing the terminal. It takes ~5–30 seconds.

If you see *"agent-daemon: skipped (below triage threshold)"* — that means the session was too small to digest. That's intentional, not a bug.

---

## Promoting a pattern to a skill

If the same correction or pattern shows up across 3+ unrelated sessions, the digest pipeline auto-proposes a new SKILL.md or an edit to an existing one. The proposal lands in `proposed/<date>-<topic>.diff`.

When you next open `agent-daemon review`, the diff is shown. You decide:
- **Accept** → diff applies, new skill enters the rotation.
- **Reject** → diff is discarded, pattern is unmarked (no further auto-proposals on that exact phrasing for 30 days).
- **Edit** → opens the diff in `$EDITOR` for tweaks before applying.

The agent doesn't accept its own proposals. Skill edits are always human-gated (constitution rule 8: confirm before destructive ops, broadly applied).

---

## See also

- [constitution/ending-protocol.md](../../constitution/ending-protocol.md) — the authoritative format spec for the digest block
- [constitution/core.md](../../constitution/core.md) — the cardinal rules every session loads
- [memory-templates/](../../memory-templates/) — the 6-file scaffold the pipeline writes into
- [audit-runner](../audit-runner/SKILL.md) — when the user wants to systematically improve a backlog of findings
- [implement-feature](../implement-feature/SKILL.md) — Phase 0's "search before you write" loop is what feeds the recurring-pattern detector
