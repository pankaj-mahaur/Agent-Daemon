# Extractor corpus (held out)

Prompts a user types to a coding agent, each labelled for whether it contains a **durable correction or preference** the agent should remember beyond this turn. Used by the L4a and L5 gates: precision ≥ 0.85 and recall ≥ 0.6 on `is_correction`.

## Provenance

- **Written by:** a clean-room agent (Claude Opus 5.5, model id `claude-opus-5-5`), 1 Nov 2026, under plan decision D29 (the implementer must not grade itself).
- **What it read:** only `docs/plans/mcp-platform/02-ARCHITECTURE.md` §2 and §2.1, and `04-PARTS.md` sections L0, L4a and L5. Everything else came from general knowledge.
- **What it did not read:** nothing under `runtime/src`, `runtime/scripts`, `runtime/test` (apart from this folder and `../poisoning/`), `hooks/`, `adapters/`, `packages/`, `bench/`, `skills/`, `mcp/`, `plugins/` or `docs/` (apart from the two plan files). It did not grep the repo, open other corpus folders, or see the extractor, its patterns or its tests.
- No real people, emails, repositories or secrets. Hostnames use `.test`.

## Files

| File | Lines | SHA-256 |
|---|---|---|
| `extractor.jsonl` | 178 (86 positive, 92 negative) | `55819a1f7f3391439c0f599efc87445985089e3c5e92e44ab831f9586a0509e9` |
| `ambiguous.jsonl` | 18 (not gated) | `164e0dc727d3182aae0d0f8bac8a471bb624e4ceacfee1d19cd13fef0268e96f` |

JSONL: one object per line, UTF-8, LF, no blank lines; every line was checked with `JSON.parse`, and no two prompts are the same after lower-casing and stripping punctuation.

## Schema

```
{"id","prompt","is_correction":true|false,"learning":<one line, positives only, else null>,
 "category":"tooling"|"style"|"workflow"|"testing"|"git"|"paths"|"communication"|"architecture"|"fact"|null,
 "lang":"en"|"hinglish","note":"form: <phrasing>" (positives) | "class: <negative type>" (negatives), optionally followed by " | why"}
```

Grade on `is_correction` only. `learning` is a reference paraphrase: compare it by meaning, never by exact text. `category` is a best fit (tooling and workflow overlap, for example) and should not be gated. `note` is for humans and coverage counts; a harness must not read it.

## What "durable" means

A prompt is **positive** when it contains an instruction, preference or project fact that should change what the agent does in a **later, unrelated task** in the same project (or for this user), and that rule can be stated in one line **from the prompt alone**.

Test: *if a fresh session tomorrow did not know this, would the user have to say it again?* If yes, it is durable.

Positive:
- a rule about tools and commands, code style, workflow steps, testing, git, file locations, how to communicate, or architecture;
- a **stable project fact** the agent got wrong: ports, versions, hostnames, the deploy target, ID types. These describe configuration or the environment and stay true after the current task (ext-161: "The API runs on port 4000, not 3000");
- a rule embedded in a longer task request (the task part is ignored: ext-070, ext-124, ext-154, ext-173, ext-175, ext-177);
- a rule the user explicitly adopts from someone else ("Our tech lead decided … Follow that from now on", ext-156).

Negative, even when the wording looks like a rule:
- **one-off:** tied to this turn's artifact: which file, which function, undo, revert, commit this, push it, stop, wait (ext-002, ext-033, ext-146 "I prefer the first option you suggested");
- **scoped or temporary:** limited by "for now", "this PR", "this feature", "this one test", "yet" (ext-026, ext-065, ext-131, ext-158). A scope limiter overrides a durable marker;
- **questions and hypotheticals**, even when they name a tool or a convention (ext-011 "should we be using pnpm instead of npm?", ext-174);
- **approvals, praise, "no rush"**;
- **task requests**, including one-time git instructions (ext-093);
- **pasted machine output**: errors, lint messages, git hints, even when they start with "No", "Never", "Don't" or "Do not", or contain an imperative (ext-006, ext-041, ext-057, ext-063, ext-108);
- **quoted comments from others** that the user asks about, or asks to address once, without adopting (ext-021, ext-100, ext-102, ext-104);
- **corrections of the agent's claim about the current bug, output or code state**: they stop being true once the code changes (ext-030 "the bug is in parse()", ext-162 "the total should be 42");
- **status reports** that contain "always" or "we never" (ext-088, ext-137, ext-144).

