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

## Providers

| Provider | Id | How | Notes |
|---|---|---|---|
| OpenAI API | `openai` | API key | several keys side by side; ad 3.0's key, kept by the engine, still works |
| OpenRouter | `openrouter` | API key | reaches Claude, Gemini and many others with one key; free models are marked (below) |
| Kimi Code | `kimi-code` | API key | |
| Moonshot (Kimi API) | `moonshot` | API key | |
| xAI | `xai` | API key | |
| Fireworks | `fireworks` | API key | |
| Your own endpoint | `custom` | API key, or none on this machine | must speak the Responses API (below) |
| Ollama | `ollama` | none (local) | `localhost:11434` |
| LM Studio | `lmstudio` | none (local) | `localhost:1234` |

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

### Your own endpoint

```bash
ad auth login custom --base-url https://llm.example.com/v1
ad auth login custom --base-url http://127.0.0.1:8000/v1 --no-key   # a server on this machine
```

- **Addresses ad accepts.** https anywhere. http only on this machine (`localhost`, `127.0.0.1`, `[::1]`), or with `--insecure` for a host you control: http sends your key unencrypted.
- **Addresses ad refuses.** A user name or password in the address, a `#fragment`, or a key in the query. ad asks for the key separately.
- **The test.** ad lists the endpoint's models, then asks before sending a one-token request, which may cost a fraction of a cent; `--no-test` skips it.
- **Chat Completions only.** An endpoint without the Responses API can't be used yet. That works once ad's chat bridge ships; meanwhile use OpenRouter, or a server with the Responses API (Ollama 0.13.3+, LM Studio, vLLM).

### Local models

`ad auth login ollama` and `ad auth login lmstudio` add the server on your own machine: no key, and nothing leaves the machine. If the server isn't running, ad says how to start it (`ollama serve`, `lms server start`).

## Free models

OpenRouter offers some models for free. ad marks a model free only from a fresh price check: OpenRouter's own model list, under 24 hours old, pricing it at zero. A `:free` name alone is not enough. Free models carry OpenRouter's note that they may log or train on prompts, depending on the provider behind them.

## Sign-ins ad doesn't offer

These sign-ins aren't open to other apps, so ad doesn't use them:
- **Claude Pro/Max.** Anthropic doesn't allow other apps to use it. Claude models work now through OpenRouter; an Anthropic API key comes later.
- **Gemini CLI.** Google doesn't allow other apps to use it. Gemini models work now through OpenRouter; a Gemini API key comes later.
- **GitHub Copilot and xAI SuperGrok.** Only partner apps may use them. Use an xAI API key.
- **Nous Portal.** Not available yet: Nous hasn't published a way for other apps to sign in. Hermes models are open: run them with Ollama, or use them through OpenRouter.

## Switching accounts

A conversation keeps the account it started on. Switching to another account of the same provider (same model) continues it as a copy on the new account, with its history; anything else starts a new conversation.

The copy carries the conversation, not everything around it:
- `/undo` checkpoints stay with the old conversation;
- background terminals keep running there.
