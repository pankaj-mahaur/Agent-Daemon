---
name: feature-flow
description: "Use when the user wants a feature built end to end — \"build the whole feature\", \"feature start to finish\", \"end to end implement\", \"poora feature banao\", \"plan + build + verify\", \"ship this feature properly\". Chains feature-prep-docs → implement-feature → verify → review-slice as one disciplined workflow with checkpoints between steps."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
  kind: flow
---

# Feature Flow

A composite workflow: each step invokes an installed skill, ends with a
one-line checkpoint, and the next step starts by validating that checkpoint.
Steps are ordinary skill invocations — telemetry and GEPA evolution track each
sub-skill individually, and this flow body itself is GEPA-evolvable.

If a step's skill is not installed, say so and offer `ad skill install <name>`
(or proceed with the step's intent manually, flagged as "unskilled").

## Steps

### Step 1 — Plan
- uses: `feature-prep-docs`
- entry: a feature request with enough scope to size (ask 2-3 questions if not)
- exit checkpoint: write to the conversation — `FLOW feature-flow 1/4 planned: <doc paths>`

### Step 2 — Implement
- uses: `implement-feature`
- entry: Step 1's docs exist and the user approved the plan
- discipline: search existing utilities before writing; one commit per root cause
- exit checkpoint: `FLOW feature-flow 2/4 implemented: <files touched>`

### Step 3 — Verify
- uses: `verify`
- entry: implementation compiles / lints clean
- discipline: run the actual app or tests and OBSERVE behavior — type-check
  passing is not "tested" (constitution rule 1)
- exit checkpoint: `FLOW feature-flow 3/4 verified: <what was observed>`

### Step 4 — Review
- uses: `review-slice`
- entry: verification passed
- discipline: findings grouped by root cause + severity; fix approved findings
- exit checkpoint: `FLOW feature-flow 4/4 reviewed: <findings count, fixes applied>`

## Rules

- Never skip a checkpoint: if a step ended without one, re-state it before
  moving on (drift between steps is the #1 flow failure mode).
- A failed step does NOT advance — fix or surface to the user.
- Mid-flow scope changes restart at Step 1 (re-plan), not Step 2.
- Record one activeContext.md line at flow completion:
  `- YYYY-MM-DD: feature-flow completed for <feature> (<commit range>)`
