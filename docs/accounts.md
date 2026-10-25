# Accounts and providers

ad runs on the accounts you add: several keys of one provider, several providers side by side, your own endpoint, and models on your own machine. Keys stay in ad's secret store and reach the provider through ad's local gateway; the engine and the tools it runs never see them ([harness.md](harness.md)).

## Adding an account

```bash
ad auth login openrouter                  # an API key, asked at a hidden prompt
ad auth login openrouter --label work     # a second key of the same provider
ad auth login openrouter --oauth          # or sign in to OpenRouter in the browser
ad auth login xai
ad auth login custom --base-url https://llm.example.com/v1
ad auth login ollama                      # a local server, no key
ad auth status                            # every account, its status, the key's last 4 characters
ad auth use openrouter/work               # the default account (--model sets its default model)
ad auth test openrouter/work              # check a stored key again
```

- **A key is never typed on the command line.** It would stay in your shell history, so ad refuses `--key` and anything that looks like a key there. Type it at the hidden prompt, or pipe it: `… | ad auth login openrouter --stdin` (the first line, trimmed).
- **Labels.** A provider's first account is called `default`; give every other one a `--label`. Use an account anywhere as `<provider>/<label>`.
- **The default account.** The first account you add becomes the default. `ad auth use` changes it, and `--account` picks another one for a single run ([harness.md](harness.md#safety-model)).
- **Checking a key.** ad asks the provider itself, never through the engine. It sends only a `User-Agent: ad/<version>` and the key, over https (or to your own machine), and never follows a redirect with the key.
  - A refused key is not saved.
  - When the provider can't be reached, the key is saved and the account waits for `ad auth test`.

### OpenRouter's own sign-in

`ad auth login openrouter --oauth` signs in on OpenRouter's site, using OpenRouter's official flow for apps (PKCE). No password or key passes through ad: OpenRouter gives ad a key for you, stored like any other.

1. ad opens the page in your browser and prints the address, in case the browser doesn't open.
2. ad waits for OpenRouter to send you back to a page on your own machine (127.0.0.1).
3. Ctrl+C, or 10 minutes without an answer, ends the sign-in and saves nothing.

## Managing accounts

```bash
ad auth list                         # your accounts, grouped by provider (--wide: method and last use; --json)
ad auth use openrouter/work          # the default for new sessions (--model, --effort)
ad auth use openrouter/work --project   # this project prefers it (in a folder you trust)
ad auth use openrouter/work --session   # prints the line that sets it for this terminal only
ad auth use openrouter/work --digest    # the account ad's own session digests may use
ad auth rename openrouter/work acme --owner "Acme Ltd"
ad auth logout openrouter/acme       # its key is deleted from this computer; the account stays (needs sign-in)
ad auth remove openrouter/acme       # forget it (asks; --yes in scripts)
ad auth status [<account>]           # what ad uses now; one account in detail
ad auth test <account>               # check it (--model: also one small request)
```

- **Naming an account.** `<account>` is `provider/label`, a provider with one account (`openrouter`), a label used once, or an account id. A label can't be a provider's name, so `logout chatgpt` can never reach an OpenRouter key.
- **The list.** It fits an 80-column terminal:
  - `●` marks the default;
  - the owner column shows only when it differs from the label;
  - "who" is the masked email and plan for a sign-in, `key …1234` for a key, `local` for your own machine;
  - "limits" shows a limit the provider just reported.
- **Scripting.** `--json` is the scripting contract. It is built from a fixed list of fields, and never holds a key, its storage name, a full email or an engine folder path. With `--json`, any error comes back as `{"error": {"code", "message"}}` with the same exit code.
- **Logout vs remove.** `logout` signs one account out and keeps its name, so `ad auth login <provider> --label <label>` brings it back. `remove` forgets it. `logout` alone signs out the ChatGPT or OpenAI sign-in in ad's main engine folder, as in 3.0.
- **Not from the agent's own shell.** `login`, `use`, `rename`, `logout`, `remove` and `repair` refuse to run there (exit 2), so an accident or a naive prompt injection can't change your accounts. `list`, `status` and `test` work everywhere. This is a guard, not a wall: a determined process on your machine can still read ad's files.

### From ad 3.0

| 3.0 command | Now |
|---|---|
| `login openai`, `login openrouter --model m` | adds an account (label `default`, or `--label`); `--model` is optional |
| `use openai` / `use openrouter` | that provider's account, if it has only one (two or more: name it as `provider/label`) |
| `status` | the same first two lines, then a summary of your accounts |
| `logout` | signs out the sign-in in ad's main engine folder only |
| `logout openrouter` | signs out the one OpenRouter account: its key is deleted, the account stays |

## In the terminal UI

- **`/model`.** With several accounts, `/model` lists them first, grouped by provider. `●` marks this window's account. Each row says before you choose whether the conversation continues or a new one starts. A model alone changes from the next turn, even while a turn runs; an account change waits for the turn to end.
- **Switching within one provider.** Moving to another account of the same provider with the same model continues the conversation as a copy on that account. Any other move asks first, then starts a new conversation; the old one stays in `/resume`.
- **`/account`.** It opens the account list directly. `/model default` makes this window's account the default for new sessions.
- **`/login`.** Adds an account without leaving ad. The key goes into a masked field that never reaches the prompt history, the transcript or the window title. The OpenRouter browser sign-in shows its address in case no browser opens (over SSH, say); Esc cancels it. An account that needs signing in again takes its new key the same way and keeps its label.
- **`/logout`.** Signs out one account.
- **Each window keeps its own choice.** Another window's `/model` doesn't change it, and `ad auth use` doesn't either. The footer names the account when more than one is ready.

## Providers

| Provider | Id | How | Notes |
|---|---|---|---|
| OpenAI API | `openai` | API key | several keys side by side; ad 3.0's key, kept by the engine, still works |
| OpenRouter | `openrouter` | API key | reaches Claude, Gemini and many others with one key; free models are marked (below) |
| Kimi Code | `kimi-code` | API key | |
| Moonshot (Kimi API) | `moonshot` | API key | |
| xAI | `xai` | API key | |
| OpenCode Go | `opencode-go` | API key | OpenCode's paid plan; its open models (GLM, Kimi, DeepSeek…) through ad's chat translation (below) |
| Fireworks | `fireworks` | API key | |
| Your own endpoint | `custom` | API key, or none on this machine | must speak the Responses API (below) |
| Ollama | `ollama` | none (local) | `localhost:11434` |
| LM Studio | `lmstudio` | none (local) | `localhost:1234` |

More providers that speak only Chat Completions (Gemini, Groq, Cerebras, Mistral, NVIDIA, Anthropic, DeepSeek, Together, Z.ai, Hugging Face, Nebius, MiniMax, SambaNova): [providers.md](providers.md).

**What "supported" means.** A provider is *supported* once a real task on a real key passed ad's acceptance run, dated and recorded. *Experimental* means ad's mock contract tests pass plus one real task with known gaps. Until then a provider is a *candidate*: you can add it by id, but pickers and help don't list it unless `AD_SHOW_CANDIDATES=1` is set. Each provider's record is re-run before a release, since providers change their addresses and terms.

To make a record yourself, with one of your own accounts:

```bash
node runtime/scripts/provider-accept.mjs --account openrouter/work [--model <id>] [--out <dir>]
```

- **What it runs.** One real coding task (a failing test to fix) in a throwaway folder, through ad's own path: the account's engine, then ad's gateway, then the provider.
- **What it writes.** A dated record of:
  - the models listed and which are free;
  - the tools the agent called and the turn's status;
  - the last limits the gateway saw;
  - the time taken and the versions in use.

  It never holds the key. The lines only a person can check are marked `(fill in)`: the official docs, the price source and the data terms. The status stays *candidate* until someone reviews the record.
- **Where it runs.** On your machine only: the script refuses under CI.

**Retries.** A provider that fails ends the turn quickly and says so: each provider ad adds allows one retry of a request and one of a broken stream, and nothing more.

### OpenCode Go

`ad auth login opencode-go` takes the API key from your OpenCode account (opencode.ai, with a Go or Go Plus plan). OpenCode Go welcomes other coding agents that name themselves, so ad sends its own User-Agent (`ad/<version>`) and each conversation's id as OpenCode's session header; ad never presents itself as OpenCode.

- **Which models work.** Models OpenCode serves on the Responses API (GPT, Grok, Muse Spark) go through as they are. Models it serves on Chat Completions (GLM, Kimi, DeepSeek, MiMo, MiniMax M3.1 Flash, LongCat, Hy, Step, Beam Free) go through ad's chat translation. Models on Anthropic's or Gemini's API (Claude Haiku, Qwen, MiniMax M3, Gemini) show as "coming later" in `/model`.
- **Usage limits.** Go limits each model per 5 hours, week and month. When one is reached, the turn stops with "OpenCode Go's usage limit is reached" and the reset time if OpenCode gives one; switch with `/model` or wait. ad doesn't switch for you.
- **Zen's free models** are not available: OpenCode allows them only in its own app. For free models in ad, use OpenRouter's free models or a local model (Ollama, LM Studio).
- **Status.** A candidate until its acceptance run on a real Go key is recorded; until then add it with `AD_SHOW_CANDIDATES=1` to see it in pickers.
- **Known limits.** OpenCode doesn't publish each model's context size, so ad can't yet tell the engine when to compact on Go's chat models: a very long session may end with a context error instead (start a new conversation, or `/compact` earlier). On the Responses models, a usage limit reached in the middle of an answer is retried once before the turn stops.

### Your own endpoint

```bash
ad auth login custom --base-url https://llm.example.com/v1
ad auth login custom --base-url http://127.0.0.1:8000/v1 --no-key   # a server on this machine
```

- **Addresses ad accepts.** https anywhere. http only on this machine (`localhost`, `127.0.0.1`, `[::1]`), or with `--insecure` for a host you control: http sends your key unencrypted.
- **Addresses ad refuses.** A user name or password in the address, a `#fragment`, or a key in the query. ad asks for the key separately.
- **The test.** ad lists the endpoint's models, then asks before sending a one-token request, which may cost a fraction of a cent; `--no-test` skips it.
- **Chat Completions only.** An endpoint without the Responses API is added too (after the test): its requests go through ad's chat translation. ad hasn't tested your endpoint, so its quirks are yours to find.

### Local models

`ad auth login ollama` and `ad auth login lmstudio` add the server on your own machine: no key, and nothing leaves the machine. If the server isn't running, ad says how to start it (`ollama serve`, `lms server start`).

## Free models

OpenRouter offers some models for free. ad marks a model free only from a fresh price check: OpenRouter's own model list, under 24 hours old, pricing it at zero. A `:free` name alone is not enough. Free models carry OpenRouter's note that they may log or train on prompts, depending on the provider behind them.

## Sign-ins ad doesn't offer

These sign-ins aren't open to other apps, so ad doesn't use them:
- **Claude Pro/Max.** Anthropic doesn't allow other apps to use it. Claude models work now through OpenRouter; an Anthropic API key comes later.
- **Gemini CLI.** Google doesn't allow other apps to use it. Gemini models work now through OpenRouter; a Gemini API key comes later.
- **GitHub Copilot and xAI SuperGrok.** Only partner apps may use them. Use an xAI API key.
- **OpenCode Zen free models.** OpenCode allows them only in its own app. Free alternatives in ad: OpenRouter's free models and local models (Ollama, LM Studio). OpenCode Go (paid) works with your own key.
- **Nous Portal.** Not available yet: Nous hasn't published a way for other apps to sign in. Hermes models are open: run them with Ollama, or use them through OpenRouter.

## Switching accounts

A conversation keeps the account it started on. Switching to another account of the same provider (same model) continues it as a copy on the new account, with its history; anything else starts a new conversation.

The copy carries the conversation, not everything around it:
- `/undo` checkpoints stay with the old conversation;
- background terminals keep running there.
