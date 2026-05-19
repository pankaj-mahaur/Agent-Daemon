---
name: methodology-dependency-management
description: Use when adding, upgrading, or auditing third-party packages and libraries. Covers the decision of whether to add a dependency at all, evaluation criteria, version pinning strategy, upgrade discipline, and how to avoid supply-chain risk.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Dependency Management Methodology

Every dependency you add is a bet that the maintainer will keep it working, keep it secure, and keep it compatible — forever. Some bets are good (a well-maintained crypto library). Some are terrible (a 3-line utility with 47 transitive dependencies from an anonymous author).

This skill provides the discipline for making those bets deliberately.

---

## The first question: should you add this dependency at all?

Before evaluating any package, answer this:

**Can you write it yourself in under 30 minutes with no ongoing maintenance burden?**

If yes, write it yourself. A 10-line utility function in your codebase has zero supply-chain risk, zero version conflicts, and zero upgrade burden. A package that does the same thing has all three.

```ts
// Do you really need a package for this?
// leftPad, isEven, isOdd, isNumber — write it yourself.

function leftPad(str: string, length: number, char = " "): string {
  return str.padStart(length, char);
}
```

**Exceptions:** Crypto, compression, image processing, parsers for complex formats (CSV, XML, YAML), and anything involving platform-specific native code. These are genuinely hard to write correctly. Use a library.

---

## Evaluating a dependency

When you have decided a dependency is justified, evaluate it on these criteria:

### 1. Maintenance health

| Signal | Green | Red |
|--------|-------|-----|
| Last commit | Within 6 months | Over 2 years ago |
| Open issues | Triaged, some closed | Hundreds, no responses |
| Release frequency | Regular releases | Last release 2+ years ago |
| Bus factor | Multiple active maintainers | Single maintainer, sporadic |
| CI status | Passing, visible | No CI or failing |

**A package with no commits in 2 years is not necessarily dead.** Some packages are simply done (e.g., `ms`, `escape-html`). Check if the package is feature-complete and stable, or abandoned.

### 2. Scope and size

- **Does it do one thing well, or is it a kitchen sink?** Prefer focused packages. `date-fns` (import only what you use) over `moment` (imports everything).
- **How large is it?** Check the unpacked size (`npm pack --dry-run` or bundlephobia.com). A 2MB package for a utility function is a red flag.
- **How many transitive dependencies?** Each one is an additional supply-chain risk. `npm ls --all <package>` shows the full tree.

### 3. License compatibility

The package license must be compatible with your project. The quick reference:

| License | Can use in proprietary? | Can use in open source? | Must distribute license? |
|---------|------------------------|------------------------|-------------------------|
| MIT | Yes | Yes | Yes (include the text) |
| Apache 2.0 | Yes | Yes | Yes + NOTICE file |
| BSD 2/3 | Yes | Yes | Yes |
| ISC | Yes | Yes | Yes |
| GPL 2/3 | No (viral) | Yes (if same license) | Must open-source derivative |
| LGPL | Yes (with care) | Yes | Must allow relinking |
| UNLICENSED | No | No | No rights granted |

**If the package has no license, do not use it.** No license means all rights reserved by the author.

### 4. Security track record

- Check for known vulnerabilities: `npm audit`, `pip audit`, `cargo audit`
- Review the package's security policy (do they accept vulnerability reports? how fast do they patch?)
- Check if the package has been involved in supply-chain attacks (Google the package name + "malware" or "supply chain")

### 5. API stability

- Does the package follow semver? Check the changelog for breaking changes in minor versions (a bad sign).
- Is the API surface small and stable, or does it change frequently?
- Are there migration guides for major versions?

---

## Version pinning strategy

### Lock files: always commit them

`package-lock.json`, `yarn.lock`, `poetry.lock`, `Cargo.lock` — these files ensure that every developer and CI environment uses the exact same dependency versions. **Always commit them.** Never `.gitignore` them.

### Pinning policy by dependency type

| Dependency type | Pin strategy | Rationale |
|----------------|-------------|-----------|
| Direct (your code uses it) | Pin exact or ~minor | You test against this version |
| Dev (test frameworks, linters) | ^major or ~minor | Less risk, easier to stay current |
| Peer (library consumers must provide) | Range (^major) | You want compatibility with consumer versions |

```json
// package.json
{
  "dependencies": {
    "express": "~4.18.2",     // Accept patches, not minors
    "pg": "8.11.3"            // Exact pin — database driver, high risk
  },
  "devDependencies": {
    "vitest": "^1.0.0",       // Accept any 1.x — low risk
    "typescript": "~5.3.0"    // Accept patches — compiler changes can break builds
  }
}
```

