---
name: methodology-api-design
description: Use when designing new endpoints, modifying API contracts, or reviewing API surface. Enforces naming consistency, versioning discipline, error contract design, and backward compatibility analysis to prevent breaking changes that are expensive to fix after clients depend on them.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# API Design Discipline

An API contract is the hardest thing to change in a system. Database schemas can be migrated. UI can be rewritten. But once clients depend on your API shape, changing it means coordinating with every consumer — or breaking them.

This skill provides the discipline for designing APIs that do not need to be redesigned. It applies to REST endpoints, GraphQL schemas, RPC interfaces, library public APIs, and CLI argument shapes.

---

## Decision 1 — Is this a new endpoint or a change to an existing one?

This is the first fork. Get it wrong and you either introduce a breaking change or create unnecessary endpoint sprawl.

### Modify an existing endpoint when:

- You are adding an optional field to the response (additive, non-breaking)
- You are adding an optional query parameter or request body field
- You are fixing a bug in the behavior (the contract stays the same, the implementation becomes correct)

### Create a new endpoint when:

- The new behavior is fundamentally different (different resource, different action)
- Adding the behavior to the existing endpoint would require a required field that breaks existing clients
- The existing endpoint's semantics would become ambiguous with the addition

### Version the endpoint when:

- You must change a required field's type, remove a field, or change the response shape
- The behavior change is incompatible with existing clients
- You need to run old and new behavior simultaneously during migration

---

## Decision 2 — Resource naming

### REST conventions

Resources are nouns, not verbs. Actions are HTTP methods, not URL segments.

```
# Good
GET    /api/users          — list users
POST   /api/users          — create user
GET    /api/users/:id      — get user
PATCH  /api/users/:id      — update user
DELETE /api/users/:id      — delete user

# Bad
GET    /api/getUsers
POST   /api/createUser
POST   /api/users/update/:id
GET    /api/users/delete/:id
```

### Naming rules

- **Plural nouns for collections.** `/users`, not `/user`. Consistency matters more than grammar debates.
- **Kebab-case for multi-word resources.** `/api/user-profiles`, not `/api/userProfiles` or `/api/user_profiles`. URLs are case-insensitive by convention; kebab-case is unambiguous.
- **Nesting for ownership.** `/api/users/:userId/orders` — orders belonging to a user. Limit nesting to 2 levels; deeper nesting makes URLs brittle and hard to cache.
- **Actions that don't fit CRUD.** Use a verb sub-resource: `POST /api/users/:id/deactivate`, `POST /api/orders/:id/refund`. This is a pragmatic exception to the "no verbs" rule.

### Match existing project conventions

Before inventing a naming pattern, grep the existing routes:

```bash
# Express
grep -r "router\.\(get\|post\|put\|patch\|delete\)" src/routes/
# FastAPI
grep -r "@router\.\(get\|post\|put\|patch\|delete\)" app/routers/
# Django
grep -r "path(" */urls.py
# Rails
grep -r "resources\|get\|post\|put\|patch\|delete" config/routes.rb
```

If the project uses `/api/v1/user_profiles` (snake_case, singular), follow that pattern even if you personally prefer kebab-case plural. Consistency within a project beats theoretical correctness.

---

## Decision 3 — Request shape

### Required vs. optional fields

A field should be required only if the operation literally cannot proceed without it. Every required field is a constraint on every future client.

```ts
// Too many required fields — over-constraining
interface CreateUserRequest {
  name: string;       // Required: yes, we need a name
  email: string;      // Required: yes, we need to send a verification
  avatar: string;     // Required? No — most users won't have one at creation
  timezone: string;   // Required? No — default to UTC
  locale: string;     // Required? No — default to en-US
}

// Better — only truly required fields are required
interface CreateUserRequest {
  name: string;
  email: string;
  avatar?: string;
  timezone?: string;  // Default: UTC
  locale?: string;    // Default: en-US
}
```

### Validation

Validate at the API boundary, not inside business logic. The API layer should reject invalid input before it reaches the service layer.

```ts
// API layer — validate shape and constraints
if (!body.email || !isValidEmail(body.email)) {
  return res.status(400).json({ error: "Invalid email format" });
}

// Service layer — assumes valid input
async function createUser(data: ValidatedCreateUserInput) {
  // No validation here — the API layer already did it
}
```

### Idempotency

For non-GET operations, consider: what happens if the client sends the same request twice?

- **POST /users** — creates two users. Is that intended? Consider requiring an idempotency key.
- **PUT /users/:id** — replaces the user. Idempotent by nature.
- **PATCH /users/:id** — updates fields. Idempotent if the fields are absolute values, not if they are relative (e.g., `{ increment: 1 }`).
- **DELETE /users/:id** — idempotent (deleting something already deleted is a no-op, return 204 or 404 per your convention).

---

## Decision 4 — Response shape

### Envelope vs. bare response

Choose one pattern for the project and stick with it.

```json
// Bare response — simpler, standard REST
{ "id": 1, "name": "Alice" }

// Envelope — allows metadata
{ "data": { "id": 1, "name": "Alice" }, "meta": { "requestId": "abc123" } }
```

