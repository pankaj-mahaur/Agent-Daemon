# productivity/

Workflow tools and agent-self-improvement skills. These fire when the work *about* the work matters — capturing learning, parsing LLM output, building reusable indexes.

| Skill | What it does |
|---|---|
| [agent-self-improve](agent-self-improve/) | Meta-skill — discipline an agent follows so each session leaves clean signal for the digest pipeline. Includes write-a-skill template. |
| [audit-every-attempt](audit-every-attempt/) | Write an audit ledger entry on every code path — success, failure, skip, error. Future-you needs to distinguish "didn't run" from "ran, did nothing". |
| [graphify](graphify/) | Build knowledge graphs from code, docs, papers, images |
| [llm-output-lenient-parsing](llm-output-lenient-parsing/) | Strict-first then fallback chain for parsing LLM output where Claude drifts the strict format (colon for hyphen, YAML for JSON, code-fenced vs bare). |
| [qmd](qmd/) | Hybrid BM25 + vector + HyDE search across code AND documentation |
| [regex-clause-anchored-extractors](regex-clause-anchored-extractors/) | Anchor natural-language regex to clause boundaries (`^|[.!?]\s+`) to stop mid-sentence fragment matches. Use when mining transcripts/logs/prose for phrases. |
| [repomix-deep-research](repomix-deep-research/) | Workflow for deep-researching remote GitHub repos via repomix pack → grep → read. Use when evaluating any repo for vendoring/import. |

## Also flat-vendored from `mattpocock/skills`

These 5 are productivity-bucket-by-purpose but live flat under `skills/` because they carry upstream `source:` frontmatter:

- [caveman](../caveman/) — ultra-compressed output mode
- [handoff](../handoff/) — dual-write handoff doc on session close
- [grill-me](../grill-me/) — pre-implementation interview
- [grill-with-docs](../grill-with-docs/) — grill-me + memory + constitution cross-ref
- [zoom-out](../zoom-out/) — ask for the higher-level architectural picture
