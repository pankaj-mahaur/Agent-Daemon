// The alternate-screen guard (plan P2.1): whether ad holds the terminal's
// alternate screen, and the bytes that enter and leave it.
//
// The state is module-level (one per process) so every exit path (io's
// restore on a signal, an uncaught error, a handoff) can leave the alternate
// screen without a renderer object. It is marked active BEFORE the enter bytes
// are written: a signal that lands mid-write still finds something to undo.
//
// enterAltScreen(writeSync, {mouse, keyboard = true})
// releaseAltScreen(writeSync) → true when it left, false when not active;
//   synchronous, idempotent, never throws
// isActive(), onRelease(fn) → off   (renderers subscribe to become inert)

const CSI = "\x1b[";
export const ENTER = `${CSI}?1049h`;
export const LEAVE = `${CSI}?1049l`;
const PUSH = `${CSI}>1u`; // the alternate screen's own keyboard stack (flag 1, as io.mjs pushes)
const POP = `${CSI}<u`;
// ?1007l keeps the wheel from turning into arrow keys (they would walk the
// prompt history). Button-event tracking (?1002h) is enough for drags; no
// any-motion ?1003h.
const ALT_SCROLL_OFF = `${CSI}?1007l`;
export const MOUSE_ON = `${ALT_SCROLL_OFF}${CSI}?1000h${CSI}?1002h${CSI}?1006h`;
// ?1003l too: whatever a child left on must not outlive ad.
export const MOUSE_OFF = `${CSI}?1006l${CSI}?1003l${CSI}?1002l${CSI}?1000l`;

export const enterBytes = ({ mouse, keyboard = true }) =>
  ENTER + (keyboard ? PUSH : "") + (mouse ? MOUSE_ON : ALT_SCROLL_OFF) + `${CSI}H${CSI}2J`;

// ?2026l first: a crash mid-frame leaves synchronized output open, and the
// terminal would hold every byte after it.
export const leaveBytes = ({ keyboard }) => `${CSI}?2026l` + MOUSE_OFF + (keyboard ? POP : "") + ALT_SCROLL_OFF + LEAVE;

const state = { active: false, mouse: false, keyboard: false };
const listeners = new Set();

export const isActive = () => state.active;

export function onRelease(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function enterAltScreen(writeSync, { mouse, keyboard = true }) {
  Object.assign(state, { active: true, mouse: !!mouse, keyboard });
  writeSync(enterBytes({ mouse, keyboard }));
}

export function releaseAltScreen(writeSync) {
  if (!state.active) return false;
  const { keyboard } = state;
  state.active = false;
  try {
    writeSync(leaveBytes({ keyboard }));
  } catch {
    // The terminal is gone (EPIPE, a closed pty): nothing left to restore.
  }
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A listener's failure must not stop the others on an exit path.
    }
  }
  return true;
}
