// The one way a stored note is shown to an agent (P5.1): the MCP tools,
// SessionStart (working set, recent learnings, profile) and prompt recall all
// call safeNoteText. A note that reads like an instruction is withheld whole;
// any other note is neutralized (markers defanged, secrets masked) and capped.

import { neutralizeText } from "../digest/sanitize.mjs";
import { readsAsInstruction } from "./safety.mjs";

export const WITHHELD = "[withheld: this note reads like an instruction to the agent, not a lesson]";

/** → the text to show for a note (and its evidence, which is judged with it). */
export function safeNoteText(text, { maxChars, evidence } = {}) {
  if (readsAsInstruction(text, evidence)) return WITHHELD;
  return neutralizeText(String(text ?? ""), maxChars ? { maxChars } : {});
}
