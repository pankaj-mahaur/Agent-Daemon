---
name: ad-state-migrate
description: "Use when the user wants to move Agent Daemon (ad) to another computer or between the OSes of a dual boot — \"move ad to my new laptop\", \"export my ad memory\", \"import ad state\", \"Windows se Linux pe ad le jao\", \"naye computer pe ad setup\", \"ad ka data transfer karo\". Runs ad state export on the side being left and ad state import on the other, proves recall, explains review, re-sign-in, ad init and the dual-boot checkout rule. Never copies ~/.agent-daemon by hand."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read
disable-model-invocation: false
---

# Move ad to another computer

This is **not** `ad migrate` (that only renames ad's engine folder on one machine). Moving ad means: export on the side being left, carry one file privately, import on the other side, prove recall, then the user reviews, signs in and re-runs `ad init`. Quote ad's output; never paraphrase a pass.

## Never

- Never extract or edit a bundle by hand, and never copy `~/.agent-daemon` or the engine's folder directly.
- Never read `secrets/`, `auth.json` or another tool's credential store, and never ask for a key in chat.
- Never delete or change the state on the side being left.
- Never claim the move worked without `ad state verify --import` output.
- Never use `--on-conflict take-theirs`, `--force-tracked` or `--accept-held` without the user's explicit yes for this import.
- Never run `ad review --import`, `--accept-all` or `ad memory promote` yourself: the user does, in their own terminal.
- Never put the bundle in a synced or shared cloud folder, or in git.

## 0. Which side, and is this a repeat move?

Ask once: "Are we on the side you're leaving (export), or the side you're moving to (import)? Have you moved between these two before (for example, the two OSes of a dual boot)?" Check `ad --version` on both sides and update the older one first. If you run inside ad's own tool shell, `ad state` refuses ("… doesn't run them from an agent's shell"): ask the user to run each command in their own terminal and paste back the output.

## Side being left: export

1. `ad state inspect --all-projects` → show the projects and classes. Ask which projects to take, and whether to add `--include global-memory` (included with `--all-projects`), `--include engine-rollouts` (large, view-only), `--include tui-history` or `--include project-journals`.
2. `ad state export --out <path>.adstate --project <dir>` (one `--project` per project, or `--all-projects`). If it stops on items that look like keys, show the list it printed and let the user choose: `--redact` (cleans the export only) or `ad memory redact <table>:<id>` (cleans their own copy, in their terminal).
3. `ad state verify <path>.adstate` → must say "no problem found". On a problem: stop, show it, and retry at most once with different flags.
4. Carry the file: it is **not encrypted** (the export says so). Use the user's own disk: for a dual boot, a partition both OSes can read; otherwise a USB drive.

## Side being moved to: import

5. Install ad (`docs/installation-guide.md`). Dual boot: **one checkout per OS** (or a global install per OS): a shared checkout's native SQLite module, rebuilt for one OS, breaks the other. Then `ad doctor` shows the SQLite driver working.
6. Clone the projects with git if they aren't there yet: the bundle carries ad's state, not source code.
7. `ad state import <path>.adstate --dry-run --search <dir>` → read the plan with the user: projects not mapped (`--map <name>=<dir>`), files held back, conflicts. **First move:** keep the default (`--on-conflict refuse`); the user decides each conflict. **Repeat move:** `--on-conflict keep-both` (memory merges and dedups; a differing file arrives as `<name>.imported-<date>` beside theirs).
8. `ad state import <path>.adstate --map <name>=<dir> --on-conflict keep-both` (the flags the plan needed) → note the import id it prints.
9. `ad state verify --import <importId>` → "Recall: N/N lessons found in <project>" for each project. Fewer than N: report it plainly, offer `ad state rollback <importId>`, and don't call the move done.
10. Review is the **user's** step: imported lessons and facts are searchable now but reach sessions only after they accept them. Tell them to run `ad review --import <importId>` (or `--accept-all`, typing the import id) in their own terminal; a fact meant for every project still needs `ad memory promote`.
11. Sign in again: `ad auth list`; for each account that needs it, the user runs `ad auth login <provider> --label <label>` (a browser or a hidden prompt).
12. `ad init` in each mapped project (hooks and managed blocks; engine folders rebuild on first start).
13. Schedules come in switched off: `ad schedule list`, then `ad schedule enable <id>` for the ones wanted; `ad service install` if jobs should run here. Skills: show the reinstall list from the import **with its sources** (some are git URLs) and install only what the user confirms.
14. Undo if needed: `ad state rollback <importId>` removes only what the import added and keeps anything changed since; the side left behind was never changed.

## Report

Versions on both sides, projects mapped (and any left unmapped), what came in, the recall result word for word, items waiting for review or held back, accounts still to sign in, and the manual steps left (review, `ad init`, schedules).
