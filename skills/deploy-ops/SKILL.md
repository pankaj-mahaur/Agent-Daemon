---
name: deploy-ops
description: Deploy contract, CI gates, env-var plumbing, container images, prod migrations, monitoring, security hardening, rollout cache invalidation, and rollback playbook. Use when the user mentions deploy, prod, server, env, Docker, docker-compose, CI, lint pipeline, security headers, monitoring, rollout, or rate limiting. Captures the env-dispatcher contract, init-script flow, CI-gate patterns, migration safety during rollouts, cache-invalidation-on-deploy, and the open prod-readiness checklist.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Deploy and operate without breaking prod

The deploy/CI/ops layer is where small mistakes have the biggest blast radius — a missing env var silently demotes prod to dev settings; a `cache.delete_pattern("*")` on rollout nukes shared state for everyone; a migration that needs a backfill ships without one and now you're trying to fix a half-applied schema under load.

This skill is the discipline that prevents those classes of regression. It applies whether the project deploys to a VPS via PM2/nginx, AWS ECS/Fargate, Fly.io, Render, Railway, Kubernetes, or a custom Docker Compose setup.

For the migration-specific subset, see [db-migrations](../db-migrations/SKILL.md). For the launch checklist, see [production-readiness](../production-readiness/SKILL.md) and [playbooks/production-readiness.md](../../playbooks/production-readiness.md).

---

## Deploy contract — non-negotiable

### One env variable selects the settings file

A single environment variable should determine which settings module loads. Common conventions:

```python
# Django
DJANGO_ENV=production  # apiserver/settings/__init__.py dispatches to production.py vs development.py

# Rails
RAILS_ENV=production

# Node / NestJS
NODE_ENV=production

# Spring Boot
SPRING_PROFILES_ACTIVE=production
```

**Without the env var set, the server boots with dev settings** (DEBUG on, dev DB creds, verbose logging) — silently. Verify the var is plumbed end-to-end:

1. **Host environment** — `printenv NODE_ENV` / `echo $DJANGO_ENV` on the server itself (not in your local shell).
2. **Container env** — `docker compose config | grep -E "NODE_ENV|DJANGO_ENV"` shows the resolved value the container will see.
3. **App env** — add a startup log line that prints the env name + a non-secret prod fingerprint (e.g. the DB host's hash, the model name in use). First few lines of `pm2 logs` / `docker compose logs server` should show it.

If any of those three layers shows the wrong value, the deploy is misconfigured even if the app appears to work.

### One init script is the entry point

Production starts with a single script that handles install + migrate + permissions + boot, in order. Examples:

```bash
# app_init.sh / docker-entrypoint.sh — runs every container start
#!/bin/bash
set -e

# 1. Install / sync deps (no-op if image was prebuilt with deps)
if [ "$DJANGO_ENV" = "production" ]; then
  pip install -r requirements/production.txt --no-deps
fi

# 2. Run migrations
python manage.py migrate --noinput

# 3. Run idempotent setup commands
python manage.py setup_admin_permissions   # safe to re-run on every boot

# 4. Boot the server
if [ "$DJANGO_ENV" = "production" ]; then
  exec gunicorn apiserver.wsgi:application --bind 0.0.0.0:8000 --workers 4
else
  exec python manage.py runserver 0.0.0.0:8000
fi
```

```bash
# Node / Express
#!/bin/sh
set -e

if [ "$NODE_ENV" = "production" ]; then
  npm ci --omit=dev
fi
npm run db:migrate

if [ "$NODE_ENV" = "production" ]; then
  exec node dist/server.js
else
  exec npm run dev
fi
```

**Idempotent setup commands** (`setup_admin_permissions`, `seed_required_data`, `update_locales`) must be safe to re-run on every boot — pods restart, containers crash and recover, deploys happen mid-traffic.

### Compose / orchestrator wires the env var from the host

```yaml
# docker-compose.yml
services:
  server:
    environment:
      DJANGO_ENV: ${DJANGO_ENV:-development}   # default to dev
```

```yaml
# Kubernetes
env:
  - name: DJANGO_ENV
    value: production
```

```toml
# fly.toml
[env]
  DJANGO_ENV = "production"
```

To deploy prod via Compose, the host's shell or the compose `.env` file must export the env var before `docker compose up`. Otherwise the default kicks in and you ship dev settings.

---

## CI gates

Run the same gates locally that CI runs — they should be deterministic and stack-appropriate. Common shapes:

| Stack | Lint | Format check | Type-check | Test |
|---|---|---|---|---|
| TypeScript / Node | `npx eslint .` | `npx prettier --check .` | `npx tsc --noEmit` | `npm test` |
| Python (Django) | `ruff check .` | `ruff format --check .` | `mypy .` | `pytest` |
| Python (FastAPI) | `ruff check .` | `ruff format --check .` | `mypy app/` | `pytest` |
| Go | `go vet ./...` | `gofmt -l .` (must be empty) | (built-in) | `go test ./...` |
| Rust | `cargo clippy -- -D warnings` | `cargo fmt --check` | (built-in) | `cargo test` |
| Ruby | `bundle exec rubocop` | (rubocop) | `srb tc` (Sorbet) | `bundle exec rspec` |

**Always run the format check locally before pushing** — `ruff format .` / `prettier --write .` / `gofmt -w .` — or CI will reject the PR for whitespace.

Common CI failures:

- **Unused imports** — `F401` (ruff), TS6133 (tsc), `unused-imports` (eslint). Often pulled in during a refactor and left behind.
- **Undefined names** — `F821` (ruff), `no-undef` (eslint), `undefined: <Name>` (go). Refactor that renamed a symbol but missed a call site.
- **Format drift** — easiest to prevent by running formatters on save (editor config) or as a pre-commit hook.

If your project doesn't have CI for one of the clients yet (e.g. backend has CI but frontend doesn't), add it as a "open prod-readiness" item — see backlog section below.

