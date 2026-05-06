---
name: diagnose-intermittent-failure
description: Use when the user reports "sometimes works, sometimes doesn't" against a local backend — flag-gated 503s that flap, requests succeeding in one tab but failing in another, or intermittent service responses. Root causes are typically zombie watchers, stale env, or port conflicts.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Diagnose intermittent failures on a local backend

Use when the user reports any of:

- "Feature is currently disabled" / 503 with a config-flag-shaped error code, but the env file shows the flag is enabled
- Same shape for paywall flags, beta flags, kill-switches — "REALTIME_DISABLED", "FEATURE_X_OFF", etc.
- "Sometimes works, sometimes doesn't" against `localhost:8000` (or any local port)
- DevTools screenshot showing a status code that doesn't match what the backend code should produce given the current env
- A repro that succeeds when run from one terminal and fails from another

For "CORS blocked" / `net::ERR_FAILED` shaped errors specifically, see [diagnose-fetch-failure](../diagnose-fetch-failure/SKILL.md). The two skills overlap — start there if the surface error is CORS-flavored.

## Why the surface error lies

The 503 (or whatever the flag-disabled response is) is usually raised by a literal config check at the top of the handler:

```python
# FastAPI / Pydantic Settings
if not settings.REALTIME_MODE_ENABLED:
    raise HTTPException(503, "REALTIME_DISABLED")
```

```ts
// Express / dotenv
if (process.env.LIVE_MODE !== "true") {
  return res.status(503).json({ code: "LIVE_DISABLED" });
}
```

```go
// Go / viper
if !viper.GetBool("live_mode") {
    http.Error(w, "live disabled", 503)
    return
}
```

Settings instances and `process.env` are read **once at process startup**. They cannot flap mid-process. So intermittent symptoms always mean one of:

- **Different processes are answering at different times** (zombie workers from a previous reload, multiple instances running in parallel).
- **The same process was started with a different env than the file currently shows on disk** (env edited after start; file in the wrong directory; typo silently dropped by `extra: "ignore"`).
- **Different *backends* are answering** (browser tab pointed at `beta.example.com`, another at `localhost`; container fighting local dev server for the port).

Don't waste time staring at the config schema or chasing config-library bugs — the code is fine.

---

## Triage ladder (top-down — stop at first hit)

### 1. Which backend is the failing request actually hitting?

Open DevTools → Network tab → click the failing request → check the **Request URL host**.

- `127.0.0.1:<port>` / `localhost:<port>` → local dev server
- `beta.example.com`, `staging.example.com`, any deployed host → completely different machine, completely different env, completely different `.env`

Cross-check the frontend's API base URL. Locations vary by stack:

```bash
# Next.js
grep -E "NEXT_PUBLIC_(API_URL|BASE_URL)" .env.local

# Vite
grep -E "VITE_(API_URL|BASE_URL)" .env.local

# Create React App
grep -E "REACT_APP_(API_URL|BASE_URL)" .env

# Expo
grep -E "EXPO_PUBLIC_(API_URL|BASE_URL)" .env
```

If the user has multiple browser tabs open — one against `localhost:3000` and one against `staging.example.com` — the "intermittent" behavior is just tab-switching between two different backends. End of investigation.

### 2. Confirm the env value the running process *should* have

```bash
# From the backend directory
ls -la .env  # note mtime
grep -E "FLAG_NAME|MODE_ENABLED|FEATURE_X" .env
```

If the `.env` file's mtime is **older** than when the running server started, "user edited env after start" is not the theory. If `.env` is newer than the running process, that's a strong hint — go to step 3.

### 3. Confirm a fresh interpreter reads the same value

Run a one-shot script with the same Python/Node/Go interpreter that the server uses:

```bash
# Python (use the venv directly — uv run can have trampoline issues on Windows)
./.venv/Scripts/python.exe -c "from app.config import settings; print(settings.REALTIME_MODE_ENABLED)"
# Linux/macOS
./.venv/bin/python -c "from app.config import settings; print(settings.REALTIME_MODE_ENABLED)"

# Node
node -e "require('dotenv').config(); console.log(process.env.LIVE_MODE)"

# Go (one-off)
go run cmd/checkconfig/main.go
```

Outcomes:

- Prints the value you expect, AND `.env` shows the same → **config is correct**. The problem is the running process. Skip to step 4.
- Prints the wrong value while `.env` shows the right one → `.env` is in the wrong directory, has a typo in the key name, or the config library is silently dropping a malformed line (`pydantic-settings` with `extra="ignore"` is a classic). Fix the env file first.

### 4. Inspect the running process(es)

```bash
# Linux / macOS
ps -ef | grep -iE "uvicorn|gunicorn|node|express|nodemon"
lsof -i :8000  # or whatever port

# Windows
tasklist | grep -iE "python|uvicorn|node"
netstat -ano | findstr :8000
```

Then drill into each PID's start time and command line:

