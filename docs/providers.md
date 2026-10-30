# Providers that speak Chat Completions

These providers have no Responses API, which ad's engine speaks, so ad's gateway translates for them (see [architecture.md](architecture.md#chat-translation-in-the-gateway-p61)). Each one's address, models, limits and data terms were read from its own docs on 25 Oct 2026, and the tests run each provider's error shapes and quirks against a stand-in. None has been through an acceptance run on a real key yet, so all are **candidates**. Add one by its id:

```bash
ad auth login groq
```

To see the candidates in `/login` and `ad auth login --help`, set `AD_SHOW_CANDIDATES=1`. A provider becomes *supported* once a real-key acceptance run is recorded (see [accounts.md](accounts.md#providers)).

| Provider | Id | Free use | Data note | Status |
|---|---|---|---|---|
| Gemini API | `gemini` | free tier | free keys: Google may use prompts to improve its products (asked once at sign-in) | candidate; native API (thought signatures kept) |
| Groq | `groq` | free tier with daily limits | — | candidate |
| Cerebras | `cerebras` | trial credits | — | candidate |
| Mistral | `mistral` | free mode | — | candidate |
| NVIDIA API catalog | `nvidia` | trial | for trial use: don't send personal or confidential code (asked once at sign-in) | candidate |
| Anthropic API | `anthropic` | — | — | candidate; native Messages API (extended thinking kept across tool calls) |
| DeepSeek | `deepseek` | — | — | candidate |
| Together AI | `together` | — | — | candidate |
| Z.ai | `zai` | `glm-4.7-flash` is free | — | candidate |
| Z.ai Coding Plan | `zai-coding` | — | — | **not available**: its plan allows only Z.ai's listed coding tools; use a standard Z.ai key |
| Hugging Face | `huggingface` | credits | the provider named after `:` in a model id receives your prompts | candidate |
| Nebius Token Factory | `nebius` | — | — | candidate |
| MiniMax | `minimax` | — | — | candidate |
| SambaNova | `sambanova` | free tier with daily limits | — | candidate |

Acceptance runs: not attempted yet for any of them (no keys).

## Why Claude and Gemini use their own APIs

Claude and Gemini also offer OpenAI-compatible endpoints, but those lose what a coding agent needs: Anthropic's drops extended thinking and ignores strict tool schemas, and Gemini's carries thought signatures and quota detail only through extensions. Losing thinking in the middle of a tool loop degrades or breaks multi-step work. So ad speaks each one's own API (Anthropic's Messages API, Gemini's `streamGenerateContent`) inside its gateway: Claude's thinking and its signature go back exactly as they came, before the next tool call; each Gemini tool call's thought signature goes back on that call. The Gemini key travels in the `x-goog-api-key` header, never in an address. A Claude Pro/Max or Gemini app subscription can't be used here (their terms don't allow other apps).

## What ad does for each

- **Limits.** A daily or monthly limit, or an empty balance, stops the turn at once with the provider's reason (for example "Groq: the daily limit is used up."), and isn't retried. A per-minute limit waits as long as the provider asks (up to 60 s). Providers that put the reason in their own codes are read by those codes: Z.ai's 1113 (balance), MiniMax's 1008 and 2062, Anthropic's monthly spend cap.
- **Context windows.** ad tells the engine each listed model's context window, so it compacts before the provider's limit. A model the preset doesn't list gets the engine's default.
- **Tool calls.** Mistral's 9-character tool-call ids, DeepSeek's and MiniMax's reasoning sent back with the history, Gemini's thought signatures sent back on their calls. Z.ai takes only `auto` for `tool_choice` and MiniMax `auto` or `none`; ad refuses the others before sending.
- **What can't be carried** (live web search, a stored response, an image for a model without vision) is refused before anything is sent, with ad's reason.

## Your own Chat Completions endpoint

`ad auth login custom --base-url …` tries the Responses API first; an endpoint that has only Chat Completions is added too and goes through the same translation. ad hasn't tested your endpoint: its quirks are yours to find.
