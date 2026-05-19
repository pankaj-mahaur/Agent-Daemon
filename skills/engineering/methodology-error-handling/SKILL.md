---
name: methodology-error-handling
description: Use when designing error boundaries, adding try/catch blocks, reviewing error propagation patterns, or diagnosing swallowed errors. Covers the decision of when to catch vs propagate, error typing, user-facing vs internal errors, and the antipatterns that cause silent failures in production.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Error Handling Strategy

Most production incidents are not caused by bugs in the happy path. They are caused by errors that were caught and silently discarded, errors that were logged but not acted on, or errors that propagated as the wrong type and confused every handler above them.

Error handling is not about try/catch placement. It is about designing how errors flow through the system.

---

## The fundamental decision: catch or propagate

At every point where an error can occur, you face one choice: handle it here, or let it propagate to the caller. The decision tree:

### Catch and handle when:

- **You can meaningfully recover.** Retry a transient network failure. Fall back to a cache when the database is slow. Return a default value when an optional enrichment fails. Recovery means the operation succeeds from the caller's perspective.
- **You are at the system boundary.** HTTP handlers, CLI entry points, queue consumers, cron job runners. These are the outermost error boundaries — if an error reaches here, it must be caught, logged, and translated into an appropriate response (HTTP 500, exit code 1, dead-letter queue).
- **You need to add context before re-throwing.** Catch, wrap with context, re-throw. This is not swallowing — it is enriching.

### Propagate when:

- **You cannot recover.** If the database is down and you are a data-access function, you cannot fix that. Throw (or return an error) and let the caller decide.
- **The caller needs to know.** If a validation function catches its own errors and returns a default, the caller never knows the input was invalid. That validation function has become a liar.
- **You are in the middle of the stack.** Most functions should not catch errors. They should let errors bubble up to the nearest boundary that can handle them.

**The default should be propagation.** Catching is the exception, not the rule. Code that catches too eagerly silences failures that should be visible.

---

## Error categories

Errors are not all the same. Treating them identically leads to either over-handling or under-handling.

### Operational errors (expected failures)

These are things that go wrong during normal operation: network timeouts, invalid user input, file not found, rate limits, database constraint violations.

**Characteristics:**
- They are expected and documented
- They have a clear recovery or user-facing message
- They should NOT trigger alerts (unless frequency spikes)

**Handling:** Catch at the appropriate boundary, respond gracefully, log at INFO or WARN level.

### Programmer errors (bugs)

These are mistakes in the code: null reference on a value that should never be null, array index out of bounds, calling a function with the wrong argument type.

