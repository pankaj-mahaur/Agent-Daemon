# methodology-tdd — examples

Real before-after pairs for the red-green-refactor loop, test granularity, and the testability heuristics.

---

## Example 1 — Behavior vs. implementation

### ❌ Bad

```ts
test("createUser calls db.insert exactly once", async () => {
  const spy = jest.spyOn(db, "insert");
  await createUser({ name: "Alice" });
  expect(spy).toHaveBeenCalledTimes(1);
});
```

Tests an *implementation detail*. The day we batch inserts or switch to an outbox table, this test fails — but the actual user-facing behavior is fine. False-positive failures train developers to ignore the suite.

### ✅ Good

```ts
test("createUser returns user with generated id and trimmed name", async () => {
  const user = await createUser({ name: "  Alice  " });
  expect(user.id).toBeDefined();
  expect(user.name).toBe("Alice");
});
```

Tests the *contract*. Survives any refactor that preserves the contract. Reads as a spec — anyone can understand what the system does from the name alone.

---

## Example 2 — Horizontal vs. vertical slicing

### ❌ Bad (horizontal — bulk tests first, bulk impl after)

```ts
// RED phase — agent writes 5 tests upfront
test("createUser ...", () => { /* placeholder */ });
test("updateUser ...", () => { /* placeholder */ });
test("deleteUser ...", () => { /* placeholder */ });
test("listUsers ...", () => { /* placeholder */ });
test("searchUsers ...", () => { /* placeholder */ });

// GREEN phase — agent writes all 5 implementations
```

The tests are guesses about behavior the agent hasn't built yet. They test the *shape* of imagined APIs, not what the system does. When implementation reveals constraints (search needs pagination, listUsers needs filtering), the tests are wrong and have to be rewritten anyway. Bulk re-work.

### ✅ Good (vertical — tracer bullets, one cycle at a time)

```
RED → GREEN: test "createUser returns user with id"   → impl: createUser
RED → GREEN: test "createUser trims whitespace"        → impl: add .trim()
RED → GREEN: test "createUser throws on empty name"    → impl: add validation
... continues, each test informed by what the previous cycle revealed
```

Each test responds to what was learned. The implementation reveals interface details (do we throw or return `Result`?) one cycle at a time, with tests that match.

---

## Example 3 — Bug fix WITHOUT regression test

### ❌ Bad

User reports: "discount calculation rounds wrong for amounts ending in .x5". Agent reads `calculateDiscount`, spots a `Math.floor` that should be `Math.round`, changes it. Commits. Moves on.

Three months later, someone refactors `calculateDiscount` to use a tax-inclusive base, and the rounding bug silently regresses. No alarm.

### ✅ Good

Agent writes the test that reproduces the bug *first*:

```ts
test("calculateDiscount rounds .x5 correctly (regression: issue #842)", () => {
  expect(calculateDiscount(10.05, 0.1)).toBe(1.01);  // not 1.00
  expect(calculateDiscount(20.15, 0.2)).toBe(4.03);
});
```

Test fails. Agent applies the `Math.floor → Math.round` fix. Test passes. **Now the regression is locked down forever** — any future refactor that breaks the rounding will trip this test.

The commit message names the hypothesis: *"fix(discount): Math.round corrects .x5 rounding (issue #842 — was using Math.floor)"*. The next debugger who hits adjacent code will learn from the message.

---

## Example 4 — Interface designed for testability

### ❌ Bad

```ts
async function processOrder(order: Order) {
  const gateway = new StripeGateway(process.env.STRIPE_KEY!);
  const result = await gateway.charge(order.total);
  await db.orders.update(order.id, { paid: result.ok });
  return result;
}
```

Two boundaries baked inside (`StripeGateway`, `db.orders.update`). To test, you have to monkey-patch globals, set env vars, or refactor. Tests are slow and fragile.

### ✅ Good

```ts
type OrderDeps = {
  charge: (amount: number) => Promise<{ ok: boolean }>;
  updateOrder: (id: string, patch: Partial<Order>) => Promise<void>;
};

async function processOrder(order: Order, deps: OrderDeps) {
  const result = await deps.charge(order.total);
  await deps.updateOrder(order.id, { paid: result.ok });
  return result;
}
```

