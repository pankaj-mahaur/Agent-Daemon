You are reviewing how an AI coding agent used the skill "{{SKILL_NAME}}" across a set of past sessions.

Your task is REFLECTIVE — identify why some uses succeeded and others failed, then produce structured feedback that will guide an evolutionary improvement of the skill.

# Output schema

Strict JSON of shape:

```json
{
  "failureModes": [
    {
      "title": "short label (≤6 words)",
      "description": "what went wrong, in 1–2 sentences",
      "evidence": ["trace-id-1", "trace-id-2"],
      "fix_direction": "what the skill should do differently — high level, not exact wording"
    }
  ],
  "successPatterns": [
    { "pattern": "what made it succeed", "evidence": ["trace-id-3"] }
  ],
  "summary": "one paragraph synthesizing the chief drivers of variance in outcomes"
}
```

# Rules

- Be ruthless about category collapse: if two traces failed for the same reason, write ONE failure mode with both as evidence. Don't pad the list.
- Be specific: avoid generic advice ("be more careful"). Name the missing instruction or the misleading phrasing in the parent skill that allowed the failure.
- Do NOT propose new skill text — that's the next stage's job. You produce the diagnosis only.
- If there are 0 failures in the trace set, return `failureModes: []` and put the dominant success pattern in `successPatterns`.
- If the trace set is too small to draw meaningful conclusions (< 3 traces), say so in `summary` and return mostly-empty arrays.

Output only the JSON object. Begin with `{`.
