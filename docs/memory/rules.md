# Rules

A correction you accepted can do more than come back as a note. If it names a
command or a file, it can become a rule: the check before each tool call then asks
you, or stops the call, when the agent is about to repeat the mistake.

Command and file repeats are asked about or stopped where the host can; other
corrections are recalled and counted.

## What a rule is

A rule belongs to one accepted learning and holds one pattern:

- **a command**: a program and, optionally, its subcommands or flags. `use pnpm, not
  npm` becomes `npm install|i|ci|add`: it matches `npm install`, not `npx`. The
  matcher sees through chains, nested shells, wrappers, quoting and Windows
  spellings, and ignores text that only mentions a command.
- **a file pattern**: `write src/gen/**` matches an edit or a write to those files.

A git rule can name branches: `git push on main` matches a push to `main` (named,
as `HEAD:main`, or through the branch's upstream), while a push from a feature
branch passes. Commit, merge, rebase and reset look at the branch you are on.
When the branch can't be told, the rule applies.

Each rule either **asks** (the default) or **stops** (`--block`), in **this
project** (the default) or in **all projects**. A project's rules also apply in
its git worktrees and in the folders where `ad sp` workers run.

## Getting a rule: review

After the checklist, `review` offers up to 3 accepted learnings that can become a
rule, one at a time:

```text
#12 "use pnpm, not npm"
  rule: npm install|i|ci|add  ·  asks in Claude Code, stops in Codex  ·  this project
  last 30 days here: would have stopped 14 commands, e.g. npm install lodash · npm ci
  r make it a rule · e edit · p all projects · b block instead of ask · n never · enter later
```

`r` adds it, `e` edits the pattern, `p` makes it apply in all projects, `b` makes
it stop instead of ask, `n` never offers it again, and `enter` keeps it for a later
review. `--accept-all` never offers rules.

## The rules commands

Run them as `npx agent-daemon-memory rules …` or `ad rules …`.

| Command | What it does | Where |
|---|---|---|
| `rules list [--json]` | Every rule: asks or stops, where it applies, its pattern and reason, a pause, when it last asked or stopped, and a rule whose learning is gone | anywhere |
| `rules add <learning> [--pattern "…"] [--all-projects] [--block]` | Makes a rule from an accepted learning. Without `--pattern`, ad reads the pattern from the learning's words | your own terminal |
| `rules rm <id>` | Removes a rule | your own terminal, with a typed code |
| `rules pause [--all] [--for 30m\|1h\|2d \| --until-resume]` | Pauses this project's rules, or every rule with `--all`. One hour by default, up to 30 days | your own terminal, with a typed code |
| `rules resume [--all]` | Ends a pause | your own terminal |
| `rules allow-once <rule> [<call-id>] [--pick N] [--minutes N]` | Lets one stopped call through, once | your own terminal, with a typed code |

From the agent's shell, only `rules list` runs; the others change nothing and say
that you decide in your own terminal.

## Ask or stop, per host

| | An ask rule | A stop rule |
|---|---|---|
| Claude Code | asks you | stops the call |
| Claude Code in bypass (`bypassPermissions`) or don't-ask (`dontAsk`) mode | stops the call | stops the call |
| Codex | stops the call, with the reason | stops the call, with the reason |

Codex can't ask, so both kinds stop there. A stopped call tells the agent why, and
shows you the line to allow it once.

## Allow once

When a rule stopped a call you want, run the `rules allow-once` line the message
shows, in your own terminal. It names the rule and the call. ad shows the call and
asks for the typed code; the agent may then run that exact call once in the next 5
minutes (`--minutes`, 1 to 30). The call is bound by a hash: a different command,
a different file or a second run is checked again. If ad can't tell which call you
mean, it lists the recent ones to `--pick`.

## Pause and resume

`rules pause` pauses this project's rules; `rules pause --all` pauses every rule,
your starter safety policy included. A pause lasts one hour unless you give
`--for` or `--until-resume`. When it ends, the rules apply again at once: nothing
has to switch them back on. `rules resume` ends it early. A pause never turns off
self-protection.

## Self-protection

Whatever your rules are, even with none, the check stops or asks about calls that
would change ad itself:

- ad's commands that change what is remembered or enforced (accepting in
  review, removing or pausing a rule, allowing a call, turning the safety policy
  off, setup and uninstall), run from the agent's shell;