---

## Migration safety during rollouts

See [db-migrations](../db-migrations/SKILL.md) for the full discipline. Deploy-time additions:

- **One pod / one job runs the migration**, app pods boot after. Running migrations from N parallel pods causes race conditions.
- **Backfill before enforcing constraints.** A migration that adds `NOT NULL` to a column must come after a migration that backfills the column.
- **Backup before destructive ops** (`DROP COLUMN`, `RENAME TABLE`). Confirm the dump exists in prod backup storage before letting the deploy proceed:
  ```bash
  # SQLite
  ls -lh /var/backups/app/*.db | tail -3
  # Postgres
  ls -lh /var/backups/app/*.dump | tail -3
  ```

---

## Cache invalidation during rollouts

Schema-affecting changes can leave caches with stale-shape entries that the new code expects differently. Symptoms post-deploy: 500s only on cached paths, weird type errors in logs, half-rendered pages.

After a rollout that changes any cached payload shape:

```bash
# Django + django-redis
docker compose exec -T server python manage.py shell -c \
  "from django.core.cache import cache; cache.delete_pattern('AFFECTED_PREFIX_*')"

# Direct Redis
redis-cli --scan --pattern 'project:list:*' | xargs -r redis-cli DEL

# Cloudflare cache (page cache after a rendering change)
# via API:
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"prefixes":["example.com/api/projects"]}'
```

**NEVER** wildcard the entire cache (`cache.delete_pattern('*')`, `redis-cli FLUSHDB`, `Rails.cache.clear`) on prod — it nukes shared state, triggers a thundering-herd refill, and is often blocked in sandboxed environments. Always scope.

Maintain a list of cache key families that the project uses, in `CLAUDE.md` or a comment block in the cache helper. Future deploys can paste the prefixes from that list and skip the discovery step.

---

## Multi-repo / multi-client git hygiene

For workspaces with separate repos (e.g. `frontend/`, `backend/`, `mobile/` each as its own git repo, parent dir not a repo):

- **Ignore scratch / planning notes.** `.md` files outside README and CHANGELOG are usually gitignored to keep memory and skill files OUT of the published repos. Verify before committing.
- **Stage explicitly by name.** Never `git add -A` / `git add .`. Multi-repo workspaces accumulate stray scratch files in unexpected places.
- **One commit per repo per concern.** Frontend and backend changes commit separately, in their own repos.
- **Commit message body explains why**, not what. The diff shows what; the body explains the user pain or constraint that drove the change.
- **Co-author trailers** if your workflow uses them — keep consistent across the workspace.

---

