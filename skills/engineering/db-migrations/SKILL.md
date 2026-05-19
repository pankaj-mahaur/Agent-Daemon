---
name: db-migrations
description: Database schema and migration discipline. Use when adding/editing migration files, changing API response shape, adding/dropping columns or tables, or touching DB initialization code. Encodes numbered-migration ordering, the never-edit-shipped rule, forward-compatibility (no destructive ops), idempotency, response-payload preservation, and prod backup gating.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Database migrations without breaking production

Migrations run forward-only on shared environments (staging, prod). The same migration file applied locally + on staging + in CI + on prod must produce the same schema, and every step must be safe to re-run after a partial failure. Most migration regressions come from breaking one of those guarantees.

This skill is the discipline. It applies whether you use Alembic (SQLAlchemy), Django migrations, Prisma Migrate, Knex, Flyway, Liquibase, Rails ActiveRecord, golang-migrate, sqlx, or hand-rolled numbered SQL files.

---

## Pre-flight (always)

1. **Find the current head.** Don't trust memory.
   ```bash
   # Hand-rolled numbered files
   ls db/migrations/ | sort | tail -5

   # Alembic
   alembic current && alembic heads

   # Django
   python manage.py showmigrations <app> | tail -10

   # Prisma
   ls prisma/migrations/ | sort | tail -5

   # Rails
   bin/rails db:migrate:status | tail -10

   # golang-migrate
   migrate -path db/migrations -database "$DATABASE_URL" version
   ```
2. **Read the migration runner** to understand how files are discovered, ordered, and applied. Custom migrators (a hand-rolled `db.ts` walking `migrations/`) often have non-obvious rules — file naming, transaction wrapping, idempotency expectations.
3. **Read the type/contract files** that will need to change in lockstep — TypeScript types, Pydantic models, GraphQL schema, OpenAPI spec, generated client SDKs.
4. **Plan first.** Schema changes are never trivial. Use plan mode (or its equivalent) before writing the migration file.

---

## Hard rules

### Numbered files only, increment from the head

Every migration system orders by some monotonic key — number, timestamp, or both. Match the project's existing pattern exactly:

| Pattern | Example |
|---|---|
| Zero-padded integer | `001_initial_schema.sql`, `012_add_user_locale.sql` |
| Timestamp | `20240315142103_add_user_locale.sql` |
| Alembic revision id | `f3a8b2c4d_add_user_locale.py` (parent: `e2d1f0a9`) |
| Django auto-name | `0042_alter_user_locale.py` |

**Read the directory before naming the new file.** Guessing the next number is how you get duplicate revisions and a broken migration graph.

### Never edit a shipped migration

Once a migration has run on staging, prod, or any teammate's database, editing it = corrupted history. The hash/checksum that the runner stores in its tracking table won't match the file, and partial environments will refuse to migrate further.

If you need to change what a shipped migration did, write a **new** migration that adjusts the result. Even fixing a typo in a column name needs a new migration.

### Forward-compatible only

No destructive operations on populated tables without a multi-step deprecation:

- **DROP COLUMN, DROP TABLE, RENAME COLUMN** → split into:
  1. Migration N: add the new column / table; backfill; mark old as deprecated in code
  2. Wait one or more deploys for callers to switch
  3. Migration N+M: drop the old column / table

- **Type narrowing or constraint tightening** (e.g. `VARCHAR(255)` → `VARCHAR(64)`, adding `NOT NULL` to an existing column) → backfill first, then enforce. Adding `NOT NULL DEFAULT <x>` is fine on small tables but will lock larger ones — see "Long-running operations" below.

- **SQLite quirk:** `ALTER TABLE DROP COLUMN` and arbitrary `ALTER COLUMN` are limited (require table rebuild via temp table). Design schemas to grow with `ADD COLUMN` only.

### Idempotent where possible

Migrations should not fail catastrophically on a partially-applied database:

```sql
-- SQL flavors
CREATE TABLE IF NOT EXISTS users (...);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;  -- Postgres 9.6+
```

```python
# Django — check before creating to support partial state
class Migration(migrations.Migration):
    operations = [
        migrations.RunSQL(
            sql="ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;",
            reverse_sql="ALTER TABLE users DROP COLUMN IF EXISTS locale;",
        ),
    ]
```

For ORMs that don't support `IF NOT EXISTS` natively (SQLAlchemy/Alembic, MySQL pre-8.0), use a guard:

```python
# Alembic
from alembic import op
from sqlalchemy import inspect

def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    cols = [c["name"] for c in inspector.get_columns("users")]
    if "locale" not in cols:
        op.add_column("users", sa.Column("locale", sa.String(8)))
```

### API response payload preservation

If the project ships an API consumed by mobile apps, third parties, or your own released clients, **adding fields is safe** (clients ignore unknowns); **renaming, removing, or retyping** an existing field breaks them. Even if you control all clients, an old mobile binary in the wild may run for months.

If a schema change forces a payload shape change, **stop and ask the user** before proceeding. Plan a versioned response (`/api/v2/...`) or a deprecation window.

### Long-running operations on populated tables

These take an exclusive table lock under default settings — fatal on prod:

- `CREATE INDEX` on a large table (without `CONCURRENTLY` in Postgres)
- `ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT <x>` on large Postgres tables (pre-11) — rewrites the table
- `ALTER TABLE` that changes a column type
- Adding a foreign key constraint without `NOT VALID + VALIDATE`

Pattern fixes:

```sql
-- Postgres: non-blocking index
CREATE INDEX CONCURRENTLY idx_orders_user_date ON orders (user_id, created_at);
```

