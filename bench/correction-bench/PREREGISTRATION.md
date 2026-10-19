# Pre-registration (DRAFT)

Status: draft. It becomes final once the dev pilot's power check sets n. It is
then tagged before any test-split episode runs, and the test archives are
published with that tag.

## Hypotheses (confirmatory, one-sided)

- **H1**: with ad's memory (`on-hooks`), agents repeat corrected mistakes less often than with no memory (`off`).
- **H4**: with ad's memory, agents repeat corrected mistakes less often than with **both** the host's own memory (`native`) **and** the correction written into the rules file (`static-rules`).

## Primary outcome and test

- **Outcome:** the repeat-mistake rate R in sessions 2…k, before any correction
  in that session (PROTOCOL.md "Outcomes").
- **Units:** pairs across two conditions of the same family, seed and session.
  A pair is kept only when session 1 was corrected under both conditions and the
  session was an opportunity under both.
- **Test:** the exact cluster sign-flip test over families, one-sided. It is
  Monte Carlo with 100,000 draws (seed 20261019) above 20 families.
- **CI:** cluster bootstrap, 10,000 resamples.
- **H4:** an intersection-union test, so its p is the larger of its two p-values.
- **Holm** across m = 2 hypotheses × models × hosts (fixed here before the run;
  an untestable hypothesis counts as p = 1), α = 0.05.

## Sample

- **Test split:** at least 40 families written outside the repository, hashed
  with the fixtures in `tasks/test.sha256`, `phrasings/test.sha256` and
  `repos.sha256`.
- **Phrasings:** 3 or more writers other than the extractor's author, 5 or more
  per family.
- **Models and seeds:** two models (one open-weight), 3 seeds, sessions 2 and 3 scored.
- **Smallest effect worth finding:** TBD, in violation-rate points, stated
  before the pilot is analysed.
- **Final n:** from `analysis/analyze.mjs --power … --min-effect <that effect>`.
  It powers H4 (both comparisons) at 0.05 ÷ m.

## Exclusions

These sessions are excluded from the primary analysis and all reported:
- timeouts and crashes;
- `hooks-missing` (ad's hooks didn't run where they should);
- `condition-broken` (ad's hooks or the host's memory ran where they shouldn't).

## Sensitivities (reported, not confirmatory)

- exact McNemar;
- logistic GEE (exchangeable within family, Mancl–DeRouen robust SE, t with G − 1 df);
- failures counted as violations;
- either arm's opportunity.

Each condition's opportunity rate and capture rate are reported too.

## Reporting

- Any public number names its baseline ("vs no memory", "vs Claude Code's own memory").
- Results below the pre-registered size are labelled exploratory.
- Every run is published with its settings (`run.json`), failures and cost.
- The report states that ad's author built the benchmark.
