# Privacy

Agent Daemon runs on your computer. It has no account, no server of its own and no telemetry. This page says what it stores, what it writes into other tools' settings, and when it uses the network.

## What is stored, and where

Everything stays in folders on your computer:

- **ad's own folder,** `~/.agent-daemon` (or the folder `AD_ROOT` names): the memory database (`episodic.db`: lessons, corrections, session summaries and the project each belongs to), your profile notes, the project list (`projects.json`), proposals waiting for review, the session record (`sessions/`), settings, your account list (`accounts/`), keys you entered (`secrets/`, encrypted with Windows DPAPI, stored in the system keyring, or kept in a file only you can read), and the engine's own folders (sign-ins, conversations).
- **Each project's folder:** after `ad init`, a `.agent-daemon/` folder with that project's memory notes and handoffs. A project where you never ran `ad init` keeps its capture files under `~/.agent-daemon/projects/` instead, so nothing lands in your repository.
- Memory is kept per project. Notes from one project are never served in another unless you accept them as cross-project. Text that looks like a key is filtered before it is stored.

## What the installer writes

`ad init`, `ad memory install` and `npx agent-daemon-memory install` add ad's memory server and hooks to the settings of the agents you choose (for example a host's MCP configuration and hook files), plus managed blocks in instruction files such as `CLAUDE.md`. Every change is listed before it is made, the previous file is backed up, and a ledger records what was written so `uninstall` can remove exactly that.

## Network

- **The memory server makes no network calls.** The package contains no network code; a test fails if any is added.
- **ad's agent harness** (`ad`, `ad run`, `ad loop`) talks to the model provider you choose (for example OpenAI, OpenRouter or a local model), through a gateway that runs on your own computer. Your prompts, code context and tool results go to that provider, under its terms. ad also reads the provider's own model list and limits (for example OpenRouter's `/key`) when you ask for them.
- **Signing in** opens the provider's own sign-in page (for example OpenAI or OpenRouter) in your browser.
- **The engine** (the open-source agent engine ad runs) may make calls of its own. ad hasn't yet listed and switched off each of them; until it has, this line stays here.
- Nothing else: no update check, no analytics, no crash reports.

## Telemetry

None. ad sends no usage data, analytics or crash reports anywhere. `ad memory report` shows your own numbers on your own screen; sharing them is something you do yourself. Any future telemetry would need its own page, a question you answer first, and a new decision recorded in the open.

## Deleting everything

- `npx agent-daemon-memory uninstall` (or `ad memory uninstall`) removes what the installer added to other agents' settings.
- Delete `~/.agent-daemon` to remove ad's memory, settings, sessions, keys and engine folders.
- Delete a project's `.agent-daemon/` folder to remove that project's notes.
- `ad auth logout <account>` deletes one account's stored key.

## Contact

Questions about this page: open an issue at <https://github.com/pankaj-mahaur/Agent-Daemon/issues>. Security problems: see [Reporting a vulnerability](../SECURITY.md#reporting-a-vulnerability).
