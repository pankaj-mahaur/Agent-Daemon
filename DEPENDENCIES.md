# Dependencies

Most skills have zero external dependencies. Two skills require specific tools:

| Skill | Required | Install Command |
|-------|----------|-----------------|
| diagnose-fetch-failure | None | — |
| graphify | Python 3.9+ | `pip install graphifyy` |
| qmd | Node.js 18+ | `npm install -g @tobilu/qmd` |
| seed-data | None | — |
| review-slice | None | — |
| merge-feature-branch | None | — |
| security-audit | None | — |
| production-readiness | None | — |
| optimization-audit | None | — |
| dead-code-review | None | — |
| docs-sync-audit | None | — |

## Notes

- **graphify** uses the Python package `graphifyy` (note the double y). It requires Python 3.9 or later and installs NetworkX, graspologic, and other graph analysis libraries.
- **qmd** is a Node.js CLI and MCP server for searching markdown files. After installing, index your markdown with `qmd collection add ~/path/to/docs --name myname && qmd embed`.
- All other skills are pure markdown instructions with no runtime dependencies.
