# Research notes

Background research behind the `ad` terminal UI ([plan](../plans/ad-tui.md)). Each note is our own summary with links to the sources; claims that couldn't be confirmed are marked *(unverified)*. Collected 2026-10-04.

| Note | What it answers |
|---|---|
| [codex-tui-and-app-server.md](codex-tui-and-app-server.md) | How the official Codex TUI is built (it is an app-server client), its full UX (keys, slash commands, approval prompt, transcript cells), the app-server protocol surface split into stable vs experimental, and how Codex versions (or doesn't version) the protocol |
| [terminal-engineering.md](terminal-engineering.md) | How production agent CLIs render, Node library options, Windows Terminal and Node raw-mode facts, inline history insertion and resize, streaming markdown, testing with `@xterm/headless`, performance and pitfalls |
| [harness-landscape.md](harness-landscape.md) | How OpenCode, Toad, the Codex ACP adapter, Crush, Goose, pi, Amp, Claude Code and others are built; what broke for wrappers; patterns for surviving upstream changes; what users love and hate |

Spike results (checked on this machine against the real pinned Codex) are recorded in the plan's Part 0, not here.

When a note goes stale, for example after a Codex release changes the TUI or the protocol, update it in place and say what changed and when.
