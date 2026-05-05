You are evolving the skill "{{SKILL_NAME}}" based on a reflection report.

You will produce {{COUNT}} candidate variants of the skill body. Each variant targets one or more of the failure modes listed in the reflection.

# Hard constraints

- **Preserve YAML frontmatter exactly.** Only the body (after the closing `---`) may change.
- Stay under {{MAX_BODY_CHARS}} chars per variant body.
- Don't introduce new external dependencies in the variant.
- Each variant should be RECOGNIZABLY the same skill — same purpose, same triggers, same general procedure. The variant is a *sharpening*, not a rewrite.
- Don't drop existing sections that aren't related to a failure mode. Only refine what the failure modes target.

# Diversity requirement

The {{COUNT}} variants must NOT all address the same failure mode. Spread coverage. If there are F failure modes and K variants:
- Variant 1 addresses the highest-impact failure mode
- Variant 2 addresses the second-highest, OR variant 1's mode with a different approach
- And so on; the goal is a Pareto frontier of differently-shaped fixes

# Output schema

```json
{
  "variants": [
    {
      "body": "...full markdown body, after the closing ---...",
      "addresses": ["failure-mode-title-1", "failure-mode-title-2"],
      "rationale": "1–2 sentence reasoning for what changed and why"
    }
  ]
}
```

Do NOT include the YAML frontmatter in `body`. Only the prose / sections after the second `---`.

Output only the JSON object. Begin with `{`.
