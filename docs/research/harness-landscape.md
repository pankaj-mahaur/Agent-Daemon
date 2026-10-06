# Research: how other agent harnesses are built, and how they survive upstream changes

Collected 2026-10-04 for the `ad` terminal UI ([plan](../plans/ad-tui.md)). Summaries are ours; follow the links for detail. *(unverified)* marks claims the sources didn't settle.

## The big picture

- **Agent CLIs have converged on client/server.** The engine runs as a server (in-process, a local daemon or remote), and the TUI, web UI, IDE plugins and ACP adapters are peer clients. Codex (TUI → app-server), OpenCode (Bun server + OpenAPI + SSE), Crush (HTTP over a Unix socket / named pipe) and Claude Code's agent view (a background supervisor) all work this way. Putting `ad`'s TUI on `codex app-server` follows Codex's own design.
- **Codex moves fast.** Its last 100 GitHub releases span only 2026-09-18 → 10-04 (11 stable). The Codex ACP adapter's handler already switches over 80+ notification methods and 24 item types.
- **Renderers were rewritten everywhere.** Claude Code rewrote its React renderer to fix flicker (2.0.72), Amp built its own fullscreen framework, OpenCode swapped Bubble Tea for OpenTUI, Gemini CLI rolled back an alternate-screen experiment within a week. A clean split between view model and renderer is what made those rewrites survivable.

## Projects

**OpenCode** (now `anomalyco/opencode`)
- `opencode` starts a Bun/Hono server plus a TUI client. OpenAPI 3.1 at `/doc`; the JS SDK is generated from it. Commands are REST (`POST /session/{id}/prompt_async` returns at once); progress is an SSE stream (`GET /event`).
- Clients: `serve`, `web`, `attach <url>` (TUI on a remote backend), `acp`. The v1.0 TUI rewrite "works like the old one since it connects to the same server", though keybinds changed.
- Primary agents Build/Plan (Tab cycles), subagents by @-mention, child sessions navigable. Markdown custom commands, `tui.json` keybinds with a leader key (`ctrl+x`), plugins as JS modules on bus events, allow/ask/deny permission patterns, `/share`, LSP diagnostics fed to the agent.

**Toad** (Will McGugan, Textual, AGPL)
- A universal front end: every agent is an ACP subprocess declared in a TOML file (per-OS run command, install actions, help).
- Adds an embedded shell that keeps `cd`/env, a Markdown prompt editor, `@` fuzzy file picker, side-by-side diffs, notebook-style cursoring through transcript blocks, a concurrent-sessions overview.
- Flicker comes from erasing and rewriting lines and exposing partial frames; update the smallest region possible.
- **Streaming Markdown:** treat every block except the last as final, update only the last block, re-parse only from where it starts, and coalesce tokens so the display never lags the stream. (No native Windows support; last release 2026-05 *(may be stale)*.)

