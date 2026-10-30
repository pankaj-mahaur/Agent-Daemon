# Protocol

## Question

After an agent is corrected once ("we log with logInfo, not console.log"), does it
make the same mistake in a later session? And does ad's memory make that less
likely than what the user already has for free: the host's own memory, or
writing the correction into the project's rules file?

## Families

A family is one invented project convention (a logger, a date helper, a test
layout, an error envelope, a generated folder, id and money helpers, …) with:

- a one-sentence `convention`;
- a deterministic `oracle` (no model judges the primary outcome):
  - `grep`: a forbidden pattern in a line the session **added** to a matching file;
  - `file`: where files may appear, and which may not change;
  - `command`: a node script in the family folder reading the session's changes;
- three session tasks that naturally tempt the mistake;
- a violating and a compliant example, which the tests run the oracle against.

**Opportunity.** A session that never touched what the convention governs (wrote
no log line, added no test) had no chance to break it. Only opportunities count.

The dev split (`tasks/dev/`, 12 families) is for building and tuning. The test
split (at least 40 families) is written outside this repository.

## Corrections

The correction a session receives is one phrasing from the family's file, picked
by the seed, the same for every condition and model.

- Test-split phrasings come from at least 3 people other than the author of ad's
  extraction rules, at least 5 per family, frozen before the dev pilot. Files
  carry opaque writer labels (`w1`, `w2`…), never names.
- The dev phrasings are written by that author and labelled `author`.
- **Capture rate** (did ad store the correction?) is reported separately from
  the repeat rate. It is not assumed: building the smoke test showed the hook's
  rules miss many natural phrasings, and cut a stored lesson at the first "." of
  an identifier ("use log.info…" becomes "we always use log"). Those are dev
  findings; the test phrasings must not be used to tune them.

## Keeping the test split private