**Characteristics:**
- They indicate a defect in the code
- There is no meaningful recovery (the program's assumptions are violated)
- They should trigger alerts

**Handling:** Let them crash the process (or the request handler). Log at ERROR level with full stack trace. Fix the bug. Do NOT wrap them in try/catch and return a generic error — that hides the bug.

### Infrastructure errors (environmental failures)

These are failures in the underlying platform: out of memory, disk full, DNS resolution failure, TLS certificate expired.

**Characteristics:**
- They affect all operations, not just the current one
- They usually require human intervention
- They should trigger alerts immediately

**Handling:** Let them propagate to the top. Log at FATAL level. Rely on process supervisors (systemd, Kubernetes, PM2) to restart.

---

## Error typing and structure

### Use typed errors, not string messages

```ts
// Bad: error type is a string
throw new Error("User not found");
// The caller cannot distinguish this from "Database not found" without parsing the string

// Good: error type carries semantic meaning
class NotFoundError extends Error {
  constructor(public readonly entity: string, public readonly id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}
throw new NotFoundError("User", userId);
// The caller can check: if (err instanceof NotFoundError) { return 404; }
```

### Include context, not just a message

An error should carry enough information for the handler to decide what to do without parsing the message string.

```ts
// Bad: just a message
throw new Error("Validation failed");

// Good: structured context
class ValidationError extends Error {
  constructor(public readonly field: string, public readonly constraint: string, public readonly value: unknown) {
    super(`Validation failed: ${field} ${constraint}`);
    this.name = "ValidationError";
  }
}
throw new ValidationError("email", "must be a valid email address", input.email);
```

### Wrap errors when crossing boundaries

When an error crosses an architectural boundary (data layer -> service layer -> API layer), wrap it with context from the current layer.

```ts
// In the service layer
async function getUser(id: string): Promise<User> {
  try {
    return await db.users.findById(id);
  } catch (err) {
    // Wrap the database error with service-layer context
    throw new ServiceError(`Failed to retrieve user ${id}`, { cause: err });
  }
}
```

This preserves the original error (via `cause`) while adding information about what the current layer was doing when the error occurred.

---

## Error handling at system boundaries

### HTTP API handlers

Every API handler should have a top-level error handler that translates error types to HTTP status codes.

```ts
// Error-to-HTTP mapping (centralized, not per-route)
function errorToResponse(err: Error): { status: number; body: object } {
  if (err instanceof NotFoundError) return { status: 404, body: { error: err.message } };
  if (err instanceof ValidationError) return { status: 400, body: { error: err.message, field: err.field } };
  if (err instanceof AuthorizationError) return { status: 403, body: { error: "Forbidden" } };

  // Unknown error: log it, return generic 500
  logger.error("Unhandled error", { error: err, stack: err.stack });
  return { status: 500, body: { error: "Internal server error" } };
}
```

**Critical:** Never expose internal error details to the user. `{ error: "ECONNREFUSED 127.0.0.1:5432" }` tells an attacker your database host. Return a generic message and log the details server-side.

### Queue consumers / background jobs

Background workers must catch ALL errors and decide: retry or dead-letter.

```ts
async function processJob(job: Job): Promise<void> {
  try {
    await handleJob(job);
  } catch (err) {
    if (isTransient(err) && job.attempts < MAX_RETRIES) {
      await job.retry({ delay: exponentialBackoff(job.attempts) });
    } else {
      await job.deadLetter({ reason: err.message });
      logger.error("Job permanently failed", { jobId: job.id, error: err });
    }
  }
}
```

### CLI entry points

CLI tools should catch errors at the top level and exit with a meaningful code and message.

```ts
async function main() {
  try {
    await runCommand(process.argv);
  } catch (err) {
    if (err instanceof UserInputError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error("Unexpected error:", err);
    process.exit(2);
  }
}
```

---

## Anti-patterns

### The silent swallow

```ts
// The worst pattern in software
try {
  await riskyOperation();
} catch (err) {
  // ignore
}
```

This hides every possible failure — transient, permanent, bugs, infrastructure. The system appears to work but produces wrong results. If you think an error is ignorable, you are either wrong or the operation is not needed (in which case, remove it).

### Catch-log-rethrow without adding context

```ts
try {
  await doSomething();
} catch (err) {
  logger.error(err); // Adds nothing — the error would be logged at the boundary anyway
  throw err;
}
```

This creates duplicate log entries with no added information. Either add context when re-throwing or do not catch at all.

### Using exceptions for control flow

```ts
// Bad: exception as a return value
function findUser(id: string): User {
  const user = db.users.find(id);
  if (!user) throw new NotFoundError("User", id);
  return user;
}

// Then later:
try {
  const user = findUser(id);
  // use user
} catch (err) {
  if (err instanceof NotFoundError) {
    // create the user instead — this was the expected case!
    await createUser(id);
  }
}
```

If "not found" is a normal, expected case in the calling code, do not use an exception. Use a return type that represents absence (`null`, `undefined`, `Option`, `Result`).

### Over-catching with generic handlers

```ts
try {
  const user = await getUser(id);
  const processed = transformUser(user);
  await saveUser(processed);
} catch (err) {
  return { status: 500, error: "Something went wrong" };
}
```

This catches three different operations and treats all failures identically. Was the user not found (404)? Was the transformation invalid (400)? Was the save a constraint violation (409)? You cannot tell. Narrow the try/catch scope or use typed error checks.

---

## Logging strategy

### What to log at each level

| Level | When | Example |
|-------|------|---------|
| DEBUG | Expected conditions useful during development | "Cache miss for key user:123" |
| INFO | Normal operational events | "User 456 created successfully" |
| WARN | Recoverable issues that may indicate a problem | "Retry 2/3 for payment service" |
| ERROR | Failures requiring investigation | "Unhandled error in /api/users: TypeError..." |
| FATAL | Process-ending failures | "Database connection pool exhausted, shutting down" |

### What to include in error logs

Every error log should include:
- **What operation was being performed** ("Processing webhook for order #123")
- **The error type and message** ("NotFoundError: Product SKU-456 not found")
- **The stack trace** (for programmer errors)
- **Request/job context** (request ID, user ID, job ID — whatever helps find it in traces)

Do NOT include:
- Passwords, tokens, or secrets (even in error context)
- Full request bodies (may contain PII)
- Stack traces for expected operational errors (they are noise)

---

## Verification checklist

When reviewing error handling:

- [ ] No empty catch blocks (`catch (err) {}`)
- [ ] Operational errors and programmer errors are handled differently
- [ ] Error types carry enough context for handlers to make decisions
- [ ] Internal error details are never exposed in user-facing responses
- [ ] Errors that cross boundaries are wrapped with layer-appropriate context
- [ ] Every system boundary (HTTP handler, queue consumer, CLI) has a top-level error handler
- [ ] Transient failures are retried with backoff; permanent failures are surfaced
- [ ] Error logs include operation context, not just the error message

---

## Related

- [methodology-systematic-debugging](../methodology-systematic-debugging/SKILL.md) — debugging often starts with an error that was poorly handled
- [methodology-api-design](../methodology-api-design/SKILL.md) — API error response design
- [production-readiness](../production-readiness/SKILL.md) — error handling is a core production readiness concern
