---
name: multiplatform-parity
description: Enforce parity when web and mobile (or web and desktop, or any pair of clients) share a backend. Use whenever editing chat code, tool pages, supplement/catalog data, or any shared feature that touches both clients. Encodes the parity rule, the duplicated-logic registry, what is/isn't shared between platforms, and the feature-parity tracker pattern.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Keep separate clients in lockstep when only the backend is shared

If your project has a web client and a mobile client (or web + desktop, or two SDKs in different languages) sharing a single backend, **changes do not propagate automatically**. UI components, navigation, styling, and most state are duplicated. Feature drift is the default outcome unless you actively prevent it.

This skill is the discipline. It applies whether the pair is Next.js + React Native (Expo), SvelteKit + Tauri, Nuxt + Capacitor, web + iOS-Swift, web + Flutter — anywhere the clients share an API but not the UI code.

---

## The parity rule

After any feature change on one platform, **stop and ask**: does the other platform need this too?

- The user often works on one platform first (commonly web → mobile, but flag it either way).
- Some changes are deliberately platform-specific (a desktop-only keyboard shortcut, a mobile-only haptic). Mark them in the parity tracker so they don't show up as drift later.

Before declaring a feature change done:

1. Open (or create) `FEATURE_PARITY_TRACKER.md` in the mobile / second client's repo. It's a living checklist; update it after each parity pass.
2. If the change adds a new backend response field, **confirm both clients render it**. It's common for backends to ship fields that one client silently drops because it never knew to handle them.
3. Update the shared types package and run the type-build step (next section).

---

## What IS shared

The list is small. For most multiplatform projects, the shared surface is:

| Shared | Typical location |
|---|---|
| Backend API | `backend/routes/`, `api/`, `apiserver/` |
| Shared types package | `packages/types/` (TS), `packages/api-models/` (Python+TS), `proto/` (gRPC), `openapi.yaml` |
| Shared validation schema | Zod / Yup / Pydantic models exported to both clients |
| Backend-side context builders | helpers that prepare data for any authenticated client |

That's usually it.

---

## What is NOT shared (must implement separately)

Everything else. Concretely:

| Not shared | Web stack | Mobile / second client stack |
|---|---|---|
| UI components | React DOM | React Native / Flutter widgets / SwiftUI |
| Styling | Tailwind / CSS / styled-components | NativeWind / StyleSheet / SwiftUI modifiers |
| Navigation | App Router / React Router | React Navigation / Flutter Navigator / SwiftUI NavigationStack |
| Forms | react-hook-form / formik | react-hook-form (native variant) / Flutter Form widgets |
| Storage | localStorage / IndexedDB / cookies | AsyncStorage / SecureStore / SharedPreferences |
| Push / notifications | Web Push / service worker | Firebase / APNs / Expo Notifications |
| Image / media | `<img>` / `<video>` | `<Image>` / `<Video>` / native players |
| Type definitions for chat / API responses | often a `web-chat-types.ts` | often inline in `mobile/utils/api.ts` — keep BOTH updated when the API changes |

When a change touches any of the above, it must be implemented twice — once per client.

---

## Currently duplicated logic (project memory)

Some logic is duplicated because the shared types package doesn't yet abstract it. Until then, **maintain both copies in lockstep.** Document the pairs in a table at the top of the project's `CLAUDE.md` or in `FEATURE_PARITY_TRACKER.md`:

| Logic | Web copy | Second-client copy |
|---|---|---|
| _e.g. intent detection_ | _`web/lib/web-chat-utils.ts:detectPlanIntent`_ | _`mobile/screens/ChatScreen.tsx:detectPlanIntent`_ |
| _e.g. format-summary helper_ | _`web/lib/web-chat-utils.ts:formatPlanSummary`_ | _`mobile/screens/ChatScreen.tsx:formatPlanSummary`_ |
| _e.g. catalog data (supplements / products / coupons)_ | _`web/lib/<domain>-catalog.ts`_ | _`mobile/utils/<domain>Catalog.ts`_ |
| _e.g. markdown / rich-text rendering_ | _`web/components/Markdown.tsx`_ | _`mobile/components/MarkdownText.tsx`_ |
| _e.g. ID → display-name mapping_ | _`web/lib/api.ts`_ | _`mobile/components/<X>Cards.tsx`_ |

