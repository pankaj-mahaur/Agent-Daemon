# in-progress/

Drafts not ready for use. Skills here are excluded from installer profiles.

Move a skill here when:

- It's incomplete — frontmatter exists but body/examples need work
- It's experimental — being trialled before promoting to `engineering/` / `productivity/` / `daemon/`
- The trigger phrasing is being tuned and you don't want it auto-firing yet

When promoting OUT of `in-progress/`:

1. Run `node runtime/scripts/lint-skills.mjs` — must pass cleanly.
2. Add the new skill to its target bucket's `README.md`.
3. If it should be installed by default, add the bare name to a profile in `runtime/profiles/profiles.json`.

Nothing here yet.
