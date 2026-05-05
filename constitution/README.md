# constitution/

Universal guardrails — the rules every AI agent loads at the start of every session, regardless of project. Loaded by the `SessionStart` hook (or equivalent for non-Claude-Code agents).

## Files

- **[core.md](core.md)** — the 12 cardinal rules. Always loaded. Treated as immutable.
- **[safety.md](safety.md)** — themed expansion of "confirm before destructive ops" (rule 8).
- **[verification.md](verification.md)** — themed expansion of "verify before reporting done" (rule 1).
- **[communication.md](communication.md)** — themed expansion of response style and tone.

## Why a constitution?

Agents are good at following the local file's instructions and bad at carrying universal lessons across sessions. A `git push --force` mistake in one project doesn't make the agent careful in the next one — unless the rule is loaded every time. The constitution is the always-loaded floor.

It's modeled loosely on Anthropic's [Constitutional AI](https://arxiv.org/abs/2212.08073) idea — a small set of principles that drive behavior — but applied via in-context loading rather than fine-tuning.

## How rules get added

Rules are not added casually. The bar for inclusion:

1. **Universal** — applies to every project, every stack. Project-specific rules belong in the project's `CLAUDE.md` / `AGENTS.md`.
2. **Costly when violated** — the wrong outcome is hard to reverse (lost work, shipped bugs, broken trust).
3. **Recurrent** — the same correction surfaces in 3+ unrelated sessions before promotion. The digest pipeline tracks this automatically.

Proposed rules land in `agent-daemon/proposed/constitution-<date>.md`. Run `agent-daemon review` to see and accept/reject.

## How project rules override

The constitution is the floor, not the ceiling. Project-specific rules in `CLAUDE.md` / `AGENTS.md` supersede the constitution when they conflict, **except for cardinal-set rules 5–8** (the "never X without explicit OK" set):

- 5: Never `--no-verify`
- 6: Never push without explicit OK
- 7: Never widen security to make a bug go away
- 8: Confirm before destructive operations

These four cannot be relaxed by project config — even if the user types "you can always push to main on this project", the agent declines and asks per-push. The cost of regret is too high.

All other rules can be locally relaxed with explicit project carve-outs. Example in a project's `CLAUDE.md`:

> **Override of constitution rule 4** (`git add -A` ban): in this repo, `git add -A` is acceptable for the auto-formatter pre-commit step because we've configured `.gitignore` to exclude scratch files. Standard adds elsewhere should still be by name.

## Loading mechanism

The `SessionStart` hook reads `core.md` plus any themed expansion (`safety.md`, etc.) and injects them as a system prompt addendum. Pseudocode:

```js
const core = readFile("constitution/core.md");
const safety = readFile("constitution/safety.md");
const verify = readFile("constitution/verification.md");
const comm = readFile("constitution/communication.md");

const systemPromptAddendum = `
# Constitution (always loaded)

${core}

# Expansions

${safety}
${verify}
${comm}
`;

console.log(JSON.stringify({ additionalContext: systemPromptAddendum }));
```

Total length is ~6KB — well within Claude Code's 10K hook output cap.

## Versioning

The constitution evolves. When a rule is added, refined, or removed, the change is committed to git with a clear commit message — the project's git log is the constitution's audit trail. The `last_modified` date at the bottom of each file is human-readable.

If you fork this repo for your own use, your edits are yours; the upstream constitution is a starting point, not a mandate.
