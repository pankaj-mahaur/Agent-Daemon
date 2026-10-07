# Contributing

For new developers joining the agent-daemon project. Skim this once before your first change.

---

## Get the source

```sh
git clone https://github.com/pankaj-mahaur/Agent-Daemon.git
cd Agent-Daemon
cd runtime
npm install
npm link
```

Verify:

```sh
ad --version       # → the version in runtime/package.json
ad doctor          # → all green
cd ../runtime && npm test
```

All tests should pass (`# fail 0`).

---

## Project layout (the 60-second tour)

```
runtime/src/cli.mjs              ← Launcher: routes the terminal UI and `ad codex`, loads cli-full.mjs for the rest
runtime/src/cli-full.mjs         ← Help text + command dispatcher
runtime/src/digest/digest.mjs    ← Pipeline orchestrator (read first)
runtime/src/hooks/*.mjs          ← One file per hook handler
runtime/src/adapters/*.mjs       ← Transcript parsers (claude-code, codex, cursor, cline)
runtime/src/memory/episodic.mjs  ← SQLite wrapper
runtime/src/orchestration/       ← Multi-agent team layer (Codex + claude workers)
runtime/src/engine/codex/        ← Codex app-server driver (the harness engine)
runtime/src/harness/             ← ad chat / run / loop / schedule / web / acp / auth / sandbox / codex, session controller, /undo checkpoints
runtime/src/tui/                 ← ad tui: terminal/ layer, view/ components, app, /undo wiring
runtime/test/*.test.mjs          ← node:test suite

constitution/                    ← Loaded into every session
skills/<name>/SKILL.md           ← One per skill
hooks/*.json                     ← Snippets for ~/.claude/settings.json
runtime/profiles/profiles.json   ← What each install profile pulls in
```

Read [`docs/architecture.md`](./architecture.md) for the full picture.

---

## Coding conventions

### Code style

- **Plain ESM modules** (`.mjs`), no TypeScript, no transpilation
- **Node 22+** features OK (top-level await, `node:test`, `node:util/parseArgs`)
- **Prefer pure functions** for testable units; side effects (fs, child_process) at the edges
- **No formal style enforcement** (no Prettier / ESLint config yet) — match surrounding code
- **JSDoc types** on public APIs where it helps

### Naming

- File names: `kebab-case.mjs`
- Functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Hook handlers: `<event>-<short-name>.mjs` (e.g. `bash-pre.mjs`)
- Skills: `<verb>-<noun>` (e.g. `debug-triage`, `review-slice`)

### Comments

- Comment **why**, not **what**
- Top of each module: 1-3 line purpose statement
- Inline comments for non-obvious decisions only

### Error handling

- **Hook handlers must fail-safe to approve** — see [`SECURITY.md`](../SECURITY.md)
- Top-level async functions wrap in try/catch and log to stderr with `[agent-daemon]` prefix
- Persistence (fs writes, SQLite inserts) is always best-effort — never let a write failure crash a CLI command

---

## Adding a new command

1. **Define what it does in one sentence.** If you can't, the command is too big.
2. **Add an entry to the help banner** (`HELP`) in `cli-full.mjs`
3. **Add a `case "<name>":` in the dispatcher** (the `switch (command)` in `cli-full.mjs`)
4. **Implement the handler** — either inline in `cli-full.mjs` (if < 50 lines) or in its own module
5. **Add at least one test** in `runtime/test/<name>.test.mjs`
6. **Document it** in `docs/workflow.md` (Claude Code mode) or `docs/harness.md` (harness) if user-facing

`cli.mjs` itself stays a small launcher: only commands that must start before the full command module loads (the terminal UI, `ad codex`) are routed there.

Example skeleton:

```js
// in cli-full.mjs
async function cmdHello(opts) {
  console.log(`hello, ${opts.cwd}`);
  return 0;
}

// later in the switch:
case "hello":  return cmdHello(opts);
```

```js
// in test/hello.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

test("hello command exits 0", async () => {
  // ... use spawn() to invoke `node src/cli.mjs hello`
});
```

---

## Adding a new hook