Signal words such as "always", "never", "we", "here", "from now on", "again" and "every time" are evidence, not proof: the content must be a rule about behaviour or a stable fact. "Here" in "use pnpm here" means this project (durable); "here" in "prefer const over let here" points at one line (not durable).

## Coverage

Positives by category (86):

| tooling | style | workflow | testing | git | paths | communication | architecture | fact |
|---|---|---|---|---|---|---|---|---|
| 15 | 15 | 10 | 9 | 9 | 7 | 6 | 9 | 6 |

Positives by phrasing (`note: form:`):

| imperative | frustrated repeat | statement | please stop | we-statement | embedded in a task | "No …" | preference | rhetorical question | adopted relay |
|---|---|---|---|---|---|---|---|---|---|
| 35 | 12 | 10 | 8 | 7 | 6 | 4 | 2 | 1 | 1 |

Negatives by class (`note: class:`, 92):

| one-off | pasted output | question | code fact | task request | hypothetical | approval | praise | status report | temporary | quoted review | no rush | scoped | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 26 | 11 | 11 | 6 | 6 | 5 | 4 | 4 | 4 | 4 | 4 | 3 | 3 | 1 |

- **Balance:** 48.3% positive.
- **Language:** 31 Hinglish (17.4%; 17 positive, 14 negative) and 147 English.
- **Operating systems:** Windows (ext-016, ext-020, ext-024, ext-117), macOS (ext-019, ext-090) and Linux (ext-027, ext-028, ext-090).
- **Length:** from 2 to 185 characters, median 58.

## How items were chosen

- Positives first covered every category with several phrasings, then added the forms the brief asked for: "no, …", "we never …", "please stop …", frustrated repeats, corrections inside longer task requests, and Hinglish.
- Each hard-negative class was built to sit next to a positive that shares its surface words: "use pnpm here" vs "should we be using pnpm?" vs "you can use npm for this one, pnpm isn't installed yet"; "We never use …" vs "We never got the webhook"; "I prefer small PRs" vs "I prefer the first option"; "Our tech lead decided … follow that" vs "my lead mentioned we might move"; the port fact vs the computed total.
- Anything I could not label confidently went to `ambiguous.jsonl`.

## Notes for the plan owner (judgment calls and gaps)

- **Context-free labels.** Real prompts are judged with the previous turn in view. Prompts whose label depends on that turn ("use pnpm", "use the logger", "same as before, don't touch the lockfile") are in `ambiguous.jsonl` with a lean (`is_correction` holds the lean, and `note` says `lean: …`) and a `why`.
- **Stable facts count as durable** (category `fact`); facts about the current bug or output do not. This is the line most likely to be drawn differently by another labeller.
- **Quoted review comments are negative** unless the user adopts them for the future (ext-102 negative; ext-amb-005 "Please follow that" is ambiguous).
- **Environment facts** such as "Python is `py` on this machine" (ext-016) and "this is PowerShell 5.1" (ext-020) are positive (tooling), even though they are machine-scoped rather than repo-scoped.
- **Base rate.** At 48% positive, the corpus is far richer in corrections than real traffic, where most prompts are tasks. Precision measured here will overstate real-world precision; the L4a report on real history is the better check.
- **Gaps:**
  - one learning per positive (no prompt carrying two separate rules);
  - no long paste that hides a real user correction after the log;
  - Hinglish is romanised only (no Devanagari);
  - few items for `communication` and `fact` (6 each);
  - no prompts from voice dictation or with heavy typos;
  - the "Correction to expected rule pattern" corpus (L0, ≥ 60) is separate and was not written here.

Frozen: do not edit; changes need a new corpus version and a new hash.
