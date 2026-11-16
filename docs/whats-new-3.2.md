# What's new in 3.2

3.2 turns ad's memory into something you review and that acts. Every correction
ad captures waits for your review; accepted learnings come back at session start
and with each prompt; and a correction that names a command or a file can become
a rule that asks before, or stops, that call. Claude Code and Codex get all of it;
Cursor, VS Code and Gemini CLI get the memory tools (built, not yet accepted
live: see the [support matrix](support-matrix.md)). The full list is in the
[CHANGELOG](../CHANGELOG.md).

## Review first

Correct your agent once ("no, we use pnpm here") and ad saves it for this
project. Nothing is used until you accept it.

- **Review:** `ad review` (or `npx agent-daemon-memory review`) opens one
  checklist in your own terminal. Only a real terminal can accept a note; the
  agent's shell can't.
- **Screened:** each capture is checked for text aimed at the agent or its
  memory, and for secrets, before it waits for you.
- **Your learnings:** `learnings list`, `show`, `edit`, `forget`, `export` and
  `import`, with where each came from. See [your learnings](memory/learnings.md).
- **Forget and restore:** `forget <n>` and `restore <n>`; who may forget what is
  in [capture, review and forget](memory/review.md#forget-and-restore).

## Recall

- **Session brief:** at session start, a short brief of the learnings that fit
  the work you're on.
- **With each prompt:** learnings that fit the prompt, in Claude Code and Codex.
- **Why this one?** `/agent-daemon-memory:recall` shows what a session received
  and why; `config recall on|off` sets it per project. See [recall](memory/recall.md).

## Rules that ask or stop

- **From review:** after the checklist, `review` offers up to 3 accepted
  learnings as rules, with a preview of what each would have done on this
  project's last 30 days (asked once, read on this computer).
- **Ask or stop:** Claude Code asks you (and stops in bypass or don't-ask mode);
  Codex, which can't ask, stops the call with the reason.
- **Commands:** `rules list`, `add`, `rm`, `pause`, `resume` and `allow-once`.
  A git rule can name branches (`git push on main`).
- **Self-protection:** whatever your rules, the check stops or asks about calls
  that would change ad itself: its commands, files, hooks or variables.
- **Fail-closed:** while any rule exists, a check that crashes or times out
  blocks the call instead of letting it through.
- **A typed code:** commands that lower enforcement (`rules rm`, `rules pause`,
  `safety off`, …) ask you to type a 4-letter code in your own terminal.

Details: [rules](memory/rules.md).

## A starter safety policy (off by default)

`ad safety on` (or `npx agent-daemon-memory safety on`) asks before four kinds of
catastrophic commands: a recursive delete of your home, a root or the project; a
force push to the default branch; `--no-verify`; and reading `.env` files.
`safety status` shows each family. See [security](memory/security.md#starter-safety-policy-off-by-default).

## Setup and doctor

- **Setup:** `npx agent-daemon-memory setup` (or `ad memory setup`), in your own
  terminal, adds the hooks to Claude Code and Codex.
- **Install and uninstall:** install writes a stable launcher; uninstall puts
  back exactly what ad changed and lists what it kept.
- **Doctor:** per host, a Readiness section says what works there and the one
  command that fixes each gap; rules rows say whether the check is in place.
- **In Claude Code:** `/agent-daemon-memory:remember`, `recall` and `report`.

## Seeing it work

- **`report`:** week by week: what was captured, accepted and recalled, what you
  said again after accepting it, and how often a rule asked or stopped.
  `--share` and `--share-link` leave out projects, paths and lesson text.
- **`view`:** writes one read-only HTML page of your learnings, rules and weekly
  numbers. See [metrics](memory/metrics.md).
- **`ad mistakes`:** the corrections you keep typing, from your Claude Code and
  Codex history (read-only, offline), and which of them could become rules.
  `--save` puts them up for review. See [mistakes](mistakes.md).

## Upgrading from 3.1

- **Update:** `git pull` in your ad checkout (or re-run the installer), then run
  `ad init` once. The memory package is `npx agent-daemon-memory@beta`.
- **Every note waits for review,** including what hooks and the session-close
  digest capture. The store moves to schema 5; an older ad on the same store
  keeps serving only the notes you accepted.
- **One hook dispatcher.** Every hook goes through `runtime/bin/hook.mjs`; update
  the memory plugin along with ad, since an older plugin only knows ad's older
  entries.
- **Security fix:** if you pasted `hooks/pre-tool-use-qmd-redirect.json` into
  your settings, paste the new one (its guards used to answer "approve", which
  Claude Code reads as allow).
- **Removed:** the undocumented `mirror_to_claude_md` setting.

## Known limits

- **A rule matches what a call says,** not what a script it runs does; file rules
  see the agent's file tools, not shell redirects; MCP tools aren't checked.
- **The typed code** stops a script run blind in a terminal, not one that drives
  a terminal or reads the screen. It hasn't been checked on a real Windows
  console yet.
- **Cursor, VS Code and Gemini CLI** are built and tested in CI, with live
  acceptance still to come.
