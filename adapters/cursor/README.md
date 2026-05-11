# Cursor Adapter

Wires agent-daemon's hooks and skills into [Cursor](https://cursor.com). Cursor uses a different hook schema and a different rule format (`.mdc`) than Claude Code, so we ship two artifacts here:

- [`hooks.json`](hooks.json) — Cursor v1 hook bindings that route to our `ad hook <name>` Node helpers.
- [`adapt.mjs`](adapt.mjs) — converts a `SKILL.md` (our format) into a `.mdc` rule file (Cursor's format).

Reference upstream: `vendored/everything-claude-code/.cursor/` (MIT) — see [ATTRIBUTION.md](../../ATTRIBUTION.md).

## Install

### Hooks

```sh
# Per-project (recommended)
mkdir -p .cursor
cp adapters/cursor/hooks.json .cursor/hooks.json

# Or global
mkdir -p ~/.cursor
cp adapters/cursor/hooks.json ~/.cursor/hooks.json
```

Requires `ad` (alias for `agent-daemon`) on `PATH`. From repo root:

```sh
cd runtime && npm install && npm link
```

After install, Cursor will fire `sessionStart`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `beforeMCPExecution`, `sessionEnd`, and `preCompact` against `ad`. The same handlers Claude Code uses — Cursor wraps an identical stdin/stdout protocol.

### Skills → Rules

Convert one skill at a time:

```sh
node adapters/cursor/adapt.mjs skills/debug-triage > .cursor/rules/debug-triage.mdc
```

Or batch all skills:

```sh
# Our 36 curated skills only (skips the 181 vendored ECC imports)
node adapters/cursor/adapt.mjs --core --out .cursor/rules

# Everything (our + vendored)
node adapters/cursor/adapt.mjs --all --out .cursor/rules
```

Each `.mdc` carries `alwaysApply: false` so Cursor auto-routes based on the `description` trigger (matches our `Use when ...` convention).

## What we don't port

| ECC hook | Why skipped |
|---|---|
| `beforeReadFile`, `beforeTabFileRead` | Cursor-specific; we treat secret detection at the constitution layer instead. |
| `afterTabFileEdit` | Tab is a Cursor-only surface; our `afterFileEdit` covers the cases we care about. |
| `beforeSubmitPrompt` | Daemon doesn't yet do prompt-time secret scanning. Track in `docs/future-harnesses.md`. |
| `subagentStart` / `subagentStop` | We track multi-agent work via `ad team` lifecycle, not Cursor's subagent events. |
| `stop` | Redundant with our `sessionEnd` digest. |

## Verify

```sh
# Hook smoke (matches Claude Code behavior)
echo '{"command":"git push --no-verify"}' | ad hook bash-pre
# → {"decision":"block","reason":"Refusing to skip git hooks..."}

# Rule conversion
node adapters/cursor/adapt.mjs skills/debug-triage | head -5
# → ---
#    description: "..."
#    alwaysApply: false
#    ---
```

## Status

Reference-grade and tested ([runtime/test/cursor-adapt.test.mjs](../../runtime/test/cursor-adapt.test.mjs)). Cursor's hook schema may evolve — pin compatibility to v1 today; bump when v2 lands.