### List responses

Always include:

- The array of items
- Total count (for pagination)
- Pagination cursor or next-page link

```json
{
  "items": [...],
  "total": 142,
  "page": 1,
  "pageSize": 20,
  "hasMore": true
}
```

Do NOT return an unbounded array. Every list endpoint must have a default page size and a maximum page size. If a client requests all 100,000 records, that is a bug in the client — not a feature of the API.

### Null vs. absent vs. empty

Define a convention and document it:

- **Null:** The field exists but has no value. `"avatar": null`
- **Absent:** The field is not included in the response. (Only for optional fields in partial responses.)
- **Empty:** The field has a value that is empty. `"tags": []`, `"bio": ""`

Mixing these without a convention causes client bugs. Common convention: always include the field, use null for "no value," use empty collections for "no items."

---

## Decision 5 — Error responses

### Use a consistent error shape

Every error response from every endpoint should have the same structure.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Email format is invalid",
    "details": [
      { "field": "email", "issue": "Must be a valid email address" }
    ]
  }
}
```

### Map error types to HTTP status codes

| Situation | Status | Error code |
|---|---|---|
| Invalid input | 400 | VALIDATION_FAILED |
| Missing or invalid auth | 401 | UNAUTHORIZED |
| Valid auth, insufficient permissions | 403 | FORBIDDEN |
| Resource not found | 404 | NOT_FOUND |
| Conflict (duplicate, state violation) | 409 | CONFLICT |
| Rate limited | 429 | RATE_LIMITED |
| Server error | 500 | INTERNAL_ERROR |

### Error messages are for developers, not users

API error messages should help the calling developer debug. User-facing messages are the frontend's responsibility.

```json
// Good: helps the developer fix their request
{ "error": { "code": "VALIDATION_FAILED", "message": "Field 'email' must match pattern ^.+@.+\\..+$" } }

// Bad: unhelpful to everyone
{ "error": "Something went wrong" }

// Bad: leaks implementation details
{ "error": "psycopg2.errors.UniqueViolation: duplicate key value violates unique constraint \"users_email_key\"" }
```

---

## Decision 6 — Backward compatibility

### Non-breaking changes (safe to make)

- Adding a new optional field to the request
- Adding a new field to the response
- Adding a new endpoint
- Adding a new optional query parameter
- Widening a validation constraint (accepting more values)

### Breaking changes (require versioning or migration)

- Removing a field from the response
- Renaming a field
- Changing a field's type
- Making an optional field required
- Narrowing a validation constraint (rejecting previously accepted values)
- Changing the semantics of a field (same name, different meaning)
- Changing the status code for a given condition

### How to handle breaking changes

1. **Add, don't modify.** Instead of renaming `userName` to `displayName`, add `displayName` alongside `userName`. Deprecate `userName` with a documented timeline.
2. **Version the endpoint.** `/api/v2/users` with the new shape, `/api/v1/users` with the old shape. Set a sunset date for v1.
3. **Feature flag.** Accept a header (`X-API-Version: 2`) or query param (`?version=2`) to opt into the new shape. Simpler than URL versioning for small changes.

---

## Pre-merge API design checklist

Before merging any API change:

- [ ] The endpoint follows existing naming conventions in the project
- [ ] Required fields are truly required (cannot default)
- [ ] Optional fields have documented defaults
- [ ] Error responses use the project's standard error shape
- [ ] Status codes match the situation (not 200 for everything)
- [ ] List endpoints are paginated with a maximum page size
- [ ] The change is backward compatible (or versioned if not)
- [ ] Input validation happens at the API boundary
- [ ] Auth/permission checks are in place
- [ ] The endpoint is documented (OpenAPI, JSDoc, docstring, or at least a comment)
- [ ] Performance: no N+1 queries, no unbounded responses

---

## Common API design mistakes

- **Exposing internal IDs or database structure.** If your URL is `/api/postgres-users-table/row/42`, you have coupled your API to your database. Use domain-relevant names.
- **Returning different shapes for the same resource.** The user object from `GET /users/:id` should have the same fields as each user in `GET /users`. Clients should not need to handle two shapes.
- **Using GET for mutations.** `GET /api/users/:id/delete` is a mutation disguised as a read. Browsers prefetch GET URLs. Crawlers follow GET links. The user's data gets deleted by a prefetcher.
- **Leaking server errors to clients.** Stack traces, SQL errors, file paths — none of these belong in API responses. Log them server-side; return a generic error to the client.
- **No rate limiting.** Every public API endpoint needs rate limiting. Even internal endpoints benefit from it (protects against runaway clients).

---

## Related

- [methodology-brainstorm](../methodology-brainstorm/SKILL.md) — brainstorming API shapes before committing
- [methodology-code-review](../methodology-code-review/SKILL.md) — reviewing API changes in PRs
- [implement-feature](../implement-feature/SKILL.md) — implementing the endpoint after designing it
- [security-audit](../security-audit/SKILL.md) — security review of API surface
