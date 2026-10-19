// The correction benchmark's own tests (bench/correction-bench/test/), run with
// the unit suite. The real-engine smoke (smoke-real.test.mjs) runs in the
// real-engine CI job instead.
import "../../bench/correction-bench/test/oracles.test.mjs";
import "../../bench/correction-bench/test/analysis.test.mjs";
import "../../bench/correction-bench/test/runner.test.mjs";
