// Is a prompt the user's own words? Shared by the prompt hook (plan L2, 02
// §2.1) and the history reader (L4a): text that wraps something the user
// didn't type (a slash command's expansion, a background task's report, a
// local command's output, an injected reminder), or a prompt a client wrote.
// Light on purpose: the prompt hook loads it on every prompt.

import { isGeneratedPrompt } from "./generated-prompts.mjs";

const WRAPPER_START = /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|system-reminder)\b|Caveat: The messages below were generated|\[Request interrupted by user|This session is being continued from a previous conversation)/;
const WHOLE_TAG = /^\s*<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// Context Codex injects as a user message (AGENTS.md, environment, hook context).
const INJECTED = /^\s*(?:# AGENTS\.md instructions|<(?:environment_context|user_instructions|INSTRUCTIONS|permissions|skills_instructions|user_shell_command|turn_aborted)\b|<!-- agent-daemon)/;

/** Is this context a host injected on the user's behalf? */
export const isInjectedContext = (text) => INJECTED.test(String(text ?? ""));

/** The user's own words in a prompt, or null when it isn't something they typed. */
export function typedText(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(REMINDER, "").trim();
  if (!text) return null;
  if (WRAPPER_START.test(text) || WHOLE_TAG.test(text)) return null;
  if (isGeneratedPrompt(text) || isInjectedContext(text)) return null;
  return text;
}
