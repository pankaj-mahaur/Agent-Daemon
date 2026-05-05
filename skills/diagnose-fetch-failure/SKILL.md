---
name: diagnose-fetch-failure
description: Diagnose browser-reported "CORS blocked" / "ERR_FAILED" / "network error" on a frontend fetch to a local backend. The surface message is almost always misleading — the real cause is usually a backend 5xx with stripped CORS headers, a backend not running, a stale DB schema post-merge, or an unhandled exception inside middleware. Verify with curl first, then walk the layers top-down.
---

# Diagnose fetch failures from frontend → backend

Use when the user says "login failing", "API not working", "CORS blocked", or shows a browser DevTools screenshot with red errors on a fetch call. Common in fullstack dev setups (Next.js + FastAPI, React + Express, etc.).

## Why the surface message lies

Chrome's DevTools reports `No 'Access-Control-Allow-Origin' header is present` for **three very different** underlying failures:

| What Chrome shows | What's actually happening |
|---|---|
| "blocked by CORS policy: No ACAO header" + `net::ERR_FAILED` (no status code) | **Backend down / wrong port / firewall** — the request never got a response |
| "blocked by CORS policy: No ACAO header" + `500 Internal Server Error` | **Backend raised an unhandled exception** — some middleware stacks skip CORS headers on uncaught errors |
| "blocked by CORS policy: No ACAO header" + `200/4xx` | **Actual CORS misconfig** (rare if the app has ever worked) |

The `net::ERR_FAILED` cases get misattributed to CORS because, from the browser's POV, "no response = no CORS headers = blocked". Don't debug CORS until you've ruled the others out.

Same for `Cross-Origin-Opener-Policy would block the window.closed call` — this is a **warning**, not a blocker. It's noise from Google Sign-In / OAuth popups and usually not the actual failure.

## Triage in order

### 1. Read the status code (not the CORS message)

In the user's screenshot or console, find the HTTP status on the failed request. `500` → backend exception. `net::ERR_FAILED` with no status → backend unreachable. `401/403/400` → the endpoint is working, just rejecting the payload. Attack accordingly.

### 2. Verify with curl (from the same origin the browser uses)

```bash
# Preflight:
curl -s -i -X OPTIONS "<BACKEND_URL>/<ROUTE>" \
  -H "Origin: <FRONTEND_ORIGIN>" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"

# Actual request with a dummy payload:
curl -s -i -X POST "<BACKEND_URL>/<ROUTE>" \
  -H "Origin: <FRONTEND_ORIGIN>" \
  -H "Content-Type: application/json" \
  -d '{"...":"..."}'
```

- Response includes `access-control-allow-origin: <FRONTEND_ORIGIN>` → CORS is **not** the problem. The user is hitting a 5xx or network issue.
- Preflight 200 but real POST hangs/errors → the handler itself is crashing.
- Connection refused → backend isn't running on that port.

### 3. If 500: get the real exception

Don't guess. Options in order of preference:
- **Tail the backend terminal** — uvicorn/express/etc. prints tracebacks by default.
- **Tail the log file** — most projects write to `logs/` or similar. `ls`, then `tail -100`.
- **Reproduce against the same backend** with a diagnostic script that hits the ORM/DB path directly.

### 4. Common 500 causes on a local dev setup

- **Stale DB schema after a git pull/merge.** New migrations weren't applied, ORM INSERTs reference missing columns, SQLAlchemy/Prisma/etc. raises. **Check migrations first if the user recently pulled or merged.**
- **Missing env vars** — new code path reads a var that isn't in `.env`.
- **External service down** — OAuth provider, Stripe, email service.
- **Async event loop mismatch** — Windows `ProactorEventLoop` can't run async psycopg. Use sync clients for diagnostic scripts.

### 5. Verify the DB schema matches the ORM

For SQLAlchemy + Alembic:
```bash
<venv>/python -m alembic current    # what alembic thinks is applied
<venv>/python -m alembic heads      # latest migration(s)
<venv>/python -m alembic history --rev-range "<current>:head"   # what's pending
```

If `current < heads`, migrations are pending. `alembic upgrade head`.

**Watchout: "DuplicateColumn" / "relation already exists" during upgrade.** Some migrations were applied out-of-band (e.g., someone ran DDL by hand or a teammate's container applied them to a shared DB). Fix: `alembic stamp <rev>` to mark the already-applied migrations as done without running them, then `upgrade head`. Use DB introspection to find the boundary:

```bash
# Sync psycopg (Windows-friendly) — enumerate what tables/columns exist, then
# compare to migration files to find the highest rev that's fully applied.
<venv>/python -c "
import psycopg
conn = psycopg.connect('<DATABASE_URL>')
cur = conn.cursor()
cur.execute(\"SELECT column_name FROM information_schema.columns WHERE table_name='<table>'\")
print([r[0] for r in cur.fetchall()])
cur.execute(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public'\")
print([r[0] for r in cur.fetchall()])
"
```

Stamp to the highest revision whose schema changes are *fully* present, then `upgrade head` runs only the truly-missing ones.

## Running diagnostic scripts

Prefer a one-shot `python -c "..."` (or node equivalent) over firing up a REPL — it's reproducible, the output is captured, and the user can paste it back. On Windows, always prefer `./.venv/Scripts/python.exe -c "..."` over `uv run python -c "..."` — the uv trampoline has a canonicalization bug on some Windows setups.

**Sync over async for diagnostics.** Async ORM calls in a standalone script often hit event-loop issues (Windows ProactorEventLoop + psycopg is the classic). Drop to the sync DB client (`psycopg`, `mysql.connector`, `redis`-sync) for introspection — it's simpler and always works.

## Don't fix what isn't broken

COOP popup warnings, vendor chunk logger warnings, image aspect-ratio warnings — these are noise. Distinguish warnings (yellow) from errors (red) and attack only the red that blocks the user's flow. Offer the noise-reduction fixes (COOP header, logger config) as follow-ups, not prerequisites.

## What NOT to do

- **Don't add CORS origins / wildcards** before confirming CORS is actually the problem. Most "CORS errors" are 5xx in disguise — widening CORS only hides the real bug.
- **Don't `--no-verify`** or bypass safety checks to "make it go away".
- **Don't start guessing at the frontend** (retrying, clearing cache, adding headers) until you've confirmed the backend response with curl.
- **Don't assume the user's error screenshot reflects current state.** If the user is actively debugging, the backend state (running/not, stale/migrated) may have changed between the screenshot and now. Re-verify.
