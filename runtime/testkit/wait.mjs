// Poll until a condition holds — for tests, instead of fixed sleeps that
// flake on slow CI runners. Resolves with the condition's truthy value.
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 25, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
