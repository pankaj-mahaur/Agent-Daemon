# handoff — examples

What a useful handoff reads like vs. what a useless one reads like.

---

## Example 1 — Context section

### ❌ Bad

> ## Context
>
> We worked on the project today. Did some refactoring and fixed a bug. The user was happy with the result.

Says nothing. The next agent has no way to know what was being attempted or why.

### ✅ Good

> ## Context
>
> Migrating the project-list view from REST polling to Server-Sent Events. Backend SSE endpoint is live on `/api/projects/stream`; this session wired the React client (`useProjectStream` hook) and removed the 5-second polling timer. Goal: real-time updates without exploding the request budget.

Three sentences, concrete. Names the feature, the moving parts, and the goal.

---

## Example 2 — State section

### ❌ Bad

> ## State
>
> - Made changes to several files
> - Tests are passing
> - Need to do more work tomorrow

Untraceable. "Several files" forces the next agent to read git diff. "More work" is unactionable.

### ✅ Good

> ## State
>
> **Done:**
> - `useProjectStream` hook landed at `src/hooks/useProjectStream.ts` (commit `a8f4c12`)
> - Polling timer removed from `ProjectList.tsx`
> - Manual smoke test green (10-min run, 47 events received)
>
> **In progress:**
> - Reconnection logic — exponential backoff is wired but untested under network drop
>
> **Blocked:**
> - E2E test (Playwright) needs the dev SSE server's CORS allowlist to include `localhost:3000` — opened internal ticket `INFRA-412`

Each item has a path, a commit, or a ticket. Next agent can act in 30 seconds.

---

## Example 3 — Next action

### ❌ Bad

> ## Next action
>
> Continue the migration.

Next agent has to re-read the whole context to figure out what "continue" means.

### ✅ Good

> ## Next action
>
> Test reconnection under network drop. With dev server running, run `node scripts/sse-flake.js --drops 5` (simulates 5 network drops in 60s). Verify the `useProjectStream` hook reconnects within ~2s each time and doesn't double-subscribe (check `Network` tab for duplicate `EventSource` connections). If duplicates appear, the offender is most likely the missing cleanup in the `useEffect` at `src/hooks/useProjectStream.ts:42` — `eventSource.close()` must run before the new connection opens.

Specific. Names the script, the file, the line, the most-likely failure mode. Next agent goes straight to verification.

---

## Example 4 — Open questions

### ❌ Bad

> ## Open questions
>
> Some things are still unclear.

What things? Unclear to whom? Why are they not resolved?

### ✅ Good

> ## Open questions
>
> 1. **Heartbeat interval** — backend sends `:ping` every 30s. Should the client trigger a reconnect if it doesn't see a `:ping` for >45s, or wait for the browser's native `onerror`? User AFK when asked; assumed "wait for onerror" but it's a coin-flip.
> 2. **Error-event UI** — the SSE stream can emit `event: error` with a message. Currently it goes to console only. Product hasn't specced the toast/banner behavior. Filed in `proposed/2026-05-19-sse-error-ui.md`.

Each question names *what was decided pending input* and *where to find the artifact*. Cheap for the next agent to resolve.

---

## Example 5 — What NOT to include

### ❌ Bad

> ## Diff summary
>
> ```diff
> + import { useEffect } from 'react';
> + import type { Project } from '@/types';
> +
> + export function useProjectStream() {
> +   const [projects, setProjects] = useState<Project[]>([]);
> +   useEffect(() => {
> +     const es = new EventSource('/api/projects/stream');
> +     es.onmessage = (ev) => { ... 60 more lines ... }
> ...
> ```

The full diff. Already in git. Noise.

### ✅ Good

> ## Files touched this session
>
> - `src/hooks/useProjectStream.ts` (new)
> - `src/components/ProjectList.tsx` (removed polling)
> - `src/lib/eventSource.ts` (new — reconnect helper)
> - `runtime/test/useProjectStream.test.ts` (3 cases)

Paths only. Next agent runs `git diff <commit>~..<commit>` if they want bytes.

---

## Example 6 — Dual-write filename collision

### ❌ Bad

Agent writes the handoff with `handoff.md` (no timestamp). Next session writes its own handoff with the same filename. **Previous handoff is overwritten.** Cross-project trail loses the older entry.

### ✅ Good

Both files use the UTC ISO timestamp with hyphens (Windows-safe):

```
.agent-daemon/handoffs/handoff-2026-05-19T11-37-10Z.md
~/.agent-daemon/handoffs/agent-daemon/handoff-2026-05-19T11-37-10Z.md
```

Same content in both locations. Filenames sort lexically, so `ls` lists them in chronological order. Cross-project search:

```bash
grep -l "useProjectStream" ~/.agent-daemon/handoffs/**/*.md
```

works across every project you've ever opened.

---

## Example 7 — Suggested skills

### ❌ Bad

> ## Suggested skills
>
> Various skills might help.

Useless. Burns the next agent's load budget reading every skill description.

### ✅ Good

> ## Suggested skills
>
> - **`debug-triage`** — if the SSE stream stops emitting, walk the triage ladder before opening `useProjectStream.ts`
> - **`methodology-tdd`** — the reconnect logic needs a regression test, write it before the fix
> - **`implement-feature`** — for the next-piece-after-this (error-event UI), Phase 0 inventory is important — check `@/lib/toast` and `@/components/ui/Banner`

Three skills, each matched to a *specific* upcoming task. Next agent loads them with intent.
