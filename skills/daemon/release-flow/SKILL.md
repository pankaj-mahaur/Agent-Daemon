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

### The memory package and host plugins (agent-daemon only)
Released separately, by `.github/workflows/release-memory.yml`, which runs only when the owner dispatches it:
0. Before a version bump lands, regenerate what carries the version or the tool list, and commit them with the bump:
   - `node runtime/scripts/memory-deeplinks.mjs --write` (the pinned quick-try links);
   - `node runtime/scripts/render-tools-doc.mjs --write` (`docs/memory/tools.md`).

   `runtime/test/listings.test.mjs` fails if either is stale. Listing copy comes from `docs/support-matrix.md`: move a host to "tested live" only with an acceptance record.
1. Dispatch it with `dry_run` on (the default). Read the job, download the artifacts (`server.json` and the rendered listing copy included) and check `SHA256SUMS`.
2. Install from the built trees on each host and record the result (host acceptance).
3. Only on the owner's explicit OK, dispatch again with `dry_run` off and approve the `release-memory` environment. The npm package publishes first; then the marketplace and Gemini trees are pushed and the GitHub release is made.
4. After npm publishing, and only with the owner's OK, publish to the MCP Registry:
   - run `mcp-publisher login github`, then `mcp-publisher publish` with the artifact's `server.json`;
   - the Registry is in preview and may reset, so re-running is safe;
   - only from a release whose branch is merged: `websiteUrl` points at `docs/memory/README.md` on main.

   Gallery submissions (Claude Code directory, Cursor marketplace) are the owner's, after the privacy and terms pages exist.
5. Never publish from a laptop. The package version must equal the runtime's: the build refuses otherwise.

## Go / No-Go

End with a one-screen summary: version, changelog highlights, verification
results, review findings, and a clear GO or NO-GO recommendation. Then STOP —
ask the user before tagging, committing the bump, or pushing anything.
