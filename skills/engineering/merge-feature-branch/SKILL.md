---
name: merge-feature-branch
description: Use when pulling a shared branch (dev/main/staging) into a long-lived feature branch. Handles known conflict surfaces, dev-base + graft reconstruction, WIP preservation, and merge regression baselines.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Merge Feature Branch

Pull a shared branch (`dev`, `main`, `staging`, etc.) into a long-lived feature branch safely, with conflict-resolution strategies, WIP preservation, and regression baseline comparison.

---

## 1. When to use

Activate this skill when the user says any of:

- "merge dev into my branch"
- "pull dev" / "pull main" / "pull staging"
- "rebase onto main"
- "update my feature branch"
- any merge request while on a long-lived feature branch
- recovery from a mid-merge state (conflict markers present, `MERGE_HEAD` exists)

---

## 2. Pre-flight

Run these four steps **before** touching the working tree.

### 2.1 Confirm merge direction

"Pull dev" is ambiguous. The usual intent is:

```
shared-branch --> feature-branch   (safe, normal)
feature-branch --> shared-branch   (dangerous, deploy-style)
```

**Always confirm direction.** If the user says "pull dev" while on `feature/foo`, the intent is almost certainly `origin/dev -> feature/foo`. If there is any ambiguity, ask before proceeding.

### 2.2 Back up uncommitted WIP

Before any merge operation, preserve every uncommitted change:

```bash
# Save the list of modified/untracked files
git status --porcelain > /tmp/merge-wip-status.txt

# Create a patch of all staged + unstaged changes
git diff HEAD > /tmp/merge-wip-unstaged.patch
git diff --cached > /tmp/merge-wip-staged.patch

# Copy any untracked files to a temp location
git ls-files --others --exclude-standard > /tmp/merge-wip-untracked.txt
```

If the working tree is dirty, either stash or commit WIP before merging:

```bash
git stash push -m "WIP before merge from <shared-branch>"
```

### 2.3 Record recovery point

Save the current HEAD so worst-case recovery is a single command:

```bash
RECOVERY_SHA=$(git rev-parse HEAD)
echo "Recovery point: $RECOVERY_SHA"
```

If the merge goes wrong, the user can recover with:

```bash
git merge --abort
# or, if already committed:
git reset --soft $RECOVERY_SHA
```

### 2.4 Fetch, don't assume

Always fetch before merging. If a merge is already in progress (`MERGE_HEAD` exists), check whether the remote has moved since the merge started:

```bash
git fetch origin

# If mid-merge, compare MERGE_HEAD to remote
if [ -f .git/MERGE_HEAD ]; then
  LOCAL_MERGE=$(cat .git/MERGE_HEAD)
  REMOTE_HEAD=$(git rev-parse origin/<shared-branch>)
  if [ "$LOCAL_MERGE" != "$REMOTE_HEAD" ]; then
    echo "WARNING: Remote has moved since merge started."
    echo "Recommend: abort and redo with fresh remote."
    # git merge --abort && git merge origin/<shared-branch>
  fi
fi
```

**Abort and redo** rather than committing a stale merge.

---

## 3. Known conflict surface

After your first merge on a project, fill in this table with files that consistently conflict. This turns future merges from exploratory into predictable.

```markdown
## Known conflict surface (fill in for your project)

After your first merge, record the files that consistently conflict:

| File | Hunks | Strategy |
|------|-------|----------|
| <!-- e.g. src/styles/globals.css --> | <!-- 1 hunk --> | <!-- Union --> |
| <!-- e.g. src/components/Layout.tsx --> | <!-- 4 hunks --> | <!-- Dev-base + graft --> |
| <!-- e.g. package-lock.json --> | <!-- all --> | <!-- Regenerate --> |
| <!-- e.g. src/config/routes.ts --> | <!-- 2 hunks --> | <!-- Union --> |
```

**How to populate this table:** After resolving a merge, run `git diff --name-only MERGE_HEAD HEAD` and note which files required manual resolution. Record the resolution strategy you used so the next merge is faster.

---

## 4. Conflict resolution strategies

Every conflicting file falls into one of three categories. Pick the right strategy per file.

### 4.1 Union

**When:** Both sides add content independently -- CSS blocks, import statements, config entries, dependency lists, route declarations, enum values.

**Procedure:**

1. Open the conflicting file.
2. Accept **both** sides of each conflict hunk.
3. Deduplicate any entries that appear in both (e.g., the same import added on both branches).
4. Verify ordering is correct (alphabetical imports, logical CSS cascade, etc.).
5. Stage the file.

**Typical files:** stylesheets, barrel exports (`index.ts`), config arrays, route tables, i18n dictionaries.

### 4.2 Dev-base + graft

**When:** The shared branch restructured a file significantly (refactored component, reorganized module, changed patterns), and your feature branch added localized enhancements to the old structure.

**Procedure:**

```bash
# 1. Take the shared branch's version as the base
git show origin/<shared-branch>:path/to/file > path/to/file

# 2. Manually graft your feature-specific additions on top
#    - Open the file
#    - Review your feature branch's changes (use git diff <merge-base>..HEAD -- path/to/file)
#    - Apply your additions to the new structure

# 3. Verify after EACH file before staging
<type-checker> path/to/file   # e.g., tsc --noEmit, mypy, etc.
<linter> path/to/file          # e.g., eslint, ruff, etc.

# 4. Stage only after verification passes
git add path/to/file
```