The boundaries are explicit parameters. In production, you wire up `{ charge: stripe.charge, updateOrder: db.orders.update }`. In tests, you wire up `{ charge: async () => ({ ok: true }), updateOrder: async () => {} }`. No globals, no monkey-patching.

---

## Example 5 — SDK-style mocks vs. generic fetcher

### ❌ Bad

```ts
// One generic fetch, mocked with switch logic
const api = { fetch: (endpoint, options) => fetch(endpoint, options) };

// In test:
api.fetch = vi.fn().mockImplementation((endpoint, options) => {
  if (endpoint === `/users/${id}`)      return Promise.resolve({ id, name: "Alice" });
  if (endpoint.startsWith("/orders"))   return Promise.resolve([{ id: 1 }]);
  if (options?.method === "POST")       return Promise.resolve({ created: true });
  throw new Error(`unmocked: ${endpoint}`);
});
```

The mock is a mini-server. Every new endpoint adds a `switch` arm. Tests that touch many endpoints have giant mock setups. The mock is now a maintenance burden.

### ✅ Good

```ts
const api = {
  getUser:     (id: string)         => fetch(`/users/${id}`).then(r => r.json()),
  getOrders:   (userId: string)     => fetch(`/users/${userId}/orders`).then(r => r.json()),
  createOrder: (data: OrderInput)   => fetch("/orders", { method: "POST", body: JSON.stringify(data) }).then(r => r.json()),
};

// In test — each function mocked independently
api.getUser     = vi.fn().mockResolvedValue({ id: "u1", name: "Alice" });
api.getOrders   = vi.fn().mockResolvedValue([{ id: "o1" }]);
api.createOrder = vi.fn().mockResolvedValue({ created: true });
```

Each mock is one line, one shape, one purpose. Type safety per endpoint. The mock setup *is* the documentation of what external calls the test exercises.

---

## Example 6 — Testing through mocks all the way down

### ❌ Bad

```ts
test("checkout flow works", async () => {
  const db = { orders: { insert: vi.fn().mockResolvedValue({ id: 1 }) } };
  const stripe = { charge: vi.fn().mockResolvedValue({ ok: true }) };
  const mail = { send: vi.fn().mockResolvedValue(undefined) };
  const log = { info: vi.fn() };

  await checkout({ cartId: "c1" }, { db, stripe, mail, log });

  expect(db.orders.insert).toHaveBeenCalled();
  expect(stripe.charge).toHaveBeenCalled();
  expect(mail.send).toHaveBeenCalled();
});
```

This test mocks every collaborator and asserts they were called. It's testing *the glue between mocks* — not whether checkout actually works. If the SQL query is wrong, this test passes. If the Stripe payload shape is wrong, this test passes. If the email template breaks, this test passes.

### ✅ Good — integration test with real test DB

```ts
test("checkout flow persists order and triggers mail", async () => {
  const db    = await testDb();          // real SQLite / pg-test
  const stripe = mockStripe({ ok: true }); // mock at the boundary
  const mail  = captureMails();          // in-process mail collector

  await checkout({ cartId: "c1" }, { db, stripe, mail });

  const orders = await db.orders.findMany({ where: { cartId: "c1" } });
  expect(orders).toHaveLength(1);
  expect(orders[0].paid).toBe(true);
  expect(mail.sent).toContainEqual(expect.objectContaining({ to: "alice@example.com", subject: /order/i }));
});
```

The DB is real — the test catches schema mismatches, wrong queries, broken migrations. Stripe is mocked at the boundary (external system, paid API). The mail collector is in-process. The assertions read the persisted state, not the call history.

---

## When to skip a test (not every line needs one)

### ❌ Bad

```ts
test("getName returns name", () => {
  const obj = { name: "Alice", getName() { return this.name; } };
  expect(obj.getName()).toBe("Alice");
});
```

Testing a trivial getter. Pure coverage chasing. Zero bug-prevention value, real maintenance cost.

### ✅ Good

Skip. Add a test when the getter grows logic (lazy init, fallback, derived value). Until then, a type system + a test on the *caller* that uses the getter gives you 100% of the value.
