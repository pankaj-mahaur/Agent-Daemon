# Constitution — Verification expansions

Themed expansion of cardinal rule 1: **verify before reporting done**.

The most common failure mode in agent-driven development is "it compiles, ship it" — the agent reports success based on type-check or build passing, but the feature itself was never exercised. This file enumerates what verification actually looks like by stack and change type.

---

## Verification levels (from weakest to strongest)

| Level | Evidence | When sufficient |
|---|---|---|
| 0. Code reads correctly | Re-reading the diff makes sense | Never sufficient on its own |
| 1. Static analysis passes | `tsc --noEmit`, `mypy`, `cargo check`, `go vet` | Necessary, not sufficient |
| 2. Linter passes | `eslint`, `ruff`, `clippy`, `golangci-lint` | Necessary, not sufficient |
| 3. Build passes | `npm run build`, `cargo build`, `go build` | Necessary, not sufficient |
| 4. Test passes | `pytest`, `npm test`, `cargo test`, `go test` | Sufficient *if a test covers the change* |
| 5. Manual exercise | Open the UI / call the API / run the CLI and reproduce the user-visible flow | Required for UI / behavior changes |
| 6. End-to-end against real data | Reproduce against a realistic DB state, not a fixture | Required for migrations, perf changes, integrations |

A change requiring level 5 or 6 cannot be reported "done" with only level 1–4 evidence.

---

## Verification by change type

### Bug fix
- Reproduce the bug *first*, before changing code. ("I confirmed the symptom: …")
- Apply the fix.
- Reproduce the same scenario; confirm symptom is gone.
- Run the test suite to catch regressions.
- If no test existed for this bug, add one (or note explicitly that you didn't and why).

### New feature
- Run the dev server / build the binary.
- Exercise the golden path manually (UI: click through; API: curl; CLI: invoke).
- Exercise at least one edge case (empty input, error condition, unauthorized user).
- Run lint + type-check + tests.

### Refactor
- Read the call sites. Confirm the new shape works for every caller.
- Run lint + type-check + tests.
- If tests exist for the refactored code, they should still pass with no changes (otherwise you changed behavior, not just shape).

### Migration / schema change
- Apply on a fresh local DB.
- Apply on a copy of the previous-state DB (idempotency / additive verification).
- Hit affected API endpoints with curl; confirm response shape matches the type definition.
- Re-read [db-migrations skill](../skills/db-migrations/SKILL.md) for the full discipline.

### Performance change
- Measure before. Measure after. Report both numbers.
- "Should be faster" is not verification.

### Security / auth change
- Test the un-authorized path: confirm it's still blocked.
- Test the newly-authorized path: confirm it works.
- Don't widen access to make a bug go away (core rule 7).

---

## "I couldn't verify" is an acceptable answer

The honest answer to *"can you confirm X works?"* is sometimes *"no, here's what I'd need to verify it"*. Examples of legitimate "couldn't verify":

- Production-only feature flags you don't have access to
- External APIs you can't test against from this environment
- Behavior that depends on real user data not in the dev DB
- UI changes when running in a sandbox without a browser

In these cases, write the verification steps explicitly so the user can run them:

> I couldn't open the dashboard in a browser from here. To verify:
> 1. `npm run dev`
> 2. Sign in as a manager
> 3. Open `/admin/timesheets`
> 4. Filter by "this month" — confirm the row count matches what you'd expect

This is *not* failure. It's the difference between an agent that's honest about its tools and one that bluffs.

---

## What the user sees vs what the build sees

The agent sees: build output, test results, type-check status.
The user sees: a button that does or doesn't work.

The verification bar is what the user sees. A green build with a broken UI is not "done".

---

## Recurring verification gotchas

- **Cached values invalidate at the wrong moment.** A change that looks fixed in dev sometimes only works because dev disabled caching. Test with the real cache stack.
- **Hot-module-reload masks state issues.** A page that re-renders correctly via HMR may break on full reload. Force a hard refresh during verification.
- **Background workers hold old code.** Schedulers, queue processors, websocket servers — restart them all, not just the web server.
- **Build artifacts are stale.** When in doubt, `rm -rf node_modules/.cache dist/ build/ .next/` and rebuild.
- **The user's environment differs.** They might be on Windows; you might be on Linux. Path separators, line endings, and case sensitivity bite. Test on the user's actual platform if at all possible.
