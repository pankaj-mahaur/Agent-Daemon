---
name: llm-output-lenient-parsing
description: Pattern for parsing LLM output where you specified a strict format but the model drifts (colon for hyphen, YAML for JSON, fenced for bare, single for double quotes) ~30-50% of the time. Strict parsers reject silently. Use when consuming structured blocks an LLM produces (digest blocks, JSON manifests, action plans). Build a fallback chain: strip fences → strict JSON → tolerant YAML → coerce + retry.
---

# Lenient parsing for LLM-emitted structured output

## The problem

You ask the LLM: "Emit a `<my-tag>{"key": "value"}</my-tag>` block at the end."

Real-world transcripts show the LLM emits **at least 4 variants** per session:

| What you asked | What you actually get |
|---|---|
| `<my-tag>...` | `<my:tag>...` (colon) |
| `<my-tag>...` | `<my_tag>...` (underscore) |
| JSON payload | YAML payload |
| Bare payload | ```` ```json\n...\n``` ```` (fenced) |
| `{"key":"value"}` | `{key: "value"}` (unquoted keys) |
| `'value'` | `"value"` (or vice versa) |

Strict parsers reject all of it silently. The user thinks the tool is broken when really the model is drifting.

## The fix

Build a **fallback chain** for both the tag matcher and the payload parser.

### Tag matcher

Use a character class that accepts every separator the LLM has ever used:

```js
// JavaScript
const TAG_RE = /<my[-:_]tag>\s*([\s\S]*?)\s*<\/my[-:_]tag>/i;
```

```python
# Python
TAG_RE = re.compile(r'<my[-:_]tag>\s*(.*?)\s*</my[-:_]tag>', re.DOTALL | re.IGNORECASE)
```

The closing tag must accept the same set of separators independently — the LLM sometimes mismatches them mid-block.

### Payload parser

Walk through these strategies in order:

1. **Strip code fences first** — `^```(?:json|yaml|yml)?\n([\s\S]*)\n```$` → use capture group 1
2. **Try strict JSON** — if it parses, you're done
3. **Try a lenient YAML parser** — for the keys-without-quotes / dashes-for-lists shape Claude uses when "translating to YAML"
4. **Try a JSON-coercion pass** — quote unquoted keys, normalize single to double quotes — try JSON again
5. **Last resort: return `{ok: false, error: <details>}`** — never silently swallow

```js
function parsePayload(raw) {
  const trimmed = raw.trim();
  // 1. Strip code fences
  const unfenced = trimmed.replace(/^```(?:json|yaml|yml)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();

  // 2. Looks like JSON → try it
  if (unfenced.startsWith("{") || unfenced.startsWith("[")) {
    try { return { ok: true, value: JSON.parse(unfenced) }; } catch {}
  }

  // 3. Try tolerant YAML
  const yaml = tryParseYaml(unfenced);
  if (yaml.ok) return yaml;

  // 4. Last attempt — coerce single quotes / unquoted keys, try JSON again
  try {
    const coerced = unfenced
      .replace(/'([^']*)'/g, '"$1"')
      .replace(/(\w+):/g, '"$1":');
    return { ok: true, value: JSON.parse(coerced) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

### When to write a hand-rolled YAML parser vs using a dep

For digest-block-style schemas (single top-level key + list of objects), ~30 LoC of hand-rolled YAML covers 90% of what the LLM emits. Don't pull in `js-yaml` or `pyyaml` if the schema is fixed and small — you'll spend more time on the dep than on the parser.

For arbitrary nested YAML, use the standard library.

## What to log

When a fallback fires, log it to stderr (or your audit system) — that's the signal to either tighten the prompt or accept that this format drift is permanent. Example:

```
[my-tool] parsed via yaml-fallback (json strict failed: Unexpected token 'l' in JSON at position 7)
```

After 3 sessions of fallback fires, your "strict format" prompt is no longer strict. Update the parser, not the prompt.

## Multiple blocks in one response

If the model emits multiple blocks (sometimes it iterates mid-message), take the **last** one — that's the agent's final answer. Use a global regex + `array.at(-1)`:

```js
const matches = [...text.matchAll(TAG_RE_GLOBAL)];
const last = matches.at(-1);
```

The old "take the first match" code (which `regex.match()` returns by default) silently picks stale intermediate output.

## Test fixtures

Always include in your test suite:
- Canonical correct form
- Each known drift variant (colon/underscore tag, YAML payload, fenced block, single quotes)
- Multi-block input (last wins)
- Empty / no-block input (returns `found: false`, not throws)

Drift cases come from real transcripts — don't synthesize them. Save the transcript that broke parsing as `test/fixtures/<bug-id>.jsonl` and replay against it.

## Related patterns

- **harness-enforced capture** > LLM-emitted blocks for critical signal. Use this skill for *bonus* capture; don't make it the spine.
- **audit-every-attempt** — log every parse run (success or failure) so you can measure drift rate over time.

## Anti-patterns

- ❌ `JSON.parse(payload)` with no try/catch — silent rejection
- ❌ Tightening the prompt and hoping the next model release behaves — Claude 4.7 drifts differently than 4.5
- ❌ Single-block extraction via `regex.match()` — gives you the first match, you want the last
- ❌ Hand-coding YAML parsing for arbitrary user input — use a library, but only if you actually need general YAML
