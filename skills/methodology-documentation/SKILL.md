---
name: methodology-documentation
description: Use when creating README files, API docs, architecture docs, or the user asks for documentation. Covers audience analysis, structure decisions, maintenance strategy, and the common failure modes that make documentation useless within weeks of writing it.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Documentation Methodology

Documentation fails not because people refuse to write it, but because they write the wrong things, in the wrong place, at the wrong level of detail. Good docs answer a question someone actually has, at the moment they have it.

This skill provides the discipline for writing docs that stay useful.

---

## Before writing anything: identify the audience

Every documentation decision flows from who will read it. There are exactly four audiences, and they need different things:

### New contributor (first day)

Needs: how to clone, install, run, and see something working in under 10 minutes. Does NOT need architecture rationale, history, or design philosophy. If your README requires reading 3 other docs before the contributor can run the project, it has failed.

### Active developer (daily use)

Needs: API reference, configuration options, environment variables, common tasks ("how do I add a new migration?", "how do I run a subset of tests?"). Needs to find answers in under 30 seconds. Prose paragraphs are the enemy here — use tables, code blocks, and command examples.

### Operator / deployer

Needs: deployment steps, environment requirements, monitoring endpoints, failure modes, rollback procedures. Needs zero ambiguity. "Configure the database" is useless; "Set DATABASE_URL to a PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/db`" is useful.

### Future maintainer (6 months from now)

Needs: why decisions were made, what was considered and rejected, where the bodies are buried. This is architecture documentation and ADRs. See [methodology-architectural-decision](../methodology-architectural-decision/SKILL.md).

**Common mistake:** Writing one document that tries to serve all four audiences. It serves none of them well.

---

## Document types and where they live

### README.md (root of repo)

**Purpose:** Get a new person from zero to running in under 10 minutes.

**Must contain:**
- One sentence explaining what this project does (not how it works — what it does)
- Prerequisites (Node version, system dependencies, required accounts)
- Clone + install + run commands, copy-pasteable
- How to run tests
- Link to deeper docs

**Must NOT contain:**
- Architecture explanations (link to them instead)
- API reference (it belongs near the code or in a dedicated docs folder)
- Changelog (it belongs in CHANGELOG.md or release notes)
- Badges that are not actively maintained

**Litmus test:** Delete everything and rewrite it as the steps you would Slack to a new teammate on their first day.

### API documentation

**Where it lives:** As close to the code as possible. For REST APIs, OpenAPI/Swagger specs generated from route definitions. For libraries, JSDoc/TSDoc/docstrings rendered by a doc tool.

**What it must include for each endpoint or function:**
- What it does (one sentence)
- Parameters with types, constraints, and defaults
- Return value shape
- Error responses with status codes and body shapes
- One concrete example (request + response, or call + return)

**What it must NOT include:**
- Implementation details ("internally this calls the user service which...")
- Prose explanations of why the API exists

### Architecture docs

**Where they live:** `docs/architecture/` or `docs/adr/` in the repo.

**When to write one:** When someone asks "why does this work this way?" more than once, or when you are making a decision that will be expensive to reverse. See [methodology-architectural-decision](../methodology-architectural-decision/SKILL.md) for the ADR format.

### Inline code comments

**When to write one:** When the code does something non-obvious and the "why" is not apparent from the code itself.

```ts
// Good — explains WHY
// We retry 3 times because the upstream API has transient 503s
// during their deployment window (confirmed with their team).
await retry(3, () => fetchUpstreamData());

// Bad — explains WHAT (the code already says this)
// Retry fetching upstream data 3 times
await retry(3, () => fetchUpstreamData());

// Bad — no comment where one is needed
const offset = 37; // Why 37? Nobody knows. Nobody will ever know.
```

---

## Writing the actual content

### Lead with the action, not the context

```
// Bad — buries the useful part
"The authentication system uses JWT tokens stored in HTTP-only cookies.
When developing locally, you may need to configure CORS. To do this,
set CORS_ORIGIN in your .env file."

// Good — starts with what to do
"Set CORS_ORIGIN=http://localhost:3000 in your .env file.
This configures CORS for local development.
(The auth system uses JWT tokens in HTTP-only cookies, which require
matching CORS origins.)"
```

### Use concrete examples, not abstract descriptions

```
// Bad
"The config accepts a retry policy object."

// Good
"The config accepts a retry policy:
```json
{
  "retries": 3,
  "backoffMs": 1000,
  "backoffMultiplier": 2
}
```
This retries up to 3 times, waiting 1s, 2s, 4s between attempts."
```

### Prefer tables over prose for reference material

```
// Bad
"The LOG_LEVEL variable can be set to 'debug' for verbose output,
'info' for standard output, 'warn' for warnings only, or 'error'
for errors only. The default is 'info'."

// Good
| Variable    | Values                          | Default | Description         |
|-------------|--------------------------------|---------|---------------------|
| LOG_LEVEL   | debug, info, warn, error       | info    | Log verbosity level |
```

### Make commands copy-pasteable

Every shell command in docs should work when pasted directly. No placeholder variables without explanation, no commands that assume a specific working directory without saying so, no "then run the build" without showing the actual command.

```
// Bad
"Run the migration command with your database URL."

// Good
"```bash
DATABASE_URL=postgres://localhost:5432/myapp npx prisma migrate deploy
```"
```

---

## Keeping docs alive

Documentation rots. The only question is how fast.

### Strategies that work

- **Docs live next to the code they describe.** A migration guide in `docs/migrations.md` rots. A comment at the top of `src/db/migrate.ts` explaining how to add a migration survives, because anyone editing that file sees it.
- **CI checks for doc freshness.** If you have an OpenAPI spec, validate it against the actual routes in CI. If you have a CLI help text, generate it from the code rather than maintaining it by hand.
- **Docs-as-code reviews.** When a PR changes behavior, the reviewer asks "does this change affect any docs?" Make it part of the review checklist.
- **Delete docs aggressively.** Outdated docs are worse than no docs. If a doc describes a feature that no longer exists, delete the doc. If a doc is partially correct, fix it or delete it — "mostly right" documentation causes debugging sessions.

### Strategies that do NOT work

- "Documentation sprints" — produces a burst of docs that rot immediately
- Wikis disconnected from the repo — nobody updates them, and they drift
- Auto-generated docs with no human review — produces accurate but incomprehensible reference material
- "Document everything" policies — produces volume, not value

---

## Documentation review checklist

Before publishing or merging docs:

- [ ] Every command can be copy-pasted and will work
- [ ] No placeholder values without explanation (`YOUR_API_KEY` must say where to get the key)
- [ ] Audience is clear — who is this for, and what question does it answer?
- [ ] No outdated references (check version numbers, file paths, feature names)
- [ ] At least one concrete example for every abstract concept
- [ ] No "obvious" steps skipped (test by following the doc from scratch)
- [ ] Links to other docs are valid and point to the right section

---

## When to say no to documentation

Not everything should be documented. Sometimes the right answer is:

- **Make the code self-documenting.** Rename `processData` to `parseCSVAndInsertRows` and the need for a comment disappears.
- **Add a type definition.** A TypeScript interface documents the shape better than any prose description.
- **Write a test.** A well-named test case is executable documentation that cannot go stale.
- **Automate the process.** Instead of documenting a 12-step release process, write a release script and document how to run it.

---

## Related

- [methodology-architectural-decision](../methodology-architectural-decision/SKILL.md) — ADRs for capturing design decisions
- [methodology-api-design](../methodology-api-design/SKILL.md) — designing APIs that need less documentation
- [docs-sync-audit](../docs-sync-audit/SKILL.md) — auditing docs for staleness
