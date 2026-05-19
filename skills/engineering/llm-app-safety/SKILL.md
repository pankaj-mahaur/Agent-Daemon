---
name: llm-app-safety
description: Standards for changes to LLM-powered features — agentic pipelines, vision/image analysis, prompt templates, model config, and any user-facing AI output. Use when touching files that call OpenAI / Anthropic / OpenRouter / Gemini / local models, multi-agent orchestration, deterministic safety layers, or guardian/moderation logic. Encodes model-fallback discipline, agent veto semantics, deterministic-engine preservation, parallel guardian runs, and the "verify the actual code" rule.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Working on the LLM / safety layer

LLM-powered features are the most sensitive surface in most apps that have them. Outputs reach users directly; failure modes (hallucination, prompt injection, leaked PII, missed safety triggers) are hard to test for and easy to regress. Default to **read-only investigation** until you have explicit instruction to change behavior.

This skill applies whether your project uses OpenAI, Anthropic, Google Gemini, OpenRouter, Together, Replicate, Bedrock, vLLM, llama.cpp, or any combination. The discipline is the same; the SDK calls vary.

---

## Pre-flight (always)

1. **Read the actual file at the change site before planning.** Memory and `CLAUDE.md` drift in this layer faster than anywhere else. Documented model names, fallback chains, and pipeline shapes are often hypotheses, not current facts. Examples of common drift:
   - File documented as "uses OpenRouter with fallback chain" but currently calls OpenAI directly with a single model
   - Function name says `callClaude` but the body calls a different provider
   - Prompt template referenced in docs has been since edited
2. For non-trivial changes, propose in plan mode first. The bar for "trivial" in this layer is *very* low — even formatting changes near a prompt template should be planned.
3. Read the connected files. The map for a typical AI feature:
   - **AI client core** — the thin wrapper around the SDK (`callOpenAI`, `callClaude`, `callOpenRouter`). Implements retries, fallbacks, model selection.
   - **Agent / pipeline files** — multi-step orchestration. Often A → B → C with a synthesizer or arbiter at the end.
   - **Vision / multimodal client** — usually a separate function with separate timeouts and a separate model chain.
   - **Deterministic safety layer** — hardcoded thresholds or rules that intentionally do **not** call an LLM (medical risk thresholds, PII detection, content filters). See "Deterministic engines" below.
   - **Guardian / moderation** — runs in parallel with chat to detect emergencies, abuse, jailbreaks. Writes to an audit log.
   - **Prompt templates** — system prompts, few-shot examples, structured-output schemas.

---

## Hard rules

### Model config & fallback

- The model selection in the AI client is a deliberate decision (cost, latency, capability tradeoffs). **Don't reorder, drop, or substitute models** without an explicit ask. Even moving from `gpt-4o-mini` to `gpt-4o` is a behavior change.
- If the file has a fallback list (`MODELS = ["claude-opus-4-5", "claude-sonnet-4-5", "gpt-4o"]`), preserve order and the trigger conditions. Common triggers: 429 rate limit, 402 payment required, 500 provider error, timeout.
- **Vision / multimodal calls have separate model chains and separate timeouts** (often 30–60s per model — image processing is slow). Don't merge them with the text chain.
- **All AI calls should still go through the central client.** Don't add a second code path that bypasses the chain — that's how a teammate ships a feature with no fallback by accident.

Example fallback shape (provider-agnostic):

```ts
async function callLLM(prompt: string, models: string[]) {
  for (const model of models) {
    try {
      return await provider.complete({ model, prompt, timeout: 30_000 });
    } catch (e) {
      if (isRateLimit(e) || isQuotaExceeded(e) || isTimeout(e)) {
        log.warn("llm fallback", { failed: model, next: models[models.indexOf(model) + 1] });
        continue;
      }
      throw e; // non-fallback error — don't swallow
    }
  }
  throw new AllModelsFailed(models);
}
```

### Agentic pipeline ordering and veto

If the project uses multiple agents in sequence (e.g. cluster → score → validate → synthesize), the order is usually a deliberate safety choice:

- **Don't reorder agents.** A validator that runs after the scorer is intentional — it catches scorer hallucinations.
- **Validators / arbiters often have veto power** over upstream agents regardless of upstream confidence. If a validator rejects a result, the synthesizer takes the validator's verdict, not the original. Don't add a "skip validator on high confidence" path — that defeats the design.
- **Don't paper over guardrails by raising a confidence floor.** That hides the rejections, doesn't reduce them.

### Deterministic engines

Many AI apps have a layer that intentionally does **not** call an LLM — hardcoded rules / thresholds for safety-critical decisions. Examples:

- Medical risk scoring with fixed lab-value thresholds (hemoglobin, glucose, creatinine)
- PII / secret detection with regex + entropy heuristics
- Allowlist-based content filters
- Numeric calculation paths where an LLM's arithmetic is unreliable

Rules:

- **Never replace deterministic thresholds with model output** to "make it more flexible". The whole point is determinism — it can be audited and won't regress with a model swap.
- **New rules / thresholds may be added** through normal code review.
- **Existing thresholds may not be relaxed without explicit ask** from the user (and ideally a domain expert).
- Return enums (`LOW | MODERATE | HIGH`) — don't widen them silently.

