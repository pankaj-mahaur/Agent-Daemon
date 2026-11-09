// Whether a project gets recall (MCP launch plan L6, design decision 13): on (the
// default: the session brief and prompt-time recall) or off (nothing recall adds to the
// agent's context). Kept in the store (memory_settings `recall_mode:<project id>`).
// Changing it in either direction needs the review token (02 §7: no model-callable path
// stops recall of an accepted note, and the agent can't undo the user's off either):
// `<pkg> config recall on|off` writes it through the review service. Any other value
// (a damaged or forged row) reads as on.

import { getSetting } from "./l5-tables.mjs";

export const RECALL_MODES = Object.freeze(["on", "off"]);

/** The effective mode for a project: "off" only when its own row says so. */
export function recallMode(handle, projectId = null) {
  try {
    return projectId && getSetting(handle, `recall_mode:${projectId}`) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

export const briefAllowed = (mode) => mode !== "off";
export const promptRecallAllowed = (mode) => mode !== "off";
