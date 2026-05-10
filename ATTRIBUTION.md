# Attribution

Portions of this project draw on upstream open-source work. We are grateful to those authors.

## everything-claude-code

- **Project:** [everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- **Author:** Affaan M
- **License:** MIT
- **Pinned commit:** `841beea45cb25ba51f29fa45b7e272938d19b80a` (2026-04-30)

What we use:

- **Skills** — 181 skills imported into [skills/](skills/), each carrying a `source:` frontmatter line pointing back to upstream.
- **Hook patterns** — `before-shell-execution.js`, `after-shell-execution.js`, `after-file-edit.js`, `before-mcp-execution.js` reimplemented as Node helpers under [runtime/src/hooks/](runtime/src/hooks/) and exposed via `ad hook <name>`. New JSON configs in [hooks/](hooks/): `pre-tool-use-shell-guard`, `post-tool-use-shell-log`, `post-tool-use-file-edit-lint`, `pre-tool-use-mcp-audit`.
- **Install profile shape** — [runtime/profiles/profiles.json](runtime/profiles/profiles.json) adopted from `.manifests/install-profiles.json`. Trimmed to `minimal` / `developer` / `security`.
- **Codex adapter** — [adapters/codex/config.example.toml](adapters/codex/config.example.toml) adapted from ECC's `.codex/config.toml`.
- **Constitution review** — ECC's `.claude/rules/everything-claude-code-guardrails.md` and `node.md` were reviewed against our [constitution/core.md](constitution/core.md) and [constitution/safety.md](constitution/safety.md). No net-new rules merged — ECC's guardrails are project-specific (camelCase file naming, conventional commits, hybrid module org), and our `--no-verify` / push / destructive-op rules are already stricter. Recorded for future reference.
- **Deferred harnesses** — Kiro / Trae / CodeBuddy / OpenCode / Gemini packs left in the vendored snapshot, see [docs/future-harnesses.md](docs/future-harnesses.md).

The full upstream snapshot can be re-hydrated locally via `node vendored/fetch.mjs` (the snapshot itself is gitignored — see [vendored/MANIFEST.md](vendored/MANIFEST.md)).

The MIT license terms from upstream apply to the imported files; our own additions are licensed under our repo's [LICENSE](LICENSE).
