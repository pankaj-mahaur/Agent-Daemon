# correction-bench

Does a coding agent repeat a mistake it was already corrected for? This benchmark
measures it, with and without ad's memory, against the host's own memory and
against simply writing the correction into the project's rules file.

- What it measures and why each choice was made: [PROTOCOL.md](PROTOCOL.md).
- The confirmatory hypotheses, fixed before the test run: [PREREGISTRATION.md](PREREGISTRATION.md) (draft).
- MIT, like the rest of the repository. Every number is recomputable from the published results.

## Layout

| Path | What |
|---|---|
| `tasks/dev/<family>/family.json` | a convention, its oracle, three session tasks, a violating and a compliant example |
| `phrasings/dev/<family>.json` | corrections, each with an opaque writer label (`author`, `w1`…) |
| `repos/shop-app/` | the fixture project every dev family starts from |
| `lib/` | fixture copies and diffs, oracles, plan, statistics, archive hashes |
| `runner/run.mjs` | runs the episodes, each in its own process and temp home |
| `runner/driver-ad.mjs`, `runner/driver-claude.mjs` | ad's engine; Claude Code headless |
| `runner/mock-model.mjs` | a scripted model for the CI smoke (plumbing only, never a result) |
| `analysis/analyze.mjs` | the report: rates, H1, H4, CIs, sensitivities, power |
| `test/` | oracle, statistics, runner and real-engine smoke tests |

The test split is not here: only its hashes will be (`tasks/test.sha256`,
`phrasings/test.sha256`), written once before the dev pilot. See PROTOCOL.md.

## Run

```bash
# The plumbing, with the scripted model (needs the pinned engine: cd runtime && npm install)
node bench/correction-bench/runner/run.mjs --mock --families logger --conditions off,on-hooks --sessions 2

# A real run on ad's engine: provider.toml holds the engine's model provider settings
node bench/correction-bench/runner/run.mjs --driver ad --engine-config provider.toml --models <model> --seeds 1,2,3 --out bench/correction-bench/results/dev-<date>

# Claude Code (headless; on Windows pass node and Claude Code's script as --host-command)
node bench/correction-bench/runner/run.mjs --driver claude --models <model> --out …

node bench/correction-bench/analysis/analyze.mjs bench/correction-bench/results/dev-<date> --power 20,40,60 --min-effect 0.10
```

Each episode runs with its own HOME, ad store and engine or Claude settings
folder inside a temp directory; a run never reads or changes your own.

## Tests

```bash
cd runtime && node --test test/correction-bench.test.mjs            # oracles, statistics, runner
AD_REAL_ENGINE=1 node --test ../bench/correction-bench/test/smoke-real.test.mjs   # the driver smoke
```