**Key rule:** Type-check and lint after each file, not after all files. Catching errors one file at a time prevents cascading confusion.

**Typical files:** heavily-modified components, refactored modules, restructured services.

### 4.3 Regenerate

**When:** Lock files, generated manifests, compiled output, auto-generated code. Never hand-merge these.

**Procedure:**

```bash
# 1. Accept theirs (the shared branch version of the config/manifest)
git checkout --theirs <lockfile>

# 2. Regenerate from the merged source-of-truth
<package-manager> install
# Examples:
#   npm install           (generates package-lock.json)
#   yarn install          (generates yarn.lock)
#   pip-compile           (generates requirements.txt)
#   cargo generate-lockfile
#   bundle install        (generates Gemfile.lock)

# 3. Stage the regenerated file
git add <lockfile>
```

**Typical files:** `package-lock.json`, `yarn.lock`, `Pipfile.lock`, `Cargo.lock`, `Gemfile.lock`, compiled CSS/JS bundles, auto-generated API clients, migration snapshots.

---

## 5. Post-merge verification

Run this checklist after resolving all conflicts and before committing.

```
- [ ] Type-check passes          (tsc --noEmit / mypy / cargo check / etc.)
- [ ] Lint passes                (eslint / ruff / clippy / etc.)
- [ ] Build succeeds             (npm run build / make / cargo build / etc.)
- [ ] Import smoke test passes   (app boots without import errors)
- [ ] Pending migrations applied (if applicable: database, schema, config)
- [ ] No leftover conflict markers (grep -r '<<<<<<' src/)
- [ ] No unresolved files        (git diff --check)
```

Adapt this list to the project's toolchain. The goal is: **the merge commit must leave the project in a buildable, lintable, type-safe state.**

---

## 6. Baseline comparison (is it a merge regression?)

When tests fail after the merge, **do not assume the merge caused the failure.**

**Procedure:**

```bash
# 1. Stash the merge state
git stash push -m "merge-in-progress"

# 2. Checkout the pristine shared branch
git checkout origin/<shared-branch>

# 3. Run the exact same tests
<test-command>

# 4. Compare results
#    - If tests fail here too: NOT a merge regression.
#      Flag the failure but do NOT fix it inside the merge commit.
#    - If tests pass here but fail on merge: genuine merge regression.
#      Fix it before committing the merge.

# 5. Return to feature branch and restore merge state
git checkout <feature-branch>
git stash pop
```

**Why this matters:** Fixing pre-existing failures inside a merge commit pollutes the merge diff, makes the merge harder to review, and misattributes the fix. Pre-existing failures should be tracked separately (file an issue, note it in the PR, etc.).

---

## 7. WIP reapply

After the merge commit is finalized, reapply any WIP that was saved in step 2.2.

```bash
# If you used git stash:
git stash pop

# If you used patches:
git apply /tmp/merge-wip-unstaged.patch
git apply /tmp/merge-wip-staged.patch

# Commit WIP as a separate follow-up commit
git add -A
git commit -m "WIP: restore in-progress work after merge"
```

**Why separate commits:** The merge commit should be a clean 2-parent commit that represents only the merge. WIP changes layered on top as follow-up commits keep the history reviewable and the merge revertable.

---

## 8. Commit the merge

Use git's prepared merge message rather than writing one from scratch:

```bash
# Git prepares .git/MERGE_MSG automatically during merge
git commit -F .git/MERGE_MSG
```

**Let pre-commit hooks run.** If hooks fail, fix the issue and re-commit. Do not bypass hooks.

If you need to add context to the merge message, edit `.git/MERGE_MSG` before committing rather than replacing it entirely. The default message includes the branch names and any conflict notes, which are valuable for history.

---

## 9. What NOT to do

| Action | Why it's dangerous |
|--------|--------------------|
| Merge in the wrong direction without explicit confirmation | Pushing unreviewed feature code into a shared branch can break everyone |
| Push after merge without user confirmation | The user may want to review the merge result locally first |
| `git commit --no-verify` to skip hooks | Hooks exist to catch problems; skipping them hides merge-induced breakage |
| `git reset --hard` to undo a bad merge | Destroys uncommitted work. Use `git merge --abort` (pre-commit) or `git reset --soft` (post-commit) instead |
| Fix pre-existing test failures inside the merge commit | Pollutes the merge diff, misattributes the fix, and makes the merge harder to revert |
| Hand-edit lock files or generated artifacts | They will be inconsistent with the source-of-truth. Always regenerate |
| Commit unresolved conflict markers | `grep -r '<<<<<<' src/` should return nothing before you commit |
| Force-push the feature branch after merge | Rewrites shared history if anyone else has the branch checked out |

---

## Quick reference: merge flow

```
1. Confirm direction (shared -> feature)
2. Fetch origin
3. Save WIP (stash / patch)
4. Record recovery SHA
5. git merge origin/<shared-branch>
6. For each conflict:
   a. Identify strategy (Union / Dev-base+graft / Regenerate)
   b. Resolve
   c. Type-check + lint the file
   d. Stage
7. Verify (build, tests, no conflict markers)
8. Baseline comparison if tests fail
9. Commit with MERGE_MSG
10. Reapply WIP as follow-up commit
11. Report result to user (do NOT push without confirmation)
```
