# Production Readiness Checklist

A comprehensive launch checklist. Go through each section before deploying to production.

## Runtime Health

- [ ] All services start successfully (frontend, backend, database, cache, workers)
- [ ] Health check endpoints exist and return meaningful status
- [ ] Services restart automatically on crash (restart policies, process managers)
- [ ] Graceful shutdown handles in-flight requests
- [ ] Resource limits set (memory, CPU) to prevent runaway processes

## Environment and Secrets

- [ ] Production environment flag is set (not running in dev mode)
- [ ] All required environment variables documented in a `.env.example` or similar
- [ ] No secrets hardcoded in source code
- [ ] Secrets differ between environments (dev/staging/production)
- [ ] `.env` files in `.gitignore`
- [ ] Secret rotation procedure documented

## Security

- [ ] Debug mode disabled
- [ ] HTTPS enforced (HSTS headers, secure cookie flag, HTTP → HTTPS redirect)
- [ ] CORS restricted to known production origins
- [ ] Content Security Policy headers configured
- [ ] Cookie flags set: `httpOnly`, `secure`, `sameSite`
- [ ] Admin endpoints restricted (IP allowlist, VPN, or additional auth)
- [ ] Rate limiting on auth and public endpoints
- [ ] Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`

## Database

- [ ] All migrations applied and verified safe (no data loss, no long-running locks)
- [ ] Indexes exist for frequently filtered/sorted/joined columns
- [ ] Connection pooling configured and sized appropriately
- [ ] Backup strategy: automated, tested, documented recovery procedure
- [ ] Migration rollback plan documented for each migration
- [ ] Database credentials rotated and not shared across environments

## Observability

- [ ] Structured logging configured (JSON, not print statements)
- [ ] Error reporting service active (Sentry, Datadog, Bugsnag, etc.)
- [ ] Key metrics monitored: response times, error rates, queue depths
- [ ] Log rotation or external log shipping configured
- [ ] Alerting rules set for critical failures
- [ ] Dashboard exists for at-a-glance health

## Background Jobs

- [ ] Scheduler configured with correct timezone
- [ ] Tasks have timeouts (`time_limit` or equivalent)
- [ ] Failed tasks retry with backoff (not infinite retries)
- [ ] Dead letter queue or failure logging for permanently failed tasks
- [ ] Duplicate scheduling prevented (distributed lock, beat lock)
- [ ] Tasks are idempotent (safe to retry)

## Frontend

- [ ] Type-check passes (e.g., `tsc --noEmit`)
- [ ] Lint passes with zero errors
- [ ] Production build succeeds
- [ ] Bundle size within budget
- [ ] No `console.log` or development-only code in production bundle
- [ ] Error boundary catches and reports rendering errors
- [ ] Loading and error states for all async operations

## Backend

- [ ] Framework production/deploy checks pass
- [ ] Lint and format checks pass
- [ ] Test suite passes (or known failures documented and tracked)
- [ ] No pending migrations
- [ ] Dependency audit: no critical vulnerabilities
- [ ] API versioning strategy if applicable

## Deployment

- [ ] Deploy process documented (manual steps or CI/CD pipeline)
- [ ] Rollback procedure documented and tested
- [ ] Zero-downtime deployment if required
- [ ] Smoke test after deploy (hit key endpoints, verify responses)
- [ ] Post-deploy monitoring for error rate spikes