Until the pre-registration tag, the test families and phrasings live outside the
repository (the owner's machine and an encrypted backup). Only their hashes are
committed:

```bash
node bench/correction-bench/lib/archive.mjs write  <test tasks dir>     bench/correction-bench/tasks/test.sha256
node bench/correction-bench/lib/archive.mjs write  <test phrasings dir> bench/correction-bench/phrasings/test.sha256
node bench/correction-bench/lib/archive.mjs write  bench/correction-bench/repos  bench/correction-bench/repos.sha256
node bench/correction-bench/lib/archive.mjs verify <dir> <file.sha256>   # before every test run; exit 1 if it changed
```

The hash covers every file's path and bytes. A hash is written once; changing it
needs a deliberate delete and a note in the revision log below.

- `tasks/test/` and `phrasings/test/` are git-ignored here, so a copy placed in
  the repository by mistake is never committed.
- `run.mjs --split test` refuses to start unless the archives (and the shared
  fixtures in `repos/`) match the committed hashes.

## Episodes

One episode = family × condition × model × seed, in a fresh temp home:

1. **Session 1** (teaching): task 1 → oracle → the correction as a follow-up turn
   in the same session if violated → the session ends (so end-of-session capture runs).
2. **Sessions 2…k** (scored): a fresh copy of the fixture **at the same path** (memory is
   keyed by the project's path) and a new session → task i → oracle **before any
   correction**: the primary outcome → corrected if violated → end.

Each episode runs in its own process with HOME, USERPROFILE and AD_ROOT (and
CLAUDE_CONFIG_DIR) inside its temp root. Variables naming the user's own engine
or Claude folders, and every `GIT_*` variable, are removed. Episodes run in a
seeded, interleaved order.

A killed or timed-out episode gets `timeout` or `crash` records for the sessions
it never reported. The default episode limit allows two full turns per session,
plus start-up and capture time.

Later sessions are corrected when they violate, so what session 3 starts from
depends on session 2. That is part of the design: it is what a user does.

## Conditions

| Condition | ad | Host memory | Rules file |
|---|---|---|---|
| `off` | none | off | — |
| `native` | none | on | — |
| `static-rules` | none | off | every correction appended verbatim (AGENTS.md / CLAUDE.md) |
| `on-hooks` | hooks + memory tools | off | — |
| `on-tools` | memory tools only | off | — |

Host settings, printed into every `run.json`:

- **ad's engine** (`driver-ad.mjs`): engine memories are the `[memories]` keys
  `generate_memories` and `use_memories` (found in the engine binary). They are
  read back from the engine before every episode, and a mismatch stops it.
  - ad's harness setup (hooks, memory server) runs only in `on-*`.
  - **The same instructions everywhere.** The engine's AGENTS.md holds ad's own
    instruction block in every condition: its identity, skills note and coding
    rules. Only its Memory section changes: it is removed where ad's memory is off.
    Otherwise `on-*` would differ from `off` by coding guidance as well as memory.
    The block's hash is in every episode's session-1 record.
  - The Windows sandbox is set up the same way in every condition.
  - File changes are accepted; commands and extra permissions are declined.
- **Claude Code** (`driver-claude.mjs`): `claude -p --output-format json
  --permission-mode acceptEdits --strict-mcp-config`, plus `--resume` for the
  follow-up turn.
  - ad's hooks come from ad's developer profile.
  - The auto-memory setting name `autoMemoryEnabled` is **unverified** (open check 1).

**Each condition is checked.**

- An `on-hooks` session counts only if ad's prompt hook ran (its heartbeat);
  otherwise it is `hooks-missing`. The prompt hook's journal is what the next
  session start turns into memory.
- End-of-session capture (a new session row from the digest) is recorded and
  reported as a rate, not required. The engine gives that hook 3 seconds, and
  building the smoke test showed a cold Windows start sometimes misses them.
- A session in any other condition where ad's prompt hook ran is `condition-broken`.
- So is a session with the host's own memory off in which Claude Code wrote some
  anyway (its `projects/*/memory` folder). For Claude Code this is how the
  unverified setting name gets caught.

Both statuses are excluded and reported.

## Outcomes

- **Primary:** repeat-mistake rate R = violations ÷ opportunities in sessions 2…k.
- **Secondary:**
  - capture rate;
  - task pass rate;
  - injected tokens per session;
  - injected-item precision (LLM judge with a published prompt, 10% human audit);
  - stale-memory harm;
  - time to first useful recall in a new host.

  The harness reports capture today; the others are planned with the test run.

## Statistics (`lib/stats.mjs`, `lib/analysis.mjs`)

- **Pairs.** A comparison pairs the same (family, seed, session) across two
  conditions. It keeps a unit only if:
  - session 1 of that family and seed was **corrected under both** conditions,
    so both had the same lesson to remember (a session 1 that didn't violate
    taught nothing); and
  - the session was an opportunity under both.

  Duplicate records stop the analysis.
- **Primary test:** the cluster sign-flip randomization test. Under "no
  difference", each family's summed paired difference is equally likely to
  take either sign.
  - It is exact up to 20 families, and Monte Carlo above that (100,000 draws,
    fixed seed).
  - It is one-sided, in the direction of the hypothesis.
  - It is exact at any number of families. A cluster bootstrap's p is
    anti-conservative with few families: the review measured 8% false positives
    at a nominal 2.5% with 5 families.
  - The 95% CI comes from the cluster bootstrap (10,000 resamples).
- **When there is a p-value:**
  - fewer than 5 families: no test;
  - fewer than the pre-registered 40: the result is printed as **exploratory**.
- **Sensitivities** (reported, never confirmatory):
  - exact McNemar on discordant pairs;
  - logistic GEE, exchangeable within family, robust SE with the Mancl–DeRouen
    small-sample correction, t with G − 1 degrees of freedom;
  - timeouts and crashes counted as violations;
  - pairs where either arm had an opportunity, with no opportunity counted as compliant.

  Each condition's opportunity rate is reported too, since what the agent chose
  to touch decides what is scored.
- **Hypotheses**, per host and model:
  - **H1:** `on-hooks` < `off`.
  - **H4:** `on-hooks` < `native` **and** `on-hooks` < `static-rules`. This is an
    intersection-union test: its p is the larger one-sided p.
    - H4 is tested only when the records show the host's own memory working in
      `native`: in at least half its scored sessions. Beating a host memory that
      never ran would be beating `off` twice.
    - Claude Code's driver checks its memory folder. That shows memory was
      written, not that it was used: enough for the gate, not proof of use.
    - ad's engine driver can't see the engine's memories yet (open check 2), so
      for that host H4 stays untested until it can.
- A session 1 that was corrected counts as taught even if it was later
  excluded (`hooks-missing`, `condition-broken`). That is intent-to-treat, and it
  works against ad.
- **Holm** across the pre-registered number of tests (`--holm-m`; default 2 per
  host and model). A hypothesis that can't be tested counts as p = 1, so the
  correction never shrinks because something was missing.
- **Exclusions:** timeouts, crashes, `hooks-missing` and `condition-broken`
  sessions are left out of the primary analysis and reported.
- **Size:** at least 40 test families × 2 later sessions × 3 seeds per model.
  The final n comes from `analyze.mjs --power <sizes> --min-effect <points>`:
  - the smallest effect worth finding is stated before looking;
  - the pilot's families are resampled, with the treated arm moved to exactly
    that effect;
  - H1 and H4 (both comparisons) are each powered at 0.05 ÷ the number of
    tests, Holm's worst case.

Known limit of the oracles: renaming a helper (`src/lib/api.js` to `http.js`)
moves its own calls out of the exempt file, and they count as violations.

## Honesty rules

- Tuning happens on the dev split only. Test archives are hashed and private until the tag.
- Conditions are interleaved. The same model, temperature, limits and permissions are used everywhere.
- Two models, one open-weight. Every run is published, failures included, with its cost.
- `--mock` results prove plumbing and are refused by the analysis unless `--allow-mock` is given.
- The report states that ad's author built the benchmark, and invites reruns.
- Results contain no transcripts, and error text is scrubbed of machine paths.

## Open checks (before the pilot)

1. Claude Code's auto-memory setting name and its headless flags, against its documentation.
2. The engine memories in `native` actually generate and use memories across sessions with a real model (the smoke only proves the keys are accepted).
3. 50 labelled real correction pairs from the owner's store, to check the repeat-detection thresholds (local only).

## Revision log

- 2026-10-19: first version (P5.5b): 12 dev families, drivers, analysis, smoke.
- 2026-10-19, after review:
  - the primary test changed from a cluster bootstrap p to an exact cluster sign-flip test, one-sided;
  - results are exploratory below 40 families;
  - only pairs taught in session 1 under both arms are kept;
  - every condition gets the same instructions;
  - each condition's settings are checked;
  - `GIT_*` variables are stripped;
  - comments are ignored by the oracles, and they cover `.mjs`, `.cjs` and `.ts`;
  - Holm uses the pre-registered m;
  - power is checked at a stated smallest effect.
