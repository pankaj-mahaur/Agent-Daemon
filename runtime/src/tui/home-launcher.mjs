// "Pick a project folder" (P0.2a): shown by `ad` before the engine starts when
// the folder would load the user's own engine home. The last project comes first
// (Enter opens it), then other recent ones, then the two ways to open home.

import { homeOpenAnywayHint } from "../engine/attribution.mjs";

export const LAUNCHER_TITLE = "Pick a project folder";

/** Picker items: [{label, hint?, value: {cwd} | {allow: true, always?: true}}]. */
export function launcherItems({ recent = [], risk } = {}) {
  return [
    ...recent.map((dir, i) => ({ label: dir, ...(i === 0 ? { hint: "last used" } : {}), value: { cwd: dir } })),
    { label: "Open home anyway", hint: homeOpenAnywayHint(risk ?? {}), value: { allow: true } },
    { label: "Always open home without asking", hint: "saved in ad's prefs (allowHomeFolder)", value: { allow: true, always: true } },
  ];
}
