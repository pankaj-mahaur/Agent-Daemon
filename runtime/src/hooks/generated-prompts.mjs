// Prompts a client writes for the user, not the user's own words: ad's prompt
// hooks skip them, so nothing in them is learned as something the user said
// (parity success criterion 4).
//
// The "Yes, clear context and implement" answer (Plan mode) starts a fresh thread
// whose first message is this fixed prefix plus the model's plan
// (codex-rs/tui/src/chatwidget/plan_implementation.rs at the pinned tag). ad's
// terminal UI sends the same message, and so does the engine's own UI.
export const PLAN_CLEAR_CONTEXT_PREFIX =
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";

/** Is this prompt one a client generated (the plan hand-off above)? A /private wrapper doesn't hide it. */
export function isGeneratedPrompt(prompt) {
  const text = String(prompt ?? "").replace(/^\s*<private>/, "").trimStart();
  return text.startsWith(PLAN_CLEAR_CONTEXT_PREFIX);
}
