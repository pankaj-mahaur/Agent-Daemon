// Mouse report bytes for tests (P2.2). Coordinates are 0-based cells in, the
// terminal's 1-based ones out.
//   sgr({action, button, wheel, x, y, shift, alt, ctrl})  → "\x1b[<b;x;yM" or "…m"
//   x10({button, x, y})                                    → "\x1b[M" + 3 raw bytes (latin1)

const BUTTON = { left: 0, middle: 1, right: 2 };
const WHEEL = { up: 0, down: 1, left: 2, right: 3 };

export function sgr({ action = "press", button = "left", wheel = null, x = 0, y = 0, shift = false, alt = false, ctrl = false } = {}) {
  let b = action === "wheel" ? 64 + WHEEL[wheel] : action === "move" ? 35 : BUTTON[button] ?? 3;
  if (action === "drag") b += 32;
  if (shift) b += 4;
  if (alt) b += 8;
  if (ctrl) b += 16;
  return `\x1b[<${b};${x + 1};${y + 1}${action === "release" ? "m" : "M"}`;
}

export function x10({ button = "left", x = 0, y = 0 } = {}) {
  return "\x1b[M" + String.fromCharCode(32 + (BUTTON[button] ?? 3), 33 + x, 33 + y);
}