### Safety guardian / moderation

- **Run the guardian in parallel with the user-visible response, not in series.** Serializing it blocks the chat reply on the guardian's latency. Pattern:
  ```ts
  const [reply, guardianResult] = await Promise.all([
    generateChatReply(message),
    runGuardian(message),
  ]);
  if (guardianResult.shouldInterrupt) {
    return { reply: guardianResult.message, intercepted: true };
  }
  return { reply, intercepted: false };
  ```
- **Severity ladders are tuned** — `info | warning | emergency | crisis`, or whatever the project uses. Don't add or remove levels casually.
- **Category keyword sets are tuned.** Don't trim them to "reduce false positives" without input from whoever owns safety review.
- **`shouldInterrupt` is the contract** for the chat route — when true, the AI response is replaced with the safety message. Don't silently weaken its truthiness rules.
- **Every guardian event writes to the audit log.** Never silence this — the audit log is what gets reviewed for compliance.

### Interview / orchestration engines

If the project has a stateful conversational engine (intent classifier, phase tracker, session state machine):

- **Intent enum changes are breaking.** Adding a new intent without updating downstream consumers (chat route, UI, analytics) ships a partial feature.
- **Session state machines have implicit invariants** (e.g. `active → diagnosing → complete`, no skipping back to `active` from `complete`). Read the transitions before adding a new state.
- **Return-shape preservation:** functions in this layer are called from many places. Adding a field to the return type is fine; renaming or removing one is a refactor that needs explicit scope.

---

## Common pitfalls

- **`tsx watch` / `nodemon` / `uvicorn --reload` doesn't always reload `.env`.** After changing API keys or model names, restart the backend manually. Otherwise the new AI calls run with the old config and produce confusing behavior.
- **Documented model name vs actual model name.** Memory and CLAUDE.md drift faster here than anywhere else. Read the actual `.env` and the actual call site before quoting a model name as authoritative.
- **Audit log is not a debug log.** Don't add chatty audit-log writes for non-safety events; the log gets reviewed for compliance and noise dilutes signal.
- **Vision model timeout is per-model, not total.** A 3-model fallback × 50s = up to 150s on bad days. Route handlers must accept this latency or stream a placeholder / progress event.
- **Image upload contract.** If the project uses base64-over-JSON for image upload, don't switch to multipart without coordinating with all clients. Conversely, if it uses multipart (avoiding base64 bloat), don't add a new endpoint that takes base64 — pick one shape.

---

## Defer-to-user (always ask first)

- **Bumping the SDK version** (`openai`, `@anthropic-ai/sdk`, `google-generativeai`) — minor versions occasionally change response shapes.
- **Replacing a model name** with a "newer / better" one — even when it's a drop-in replacement on paper, real-world latency and refusal patterns differ.
- **Lowering any threshold** in the deterministic safety layer.
- **Editing any prompt template** — even formatting / whitespace. LLM output is sensitive to prompt structure in ways that aren't obvious.
- **Adding or removing guardian keywords / categories.**
- **Changing validator / arbiter veto semantics.**
- **Adding a new code path that bypasses the central AI client.**

---

## Production-grade audit before declaring done

Before claiming a change in this layer is complete:

- **API key never logged.** Search the diff and recent logs for `key=`, `Authorization:`, `Bearer`, the env var name itself.
- **Errors from the AI client surface a user-safe message** but log model + status + truncated prompt server-side. Stack traces don't reach the user.
- **New prompt content reviewed for** persona consistency, jailbreak-resistance, structured-output schema match.
- **Guardian still runs in parallel** with the user-visible response, not sequenced into it.
- **Deterministic engines still deterministic** for any data the change touches.
- **API response shape unchanged** (or coordinated change across clients — see [multiplatform-parity](../multiplatform-parity/SKILL.md)).
- **Model fallback chain still triggers** on the expected error classes.
- **Token / cost budgets** unchanged or explicitly bumped. New prompts that 3× the token count are a behavior change.

If any answer is "no", the change isn't done.

---

## What NOT to do

- **Don't replace a deterministic threshold with model output** to "make the system more flexible".
- **Don't add a "fast path" that skips the validator** when upstream confidence is high.
- **Don't serialize the guardian** into the user-visible response path.
- **Don't add a second AI client wrapper** that bypasses the central one's fallback logic.
- **Don't tweak prompt whitespace** without testing — even adding a blank line can change refusal behavior.
- **Don't log full prompts at INFO level** in production — they often contain user data.
- **Don't catch and silently retry on a non-fallback error class.** Fallback is for rate-limit / quota / timeout — not for `400 invalid request` (which means your prompt is wrong).

---

## Related

- [audit-runner](../audit-runner/SKILL.md) — chunk-by-chunk execution of an LLM-feature security review
- [security-audit](../security-audit/SKILL.md) — trust boundaries around AI input/output
- [implement-feature](../implement-feature/SKILL.md) — patterns to use while building a new AI-powered feature