## Open prod-readiness backlog (project-specific)

Most projects have a list of "we know this is missing" items that future sessions can pick up. Track them in `PROD_READINESS.md` or a `## Backlog` section in `CLAUDE.md`. Common categories:

- **Permission classes / RBAC refactor** — replacing inlined `if not is_admin(user)` checks with reusable permission classes / middleware. Reduces audit surface.
- **Rate limiting audit** — most projects start with rate limiting on the login endpoint only. Audit other auth-adjacent endpoints (password reset, OAuth callback, token refresh) and sensitive list endpoints.
- **Error tracking** — Sentry / Honeybadger / Bugsnag wired with release version + user fingerprint. Required for prod incident response.
- **Distributed tracing / OpenTelemetry** — for multi-service architectures.
- **CSP graduation** — `Content-Security-Policy-Report-Only` first, monitor reports for one week, then graduate to enforce.
- **`.env.example` completeness** — audit needed so new devs can boot without word-of-mouth env var hunting. Every var the app reads must appear in `.env.example` with a comment explaining what it does.
- **Frontend CI** — if the backend has CI but the frontend doesn't (or vice versa), add at minimum: type-check + lint + build on PR.
- **Pre-commit hooks installed everywhere** — a pre-commit-config that the team uses but isn't enforced by CI is theatre. Either install it via `husky install` / `pre-commit install`, or make CI run the same checks.

---

## Production verification checklist

When the user asks "is this prod-ready?", run through:

1. **Env var dispatcher plumbed end-to-end** (host env → orchestrator → settings dispatcher)?
2. **Migrations safe on populated tables** (no `DROP COLUMN` without a deprecation cycle, indexes created with the non-blocking variant for the DB)?
3. **Cache key families invalidated correctly** post-deploy if the rollout changed any cached payload shape?
4. **CI pipeline green** — lint, format, type-check, tests for each client.
5. **Secrets not in repo** — `.env` ignored, no hardcoded keys in settings, `.md` notes ignored if relevant.
6. **Logs / observability adequate** for the first 24h of rollout — error tracking wired, log aggregation working, on-call has access.
7. **Rollback plan documented** — see next section.

See [playbooks/production-readiness.md](../../playbooks/production-readiness.md) for the fuller checklist.

---

## Rollback playbook

If a rollout misbehaves:

1. **Revert the offending commit and redeploy** — usually the fastest path.
   ```bash
   git revert <sha>
   git push
   # CI / deploy pipeline picks it up
   ```
2. **Wipe affected cache families** so the rolled-back code doesn't see stale shape from the bad version (Cache invalidation section above).
3. **Check migration state.** If the bad rollout ran a migration:
   - **Additive migration** (new field, new index) → tolerable; old code ignores the new column.
   - **Destructive migration** (dropped a column) → recovery is manual. Restore from the pre-migration backup taken in step 0 of the deploy. This is why backups are non-negotiable.
4. **Document the incident** — even one paragraph in an `INCIDENTS.md` (what shipped, what broke, how it was reverted, what to add to CI to prevent it) is enough to compound learning over time.
5. **Don't paper over the underlying bug** with a config flag if the bug is a regression — fix it in code, ship a fresh forward deploy.

---

## What NOT to do

- **Don't deploy without `<ENV_VAR>=production` plumbed end-to-end.** Boot logs prove it; assumption doesn't.
- **Don't `cache.delete_pattern('*')`** / `FLUSHDB` / `Rails.cache.clear` on prod.
- **Don't skip pre-commit hooks** with `--no-verify` to push faster — the hook is there for a reason. Fix the issue.
- **Don't push directly to main / master** unless the team's workflow explicitly allows it. Even small "hotfix" pushes bypass review.
- **Don't run migrations manually on prod** if the deploy pipeline runs them — duplicates and drift will follow.
- **Don't commit secrets.** Once committed they're forever in git history; rotate them.

---

## Related

- [db-migrations](../db-migrations/SKILL.md) — full migration discipline
- [production-readiness](../production-readiness/SKILL.md) — pre-launch full checklist
- [playbooks/ci-cd-practices.md](../../playbooks/ci-cd-practices.md) — lint/format/type-check patterns
- [playbooks/security-checklist.md](../../playbooks/security-checklist.md) — trust boundaries + auth review
