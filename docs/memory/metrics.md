# Is memory working? The report and the repeat-correction rate

ad's memory is meant to make you correct your agent less often. `ad memory
report` (or `npx agent-daemon-memory report`) shows whether it does, from your
own store, for the project you run it in:

```
Memory report — last 30 days, this project
  Corrections captured        14   (hooks 11, record tools 3)
  Repeated corrections        3 (21%, lower is better)
    shown first, repeated     1
    not shown                 1
    unknown (pull or hookless) 1
  Lessons shown per session   median 6, about 1.1k tokens
  Feedback                    useful 11, stale 2, wrong 1 (precision 0.79)
  Waiting for review          4   (ad review)
```

`--days N` changes the window, `--all-projects` counts every project, `--json`
prints the numbers as JSON, and `--share` prints them with no project name,
path, lesson or session id, for pasting into an issue. Nothing is sent anywhere.

## What counts

- **A correction** is anything captured as one: your own words through ad's
  hooks or a digest, or a correction an agent recorded with
  `memory_record_correction`.
- **A repeat** is a correction that matches a lesson memory **already had
  accepted**, in this project (or accepted as cross-project), from an **earlier
  session**. It matches when the text is the same note (case, spacing and end
  punctuation aside) or very similar (the search's best hit shares at least 60%
  of its content words). A correction repeated within the same session is not a
  repeat; neither is one that matches only another project's lesson, or a note
  still waiting for your review. One session counts a correction once, and a
  lesson's repeat once: the hooks and that session's digest often say the same
  thing in different words.
- **The repeat-correction rate** is repeats ÷ corrections in the window.

For each repeat, ad tells three cases apart:

| Case | Meaning | What ad does |
|---|---|---|
| shown first, repeated | the lesson was shown to that session and the same correction still came | after the second time, `ad review` offers to reword the lesson (`memory-reword`): you edit it, the new text replaces the old one |
| not shown | the session's hooks were tied to it and the lesson wasn't among what memory showed | the lesson ranks a little higher next time (accepted lessons only) |
| unknown | the correction came through the memory tools, which can't tie it to a session | nothing |

Rewording goes through the same gate as every accept: your own terminal, typed
confirmation, no `--yes`.

## Feedback

`memory_feedback(id, verdict)` (`useful`, `stale`, `wrong`) now changes ranking:
search multiplies a lesson's score by 0.7 to 1.3 depending on its feedback. The
first verdict sets the value; later ones average in. For a cross-project lesson
only the verdicts given **in the project that is searching** count, so feedback in
one project can't sink a lesson for every other project.

## Limits

- SessionStart knows the session only when the host passes its id
  (`CLAUDE_SESSION_ID`); otherwise its lessons are recorded without a session and
  repeats from that session count as unknown.
- "Lessons shown per session" counts sessions whose host passed an id.
- "Similar" is a word-overlap test, not a meaning test: a rephrased correction
  with different words can be missed.
- The report counts what happens in your projects; it can't say what would have
  happened without memory. The controlled comparison (no memory, the host's own
  memory, a rules file, ad) is the [correction benchmark](../../bench/correction-bench/PROTOCOL.md).
