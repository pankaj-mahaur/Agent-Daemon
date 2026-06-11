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
ad --version       # → 0.2.0+
ad doctor          # → all green
cd ../runtime && npm test
```

You should see `# pass 33` (or whatever the current count is).

---

## Project layout (the 60-second tour)

```
runtime/src/cli.mjs              ← Entry point, command dispatcher
runtime/src/digest/digest.mjs    ← Pipeline orchestrator (read first)
runtime/src/hooks/*.mjs          ← One file per hook handler
runtime/src/adapters/*.mjs       ← Transcript parsers (claude-code, codex, cursor)
runtime/src/memory/episodic.mjs  ← SQLite wrapper
runtime/src/orchestration/       ← Multi-agent team layer
runtime/test/*.test.mjs          ← node:test suite

constitution/                    ← Loaded into every session
skills/<name>/SKILL.md           ← One per skill
hooks/*.json                     ← Snippets for ~/.claude/settings.json
profiles/profiles.json           ← What each install profile pulls in
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
2. **Add an entry to the help banner** in `cli.mjs`
3. **Add a `case "<name>":` in the dispatcher** at the bottom of `cli.mjs`
4. **Implement the handler** — either inline in `cli.mjs` (if < 50 lines) or in its own module
5. **Add at least one test** in `runtime/test/<name>.test.mjs`
6. **Document it** in `docs/workflow.md` if user-facing

Example skeleton:

```js
// in cli.mjs
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
3. **Wire it into `cli.mjs`**'s hook dispatcher
4. **Create a JSON snippet** at `hooks/<event>-<name>.json` so users can copy-paste
5. **Add to a profile** in `runtime/profiles/profiles.json` if it's part of `developer` or `security`
6. **Test it** with a subprocess test (see `runtime/test/hooks.test.mjs` for the pattern)
7. **Document** in `hooks/README.md`

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
- Every PR must pass CI: `npm test` + `npm run lint:skills` on Ubuntu / macOS / Windows × Node 22

---

## Versioning + releases

- We use **semver** (currently 0.2.0)
- Bump `runtime/package.json` `version` field
- Update `CHANGELOG.md` with the new section
- Tag the release: `git tag v0.2.x && git push --tags`
- `runtime/src/cli.mjs` reads version from `package.json` — no separate update needed

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
- [Manual test checklist](./manual-test-v0.2.0.md) — full end-to-end verification

Welcome aboard.
