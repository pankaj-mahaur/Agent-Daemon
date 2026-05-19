---
name: security-audit
description: Audit web application security across frontend and backend. Use for security audit, auth review, RBAC review, permissions audit, JWT/session security, cookie/CSRF/origin review, CORS, throttling, secrets, CSV/export safety, admin endpoints, or access control review.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Security Audit

Use this to review trust boundaries, permissions, and data exposure risks in any web application.

## Workflow

1. **Read existing security docs** — check for security policies, threat models, or past audit notes in the project before starting.
2. **Map the trust boundary** before reading code:
   ```
   Browser → Frontend server/proxy → Backend API → Database/Cache/Workers
   ```
   Identify where authentication, authorization, and data validation happen at each boundary.
3. **Review frontend auth and proxy surfaces:**
   - API proxy or gateway routes (how frontend talks to backend)
   - Auth routes (login, logout, token refresh, OAuth callbacks)
   - API client/helper (how tokens are attached, how errors are handled)
   - Admin/role-gated layouts or route guards
   - User role/permission helpers
4. **Review backend auth and permission surfaces:**
   - Authentication serializers and views
   - User profile and admin endpoints
   - Permission classes, decorators, or middleware
   - Role/group definitions and how they map to access control
5. **Compare intended role behavior with actual implementation:**
   - Check if frontend role gates match backend permission checks
   - Verify role/enum string values match between layers
   - Test that unauthenticated and low-privilege paths are properly blocked
6. **Present findings** grouped by exploitability and data impact before fixing.

## Recurring Risks

These patterns appear across most web applications:

- **Cookie-authenticated mutation routes without CSRF/origin protection.** If mutations use httpOnly cookies for auth, the backend must verify `Origin` or use CSRF tokens.
- **Frontend gates not matching backend checks.** A client-side `if (user.role === "admin")` is not security — the backend must independently enforce the same rule.
- **Enum/string drift between layers.** Backend returns "Managers" (plural), frontend checks "Manager" (singular) — comparison is always false, gate is bypassed.
- **Silent API helper failures.** Fetch wrappers that swallow 401/403 responses hide unauthorized access attempts from the user and from logging.
- **Anonymous endpoints without throttling.** Login, registration, password reset, and OAuth endpoints are public-facing — they need rate limiting and, for OAuth, domain restrictions.
- **CSV formula injection.** Exported CSV data starting with `=`, `+`, `-`, `@` can execute formulas in Excel/Sheets. Prefix with `'`.
- **Secrets in client bundles.** API keys, database URLs, or internal service URLs accidentally included in frontend builds.
- **Overly permissive CORS.** `Access-Control-Allow-Origin: *` with credentials, or allowing origins that shouldn't have access.

## Output

For every finding include:

| Field | Description |
|-------|-------------|
| **Severity** | Critical / High / Medium / Low |
| **Exploit/failure path** | Step-by-step how it could be exploited or how it fails |
| **Affected role/data** | Which users or data are at risk |
| **Files** | Clickable `file:LINE` references |
| **Minimal fix** | Smallest change that closes the vulnerability |
| **Verification** | How to confirm the fix works (curl command, test case, manual step) |