```bash
# Linux / macOS
ps -p <pid> -o pid,etime,command

# Windows
wmic process where "ProcessId=<PID>" get CommandLine,CreationDate /format:list
```

**Red flag:** multiple sets of server processes with **different start times** — leftover zombies from earlier sessions, each potentially holding a different snapshot of `.env`.

### 5. Confirm the port is actually accepting connections

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8000/health
```

- `HTTP 200` → backend is healthy and serving. The 503 the user sees is the running process's actual config state — go re-check step 3 against this specific process.
- `HTTP 000` (connection refused) while `tasklist`/`ps` shows the server "running" → **the worker crashed during reload and the parent watcher is sitting idle**. This is the "doesn't work" half of the flap. The "works" half is from earlier successful boots. See "Why reload watchers are the trap" below.

### 6. Rule out container-vs-local conflict

```bash
# Docker
docker compose ps
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}"

# Podman / Rancher Desktop
podman ps
```

If the daemon is off, the command will say so — that's fine, means no conflict. If a container is running on the same port and a local dev server started later, the local one will have failed to bind silently (or the container's old process is the one answering, with stale env).

### 7. Resolution: full clean restart

Kill **all** server PIDs (the wrapper AND children — killing only the parent leaves orphans):

```bash
# Linux / macOS — by name
pkill -f "uvicorn app.main"
pkill -f "node server.js"

# Windows PowerShell — by PID list
Stop-Process -Id <pid1>,<pid2>,<pid3> -Force
```

Then restart fresh from the project root:

```bash
# Examples — adjust to your stack
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
npm run dev:backend
go run ./cmd/server
```

**Always confirm with the user before killing processes** — they may have an in-flight debug session, an attached debugger, or open file handles you can't see.

---

## Why reload watchers are the trap

Live-reload watchers (`uvicorn --reload`, `nodemon`, `air`, `cargo watch`) usually watch source files only — `*.py`, `*.ts`, `*.go`. Editing `.env` triggers nothing. An env edit only takes effect on the next source-file save (which restarts the process) or a manual restart.

Worse: if a reload-triggered child crashes during startup (import error, port-bind race, DB connection failure, OOM), the parent watcher does **not** retry — it just waits for the next file change. From the outside: backend is "down" but `tasklist`/`ps` shows the watcher "running".

This combination produces exactly the "sometimes works, sometimes doesn't" pattern users report. The "works" comes from a successful earlier boot before the env changed; the "doesn't work" comes from the silent crash after the env edit.

---

## Optional: add a startup log to make future flaps visible

If the user has reported this flap more than once, suggest adding a single startup log line that prints the relevant flag values:

```python
# FastAPI lifespan / startup
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(f"[startup] REALTIME_MODE_ENABLED={settings.REALTIME_MODE_ENABLED} pid={os.getpid()}")
    yield
```

```ts
// Express startup
app.listen(PORT, () => {
  console.log(`[startup] LIVE_MODE=${process.env.LIVE_MODE} pid=${process.pid}`);
});
```

```go
log.Printf("[startup] live_mode=%v pid=%d", viper.GetBool("live_mode"), os.Getpid())
```

Every reload prints which env values the new worker booted with, plus its PID — making zombie / multi-process scenarios obvious in the terminal scrollback.

Don't propose this on the first occurrence — it's noise if the issue was just a one-time zombie.

---

## What NOT to do

- **Don't widen defaults in the config schema** to mask the issue (e.g. flipping the flag default from `False` to `True`). That hides real misconfigurations on prod where the deployed env intentionally omits the flag.
- **Don't suggest `--no-reload`** as a fix. It removes a useful dev affordance and doesn't address the root cause; the user will hit it again the next time they run with reload.
- **Don't kill processes without permission.** The user may be mid-debug. Show them what you found (PID list, port state) and ask before killing.
- **Don't change `.env` to "force" the flag back on** — it's already set correctly in the cases this skill targets. Changing it just confuses the next debugging round.

---

## Quick reference card

| Symptom | Most likely cause |
|---|---|
| Flag-disabled 503, env file correct, fresh interpreter reads correct value, port returns 000 | Zombie reload-watcher worker — kill all server PIDs, restart |
| Flag-disabled 503, fresh interpreter reads wrong value | Env file in wrong dir, typo in key name, or config library silently dropping the line |
| 503 in one tab, works in another | Tabs hit different backends (staging vs local) — check Network tab URL host |
| Connection refused intermittently, no 503 | Reload-watcher child crashed during reload; check the server terminal for tracebacks |
| 503 right after starting a container AND running local dev server | Port collision — only one bound, the other silently failed |

---

## Related

- [diagnose-fetch-failure](../diagnose-fetch-failure/SKILL.md) — different surface (CORS-masked 5xx, not flag-gated 503s)
- [debug-triage](../debug-triage/SKILL.md) — general "X is broken" triage ladder
- [deploy-ops](../deploy-ops/SKILL.md) — making sure the prod env actually loads what you intended
