---
name: zoom-out
description: Tell the agent to zoom out and give broader context or a higher-level perspective. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture. Triggers on "zoom out", "give me the bigger picture", "where does this fit", "I don't know this area".
source: vendored from mattpocock/skills (MIT)
---

# Zoom Out

I don't know this area of code well. Go up a layer of abstraction. Give me a map of all the relevant modules and callers, using the project's domain glossary vocabulary (from `.agent-daemon/memory/techContext.md` / `systemPatterns.md` if present).

## What I want

1. **What is this module's job?** One sentence.
2. **Who calls it?** List of callers with one-line purpose each.
3. **What does it call?** Direct dependencies with one-line purpose each.
4. **Where does it sit?** Architecturally — frontend/backend/runtime/CLI/etc.
5. **What's the seam?** What interface boundary does this module live behind?
6. **What's NOT obvious?** Anything I'd miss reading just this file.

## What I don't want

- Line-by-line code walkthrough
- The full call graph
- Implementation details
- File paths without context