### Never use `*` or `latest`

```json
// NEVER do this
{ "some-package": "*" }
{ "some-package": "latest" }
```

This means every install gets whatever the latest version is, which could include breaking changes or even a compromised release. You lose reproducibility entirely.

---

## Upgrade discipline

### Regular cadence

Set a recurring schedule for dependency upgrades — weekly for security patches, monthly for minor versions, quarterly for major versions. Do not let dependencies drift for a year and then attempt a massive upgrade.

### Upgrade process

1. **Check what is outdated.** `npm outdated`, `pip list --outdated`, `cargo outdated`
2. **Read the changelog for each update.** Even patch versions. Especially if the package is in your critical path.
3. **Upgrade one dependency at a time.** If you upgrade 15 packages in one PR and tests break, you do not know which one caused it. One dependency per commit makes bisecting trivial.
4. **Run the full test suite.** Not just unit tests — integration tests, end-to-end tests, build checks. Dependencies can break things that unit tests do not cover.
5. **Test in a staging environment** for critical dependencies (database drivers, HTTP frameworks, auth libraries).

### Handling major version upgrades

Major versions have breaking changes. For critical dependencies:

1. Read the migration guide completely before starting
2. Create a dedicated branch for the upgrade
3. Apply the migration steps incrementally (see [methodology-incremental-delivery](../methodology-incremental-delivery/SKILL.md))
4. Run the full test suite after each step
5. Deploy to staging before merging to main

### When an upgrade breaks things

If an upgrade introduces a regression and you cannot fix it quickly:

1. Revert the upgrade immediately
2. Pin the previous version explicitly
3. File an issue upstream
4. Add a comment explaining why the version is pinned and link to the issue

```json
// package.json — document why versions are pinned
{
  "dependencies": {
    "some-lib": "2.3.1"
  },
  "comments": {
    "some-lib": "Pinned to 2.3.1 — v2.4.0 breaks streaming responses, see https://github.com/org/some-lib/issues/789"
  }
}
```

---

## Supply-chain security

### Threat model

- **Typosquatting:** `expres` instead of `express`. Always verify the package name.
- **Account takeover:** Maintainer's npm/PyPI account gets compromised, and a malicious version is published.
- **Dependency confusion:** A private package name collides with a public one, and the wrong one is installed.
- **Install scripts:** Some packages run arbitrary code during `npm install`. Use `--ignore-scripts` for untrusted packages and review the scripts.

### Mitigations

1. **Use lock files.** They prevent surprise version changes.
2. **Enable `npm audit` in CI.** Fail the build on high/critical vulnerabilities.
3. **Review new dependencies before adding.** Read the source, check the author, verify the package on the registry.
4. **Use scoped registries** for private packages to prevent dependency confusion.
5. **Pin by integrity hash.** Lock files include integrity hashes (SRI). They detect if a published version is modified after the fact.
6. **Limit install scripts.** Use `.npmrc` with `ignore-scripts=true` and explicitly allow scripts for packages that need them.

---

## Removing dependencies

Dependencies should be removed when:

- The feature that used them is deleted
- You have replaced the dependency with a simpler alternative or custom code
- The dependency is abandoned with known vulnerabilities and no patches forthcoming

**Process:**
1. Remove the import/require from all source files
2. Remove from `package.json` / `requirements.txt` / `Cargo.toml`
3. Run `npm prune` or equivalent to clean the lock file
4. Run the full test suite to verify nothing breaks
5. Check for orphaned configuration (`.babelrc` plugins, webpack loaders, etc.)

---

## Verification checklist

When adding a new dependency:

- [ ] Justified: cannot be reasonably written in-house
- [ ] Maintenance health checked (commits, issues, maintainers, CI)
- [ ] License is compatible with the project
- [ ] No known vulnerabilities (`npm audit` / `pip audit` / `cargo audit`)
- [ ] Transitive dependency count is acceptable
- [ ] Bundle size impact is acceptable
- [ ] Version is pinned appropriately (not `*` or `latest`)
- [ ] Lock file is updated and committed

When upgrading dependencies:

- [ ] Changelog reviewed for breaking changes
- [ ] One dependency per commit/PR
- [ ] Full test suite passes
- [ ] Staging deployment verified (for critical deps)

---

## Related

- [security-audit](../security-audit/SKILL.md) — dependency audit is part of security review
- [methodology-code-review](../methodology-code-review/SKILL.md) — new dependencies should be reviewed carefully in PRs
- [production-readiness](../production-readiness/SKILL.md) — dependency health is a production readiness concern
