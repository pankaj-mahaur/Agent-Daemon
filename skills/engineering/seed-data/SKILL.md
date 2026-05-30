---
name: seed-data
description: Use only when user explicitly requests seed/test data generation for specified schema/models. Generates idempotent seed scripts with realistic test data.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
argument-hint: [entity names] [count]
---

# Seed Data Generator

## Purpose
Generate idempotent database seed scripts with realistic test data.

## When to Use (STRICT CRITERIA)
Only invoke this skill when ALL of these are true:
1. User explicitly requests seed/test data generation with phrases like:
   - "generate seed data"
   - "create test data script"
   - "populate database with mock data"
   - "need sample data for testing"
2. User specifies schema/models that need data
3. NOT for simple CRUD code or component generation

## When NOT to Use
- Regular feature development
- Component/API code generation
- Bug fixes or refactoring
- User asks general "how to" questions
- Unclear requirements

## Usage Pattern
User triggers with explicit command:
"Generate a seed script for [Product, User, Order] models with 50 realistic entries each"

## Output Format

### 1. Idempotent Script Template (TypeScript)
```typescript
// scripts/seed-[entity].ts
import { PrismaClient } from '@prisma/client'
// or: import payload from 'payload'
// or: WordPress REST API client

const prisma = new PrismaClient()

async function seed[Entity]() {
  console.log('Seeding [entity] data...')

  const data = [
    // Realistic data array (50-100 items)
  ]

  for (const item of data) {
    await prisma.[entity].upsert({
      where: { id: item.id }, // or slug/email
      create: item,
      update: item,
    })
  }

  console.log(`Seeded ${data.length} [entity] records`)
}

seed[Entity]()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
```

### 2. Realistic Data Generation
- Use varied, production-like data
- Include edge cases (long strings, special chars, nulls)
- Realistic dates (past year range)
- Proper relationships (foreign keys)

### 3. Make it Idempotent
Always use:
- `upsert` (Prisma)
- `findOneAndUpdate` with `upsert: true` (Mongoose)
- `INSERT ... ON CONFLICT DO UPDATE` (raw SQL)
- `wp.posts().id(123).update()` with existence check (WordPress)

### 4. Include Run Instructions
```json
// package.json
{
  "scripts": {
    "seed": "tsx scripts/seed-all.ts",
    "seed:products": "tsx scripts/seed-products.ts"
  }
}
```

## Token Efficiency Rules
1. Generate data inline (no external files)
2. Use concise but realistic content
3. Batch related entities in one script
4. Ask clarifying questions FIRST if unclear:
   - "How many records per entity?"
   - "Which entities need seeding?"
   - "What ORM/database?"

## Example Invocation

**User says:**
"I need test data for my e-commerce app - products, categories, and users"

**Claude asks:**
"I can generate seed scripts for those. Quick questions:
1. How many of each? (default: 50 products, 10 categories, 20 users)
2. Are you using Prisma, Payload, or WordPress?
3. Any specific requirements (price ranges, user roles, etc.)?"

**Then generates:** Complete seed scripts after confirmation.

## Anti-Patterns (DO NOT DO)
- Generate seed data when user just asks for a component
- Auto-suggest seeding for every database model
- Create seed data without schema context
- Generate when user says "create a Product model" (wait for explicit seed request)

## Success Criteria
- User runs script multiple times safely
- Data looks production-ready
- Script handles existing data gracefully
