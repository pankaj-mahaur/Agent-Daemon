# Future harnesses

These IDE harnesses are present in the [vendored ECC snapshot](../vendored/everything-claude-code/) but are **not** ported into the daemon yet. Listed here so the next person picking up cross-harness work knows where to look.

| Harness | Vendored path | Notable artifacts |
|---|---|---|
| Kiro | `vendored/everything-claude-code/.kiro/` | Full agents + hooks + skills + steering + settings + scripts |
| Trae | `vendored/everything-claude-code/.trae/` | install/uninstall scripts |
| CodeBuddy | `vendored/everything-claude-code/.codebuddy/` | install JS + shell |
| OpenCode | `vendored/everything-claude-code/.opencode/` | command scaffolds |
| Gemini | `vendored/everything-claude-code/.gemini/` | GEMINI.md primer |

## What porting looks like

Use the [Codex adapter](../adapters/codex/) as the template:

1. New folder `adapters/<harness>/` with a README pointing at the vendored snapshot.
2. A starter config (`config.example.<ext>`) trimmed to the daemon's MCP set + profile matrix.
3. (Stretch) An `adapt.{sh,ps1}` script that emits per-skill files for the harness from `skills/<name>/SKILL.md`.

The vendored snapshot is the source-of-truth — re-run `node vendored/fetch.mjs --force` to refresh it before porting.

## Why these aren't done yet

User scope right now is Claude Code primary + Codex secondary. The other harnesses are real but not in the immediate path. Adding them costs ~half a day each (config research + docs + smoke test) and we'd rather ship one solid Codex story than five half-done ones.
