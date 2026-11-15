# Your learnings: list, show, edit, forget, export, import

Everything memory learned from your corrections is yours to see and change. The same
commands work as `ad learnings …` and `npx agent-daemon-memory learnings …`.

| Command | What it does | Where it runs |
|---|---|---|
| `learnings list` | This project's learnings in use or waiting for review, plus your accepted all-project ones. `--status accepted\|provisional\|pending\|flagged\|hidden\|archived\|rejected\|superseded\|all`, `--json`, `--limit N`. | anywhere |
| `learnings list --all-projects` | Every project's learnings. | your own terminal |
| `learnings show <number>` | One learning: its words, where it came from, when it was saved and accepted, how often it was recalled and said again after you accepted it, and its rule. | anywhere |
| `learnings edit <number>` | Opens the words in your editor (`VISUAL`, `EDITOR`, else Notepad on Windows and `vi` elsewhere), or takes `--text "<new words>"`. | your own terminal |
| `learnings forget <number>` | Removes a learning for good once you type its number back. | your own terminal |
| `learnings export [--out <file>] [--force]` | Writes your accepted learnings to a file (`ad-learnings.json` by default) for your own private repository. | your own terminal |
| `learnings import <file>` | Brings a learnings file in. Every learning waits for your review. | your own terminal |

"Your own terminal" means a terminal you typed the command into, not an agent's shell or a
script: the same check `review` uses. Run from an agent's shell, `list` and `show` show
this project's learnings with any secret masked, a held-back learning's reason instead of
its words, and no command that changes a learning.

## Editing

- An **accepted** learning keeps its place: the new words become a new accepted learning
  (`#12 is now #31`) and the old words are kept as history, never shown to your agents.
  A rule made from it moves to the new number and keeps the reason it was approved with.
- A learning that **waits for review** (or was in use before review) changes in place and
  waits for review again.
- The new words pass the same checks as `remember`: a secret, or words that read like an
  instruction to the agent, are refused and nothing changes.
- The editor must wait until you close the file. VS Code: set `EDITOR="code --wait"`. If
  the editor returns at once, nothing changes and the message says so.

## Forgetting

`learnings forget <number>` is the same as `forget <number>`. An accepted learning goes
for good only after you type its number back. Its older wordings go with it, and so do the
lines that hold its words in the capture journals and proposal files (other lines stay). A
file git tracks is listed, not changed. A rule made from it keeps asking or stopping until
you remove the rule.

## Export and import

The export holds only accepted learnings, with their words, category, scope and rules.
It holds no ids, paths, tags, evidence or counts; secrets are masked, your home folder
becomes `~` and your account name `<user>`; a learning that still looks like it holds a
secret is left out. The file holds your learnings' words: keep it in a private repository.
ad never pushes it.

An import adds each learning for review in this project. Learnings you already have, or
deleted before, are skipped; words that read like an instruction are held back for a closer
look; rules in the file are held back until you accept the learnings and propose the rules
again in review.

`ad state export` (moving to a new computer) is different: it carries your whole memory,
including what waits for review, but not your rules.

## The weekly numbers

`report` has a week-by-week table: learnings captured, in use before review, accepted,
recalled, said again after you accepted them, and how often a rule asked or stopped. Once a
week, the first Claude Code session shows "Last week: 3 stopped, 2 asked, 1 repeated" when
there is something to say. `report --share-link` prints a prefilled GitHub Discussions post
with those counts only (no project, path or words); nothing is sent unless you post it.
See [metrics](metrics.md).
