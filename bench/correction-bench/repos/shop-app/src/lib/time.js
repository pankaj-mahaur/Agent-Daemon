// Waiting and repeating: one place, so tests can fake time.
export const wait = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
export function every(ms, fn) {
  const t = globalThis.setInterval(fn, ms);
  return () => globalThis.clearInterval(t);
}