1. **Decide which event**: `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `Stop`
2. **Create the handler** at `runtime/src/hooks/<event>-<name>.mjs`. Use [`io.mjs`](../runtime/src/hooks/io.mjs) for stdin/stdout protocol.
3. **Wire it into the hook dispatcher** (`cmdHook` in `cli-full.mjs`)
4. **Create a JSON snippet** at `hooks/<event>-<name>.json` so users can copy-paste
5. **Add to a profile** in `runtime/profiles/profiles.json` if it's part of `developer` or `security`
6. **Test it** with a subprocess test (see `runtime/test/hooks.test.mjs` for the pattern)
7. **Document** in `hooks/README.md`

Hooks in `profiles.json` are also rendered into the Codex harness (`CODEX_HOME/hooks.json`, see `runtime/src/engine/codex/hooks-config.mjs`). There the handler runs with `--host codex`, so read input and write decisions through `io.mjs`, which adapts Codex's shapes. Skill-use hooks are skipped in the harness.

Hook handler contract:

- Reads JSON from `stdin`
- Writes a JSON decision to `stdout`
- Logs warnings to `stderr` (never `stdout`)
- Finishes in **< 200 ms** for `PreToolUse` and `Stop`
- **Returns approve on any unexpected error** (fail-safe)

---

## Adding a new skill

A skill is a single `SKILL.md` file under `skills/<name>/`:

```yaml
---
name: my-skill
description: Use when ... (≤ 500 chars, kebab-case name)
---

# Skill body (markdown)

