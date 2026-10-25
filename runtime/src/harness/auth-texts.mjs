// The texts of `ad auth` (P3.8a), shared with the terminal UI's account picker (P3.8b).

import { PROVIDER_PRESETS, UNAVAILABLE, visiblePresets } from "../providers/registry.mjs";

export const AUTH_HELP = `Usage: ad auth <command>

  login <provider>     Add an account, or sign one in again
                         --label <name>   --owner <text> (e.g. personal, work, client:acme)
                         --device         ChatGPT: a code instead of the browser
                         --oauth          OpenRouter: sign in in the browser instead of pasting a key
                         --base-url <url> [--insecure] [--no-key]   your own endpoint
                         --model <id>     the account's default model
                       Keys: typed at a hidden prompt, or piped with --stdin. Never on the command line.
  list                 Your accounts, grouped by provider   [--provider <id>] [--wide] [--json]
  use <account>        The account (and model) ad uses   [--model <id>] [--effort <level>]
                         --global (default) | --project | --session (prints the line for this terminal)
                         --digest (the account ad's own session digests may use)
  rename <account> <label>   [--owner <text>]
  logout [<account>]   Sign out one account; the others stay signed in
  remove <account>     Forget an account   [--yes] [--delete-conversations]
  status [<account>]   What ad uses now, and whether each account works   [--json]
  test <account>       Check an account   [--model <id>: also one small request]   [--json]
  repair               Fix interrupted sign-ins and keys without an account   [--yes]

<account> is provider/label (openrouter/work), a provider with one account, a label used once, or an account id.
Providers and how to sign in: ad auth login --help
`;

const HOW = { "api-key": "an API key", "openrouter-oauth": "--oauth: sign in in the browser", none: "no key (local)" };

// A provider's own help line (`ad auth login <provider> --help`), where it has more to say.
const PROVIDER_HELP = Object.freeze({
  "opencode-go": "Key from your OpenCode account (opencode.ai). Zen's free models aren't available in other apps.",
  anthropic: "Use an API key from the Anthropic Console. A Claude Pro or Max subscription can't be used here; to use your subscription, run Claude Code itself as a worker (ad sp --engine claude).",
  gemini: "Use an API key from Google AI Studio. A Gemini app or Google One AI plan can't be used here.",
});

/** `ad auth login --help`: one line per provider ad lists, then what it doesn't offer. */
export function loginHelp({ env = process.env, provider = null } = {}) {
  if (provider && PROVIDER_HELP[provider]) return `Usage: ad auth login ${provider} [--label <name>] [--owner <text>]\n\n${PROVIDER_HELP[provider]}\n`;
  const shown = visiblePresets({ env });
  const rows = [["chatgpt", "ChatGPT", "your ChatGPT plan, in the browser (--device: a code)"], ...shown.map((p) => [p.id, p.name, p.methods.map((m) => HOW[m] ?? m).join(", ")])];
  const hidden = PROVIDER_PRESETS.filter((p) => !shown.includes(p)).map((p) => p.id);
  return [
    "Usage: ad auth login <provider> [--label <name>] [--owner <text>]",
    "",
    ...rows.map(([id, name, how]) => `  ${id.padEnd(12)} ${name}: ${how}`),
    ...(hidden.length ? ["", `Also (not yet checked on a real account, see docs/accounts.md): ${hidden.join(", ")}`] : []),
    "",
    "Not offered:",
    ...UNAVAILABLE.map((r) => `  ${r.text}`),
    "",
  ].join("\n");
}

export const AUTH_TEXTS = Object.freeze({
  ACCOUNT_NOT_FOUND: (ref, refs) => `no account matches "${ref}".${refs.length ? ` Your accounts: ${refs.join(", ")} (ad auth list).` : " Add one: ad auth login <provider>"}`,
  ACCOUNT_AMBIGUOUS: (ref, refs) => `"${ref}" matches ${refs.length} accounts: ${refs.join(", ")}. Name it as provider/label.`,
  TOOL_SHELL: "account changes can't run from the agent's own shell. Run this in your terminal.",
  NEEDS_YES: "removing an account needs a yes. Re-run with --yes.",
  USE_GLOBAL: (name, model) => `ad now uses ${name}${model ? ` (model ${model})` : ""} for new sessions. Open windows keep their own choice.`,
  USE_PROJECT: (name, label, providerName) => `This project now prefers ${name}. ad uses it in this folder once you trust the folder; anyone with an ${providerName} account labelled '${label}' gets it too.`,
  USE_SESSION: "For this terminal only (a starting default; a window's own choice still wins), run:",
  USE_DIGEST: (name) => `ad's digest will use ${name} when a session's own account isn't available. Your conversations' summaries go to that account.`,
  MODEL_UNLISTED: (providerName, model) => `${providerName} doesn't list '${model}' for this key; ad will try it anyway.`,
  RENAMED: (name, owner) => `Renamed: ${name}${owner ? ` (owner: ${owner})` : ""}.`,
  SIGNED_OUT_KEY: (name, providerName) => `Signed out: ${name} (its key is deleted from this computer; it still works at ${providerName} until you revoke it there). Other accounts stay signed in.`,
  REMOVE_ASK_KEY: (name) => `Remove ${name}? Its key is deleted from this computer. [y/N] `,
  REMOVE_ASK: (name) => `Remove ${name}? [y/N] `,
  REMOVED: (name) => `Removed: ${name}.`,
  REMOVED_DEFAULT: "It was your default; ad will ask next time, or run: ad auth use <account>.",
  REMOVED_PROJECT: (file) => `A project selector still names it (${file}); ad ignores it until you change it.`,
  CHATGPT_LATER: "ChatGPT accounts other than the one in ad's main engine folder come with several ChatGPT accounts (the next update).",
  DEFAULT_HOME_KEPT: "The ChatGPT account in ad's main engine folder can't be removed here; sign it out with: ad auth logout",
  PROJECT_NOT_HERE: "this folder is your home folder or ad's own; run it inside a project.",
  PROJECT_BAD_JSON: (file) => `${file} isn't a JSON object ad can add to; fix or move it first (ad never overwrites it).`,
  PROJECT_NOT_FILE: (file) => `${file} isn't a plain file; ad doesn't write through it.`,
  PROJECT_LINK: (p) => `${p} is a link; ad doesn't write project settings through links.`,
  SCOPE_CONFLICT: "use takes one scope: --global, --project, --session or --digest.",
  TEST_WORKS: (name, n) => `${name}: works (key accepted${n !== null && n !== undefined ? `; ${n} models` : ""}).`,
  TEST_FAILS: (name, why) => `${name} doesn't work: ${why}`,
});
