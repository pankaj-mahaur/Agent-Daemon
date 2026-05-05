# CI/CD Practices

Common lint, format, type-check, and commit patterns for web projects.

## Python (Ruff)

Ruff replaces flake8, isort, black, and pyflakes — one tool for lint and format.

```bash
# Lint check (CI)
ruff check .

# Format check (CI)
ruff format --check .

# Auto-fix locally before pushing
ruff check --fix .
ruff format .
```

**Pre-push rule:** Always run `ruff format .` before pushing. CI will fail on format violations that auto-fix can handle in seconds.

### GitHub Actions

```yaml
- name: Lint and format
  run: |
    pip install ruff
    ruff check .
    ruff format --check .
```

## TypeScript

```bash
# Type-check (catches real bugs, not just style)
npx tsc --noEmit

# Lint
npx eslint .
# or
npm run lint

# Build (ensures production bundle compiles)
npm run build
```

**Pre-push rule:** `tsc --noEmit` must pass. Type errors that "work at runtime" will eventually break — catch them early.

### GitHub Actions

```yaml
- name: Type check and lint
  run: |
    npm ci
    npx tsc --noEmit
    npm run lint
```

## Go

```bash
# Format (Go enforces formatting)
gofmt -w .

# Lint
golangci-lint run

# Test
go test ./...
```

## Multi-Repo Commit Practices

When frontend and backend are separate repositories:

1. **Commit separately.** Each repo gets its own commit(s). Don't try to make an atomic cross-repo commit.
2. **Deploy order matters.** Backend changes that add new endpoints should deploy before frontend changes that call them.
3. **Stage files explicitly.** Use `git add <specific-files>`, not `git add -A` or `git add .` — this prevents accidentally committing `.env` files, secrets, or unrelated changes.
4. **One root cause = one commit.** If a bug fix touches 3 files, that's one commit, not three. If two unrelated fixes are in progress, that's two commits.

## Commit Message Style

```
type(scope): short description

Optional body explaining WHY, not WHAT.
The code shows what changed. The message explains the motivation.
```

Common types: `fix`, `feat`, `refactor`, `perf`, `test`, `docs`, `chore`

## Pre-Push Checklist

Before pushing any branch:

```bash
# Backend (Python)
ruff format .
ruff check .
python manage.py check  # or framework equivalent

# Frontend (TypeScript)
npx tsc --noEmit
npm run lint
npm run build  # at least before PRs

# Both
git diff --cached  # review what you're about to commit
```