Concrete steps the agent should follow when this skill triggers.
```

Lint your skill:

```sh
node runtime/scripts/lint-skills.mjs
```

The linter checks frontmatter shape, line length, "Use when..." in description, etc.

---

## Adding a new test

Tests live in `runtime/test/*.test.mjs`. We use `node --test` (no Jest, no Mocha):

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("description of what's being tested", async () => {
  assert.equal(1 + 1, 2);
});
```

Run:

```sh
cd runtime
npm test
```

For subprocess tests (CLI commands, hook handlers), see [`runtime/test/hooks.test.mjs`](../runtime/test/hooks.test.mjs) for the established pattern.

The full map of test layers, the live terminal UI tests and CI is in [testing.md](testing.md). The test tools (`@xterm/headless`, `@lydell/node-pty`) are devDependencies: install with plain `npm install` (or `npm ci`), not `--omit=dev`.

Harness tests come in two kinds:

- **Fake engine (default).** Most harness tests drive the scripted fake app-server in [`runtime/testkit/fake-codex-app-server.mjs`](../runtime/testkit/fake-codex-app-server.mjs): fast, and good for crashes and odd traffic. A test that builds `CodexAppServer` around the fake directly marks the command `source: "test-double"`.
  - **The fake speaks the pinned protocol.** `test/tui-resilience.test.mjs` checks its messages with [`runtime/testkit/protocol-check.mjs`](../runtime/testkit/protocol-check.mjs) (required fields, enums, variants from the snapshot). A new scenario must keep passing it. The `future` scenario is the deliberate exception: a synthetic newer Codex.
- **Real engine (opt-in).** [`runtime/test/engine-real.test.mjs`](../runtime/test/engine-real.test.mjs) runs the pinned Codex binary against [`runtime/testkit/mock-responses.mjs`](../runtime/testkit/mock-responses.mjs), a scripted stand-in for the Responses API. No login and no network are needed. It catches behaviour changes in a Codex release that a protocol snapshot can't. [`runtime/test/tui-live.test.mjs`](../runtime/test/tui-live.test.mjs) goes one step further: the real `ad tui` in a pseudo-terminal, on the real Codex and the mock model, running the manual test's terminal UI script and ad's own TUI features. CI's `engine-real` job runs both on Linux, macOS and Windows.

  ```sh
  cd runtime
  AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs test/tui-live.test.mjs
  ```

**Golden files.** Terminal UI output is compared byte for byte with files under `runtime/test/golden/` (kept LF by `.gitattributes`) through `assertGolden()` in [`runtime/testkit/golden.mjs`](../runtime/testkit/golden.mjs). After an intended change, rewrite them and review the diff before committing:

```sh
cd runtime
AD_UPDATE_GOLDEN=1 node --test test/tui-text.test.mjs
git diff test/golden
```

**Screen tests.** Renderer tests run against two terminals from [`runtime/testkit/screen.mjs`](../runtime/testkit/screen.mjs). `xtermScreen` is real `@xterm/headless`, which reflows on resize like Windows Terminal and Zed. `modelScreen` is a small VT model that never reflows. Both can delay CPR answers (`cprDelayMs`) to expose races. `test/tui-pty-smoke.test.mjs` runs `scripts/tui-demo.mjs` in a real pseudo-terminal (ConPTY on Windows) through `@lydell/node-pty`. All three packages are devDependencies only. To check the terminal layer by eye, run `node runtime/scripts/tui-demo.mjs`.

**Width table.** `runtime/src/tui/terminal/width-table.mjs` is generated: `node runtime/scripts/gen-width-tables.mjs [version]` (pinned to Unicode 16.0.0). Bump it on purpose and re-run the width tests.

**Never start the real Codex outside an isolated home.** Every spawn site builds its environment with `codexEnv()` (`runtime/src/engine/codex/home.mjs`). That refuses the user's own `~/.codex` and their `CODEX_HOME`, and drops their `CODEX_*` variables. On Windows the spawn also goes through `withoutStoreAliases()` (`runtime/src/engine/codex/app-server.mjs`), which drops every `WindowsApps` entry from PATH. A test fails when a new file resolves the Codex binary without `codexEnv()`. Tests use temp homes.

**Bumping the Codex pin.** `test/tui-resilience.test.mjs` checks two files against the pin in `runtime/package.json`:
- `runtime/src/tui/codex-slash.json` (Codex's slash-command names at the pinned tag; regenerate with `node runtime/scripts/codex-slash.mjs`), so ad's own commands never collide with Codex's;
- `runtime/src/engine/codex/compat.json`, which must list the pin as tested, with a user-facing "what changed" note. `AD_COMPAT_NOTE_PENDING=1` lets the upgrade bot's run pass until a person writes it.

CI has no real login and no working Windows sandbox. Before merging an engine bump, run the live `ad run` and `ad tui` smokes on Windows in a scratch directory; the [`codex-upgrade`](../skills/daemon/codex-upgrade/SKILL.md) skill has the steps.

---

## Commit conventions

We use **conventional commits**:

```
<type>(<scope>): <subject>

<body — wrap at 72 chars, explain the why>

Co-Authored-By: <name> <email>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

Examples:

- `feat(digest): add --force flag to bypass triage`
- `fix(watch): use polling on Windows`
- `docs(workflow): document digest-latest command`

Body should explain **why**, not what. The diff shows what.

---

## Branching + PRs

- Branch from `main`
- Name your branch `feat/<thing>` or `fix/<thing>`
- Open PRs early as drafts if you want feedback
- Squash-merge into `main` (we prefer linear history)
- Every PR to `main` must pass CI: `npm test` + the skill linter on Ubuntu / macOS / Windows × Node 22. The `engine-real` job (real Codex vs a mock model, plus the live terminal UI tests) runs alongside; it is non-blocking (`continue-on-error`) while each platform's sandbox behaviour is being recorded, so read its result.
- Before pushing, check the doc links: `node runtime/scripts/check-doc-links.mjs` (every relative link must point at a file git tracks).

---

## Versioning + releases

- We use **semver** (current version: `runtime/package.json`)
- Bump `runtime/package.json` `version` field
- Update `CHANGELOG.md` with the new section
- Tag the release after merge: `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`
- v1 bug fixes go to the `release/v1` branch (tags `v1.x.y`)
- `runtime/src/cli.mjs` and `runtime/src/cli-full.mjs` read the version from `package.json` — no separate update needed

---

## Local development tips

### Run the CLI without `npm link`

```sh
node runtime/src/cli.mjs <command> <flags>
```

### Run a single test file

```sh
node --test runtime/test/<name>.test.mjs
```

### Debug a hook handler

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' |
  node runtime/src/cli.mjs hook bash-pre
```

### Watch the watcher without polluting your real `~/.claude/projects/`

Edit `~/.agent-daemon/watch.json` to point at a sandbox directory.

### See what a terminal sends (terminal UI work)

```sh
node runtime/scripts/tui-probe.mjs keys     # keys and pastes as raw bytes
node runtime/scripts/tui-probe.mjs screen   # wrapping, autowrap-off, sync output, resize reflow
```

Logs land in `~/.agent-daemon/logs/tui-probe-*.log`. How the terminal UI is built, and why: [tui-architecture.md](tui-architecture.md). How it is tested: [testing.md](testing.md).

### Edit files that contain backslashes or `$`

Use an editor or a script file, not a shell heredoc: heredocs in some Windows shells silently halve backslashes. In Node scripts, pass a function to `String.prototype.replace` (`s.replace(a, () => b)`), because `$'` and `$&` in a replacement string are patterns.

Write invisible characters (zero-width, bidi, control) as braced escapes such as `\u{200b}`, never raw. Some editing tools turn 4-hex escapes into the raw character. `grep -nP '[^\x00-\x7F]' <file>` shows what landed.

---

## Where to ask

- GitHub Issues for bugs / feature requests
- Pull request comments for code review
- `pankaj@mobiux.in` for security issues (see [SECURITY.md](../SECURITY.md))

---

## See also

- [Architecture](./architecture.md) — how it all fits together
- [Workflow](./workflow.md) — daily use
- [Troubleshooting](./troubleshooting.md) — common failure modes
- [SECURITY.md](../SECURITY.md) — threat model + responsible disclosure
- [Manual test checklist](./manual-test.md) — end-to-end checklist (Claude Code mode + harness)

Welcome aboard.