**Codex ACP adapter** (`agentclientprotocol/codex-acp`, TypeScript, successor to Zed's archived Rust adapter that linked Codex crates directly)
- Mapping: agent-message deltas → message chunks, reasoning deltas → thought chunks, tool-like items → `tool_call` then `tool_call_update` with a stable id, `turn/plan/updated` → plan, tokens/rate limits → usage, approvals → permission requests; history is replayed on session load; steering is queued onto `turn/steer`.
- **How it keeps up:** pins `@openai/codex`; `npm run generate-types` runs `codex app-server generate-ts --out src/app-server` and the output is committed; a daily workflow compares the pin with `npm view`, branches, regenerates types, runs an agent with a repo skill (`codex-update-compat`) to fix type errors and fixtures, and opens a labelled PR. The mapping is exhaustive against the generated unions at compile time, with a documented no-op list ("do not silently drop new event/item variants"). JSON fixture tests: Codex events in, ACP events out.
- Recurring breakages it lists: new required fields, changed sandbox-policy shape, changed rate-limit payloads.

**Others**
- **Crush** (Charm, Go): thin Bubble Tea v2 client over a local server; SQLite sessions, LSP, MCP, hooks.
- **Goose** (Linux Foundation AAIF): ACP server + TS ACP client library; deprecated its own ACP TUI in favour of "any ACP based TUI".
- **pi** (`earendil-works/pi`, MIT): pi-tui renders from the first changed line, full redraw only on width change or a change above the viewport, wrapped in synchronized output; normal screen by default, alternate screen optional. Sessions are a tree in one file (`/tree`, `/fork`). Extensions get hooks (`tool_call` can change or block, `turn_end` can continue) and UI primitives (`select/confirm/notify/setStatus/setWidget`) that also work over JSONL RPC.
- **Kimi Code CLI** (TypeScript, built on pi-tui): Ctrl-X shell mode, hooks, plugin marketplace with trust levels, ACP.
- **Cline CLI 2.0**: protobuf-defined core services; `-y` headless, `--json`, `--acp`.
- **Factory Droid**: read-only by default; `--auto low|medium|high` risk tiers.
- **Amp**: own fullscreen framework (mouse, overlays, no flicker); later moved the loop to the cloud, auto-compaction at 90%, queue + steer, plugin API (`amp.on`, `registerTool`, `ctx.ui.*`).
- **Warp**: detects Claude Code / Codex / OpenCode / Amp and adds rich input, notifications and code review around them.
- **Claude Code**: fullscreen mode (research preview) renders only visible messages, has `less`-style transcript keys with `/` search, `[` dumps the conversation into native scrollback, auto-follow pauses when you scroll up ("N new messages"), OSC 52 copy; screen-reader mode with plain linear lines and numbered menus; `claude agents` shows each background session as working / needs input / idle / completed / failed / stopped with peek-and-reply; auto mode lets a classifier decide approvals.

## Wrappers and orchestrators: what broke

| Approach | Example | What broke |
|---|---|---|
| Scraping a PTY / tmux | Claude Squad | auto-yes broke after CLI updates; prompts lost when the CLI switched to raw mode and discarded the PTY input buffer |
| Native CLI + hooks | Happy (local mode) | depends on hook semantics; Codex hooks lost the user's terminal identity once the TUI became a daemon client |
| Structured protocol / SDK | Vibe Kanban, T3 Code, Sculptor, Happy (remote) | survived best; one adapter per agent into a shared normalized entry type |
| Subscription OAuth reuse | OpenCode, Cline, RooCode | Anthropic blocked subscription OAuth outside its own apps (Jan 2026), broke overnight |

Upstream behaviour also changed **without** a schema change: Codex 0.151 stopped persisting zero-turn threads (resume failed), an older bundled app-server couldn't resume threads written by a newer one (version skew), and 0.149 refused to start on a removed config value.

- **Vibe Kanban**: per-agent adapters convert into a `NormalizedEntry` (messages; tool use typed as read/edit/command/search/plan/todo; status incl. PendingApproval/Denied/TimedOut), plus a mock executor for tests.
- **T3 Code**: drivers behind one `ProviderAdapterV2` with typed errors (incl. "steer unsupported"), per-provider scripts that record replay fixtures, its own pinned Codex install, and a compatibility table mapping driver × version to upstream ranges with a recommended version.
- **Sculptor**: replaces some agent tools with its own, pins extensions, documents a "not available" list per harness, and falls back to a plain terminal for anything else.

## Patterns that keep a client alive across upstream releases

1. One internal event model; one adapter per engine.
2. Generated, committed schema snapshots; the PR diff doubles as the protocol changelog.
3. Exhaustive mapping plus an explicit, documented ignore list.
4. Tolerant reading: unknown fields ignored, unknown notifications dropped (and logged), unknown requests answered with method-not-found, unknown item types shown as a generic row.
5. Capability negotiation **and probing**: older servers silently ignore unknown capabilities, so probe a method before relying on it.
6. Replay tests from recorded real sessions, re-recorded on every bump.
7. Pinning plus automated upgrade PRs (codex-acp adds an agent that fixes the breakage).
8. Runtime advisories: show which upstream versions are tested.
9. A passthrough to the native UI as the fallback.
10. Own your identifiers and persistence rather than relying on upstream side effects.

## What users love and hate

- **Flicker** is the top complaint (Claude Code #769: 336 👍, 307 comments).
- **Alternate-screen backlash:** scrollback loss, broken selection and copy under mouse capture (Codex, Claude Code issues); Gemini rolled its alt-screen TUI back.
- **Copy fidelity:** copies that include indentation, trailing spaces or hard wraps; Ctrl+C that quits instead of copying.
- **Auto-scroll that yanks you to the bottom** while you read.
- **Undo/rewind:** "bring /undo back" on Codex has 517 👍; rewind of both code and context is wanted.
- **Queue instead of interrupt** (Claude #50246, 248 👍); Codex's Enter = steer / Tab = queue split is praised.
- **Approval fatigue:** users approve ~93% of prompts (as reported), hence auto modes, risk tiers and allowlists.
- **Status/cost/context meters** and a customizable status line (Codex #17827, 213 👍).
- **Accessibility:** a plain linear mode with numbered menus and a bell when input is needed.

## Ideas ranked for `ad`

1. App-server is the only contract; Codex maps into `ad`'s own event model through one adapter.
2. Automated Codex bump pipeline: pin, regenerate schema/types, replay tests, labelled PR.
3. A replay corpus (approvals, steer, compaction, subagents, errors) run on every bump.
4. Unknown events never crash: a collapsed "unrecognized event" row, logged, with a documented ignore list.
5. A startup check: versions, method probes, grey out unsupported UI, show an advisory.
6. Long term: an `ad` hub (sessions, memory, teams, loops, schedules behind one API) with TUI, web and ACP as peer clients.
7. Inline-first rendering with differential updates and synchronized output; fullscreen as an option with transcript search and "dump to scrollback".
8. A team/loop board: worker states, "needs input" highlighted, peek-and-reply, brake and budget meters.
9. Steer vs queue, with a visible, editable queue.
10. Checkpoints owned by `ad` (git snapshot per turn), independent of the engine.
11. Approval UX: risk tiers, pattern allowlists, batched approvals.
12. A status line: model, context %, quota, memory hits, loop iteration and time left.
13. A streaming-Markdown pipeline that finalizes blocks and coalesces tokens.
14. An extension API whose UI primitives also work in the web UI and ACP.
15. Escape hatches: open the thread in native Codex, a plain screen-reader mode, headless `--json`.

## Pitfalls

1. Coupling to internals (crates, rollout files, TUI text).
2. "Types compile" is not "behaviour unchanged".
3. Version skew with persisted threads; attaching to the user's own Codex daemon bypasses our pin.
4. Passing the user's Codex config through verbatim (keys get retired without deprecation).
5. Core UX on `experimentalApi` without a gate and fallback.
6. Defaulting to the alternate screen without native scrollback, copy and search fallbacks.
7. Auto-scroll that pulls readers down; copies with hard wraps or indentation.
8. Subscription-auth policy risk: keep API-key and OpenRouter paths first-class; set `clientInfo.name` honestly.
9. Typing into a PTY in passthrough mode races the CLI's startup; send input through the protocol.
10. Daemon and Windows assumptions: daemon env frozen at start, 108-byte AF_UNIX paths, conhost mouse/scroll quirks, Windows Terminal scrollback loss.

Sources: [OpenCode server](https://opencode.ai/docs/server) · [Toad](https://willmcgugan.github.io/toad-released/) · [streaming Markdown](https://willmcgugan.github.io/streaming-markdown/) · [codex-acp](https://github.com/agentclientprotocol/codex-acp) · [pi](https://github.com/earendil-works/pi) · [Amp: look ma, no flicker](https://ampcode.com/news/look-ma-no-flicker) · [Claude Code fullscreen](https://code.claude.com/docs/en/fullscreen) · [Vibe Kanban executors](https://github.com/BloopAI/vibe-kanban/tree/main/crates/executors/src) · [T3 Code server](https://github.com/pingdotgg/t3code/tree/main/apps/server) · [Sculptor harnesses](https://github.com/imbue-ai/sculptor/blob/main/docs/help/integrated_harnesses.md)
