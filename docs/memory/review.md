# Capture, review and forget

What happens to a correction you type, how you decide what your agents keep, and how
to take something back.

## Capture

When you correct your agent ("no, we use pnpm here"), ad's prompt hook saves the
sentence as a note for this project and shows one line (Claude Code):

```text
agent-daemon memory: Saved for review: #12 "we use pnpm here" · run `npx -y agent-daemon-memory@<version> review` in your own terminal to accept it
```

The first time ever, it says `Saved your correction #12 … Approve it once in your own terminal and your agents will remember it: …`.

- **Only your own words count.** Pasted logs, quoted text, code blocks and machine
  output are left out. A prompt that only looks typed (a scheduled prompt, a
  subagent's report, a headless run) is never saved as yours.
- **Every capture is screened** for text aimed at the agent or its memory: hidden or
  encoded instructions, fake system or tool blocks, "auto-accept", exfiltration
  links, rules that weaken a guard (`--no-verify` as a habit, `curl … | sh`). A
  flagged note is saved "for a closer look" and is never chosen in bulk. A note
  holding what looks like a secret is not saved at all.
- **Typing it again counts it** ("Said 3 times now; approve #12 …"); a note you
  already accepted is counted as a repeat.
- **Nothing is used until you accept it.** No host can prove today that a prompt was
  typed by you, so every capture waits for review.

Saving on purpose: type `/agent-daemon-memory:remember use pnpm here` (Claude Code),
`$agent-daemon-memory-remember use pnpm here` (Codex), or run
`npx agent-daemon-memory remember use pnpm here` (or `ad remember …`) in your own
terminal, where it is accepted at once.

## Review

In your own terminal:

```sh
npx agent-daemon-memory review      # or: ad review
```

One screen of checkboxes, grouped: new from your prompts first, then what the agent
saved, your history, instruction files, accepted notes no longer in your instruction
files, anything flagged, notes you asked to remove, and notes that were removed
(restore within 7 days). If the agent asked to
forget an accepted note, a line at the top says so; `↑` opens it.

| Key | Does |
|---|---|
| `↑` `↓` (`j` `k`), `pgup` `pgdn` | move (moving never decides anything) |
| `space` | yes: start using · keep · restore |
| `x` | no: delete for good · forget for good · leave removed |
| `a` | choose the new notes from your prompts on this page; again: the agent's too |
| `e` | edit the focused note on one line (screened again; the edit is what's saved) |
| `→` | open an instruction file's lines, each with its own checkbox |
| `enter` | show the summary; `y` applies, anything else goes back |
| `q`, `esc` | quit (asks first when you made choices) |
| `?` | help |

So accepting the new notes on a page takes three keys: `a`, `enter`, `y`. A flagged note needs
its own `space` and then `y`; one holding a secret can only be deleted. Nothing
flagged, from a file, from your history or from the agent is ever chosen by the
first `a`.

Other ways in:

- `review --list` prints what waits, numbered, and changes nothing.
- `review --plain` is a numbered line mode with the same choices (used on its own
  when the terminal can't take raw keys, `TERM=dumb`, or a screen under 12 rows): type numbers to use,
  `x2` to delete, `y4` to use a flagged one, `a` for the new ones.
- `review --accept-all` accepts the new notes from your prompts after you type their
  count; `--with-agent` adds the agent's. Flagged notes are never included.
- `review --proposals` opens the older proposal files (cross-project promotions,
  rewordings, skills).

In a folder with nothing waiting, review lists the projects that have waiting notes
and asks which one. Without a terminal it only lists; inside an agent's shell it refuses (in Git
Bash's mintty, run it through `winpty` or use Windows Terminal).

A note you delete leaves only a hash behind, so the same capture comes back as "You
deleted this before" instead of being saved again. To save it anyway, run
`npx agent-daemon-memory remember <text>` (or `ad remember …`) in your own terminal.

## Forget and restore

`forget 12` and `restore 12` (and, as a typed command only, `forget last`: the newest
note from your prompts in this session), typed as `/agent-daemon-memory:forget 12` in Claude Code,
`$agent-daemon-memory-forget 12` in Codex, or run as `npx agent-daemon-memory forget 12`
(`ad forget 12`) in a terminal. What happens depends on who asks:

| Asked by | Your own unaccepted note | The agent's unaccepted note | An accepted note |
|---|---|---|---|
| your own terminal (`forget 12`) | removed (restore within 7 days) | removed | forgotten for good after you type its number back |
| a prompt (`/…:forget 12`) | stays as it is, marked for your next review | removed | unchanged: "forget it in your own terminal" |
| the agent's shell | refused | removed | marked "agent asked to forget": still used until you decide in review |

So a prompt that someone else wrote, or the agent itself, can never remove what you
said or anything you accepted. When the agent removes or asks to forget a note, your
next Claude Code prompt says so once, and review lists it.

## Review mode

`npx agent-daemon-memory config review strict` makes every learning wait for review on
every host (it needs no confirmation: it only narrows trust). `config review auto`
lets a correction you type apply at once, tagged and undoable, on a host that can
prove you typed it; turning it back needs your own terminal. Today no host can prove
that, so every host is review-first either way. `config review` alone shows the mode.

## Reminders and counts

- Claude Code's session start says when new notes from your prompts wait: daily, then
  weekly after three reminders with no review.
- `ad status` counts what waits; `npx agent-daemon-memory report` also shows what's in
  use before review and what goes back to waiting this week. Both count the store.
