---
name: release-flow
description: "Use when the user wants to cut a release — \"cut a release\", \"prepare the release\", \"release banao\", \"ship a version\", \"tag and changelog\". Chains changelog generation → full verification → review of the release diff, ending with an explicit go/no-go summary. Never tags or pushes without the user's OK."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
  kind: flow
---

# Release Flow

Changelog → verify → review → go/no-go. The flow ENDS at a recommendation:
tagging, version-bump commits, and pushes are user-confirmed actions
(constitution rule 6 — never push without explicit OK).

If a step's skill is not installed, say so and offer `ad skill install <name>`
(changelog-generator is optional — fall back to conventional-commit parsing
by hand if absent).

## Steps

### Step 1 — Changelog
- uses: `changelog-generator`
- entry: a release range (last tag → HEAD by default — confirm with the user)
- discipline: conventional-commit parsing; surface anything that looks like an
  undocumented breaking change
- exit checkpoint: `FLOW release-flow 1/3 changelog: <version bump + entry count>`

### Step 2 — Verify
- uses: `verify`
- entry: changelog drafted
- discipline: full test suite + lint + a real run of the app; release
  verification is the strictest bar — no "should be fine"
- exit checkpoint: `FLOW release-flow 2/3 verified: <suites run + results>`

### Step 3 — Review the release diff
- uses: `review-slice`
- entry: verification green
- discipline: review the full tag..HEAD diff for accidental inclusions
  (debug prints, WIP files, secrets) and version-consistency (package.json,
  CHANGELOG, docs)
- exit checkpoint: `FLOW release-flow 3/3 reviewed: <findings>`

## Go / No-Go

End with a one-screen summary: version, changelog highlights, verification
results, review findings, and a clear GO or NO-GO recommendation. Then STOP —
ask the user before tagging, committing the bump, or pushing anything.
