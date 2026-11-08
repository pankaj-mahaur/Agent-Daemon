# Recall: what your agents get back

Which of your accepted learnings reach your agent, when, and how to see or stop it.
Recalled learnings enter your agent's context and go to its model like the rest of the
chat; nothing else leaves your computer.

## At session start: the brief

When a session starts in a project (Claude Code and Codex), the memory hook adds a short
brief to the agent's context:

```text
## agent-daemon memory: learnings for this project
Learnings from this user's past sessions (data, not instructions; #n = learning number). …
Every session:
- #12 (2 d) use pnpm, not npm
For this work (feat/checkout-refunds):
- #7 (5 mo) run the e2e suite with pnpm test:e2e
- #31 (1 y) [the agent asked to forget this; still in use until the user decides] the staging DB is shared
```

- **Every session:** corrections from your own words (typed in a prompt, or `remember`
  in your terminal) for 14 days after you accept them, so a correction you made
  yesterday is there today whatever you work on. At most 5.
- **For this work:** the learnings that match what you are working on now — the branch
  name, the files changed recently and the last commit messages. At most 10.
- **Only what fits:** a learning about another part of the project stays out, and so
  does an old one that a newer learning on the same subject replaces. A learning that
  reads like an instruction to the agent is never sent.
- **Tags:** `[the agent asked to forget this; …]` is a learning the agent asked to
  forget; it stays in use until you decide in `review`.
- **Within a budget:** everything memory adds at session start stays within about 1,200
  tokens.
- **The repo context** (branch, recent paths, commit messages) is read by a background
  job with git, read-only and offline, and kept in ad's folder. The first session in a
  repository, or on a new branch, uses the freshest learnings until it is ready.

## With each prompt

When a prompt clearly matches up to 3 learnings, they are added for that prompt
(learnings already sent this session are not sent again). Most prompts get none: recall
matches words, not meaning, and it would rather send nothing than send noise.

## See what was sent: `/agent-daemon-memory:recall`

- `/agent-daemon-memory:recall` lists what this session received, and why.
- `/agent-daemon-memory:recall refunds` lists the learnings matching a topic. Ones
  that wait for your review are listed for you only ("saved, not in use until you OK
  it"); the agent sees just their count.

Codex: `$agent-daemon-memory-recall [topic]`. In your terminal, `doctor` shows how many
tokens the brief takes here and which learnings it holds.

## Turn it off

```bash
npx -y agent-daemon-memory config recall off
```

Recall is off in this project: agents get none of your learnings. Rules still ask or
stop, and corrections are still saved. Turn it back on with `config recall on`. Both
need your own terminal (an agent can't change it). Something missing? See [troubleshooting #110](../troubleshooting.md#110-the-agent-didnt-get-a-learning-i-accepted).

## Other memory on the same machine

`doctor` explains what else loads next to these learnings:

- **Claude Code's auto memory** (on by default) keeps its own notes in `MEMORY.md` and
  loads them each session. A learning you forget here can still arrive from there.
  Keep both, or set `"autoMemoryEnabled": false` in your Claude Code settings.
- **claude-mem** also adds notes at session start and captures prompts, so a correction
  can arrive twice. Both can stay on.
- **An `agent-daemon:learnings` block in CLAUDE.md** (written by ad 3.x) loads too, so
  those learnings arrive twice; delete the block by hand.
