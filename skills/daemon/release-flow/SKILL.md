---
name: release-flow
description: "Use when the user wants to cut a release — \"cut a release\", \"prepare the release\", \"release banao\", \"ship a version\", \"tag and changelog\". Chains changelog generation → full verification → review of the release diff, ending with an explicit go/no-go summary. Never tags or pushes without the user's OK."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.3"
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
3. Only on the owner's explicit OK, dispatch again with `dry_run` off and approve the `release-memory` environment. The npm package publishes first; then the marketplace and Gemini trees are pushed and the GitHub release is made (`memory-vX.Y.Z`, never marked Latest, so ad's own `vX.Y.Z` keeps the badge).
   - The `dry_run` box in the web form starts checked and is easy to miss: a publish job that took 0 s was skipped. `gh workflow run release-memory.yml -f dry_run=false` leaves no doubt. Start one run only; a second fails on npm with E409.
   - npm publishes through the package's trusted publisher (OIDC; no token secret). A 404 or "need auth" on publish means the trusted publisher on npmjs.com doesn't match the repository, workflow file name or environment. Check that the version is on npm afterwards.
   - npm may stage the upload: the registry then shows a `0.0.0-stage` placeholder until the owner approves the version on npmjs.com. It is live once `latest` points at it.
4. After npm publishing, and only with the owner's OK, publish to the MCP Registry:
   - run `mcp-publisher login github`, then `mcp-publisher publish` with the artifact's `server.json`;
   - the Registry is in preview and may reset, so re-running is safe;
   - only from a release whose branch is merged: `websiteUrl` points at `docs/memory/README.md` on main.

   Gallery submissions (Claude Code directory, Cursor marketplace) are the owner's, after the privacy and terms pages exist.
5. Never publish from a laptop. The package version must equal the runtime's: the build refuses otherwise.

### Release checks, every release (agent-daemon only)
- `node --test runtime/test/launch-checks.test.mjs runtime/test/support-matrix.test.mjs`: privacy and security pages, MIT everywhere, no analytics, no network in the memory package, and no matrix row that overstates its evidence.
- `node runtime/scripts/check-claims.mjs <files>` on public copy the release changed (README, listings): it flags superlatives, numbers without a linked baseline, and hosts not tested live in `docs/support-matrix.md`.
- After an engine upgrade: `AD_REAL_ENGINE=1 node --test runtime/test/engine-network.test.mjs`. A new host it reaches means a new engine setting to turn off in `ENGINE_PRIVACY` (`runtime/src/harness/setup.mjs`), or a line on `docs/privacy.md`.
- When the release changes what ad stores (accounts, memory schema, engine folders): `AD_ROLLBACK_30=1 node --test runtime/test/rollback-30.test.mjs` proves ad 3.0 still starts, shows its sign-in and finds its key on the new state (needs the `v3.0.0` tag and network); users must be able to go back.
- **Read CI per job, not the run's colour.** The real-engine job can't fail the run, and the state export/import job pairs every OS with every other. Stacked branches have been merged with red POSIX jobs: read each job of each PR before calling it green.

## Go / No-Go

End with a one-screen summary: version, changelog highlights, verification
results, review findings, and a clear GO or NO-GO recommendation. Then STOP —
ask the user before tagging, committing the bump, or pushing anything.
