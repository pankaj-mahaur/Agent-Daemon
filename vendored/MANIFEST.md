# Vendored Upstream Manifest

This directory holds **read-only snapshots** of upstream projects we draw inspiration or content from. The actual clones are gitignored — only this manifest and `fetch.mjs` are tracked. Re-hydrate with:

```sh
node vendored/fetch.mjs
```

---

## everything-claude-code

| Field | Value |
|---|---|
| Source | https://github.com/affaan-m/everything-claude-code |
| Pinned commit | `841beea45cb25ba51f29fa45b7e272938d19b80a` |
| Pin date | 2026-04-30 |
| License | MIT |
| Author | Affaan M |
| Local path | `vendored/everything-claude-code/` |
| Imported into our daemon | skills (Stage 2), hooks (Stage 3), install profile shape (Stage 4), rules merged into constitution (Stage 5) |

**Stripped from local snapshot** (out of scope for our daemon):

- `ecc2/` — Rust control plane
- `ecc_dashboard.py`, `pyproject.toml` — Python Tkinter dashboard
- `README.zh-CN.md`, `EVALUATION.md`, `SOUL.md`, `SPONSORS.md`, `SPONSORING.md`, `REPO-ASSESSMENT.md` — multilingual / marketing

**Kept in snapshot but not ported this round** (deferred to a future pass):

- `.codebuddy/`, `.kiro/`, `.trae/`, `.gemini/`, `.opencode/` — alternative-harness adapters

Attribution lives in `ATTRIBUTION.md` at repo root.
