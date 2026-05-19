---
name: audit-every-attempt
description: Write a one-line audit record on EVERY code path through your pipeline — success, failure, skip, no-op. Future-you needs to distinguish "the code didn't run at all" from "the code ran and decided to do nothing." Use when designing any digest pipeline, telemetry layer, batch job, scheduled task, hook handler, or anything that runs without a human watching. Generic engineering principle. Cheap to add, brutal to debug without.
---

# Audit every attempt, not just every success

## The problem

You ship a daemon. It runs in the background. A week later the user asks "is it actually doing anything?"

You check the audit log. It's empty. Three possibilities:

1. The daemon never ran. (Hook didn't fire? Config wrong? Permission issue?)
2. The daemon ran but found nothing to process. (Working as intended — but silent.)
3. The daemon ran, hit an error, and crashed silently. (Worst case.)

**You cannot distinguish these from an empty log.** That's a debugging nightmare and it's entirely preventable.

## The fix

Append to your audit ledger on **every exit path**, not just the success path:

```js
async function runPipeline(input) {
  if (!input.shouldProcess) {
    await audit.append({ ts, status: "skipped", reason: "triage threshold" });
    return 0;
  }

  const extracted = await extract(input);
  if (extracted.error) {
    await audit.append({ ts, status: "error", reason: extracted.error });
    return 1;
  }

  if (extracted.items.length === 0) {
    await audit.append({ ts, status: "ran-empty", reason: "no matches in input" });
    return 0;
  }

  const applied = await apply(extracted.items);
  await audit.append({ ts, status: "success", items: applied.count });
  return 0;
}
```

Now the log distinguishes:

| Line type | What it means |
|---|---|
| `status: "skipped"` | Code ran, decided not to process |
| `status: "ran-empty"` | Code ran, processed input, found nothing applicable |
| `status: "error"` | Code ran, blew up — see `reason` |
| `status: "success"` | Code ran, did the work |
| **(no line)** | Code never ran — start checking hooks/permissions/cron |

## Schema: be richer than `{ts, status}`

Include enough context that one line can be read without cross-referencing:

```jsonl
{"ts":"2026-05-14T05:42:47Z","status":"ran-empty","source":"hook","reason":"no agent block in transcript","input_size_bytes":4963206,"input_path":"~/.claude/projects/..."}
```

Fields worth including:

- `ts` — ISO timestamp
- `status` — enum: skipped / ran-empty / error / success / forced
- `reason` — human-readable string
- `source` — what triggered this run (hook / cli / cron / api)
- `input_*` — size, path, count — enough to reproduce
- `output_*` — what was produced
- `duration_ms` — for spotting slowdowns
- `version` — your tool's version (mismatched outputs across releases need this)

## Where to write

| Volume | Surface |
|---|---|
| < 10 entries / day | Plain JSONL file, rotate at 5 MB |
| 10–1000 / day | JSONL + a `tail -n 20` viewer in your CLI (`<tool> status`) |
| > 1000 / day | SQLite or DuckDB; index on `ts` and `status` |
| > 100K / day | A real log aggregator |

For the JSONL case, write one line per attempt, never multiple lines per attempt (that requires a join to reason about). One entry = one decision.

## When to audit vs when to log

- **Audit** = durable, structured, queryable, kept indefinitely (or until rotation).
- **Log** = ephemeral, free-form, kept only for debugging the current incident.

Audit is for **future you** asking "did this run, and what did it do?" Log is for **present you** debugging an incident.

Don't conflate them. Your audit pipeline goes through a single `appendAudit()` function with a fixed schema. Your logs go to stderr / a logger.

## What to check in code review

When reviewing a pipeline / handler:

- [ ] Every `return` is preceded by an `audit.append()` call (or has been considered)
- [ ] Error paths log too — `catch (err) { audit.append({status:"error", reason: err.message}); throw; }`
- [ ] No "early return" code path skips audit
- [ ] The audit schema is documented and stable across versions
- [ ] There's a `<tool> status` CLI that reads the audit log (tail + parse)

## Anti-patterns

- ❌ Auditing only on success — "ran, did nothing" looks like "didn't run"
- ❌ Auditing inconsistently across paths — `skipped` writes a line but `forced` doesn't
- ❌ Free-form audit messages (`"failed because something"`) — make `status` an enum
- ❌ One audit line per turn of an inner loop — costs more than the work; aggregate
- ❌ Audit log on a different surface than the rest of the project (different filesystem, S3 bucket) — keep it co-located so users find it via `ls`

## Anecdote

The agent-daemon project shipped v0.2 with audit-on-success only. After 2 days of user reports ("daemon isn't doing anything"), forensics showed: every session had been triaged-out, but no audit line was written for the triage-skip path. The user couldn't tell the daemon from a broken install. The v0.3 fix was 27 lines to add the no-block / triage-skip / extract-error audit cases. That's an order of magnitude less work than the time spent debugging.

## Related patterns

- **harness-enforced capture** — make the recording mechanism not depend on the agent's behavior
- **observability before features** — instrument first, build second
