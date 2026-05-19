---
name: regex-clause-anchored-extractors
description: Anchor regex extractors to clause boundaries when mining natural-language text for phrases. Use when building any tool that extracts learnings, decisions, conventions, or rules from human-written prose (transcripts, commit messages, chat logs, docs). Unanchored patterns like `/we (always|never) (.+)/` fire on mid-sentence fragments and produce 70%+ noise. Generic pattern — applies to log mining, conversation analysis, knowledge extraction, RAG pre-processing.
---

# Regex extractors must anchor to clause boundaries

## The problem

You want to extract durable lessons from chat transcripts. Patterns like:

```js
/we (always|never) (.+)/i  // mid-sentence "we never" matches in any flow
/(remember|note|important):\s*(.+)/i
/the bug was (.+)/i
```

Seem fine on synthetic test data. On real prose they catch **fragments mid-sentence**:

| Text in transcript | What the regex captures | Useful? |
|---|---|---|
| "...conversation list updates (after send, edit, delete, etc.), never on typing." | `on typing` | ❌ |
| "Components should never have their refs change as a side effect..." | `have their refs change as a side effect` | ⚠️ partial |
| "TIL: chokidar polling is required on Windows" | `chokidar polling is required on Windows` | ✅ |

After one 7-hour real session, **6 of 10 captures from the `we always|never` rule were mid-sentence garbage** — the user saw `"on typing"`, `"appears"`, `"for sidebar history"` in their memory file. Real-world noise rate: ~75%.

## The fix

**Anchor every natural-language pattern to a clause start.**

```js
// ❌ Before — fires mid-sentence
/\b(we always|always|never|we never)\s+([^.\n!?]{6,250})/i

// ✅ After — fires only at clause start
/(?:^|[.!?]\s+|\n)(?:we (?:always|never))\s+(\w+(?:\s+\w+){1,30}?)(?=[.!?]|$)/i
```

What changed:

1. **`(?:^|[.!?]\s+|\n)`** — match only at start-of-string, after `.!?` + space, or after newline. The clause must actually begin here.
2. **`we (?:always|never)`** — drop the bare `always|never`. Require the "we" prefix to filter narrative use. ("They never met" no longer matches.)
3. **`(\w+(?:\s+\w+){1,30}?)`** — capture at least one word, lazy up to 30 — bounds the noise.
4. **`(?=[.!?]|$)`** — lookahead to clause-end. Don't grab past the next `.` or `?`.

## General principle

For every pattern, ask three questions:

| Question | Why |
|---|---|
| Can this fire **inside another sentence**? | If yes, anchor to `(?:^|[.!?]\s+|\n)` |
| Does the leading word **need a subject** to be meaningful? | "remember" alone is too broad; "remember:" / "we remember" is specific |
| Is there an **upper bound** on the capture? | Without `{1,30}` or `(?=[.!?])` you grab paragraph-long fragments |

## Confidence calibration

Even with anchoring, some rules are noisier than others. Score each rule's real-world precision after 1 week of live use, then:

| Real precision | Action |
|---|---|
| ≥ 0.8 | Auto-apply (write to memory) |
| 0.5–0.8 | Queue for review (proposals folder) |
| < 0.5 | Episodic-only (audit log, don't surface) |
| < 0.3 | Delete the rule |

Don't ship the rule with confidence `0.7` because it looked promising — ship at `0.4` and let the auto-routing protect the memory file. Promote after real-world precision data confirms it.

## Test fixtures from real failures

When a rule produces noise in production, **save the offending input as a test fixture before tightening the rule**:

```js
test("does not match 'never' mid-sentence", () => {
  const text = "conversation list updates (after send, edit, delete, etc.), never on typing.";
  const out = extractWithRule(text, "always-never-rule");
  assert.equal(out.length, 0);
});
```

That fixture protects against regression when someone "improves" the regex six months later.

## Anti-patterns

- ❌ Bare keyword anchors (`\b(always|never)\s+`) — fire mid-sentence
- ❌ Unbounded capture groups (`.+`, `[^\n]+`) — grab too much
- ❌ Inline regex tweaks without test fixtures — drift creeps back
- ❌ Trusting synthetic test data — real prose breaks every "obvious" pattern
- ❌ Same confidence score for high-anchor and low-anchor rules — calibrate per-rule based on real precision

## Related patterns

- **audit-every-attempt** — keep a sample of recent matches so you can audit precision
- **llm-output-lenient-parsing** — same family of problem but for structured rather than unstructured input
