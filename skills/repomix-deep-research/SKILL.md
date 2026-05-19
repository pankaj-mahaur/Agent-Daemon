---
name: repomix-deep-research
description: Workflow for deep-researching a remote GitHub repo via repomix's pack → grep → read flow. Use when the user pastes a github.com URL and asks "study this", "what's worth adopting", "compare against ours", or you need to evaluate a repo for vendoring. Beats WebFetch for any task that touches 3+ files from the same repo — pack-once-grep-many is cheaper than fetch-each-file.
---

# Deep-research a remote repo via repomix

## When to use

- User says "look at github.com/X/Y, what's worth borrowing"
- User says "compare this repo against ours" or "is this worth adopting"
- You need to read 3+ files from the same remote repo
- You want a stable snapshot to grep + read across many turns

## When NOT to use

- You need exactly one file → use `WebFetch` on the raw URL
- The repo is private and requires auth → `gh` CLI is better
- You need git history / commits / PRs → `gh` CLI
- Local repo → use `Read` + `Grep` directly

## The pipeline

```
┌────────────────────────────────────────────────────────┐
│ 1. mcp__plugin_repomix-mcp_repomix__pack_remote_repository                   │
│    → packs the whole repo into one file, returns outputId       │
└────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────┐
│ 2. mcp__plugin_repomix-mcp_repomix__grep_repomix_output                      │
│    → search by regex, returns matching lines + context  │
│    Use to find specific files, frontmatter, patterns    │
└────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────┐
│ 3. mcp__plugin_repomix-mcp_repomix__read_repomix_output                      │
│    → read specific line ranges of the packed file       │
│    Use to read full files once you know where they are  │
└────────────────────────────────────────────────────────┘
```

## Step 1: Pack the repo

```js
mcp__plugin_repomix-mcp_repomix__pack_remote_repository({
  remote: "owner/repo",          // or full URL with /tree/branch
  style: "markdown",              // markdown / xml / json / plain
  topFilesLength: 20              // shows largest 20 files in metrics
})
```

**Style choice:**
- `markdown` — human-readable, code blocks. Best for general analysis.
- `xml` — `<file path="...">` wrapping. Best when grep-ing for file paths.
- `json` — machine-readable. Best when you'll parse programmatically.
- `plain` — minimal separators. Lowest token cost.

**Cost:** one tool call returns the full repo packed (typical: 10K–80K tokens for a skills/agent-tooling repo, 100K+ for a real codebase). Save the `outputId` — every subsequent call references it.

Read the returned `metrics.topFiles` first — gives you the size profile. Files over 5K tokens are usually README / large skill docs worth reading whole.

## Step 2: Find what you need with grep

Use focused regexes. Don't read the whole pack.

**Pattern: find skill frontmatter**

```js
mcp__plugin_repomix-mcp_repomix__grep_repomix_output({
  outputId: "...",
  pattern: "^---$|^name:|^description:",
  afterLines: 1
})
```

**Pattern: find specific file content**

```js
mcp__plugin_repomix-mcp_repomix__grep_repomix_output({
  outputId: "...",
  pattern: "path=\"skills/.+/SKILL.md\""
})
```

**Pattern: find architectural keywords**

```js
mcp__plugin_repomix-mcp_repomix__grep_repomix_output({
  outputId: "...",
  pattern: "(hook|plugin|skill).*config",
  ignoreCase: true,
  beforeLines: 2,
  afterLines: 5
})
```

The output gives you line numbers. Use those for Step 3.

## Step 3: Read in line ranges

```js
mcp__plugin_repomix-mcp_repomix__read_repomix_output({
  outputId: "...",
  startLine: 1232,
  endLine: 1470
})
```

Slice precisely. Don't read 4000 lines when you need 200. Each read counts against context.

## Typical investigation flow

Real example — researching `mattpocock/skills` to decide what to borrow:

```
1. pack_remote_repository(remote="mattpocock/skills", style="markdown")
   → outputId="abc123", 66 files, 42K tokens, top file is README.md (2.8K tokens)

2. grep for skill frontmatter (^---$|^name:|^description:)
   → 119 matches across all SKILL.md files → full catalog in one call

3. read_repomix_output(start=1, end=200)
   → directory structure + plugin.json (declares which skills are exported)

4. read_repomix_output(start=3816, end=3955)
   → caveman skill + handoff skill + write-a-skill
   → enough content to draft adoption decisions

5. read_repomix_output(start=200, end=520)
   → README.md (the project's philosophy)

Total: 1 pack + 1 grep + 3 reads = 5 tool calls.
Compared to WebFetch per-file: would be 66+ calls.
```

## Picking outputs

Keep `outputId` strings in your working memory across turns. They stay valid until the MCP server restarts (typically hours). You can re-grep / re-read the same packed snapshot across many turns without re-packing.

**Don't re-pack the same repo** unless you need a fresh snapshot (the upstream changed). Each `pack_remote_repository` clone+pack costs 5-30s.

## When repo is too big

For repos > 100K tokens packed:

1. Use `includePatterns` to narrow before packing:
   ```js
   pack_remote_repository({
     remote: "huge/repo",
     includePatterns: "skills/**,docs/**,README.md"
   })
   ```
2. Use `compress: true` to enable tree-sitter compression (~70% reduction, preserves semantic structure for code).
3. Split into per-area packs (one for `skills/`, one for `src/`, one for `tests/`).

## Adoption-decision template

After research, write your conclusions in this shape:

```markdown
## Repo: <owner>/<repo>
**Verdict:** [adopt | partial-import | reject]
**Why:** <2-3 sentences>

### Worth borrowing (with priority)
| Priority | Item | File path in upstream | Why | Effort |
|---|---|---|---|---|

### Skip
| Item | Why skip |
|---|---|

### Architectural ideas
1. ...
```

## Related patterns

- **Skim before deep-dive** — always read README + plugin.json / package.json before reading individual files. Architecture context first.
- **One pack, many reads** — never re-pack mid-investigation.
- **Adoption discipline** — split borrowings into "verbatim import", "hand-merge into ours", "skip". Document the skip list too.

## Anti-patterns

- ❌ `WebFetch` on every individual file from the same repo — expensive, no cross-file grep
- ❌ Cloning the repo locally — repomix already does this in its sandbox
- ❌ Re-packing the same repo multiple times in one session — outputId stays valid, reuse it
- ❌ Reading the entire packed output sequentially — grep first, narrow to ranges