These are candidates for a `packages/<domain>-utils/` extraction later. For now, every change to one row must touch both columns.

---

## Tool / page 1:1 mapping

Most multiplatform apps have a small number of "screens" or "tools" with the same business logic across both clients. Track them in a simple 1:1 table:

| Web route | Second-client screen |
|---|---|
| `/tools/symptom-checker` | `SymptomScreen` |
| `/tools/lab-analysis` | `LabScreen` |
| `/tools/document-analysis` | `DocumentAnalysisScreen` |
| `/admin/users` | _(not on mobile — admin is web-only — flag in tracker)_ |

If you change one, plan the other. If the change is web-only by design, mark it `web-only — flagged YYYY-MM-DD: <reason>` so a future audit doesn't re-discover it as drift.

---

## Type sync flow (every API change)

1. Edit the backend route to add / change the response field.
2. Update the shared types package (`packages/types/api.ts`, `packages/types/clinical.ts`, etc.). Add fields, never rename or retype existing ones — see [db-migrations](../db-migrations/SKILL.md) on payload preservation.
3. Run the type-build step:
   ```bash
   npm run build:types
   # or: npx prisma generate / strawberry export-schema / openapi-generator
   ```
4. Update the per-client chat / API type definitions if they exist as inline copies (web `web-chat-types.ts`, mobile inline shapes).
5. Update the renderers in both clients — even if TypeScript compiles, the field won't appear in the UI without explicit rendering.
6. Update `FEATURE_PARITY_TRACKER.md`.

---

## Known-gap registry

It's normal for one client to lag behind the other on certain features. Document the gaps so they don't get rediscovered as bugs.

In `FEATURE_PARITY_TRACKER.md` keep a section like:

```markdown
## Known gaps (intentional or pending)

- **Explainability panel** — mobile receives `explanation` data on chat messages but doesn't render the "Why this recommendation" panel. Web has `<ExplainabilityPanel>`. Mobile parity scheduled for <date or "after v2.3 ship">.
- **Plan-status sidebar widget** — web chat sidebar shows plan status; mobile sidebar doesn't have a sidebar. Won't be ported (different UX).
- **Context awareness banner** — neither client shows a visual "Plan active" banner when the AI is using injected context. Backlog: design needed.
```

When the user asks about a feature, check the gap registry before reporting it as a bug — it might be a known intentional difference.

---

## Verification (after a parity change)

- **Type-build clean** — `npm run build:types` (or equivalent).
- **Type-check clean** for both clients — `npm run typecheck` in each repo.
- **Both clients build** — `npm run build` (web), `expo prebuild && expo run:ios|android` (mobile / Expo), `flutter build` (Flutter).
- **Visually verify** both clients render the new field/feature. Type safety alone is not enough — a field can be typed correctly and still missing from the JSX/widget tree.
- **Update `FEATURE_PARITY_TRACKER.md`** with the date and a one-line note: "<date> — added <field> rendering on mobile + web (parity restored after backend ship of <commit>)".

---

## What NOT to do

- **Don't ship a backend field** that only one client knows how to consume without flagging it in the parity tracker. The other client will silently drop it for months.
- **Don't rename a payload field** to fix a typo — even if you control both clients, an in-flight mobile binary may run the old name for weeks. See [db-migrations](../db-migrations/SKILL.md) on payload preservation.
- **Don't refactor the shared types package** as a drive-by. Type changes ripple to every client; treat them like API changes.
- **Don't add a "shared" utility** that imports anything platform-specific (`window`, React Native modules, web-only DOM APIs). Shared code must be runnable in both environments.
- **Don't trust subjective parity** — "looks the same on both" is not enough. Render the same fixture data on each client and compare side-by-side.

---

## Related

- [implement-feature](../implement-feature/SKILL.md) — patterns to use while building parity changes
- [db-migrations](../db-migrations/SKILL.md) — API response shape preservation rule
- [docs-sync-audit](../docs-sync-audit/SKILL.md) — when documentation in one client lags reality