```python
# Django + Postgres CONCURRENT
class Migration(migrations.Migration):
    atomic = False  # required for CONCURRENTLY
    operations = [
        migrations.RunSQL(
            sql="CREATE INDEX CONCURRENTLY idx_x ON table_x (col);",
            reverse_sql="DROP INDEX IF EXISTS idx_x;",
        ),
    ]
```

```sql
-- MySQL 8: ALGORITHM=INPLACE for adding nullable column
ALTER TABLE users ADD COLUMN locale VARCHAR(8), ALGORITHM=INPLACE, LOCK=NONE;
```

```sql
-- Postgres FK without long lock
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT fk_user;
```

### Indexes — only with a named query

Add an index only if you can name the slow query it fixes. Phantom indexes slow writes, bloat the buffer pool, and confuse the query planner. If the project already has a tuned index set (an `INDEXES.md`, comments in migrations, query plans in code review), don't drop them without proof they're unused.

---

## Type sync (the second half of every migration)

Schema change → type change → client refresh:

1. **Edit/add migration.**
2. **Update generated or hand-written types.** Common locations:
   - TypeScript shared types — `packages/types/`, `shared/types.ts`
   - Pydantic models — `app/models/`, `app/schemas/`
   - GraphQL schema — `schema.graphql`, regenerate clients
   - OpenAPI spec — regenerate via `openapi-generator`, `swagger-codegen`
3. **Run the type-build step** before backend or client builds:
   ```bash
   npm run build:types          # if a types package exists
   npx prisma generate          # Prisma client
   strawberry export-schema     # Strawberry GraphQL
   python manage.py spectacular --file openapi.yaml  # drf-spectacular
   ```
4. **Update every query/insert/update site** the schema change touches. Grep for the table name and the column name; both will surface call sites the type system might miss in dynamic code paths.
5. **Update all client codebases** if you have multiple (web + mobile + admin). See [multiplatform-parity](../multiplatform-parity/SKILL.md).

---

## Production / VPS hygiene

- **DB path:** persistent (not ephemeral). Verify the path is mounted as a volume in Docker / a managed volume on Render/Fly/Railway / a persistent disk on the VPS.
- **Backups before destructive migrations.** Pattern:
  ```bash
  # SQLite
  sqlite3 /var/www/app/data/app.db ".backup /var/backups/app/pre-migration-$(date +%Y%m%d-%H%M).db"

  # Postgres
  pg_dump -Fc -f /var/backups/app/pre-migration-$(date +%Y%m%d-%H%M).dump $DATABASE_URL

  # MySQL
  mysqldump --single-transaction --routines --triggers <db> > /var/backups/app/pre-migration-$(date +%Y%m%d-%H%M).sql
  ```
  Confirm the dump exists and is non-empty before letting the deploy proceed.
- **Migrations on boot vs migrations on deploy.** Many setups run migrations as the app starts (Django `migrate` in entrypoint, Prisma's `migrate deploy` in build step). Verify which model your project uses — running migrations in N parallel app pods is a recipe for race conditions; usually one pod / one job runs the migration, then app pods boot.
- **Staging mirrors prod.** Test the migration there first. If staging doesn't exist, ask whether one should be set up before destructive ops.
- **Watch the logs after deploy.**
  ```bash
  pm2 logs <name> --lines 100      # PM2
  docker compose logs --tail 100 server  # Compose
  kubectl logs deployment/<name> --tail 100  # k8s
  fly logs                                # Fly
  ```

---

## Defer to user (always ask first)

- Any migration that **drops** a column, table, or constraint
- Any migration that **renames** an existing column or table
- Any migration that **re-types** an existing column
- Any change to **API response shape** (even adding a field forces a parity decision across clients — flag it)
- Running a migration **manually against the prod DB** outside the deploy pipeline
- Running an **`sqlite3 ... .dump` / `pg_dump`** against the prod DB (sensitive data egress — must be authorized)

---

## Verification

- **Apply on a fresh DB:** delete the local DB file or recreate the local schema; run all migrations from zero. Must succeed end-to-end.
  ```bash
  # SQLite
  rm -f db/dev.db && npm run dev:backend
  # Postgres
  dropdb dev && createdb dev && npm run migrate
  # Django
  python manage.py migrate
  ```
- **Apply on top of the previous DB** (the most recent shipped state — local copy or restored staging dump). Must succeed without manual intervention.
- **Type-check** clean after type updates (`npm run typecheck` / `mypy` / `cargo check`).
- **Type-build** clean (`npm run build:types` / `prisma generate`).
- **Hit the affected API endpoints** with `curl` and confirm the response shape matches the type definition. Field-by-field, not just status code.

---

## What NOT to do

- **Don't edit a shipped migration** to fix a typo — write a new one.
- **Don't `DROP COLUMN`** in the same migration as the rename — split into two deploys.
- **Don't `CREATE INDEX`** without `CONCURRENTLY` on a large Postgres table.
- **Don't add `NOT NULL DEFAULT <x>`** to a wide column on a large MySQL/Postgres-pre-11 table without batching.
- **Don't `migrate` the prod DB manually** if the deploy pipeline runs migrations — duplicates and drift will follow.
- **Don't trust `IF NOT EXISTS`** in migrators that store checksums — Alembic in particular will flag mismatch even if the SQL is idempotent. Use the inspector-based guard pattern shown above.
- **Don't widen indexes "just in case"** — name the query they fix.

---

## Related

- [production-readiness](../production-readiness/SKILL.md) — pre-launch DB checklist
- [deploy-ops](../deploy-ops/SKILL.md) — migration safety during rollouts, rollback playbook
- [seed-data](../seed-data/SKILL.md) — idempotent seed scripts that survive partial failure
