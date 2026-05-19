---
name: production-readiness
description: Audit any web application for production launch and runtime readiness. Use when asked for production readiness, deployment hardening, launch audit, runtime health, environment checks, build readiness, logging, monitoring, rollback, backups, database operations, or background job review.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Production Readiness Audit

Use this for launch-readiness and runtime-hardening work on any web application.

## Workflow

1. **Read existing docs** — check for deployment guides, runbooks, environment docs, and past audit notes.
2. **Check repo structure** — identify separate repos, monorepo packages, or service boundaries. Understand the deploy target (Docker, Kubernetes, serverless, PaaS, etc.).
3. **Inspect runtime config** without reading secrets:
   - Container/orchestration config (docker-compose, Dockerfile, k8s manifests)
   - Backend entry point and startup scripts
   - Backend settings/config (environment-based switching between dev/prod)
   - Frontend build config and environment variables
4. **Verify current health** before deeper work:
   - Are all services running?
   - Check recent logs for errors
   - Hit health endpoints if available
5. **Run through the checklist categories** below.
6. **Report blockers first**, then risks, then cleanup.

## Checklist Categories

### Runtime Health
- [ ] All services start and respond (frontend, backend, database, cache, workers)
- [ ] Health check endpoints exist and return meaningful status
- [ ] Graceful shutdown handles in-flight requests
- [ ] Restart policies configured for crash recovery

### Environment and Secrets
- [ ] Production environment flag is set (not running in dev mode)
- [ ] All required environment variables are documented
- [ ] Secrets are not hardcoded or committed to source control
- [ ] Sensitive config differs between environments (DB URLs, API keys, domains)

### Security Configuration
- [ ] Debug mode disabled in production
- [ ] HTTPS enforced (HSTS headers, secure cookies, redirect HTTP → HTTPS)
- [ ] CORS restricted to known origins
- [ ] Content Security Policy headers set
- [ ] Cookie flags correct (httpOnly, secure, sameSite)
- [ ] Admin/internal endpoints not publicly accessible

### Database and Migrations
- [ ] All migrations applied and tested for safety (no data loss, no long locks)
- [ ] Indexes exist for frequently filtered/sorted columns
- [ ] Connection pooling configured
- [ ] Backup strategy documented and tested
- [ ] Rollback procedure for failed migrations documented

### Observability and Operations
- [ ] Application logging configured (not just print statements)
- [ ] Error reporting/alerting set up (Sentry, Datadog, etc.)
- [ ] Key metrics monitored (response times, error rates, queue depth)
- [ ] Log rotation or external log shipping configured
- [ ] Rollback/deploy procedure documented

### Background Jobs (if applicable)
- [ ] Job scheduler configured with correct timezone
- [ ] Tasks have timeouts, retries, and dead-letter handling
- [ ] Idempotency ensured for retried tasks
- [ ] Duplicate scheduling prevented (beat lock or equivalent)

### Frontend Release Gates
- [ ] Type-check passes (`tsc --noEmit` or equivalent)
- [ ] Lint passes
- [ ] Production build succeeds
- [ ] Bundle size within acceptable limits
- [ ] No development-only code in production bundle

### Backend Release Gates
- [ ] Framework deploy/production checks pass
- [ ] Lint and format checks pass
- [ ] Test suite passes (or known failures documented)
- [ ] No pending migrations
- [ ] Dependency audit shows no critical vulnerabilities

## Output

Group findings as:

| Severity | Meaning |
|----------|---------|
| **Blocker** | Prevents reliable verification or safe launch |
| **High** | Production security, data, or runtime risk |
| **Medium** | Operational weakness or scaling risk |
| **Low** | Documentation or polish gap |

Each finding needs: files/config involved, what's wrong, concrete fix, and verification step.