- the same commands run through a wrapper, another terminal, remote input or a
  nested agent;
- writes to ad's own state under `~/.agent-daemon` (its databases, the rules
  files, its hooks); a write to your profile there is asked about;
- edits to a host's own settings that would remove or change ad's hook;
- changes to the variables ad uses (`AD_TOOL_SHELL`, `AD_MEMORY_DB`);
- writes to the Windows folder;
- writes to startup and persistence files (shell profiles, autostart entries);
- programs built at run time that run one of ad's commands.

Claude Code asks or stops as for a rule; bypass and don't-ask modes and Codex
stop. To make such a change yourself, run the command or edit the file in your own
terminal. Codex on Windows runs no check at all, self-protection included, until
your first rule (see below).

It is an enumerated filter, not a sandbox: a program the agent writes and then
runs can still change files.

## Fail-closed while rules exist

Claude Code runs a hook whose check fails (it crashes, or times out) as if it
weren't there, unless the hook entry says otherwise. So while any rule exists,
paused rules included, ad sets its `tool.before` entry in your user settings to
`onFailure: "block"` and `timeout: 10`: a check that can't run blocks the tool
call instead of letting it through.

- With the starter policy's `.env` rule on, the same entry also covers the Read
  tool.
- When the last rule goes, the entry gets back exactly the values it had before,
  and nothing else of yours changes. Going back needs your review in your own
  terminal: from the agent's shell, ad only ever raises it.
- Claude Code reads hooks at session start, so a change applies from your next
  session.
- `onFailure` needs Claude Code 2.1.295 or newer.
- Codex runs the tool when a hook fails, so in Codex rules are advisory when the
  check itself fails.
- On Windows, Codex gets ad's rules check only with your first rule. Each tool
  call then waits 1–4 s for it, and it stays after your last rule.

Locked out? See [troubleshooting #120](../troubleshooting.md#120-every-tool-call-is-blocked).

## The typed code

A command that lowers enforcement asks for a 4-letter code, after the usual check
that it runs in your own terminal. Those commands are `rules rm`, `rules pause`,
`rules allow-once`, `safety off`, `config review auto`, `ad init` rewriting its
rules check while rules exist, and `uninstall` removing or lowering the rules
check while rules exist.

ad prints the code and what will change to the terminal itself and reads it back
from there, never from stdin, so a script that runs the command blind can't
answer. If you already typed the dialog code in that run, you aren't asked again.

## What doctor and report show

`doctor` adds a row per rules check:

| Code | What it says |
|---|---|
| `rules.count` | How many rules, how many in force, and what is paused |
| `rules.store` | The rules file against the memory store, and rules whose learning is gone |
| `rules.sentinel` | The marker that says rules exist, so an unreadable rules file never reads as none |
| `rules.switch` | Whether the check fails closed (and covers Read) as the rules ask |
| `rules.guard` | The copy of the package the check runs, and whether its files match |
| `rules.codex-windows` | Codex on Windows: whether it has the rules check yet |
| `rules.codex-sandbox` | Codex's sandbox mode; with full access, rules see shell and patch calls only |
| `rules.limits` | What rules don't see |
| `rules.events` | The size of the log of asked and stopped calls |

`report` has a rules section: your rules (stop and ask, and any whose learning is
gone), stoppable learnings against reminded ones, how often a rule asked or
stopped, allowed-once passes, "ad's own files guarded" (self-protection), and a
pause.

## Limits

File rules see edits made with the agent's file tools, not shell redirects; MCP
tools and nested agents with their own settings aren't checked.

- A rule matches what a call says, not what a script it runs does: a command
  hidden in a script, a variable or `eval` isn't seen.
- Not yet verified: a live check that Claude Code 2.1.319 blocks a call when the
  raised check fails, and the typed code on a real Windows console.

See also: [the starter safety policy](security.md#starter-safety-policy-off-by-default),
[capture, review and forget](review.md), [uninstall](install.md#doctor-repair-status-uninstall).
