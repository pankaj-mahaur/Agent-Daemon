# daemon/

Skills that operate on the daemon itself — bootstrap, orchestrate a team across the daemon's primitives, scaffold project context.

These are **destructive or high-impact** — the bootstrap skill writes files, scaffolds memory, modifies `CLAUDE.md`. They carry `disable-model-invocation: true` where appropriate so they require explicit invocation rather than auto-routing.

| Skill | What it does |
|---|---|
| [bootstrap-daemon](bootstrap-daemon/) | Fully scaffold and populate agent-daemon memory with real project context. Manual-only — `disable-model-invocation: true`. |
| [session-close](session-close/) | End-of-session macro: session log, `<agent-daemon-digest>` block, handoff docs. |
| [skill-author](skill-author/) | Dedup-first skill authoring: classify scope, check overlap with existing skills, write or extend, log it. |
| [skill-installer](skill-installer/) | Install, find or remove skills (`ad skill install`). |
| [gepa-evolve-inline](gepa-evolve-inline/) | Evolve a skill from its execution traces inside the current session, with no API key. |
| [orchestrate-team](orchestrate-team/) | Deploy 2+ specialist agents in parallel for cross-cutting work. Use when a task spans 2+ domains and >30 min of work. |
| [feature-flow](feature-flow/) | Feature end to end: plan → build → verify. |
| [big-feature-flow](big-feature-flow/) | Multi-part work: research how others built it → plan in parts → adversarial review rounds until final → spikes → per-part implement/test/review loop. |
| [bug-flow](bug-flow/) | Bug end to end: debug-triage → fix → verify. |
| [release-flow](release-flow/) | Cut a release: changelog → verify → review → go/no-go. Never tags or pushes without OK. |
| [ad-harness](ad-harness/) | Hand work to the harness: pick `ad run` / `ad loop` / `ad schedule` / `ad sp`, set brakes, verify the result yourself. |
| [harness-troubleshoot](harness-troubleshoot/) | Harness failures: login → engine/hooks → sandbox → Codex's own log, with the known Windows causes. |
| [codex-upgrade](codex-upgrade/) | Maintainers: land a Codex engine bump — protocol diff, suite, real-engine tests, live Windows sandbox smoke, then release-flow. |
| [ad-tui-dev](ad-tui-dev/) | Maintainers: work on the `ad` terminal UI — load the plan's state, keep own-Codex isolation, the inline-renderer rules and the per-part loop. |
