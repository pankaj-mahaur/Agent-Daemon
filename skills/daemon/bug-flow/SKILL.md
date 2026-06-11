---
name: bug-flow
description: "Use when the user wants a bug fixed properly end to end — \"fix this bug properly\", \"debug and fix and verify\", \"root cause and fix\", \"bug ko poora theek karo\", \"fix it and prove it works\". Chains debug-triage → fix → verify as one workflow: triage first, fix the root cause, prove the fix by observation."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
  kind: flow
---

# Bug Flow

Triage → fix → prove. The most common failure this flow prevents: patching a
symptom before the root cause is identified, then claiming "fixed" without
observing the repro pass.

If a step's skill is not installed, say so and offer `ad skill install <name>`.

## Steps

### Step 1 — Triage
- uses: `debug-triage`
- entry: a bug report or unexpected behavior (get the exact symptom + repro first)
- discipline: strict triage order — services → data → cache → request → code;
  no code edits in this step
- exit checkpoint: `FLOW bug-flow 1/3 root-cause: <one-line root cause + evidence>`

### Step 2 — Fix
- uses: `implement-feature`
- entry: a confirmed root cause (not a hypothesis — re-triage if unconfirmed)
- discipline: fix the root cause, not the symptom; never widen security to
  make a bug "go away" (constitution rule 7); one commit per root cause
- exit checkpoint: `FLOW bug-flow 2/3 fixed: <files + what changed>`

### Step 3 — Prove
- uses: `verify`
- entry: the fix is in place
- discipline: re-run the ORIGINAL repro and observe it pass; run the
  surrounding test suite; add a regression test when one is missing
- exit checkpoint: `FLOW bug-flow 3/3 proven: <repro result + tests run>`

## Rules

- Step 1 produces a root cause, never a fix. If the "root cause" turns out
  wrong in Step 3, return to Step 1 — don't iterate blind patches.
- A bug that can't be reproduced gets reported as such — not "fixed".
- Record one activeContext.md line at completion:
  `- YYYY-MM-DD: bug-flow: <root cause> fixed in <files>`
