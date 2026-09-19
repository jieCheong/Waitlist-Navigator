# Schema and Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four raw-SQL `node-pg-migrate` migrations that create the Waitlist Navigator schema, plus a script that proves the constraints against a real database.

**Architecture:** Migrations live in `apps/api/migrations/` and run as the owner role `waitlist`. The API will later connect as `app_user`, which gets default privileges on every table and has `UPDATE`/`DELETE` revoked on `audit_log`. A check script in `scripts/` creates throwaway databases, runs `up`/`down`/`up`, and asserts every constraint by inserting bad rows and checking the SQLSTATE. Checks are written first for each migration (red), then the migration makes them pass (green).

**Tech Stack:** PostgreSQL 16 (docker compose), `node-pg-migrate` 9, `pg` 8, Node 24 ESM, npm workspaces.

**Spec:** `docs/design/schema-migrations.md`

## Global Constraints

- Raw SQL migrations only. No ORM.
- Primary keys are `uuid PRIMARY KEY DEFAULT gen_random_uuid()`. The only exception is `audit_log`, which uses `bigint GENERATED ALWAYS AS IDENTITY`.
- `created_at timestamptz NOT NULL DEFAULT now()` on every table. Mutable tables also have `updated_at timestamptz NOT NULL DEFAULT now()`, set by the application, with no triggers.
- Status and role fields are `text` with `CHECK` constraints, never Postgres enums.
- Encrypted columns are `bytea` and named `*_enc`.
- The migration runner connects as `waitlist`. The API connects as `app_user`.
- `app_user` is created idempotently and is **never dropped** by a down migration. Down runs only `DROP OWNED BY app_user`.
- `TRUNCATE` is never granted to `app_user`.
- `audit_log` has no foreign keys, in either direction.
- Do not run `git commit`. Every task ends with a commit command for the user to run.
- Dates used in fixtures: 2026-09-21 and 2026-09-28 are Mondays, 2026-09-22 is a Tuesday.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/package.json` | `pg`, `node-pg-migrate`, and the `migrate:up` / `migrate:down` scripts |
| `package.json` (root) | root pass-through scripts and `check:migrations` |
| `.env.example` | `DATABASE_URL` (as `app_user`) and `DATABASE_URL_MIGRATE` (as owner) |
| `apps/api/migrations/1758240000001_core-tables.sql` | roles, `zip_centroids`, `clinics`, `payers`, `users`, `refresh_tokens`, `clinicians`, `clinician_payers`, `availability_slots` |
| `apps/api/migrations/1758240000002_families-children-intake.sql` | `families`, `children`, `intake_requests` |
| `apps/api/migrations/1758240000003_scoring-config-waitlist-offers-bookings.sql` | `scoring_config`, `waitlist_entries`, `offers`, `bookings` |
| `apps/api/migrations/1758240000004_audit-log.sql` | `audit_log` and the `REVOKE` |
| `scripts/lib/harness.mjs` | database creation, running migrations, `pg_dump`, the test runner, `insert`, `expectFail` |
| `scripts/check-migrations.mjs` | orchestration: up, run checks, down, up, compare dumps |
| `scripts/checks/core.mjs` | checks for migration 1 |
| `scripts/checks/intake.mjs` | checks for migration 2 |
| `scripts/checks/offers-bookings.mjs` | checks for migration 3 |
| `scripts/checks/audit.mjs` | checks for migration 4 |

Prerequisite for every task: Docker is running and `npm run db:up` has been run, so `docker compose ps` shows `postgres` as healthy.

---

### Task 1: Tooling, check harness, and migration 1 (core tables)

**Files:**
- Modify: `package.json`, `apps/api/package.json`, `.env.example`
- Create: `scripts/lib/harness.mjs`, `scripts/check-migrations.mjs`, `scripts/checks/core.mjs`
- Create: `apps/api/migrations/1758240000001_core-tables.sql`

**Interfaces:**
- Produces, from `scripts/lib/harness.mjs`:
  - `urlFor(database: string, credentials?: { user: string, password: string }): string`
  - `connect(url: string): Promise<pg.Client>`
  - `createDatabase(name: string): Promise<void>` and `dropDatabase(name: string): Promise<void>`
  - `migrate(database: string, direction: 'up' | 'down'): void` (throws on failure)
  - `schemaDump(database: string): string`
  - `createRunner(): { t(name, fn): Promise<void>, results: {name, ok}[], useClients(clients: pg.Client[]): void }`
  - `insert(client, table: string, row: object): Promise<object>` (returns the inserted row)
  - `expectFail(client, sqlState: string, action: () => Promise<unknown>): Promise<void>`
  - `uniqueEmail(): string`
- Produces: check functions take `ctx = { t, owner, app, fx }`, where `owner` and `app` are `pg.Client`s inside open transactions and `fx` is a shared object of fixture rows. This task defines `fx.zip`, `fx.zip2`, `fx.clinic`, `fx.clinic2`, `fx.coordinator`, `fx.clinicianUser`, `fx.familyUser`, `fx.admin`, `fx.selfPay`, `fx.insurer`, `fx.clinician`, `fx.slot`, `fx.slot2`.

- [ ] **Step 1: Install dependencies**

```bash
npm install -w @waitlist/api pg
npm install -w @waitlist/api -D node-pg-migrate
npm install -D pg
```

`node-pg-migrate` needs `pg` as a peer dependency. The root `pg` is for the scripts in `scripts/`.

- [ ] **Step 2: Add the scripts**

In `apps/api/package.json`, add this `scripts` block. `down 9999` reverts every migration because the runner takes the last N, and N larger than the count means all of them. `--envPath ../../.env` loads the root `.env`. A missing `.env` is not an error, and a variable already set in the environment wins.

```json
"scripts": {
  "migrate": "node-pg-migrate --database-url-var DATABASE_URL_MIGRATE --envPath ../../.env --migrations-dir migrations",
  "migrate:up": "npm run migrate -- up",
  "migrate:down": "npm run migrate -- down 9999"
}
```

In the root `package.json`, add to `scripts`:

```json
"migrate:up": "npm run migrate:up -w @waitlist/api",
"migrate:down": "npm run migrate:down -w @waitlist/api",
"check:migrations": "node scripts/check-migrations.mjs"
```

In `.env.example`, replace the `DATABASE_URL=` line with:

```
# The API connects as app_user (created by the first migration).
DATABASE_URL=postgresql://app_user:app_user@localhost:5432/waitlist
# Migrations and the check script connect as the owner role.
DATABASE_URL_MIGRATE=postgresql://waitlist:waitlist@localhost:5432/waitlist
```

- [ ] **Step 3: Write the harness**

Create `scripts/lib/harness.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Load the root .env so the script targets the same Postgres as the npm scripts. A variable that
// is already set in the environment wins, and a missing file is fine.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {}

const adminUrl = new URL(
  process.env.DATABASE_URL_MIGRATE ?? 'postgresql://waitlist:waitlist@localhost:5432/waitlist',
);

export function urlFor(database, credentials) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

export async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function withAdmin(fn) {
  const admin = await connect(urlFor('postgres'));
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

export function createDatabase(name) {
  return withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  });
}

export function dropDatabase(name) {
  return withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

function run(command, env = {}) {
  const result = spawnSync(command, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export function migrate(database, direction) {
  run(`npm run migrate:${direction} -w @waitlist/api --silent`, {
    DATABASE_URL_MIGRATE: urlFor(database),
  });
}

export function schemaDump(database) {
  // pg_dump 16.10+ prints a random \restrict token on every run; drop those lines so dumps compare.
  return run(
    `docker compose exec -T postgres pg_dump --schema-only --no-owner -U waitlist ${database}`,
  )
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join('\n');
}

export function createRunner() {
  const results = [];
  let clients = [];

  // Each case runs inside a savepoint on every open client, so one failing case cannot abort
  // the transaction the remaining cases share.
  async function t(name, fn) {
    for (const client of clients) await client.query('SAVEPOINT check_case');
    try {
      await fn();
      for (const client of clients) await client.query('RELEASE SAVEPOINT check_case');
      results.push({ name, ok: true });
      console.log(`  ok    ${name}`);
    } catch (err) {
      for (const client of clients) await client.query('ROLLBACK TO SAVEPOINT check_case');
      results.push({ name, ok: false });
      const detail = String(err.message).split('\n').join('\n        ');
      console.log(`  FAIL  ${name}\n        ${detail}`);
    }
  }

  return {
    t,
    results,
    useClients(list) {
      clients = list;
    },
  };
}

export async function insert(client, table, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    Object.values(row),
  );
  return rows[0];
}

export async function expectFail(client, sqlState, action) {
  await client.query('SAVEPOINT expect_fail');
  try {
    await action();
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT expect_fail');
    if (err.code !== sqlState) {
      throw new Error(`expected SQLSTATE ${sqlState}, got ${err.code}: ${err.message}`);
    }
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_fail');
  throw new Error(`expected SQLSTATE ${sqlState}, but the statement succeeded`);
}

let emailCounter = 0;
export function uniqueEmail() {
  emailCounter += 1;
  return `user${emailCounter}@example.com`;
}
```

- [ ] **Step 4: Write the orchestration script**

Create `scripts/check-migrations.mjs`:

```js
import assert from 'node:assert/strict';
import {
  connect,
  createDatabase,
  createRunner,
  dropDatabase,
  migrate,
  schemaDump,
  urlFor,
} from './lib/harness.mjs';
import { coreChecks } from './checks/core.mjs';

const MAIN = 'waitlist_migrate_check';
const OTHER = 'waitlist_migrate_other';

const { t, results, useClients } = createRunner();

async function runChecks() {
  const owner = await connect(urlFor(MAIN));
  const app = await connect(urlFor(MAIN, { user: 'app_user', password: 'app_user' }));
  await owner.query('BEGIN');
  await app.query('BEGIN');
  useClients([owner, app]);
  try {
    const ctx = { t, owner, app, fx: {} };
    await coreChecks(ctx);
  } finally {
    useClients([]);
    await owner.query('ROLLBACK');
    await app.query('ROLLBACK');
    await owner.end();
    await app.end();
  }
}

async function main() {
  await createDatabase(MAIN);
  await createDatabase(OTHER);
  try {
    // app_user is cluster-wide. Keeping grants in a second database means a down migration
    // that tried to DROP ROLE would fail here.
    console.log('up on a second database');
    migrate(OTHER, 'up');
    console.log('up on a fresh database');
    migrate(MAIN, 'up');
    const firstDump = schemaDump(MAIN);

    console.log('constraint checks');
    await runChecks();

    console.log('down / up round trip');
    await t('down reverts everything and leaves the cluster-wide role alone', async () => {
      migrate(MAIN, 'down');
      const client = await connect(urlFor(MAIN));
      try {
        const tables = await client.query(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`,
        );
        assert.deepEqual(tables.rows, []);
        const defaults = await client.query('SELECT count(*)::int AS n FROM pg_default_acl');
        assert.equal(defaults.rows[0].n, 0);
        const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'app_user'`);
        assert.equal(role.rowCount, 1);
      } finally {
        await client.end();
      }
    });
    await t('up succeeds again after down', () => migrate(MAIN, 'up'));
    await t('schema after the second up is identical to the first', () => {
      assert.ok(
        schemaDump(MAIN) === firstDump,
        'pg_dump --schema-only output differs after up/down/up',
      );
    });
  } finally {
    await dropDatabase(MAIN);
    await dropDatabase(OTHER);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  });
```

- [ ] **Step 5: Write the migration 1 checks**

Create `scripts/checks/core.mjs`:

```js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectFail, insert, uniqueEmail } from '../lib/harness.mjs';

export async function coreChecks({ t, owner, app, fx }) {
  const clinicRow = (overrides) => ({
    name: 'Test Clinic',
    timezone: 'America/Chicago',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    ...overrides,
  });
  const userRow = (role, clinic_id) => ({
    email: uniqueEmail(),
    password_hash: 'x',
    role,
    clinic_id,
  });
  const clinicianRow = (overrides) => ({
    clinic_id: fx.clinic.id,
    user_id: null,
    full_name: 'Test Clinician',
    disciplines: ['speech'],
    languages: ['en'],
    age_min_months: 0,
    age_max_months: 144,
    caseload_cap: 10,
    ...overrides,
  });
  const slotRow = (overrides) => ({
    clinician_id: fx.clinician.id,
    day_of_week: 2,
    start_time: '09:00',
    duration_minutes: 45,
    valid_from: '2026-01-01',
    ...overrides,
  });

  await t('zip_centroids accepts five digits and rejects anything else', async () => {
    fx.zip = await insert(owner, 'zip_centroids', { zip: '75201', lat: 32.79, lng: -96.8 });
    fx.zip2 = await insert(owner, 'zip_centroids', { zip: '75001', lat: 32.96, lng: -96.84 });
    await expectFail(owner, '23514', () =>
      insert(owner, 'zip_centroids', { zip: '7520', lat: 0, lng: 0 }),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'zip_centroids', { zip: 'abcde', lat: 0, lng: 0 }),
    );
  });

  await t('clinics reference a seeded zip (check 13)', async () => {
    fx.clinic = await insert(owner, 'clinics', clinicRow());
    fx.clinic2 = await insert(
      owner,
      'clinics',
      clinicRow({ name: 'Second Clinic', city: 'Addison', zip: '75001' }),
    );
    await expectFail(owner, '23503', () => insert(owner, 'clinics', clinicRow({ zip: '99999' })));
  });

  await t('users: role and clinic_id must agree (check 9)', async () => {
    fx.coordinator = await insert(owner, 'users', userRow('coordinator', fx.clinic.id));
    fx.clinicianUser = await insert(owner, 'users', userRow('clinician', fx.clinic.id));
    fx.familyUser = await insert(owner, 'users', userRow('family', null));
    fx.admin = await insert(owner, 'users', userRow('admin', null));
    await expectFail(owner, '23514', () =>
      insert(owner, 'users', userRow('family', fx.clinic.id)),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'users', userRow('admin', fx.clinic.id)),
    );
    await expectFail(owner, '23514', () => insert(owner, 'users', userRow('coordinator', null)));
    await expectFail(owner, '23514', () => insert(owner, 'users', userRow('clinician', null)));
    await expectFail(owner, '23514', () => insert(owner, 'users', userRow('nurse', null)));
  });

  await t('users: email is unique ignoring case', async () => {
    await insert(owner, 'users', { email: 'Case@Example.com', password_hash: 'x', role: 'admin' });
    await expectFail(owner, '23505', () =>
      insert(owner, 'users', { email: 'case@example.com', password_hash: 'x', role: 'admin' }),
    );
  });

  await t('refresh_tokens: token_hash is unique', async () => {
    const row = {
      user_id: fx.familyUser.id,
      token_hash: 'hash-1',
      token_family_id: randomUUID(),
      expires_at: '2030-01-01T00:00:00Z',
    };
    await insert(owner, 'refresh_tokens', row);
    await expectFail(owner, '23505', () => insert(owner, 'refresh_tokens', row));
  });

  await t('payers: Self-pay is seeded and names are unique', async () => {
    const { rows } = await owner.query(`SELECT id FROM payers WHERE name = 'Self-pay'`);
    assert.equal(rows.length, 1);
    fx.selfPay = rows[0];
    fx.insurer = await insert(owner, 'payers', { name: 'Test Insurance' });
    await expectFail(owner, '23505', () => insert(owner, 'payers', { name: 'Test Insurance' }));
  });

  await t('clinicians: eligibility inputs are constrained', async () => {
    fx.clinician = await insert(owner, 'clinicians', clinicianRow({ user_id: fx.clinicianUser.id }));
    // Clinicians without a login are allowed, and several may share the NULL.
    await insert(owner, 'clinicians', clinicianRow());
    await insert(owner, 'clinicians', clinicianRow());
    await expectFail(owner, '23505', () =>
      insert(owner, 'clinicians', clinicianRow({ user_id: fx.clinicianUser.id })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'clinicians', clinicianRow({ disciplines: [] })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'clinicians', clinicianRow({ languages: [] })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'clinicians', clinicianRow({ age_min_months: 60, age_max_months: 60 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'clinicians', clinicianRow({ age_min_months: -1 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'clinicians', clinicianRow({ caseload_cap: 0 })),
    );
  });

  await t('clinician_payers: one row per clinician and payer', async () => {
    const row = { clinician_id: fx.clinician.id, payer_id: fx.selfPay.id };
    await insert(owner, 'clinician_payers', row);
    await expectFail(owner, '23505', () => insert(owner, 'clinician_payers', row));
  });

  await t('availability_slots: weekly template, capacity pinned to 1 (check 5)', async () => {
    fx.slot = await insert(owner, 'availability_slots', slotRow());
    assert.equal(fx.slot.capacity, 1);
    fx.slot2 = await insert(
      owner,
      'availability_slots',
      slotRow({ day_of_week: 4, start_time: '13:30' }),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'availability_slots', slotRow({ capacity: 2 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'availability_slots', slotRow({ day_of_week: 0 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'availability_slots', slotRow({ day_of_week: 8 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'availability_slots', slotRow({ duration_minutes: 0 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'availability_slots', slotRow({ valid_to: '2025-12-31' })),
    );
  });

  await t('app_user reads and writes ordinary tables through default privileges', async () => {
    await insert(app, 'payers', { name: 'Written By App' });
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM payers WHERE name = 'Self-pay'`);
    assert.equal(rows[0].n, 1);
  });
}
```

- [ ] **Step 6: Run the checks and watch them fail**

Run: `npm run check:migrations`
Expected: exits with code 1. The output shows an error from `migrate:up` because `apps/api/migrations` does not exist yet, followed by `0/0 checks passed`.

- [ ] **Step 7: Write migration 1**

Create `apps/api/migrations/1758240000001_core-tables.sql`:

```sql
-- Up Migration

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

CREATE TABLE zip_centroids (
  zip text PRIMARY KEY CHECK (zip ~ '^\d{5}$'),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL,
  city text NOT NULL,
  state text NOT NULL CHECK (char_length(state) = 2),
  zip text NOT NULL REFERENCES zip_centroids (zip),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO payers (name) VALUES ('Self-pay');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('family', 'coordinator', 'clinician', 'admin')),
  clinic_id uuid REFERENCES clinics (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_clinic CHECK (
    (role IN ('coordinator', 'clinician') AND clinic_id IS NOT NULL)
    OR (role IN ('family', 'admin') AND clinic_id IS NULL)
  )
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_token_family_id_idx ON refresh_tokens (token_family_id);

CREATE TABLE clinicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  user_id uuid REFERENCES users (id),
  full_name text NOT NULL,
  disciplines text[] NOT NULL CHECK (cardinality(disciplines) > 0),
  languages text[] NOT NULL CHECK (cardinality(languages) > 0),
  age_min_months integer NOT NULL CHECK (age_min_months >= 0),
  age_max_months integer NOT NULL,
  caseload_cap integer NOT NULL CHECK (caseload_cap > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinicians_age_range CHECK (age_max_months > age_min_months)
);

CREATE UNIQUE INDEX clinicians_user_id_key ON clinicians (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX clinicians_clinic_id_idx ON clinicians (clinic_id);

CREATE TABLE clinician_payers (
  clinician_id uuid NOT NULL REFERENCES clinicians (id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES payers (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinician_id, payer_id)
);

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinician_id uuid NOT NULL REFERENCES clinicians (id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  capacity smallint NOT NULL DEFAULT 1 CHECK (capacity = 1),
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_slots_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX availability_slots_clinician_id_idx ON availability_slots (clinician_id);

-- Down Migration

DROP TABLE availability_slots;
DROP TABLE clinician_payers;
DROP TABLE clinicians;
DROP TABLE refresh_tokens;
DROP TABLE users;
DROP TABLE payers;
DROP TABLE clinics;
DROP TABLE zip_centroids;

-- Roles are cluster-wide: revoke app_user's privileges in this database, never drop the role.
DROP OWNED BY app_user;
```

- [ ] **Step 8: Run the checks and watch them pass**

Run: `npm run check:migrations`
Expected: 13/13 checks passed (10 constraint checks plus the three round-trip checks), exit code 0.

If the round-trip check fails on `pg_default_acl`, `DROP OWNED BY` left the default-privilege entry behind. Add this line above `DROP OWNED BY app_user;` in the down section and rerun:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user;
```

- [ ] **Step 9: Hand over the commit command**

```bash
git add package.json package-lock.json apps/api .env.example scripts docs/design
git commit -m "feat(db): migration tooling, check harness and core tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 2 (families, children, intake requests)

**Files:**
- Create: `scripts/checks/intake.mjs`, `apps/api/migrations/1758240000002_families-children-intake.sql`
- Modify: `scripts/check-migrations.mjs`

**Interfaces:**
- Consumes from Task 1: `fx.familyUser`, `fx.selfPay`, `fx.zip`, plus the harness functions `insert`, `expectFail`, `uniqueEmail`.
- Produces: `intakeChecks(ctx)`, and fixtures `fx.familyUser2`, `fx.family`, `fx.family2`, `fx.child`, `fx.child2`, `fx.intake`, `fx.intake2`.

- [ ] **Step 1: Write the failing checks**

Create `scripts/checks/intake.mjs`:

```js
import assert from 'node:assert/strict';
import { expectFail, insert, uniqueEmail } from '../lib/harness.mjs';

const enc = (text) => Buffer.from(text);

async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

export async function intakeChecks({ t, owner, fx }) {
  const familyRow = (user_id, overrides) => ({
    user_id,
    guardian_name_enc: enc('guardian'),
    phone_enc: enc('555-0100'),
    zip: '75201',
    ...overrides,
  });
  const childRow = (family_id) => ({
    family_id,
    name_enc: enc('child'),
    birth_month_enc: enc('2022-03'),
  });
  const intakeRow = (family, child, overrides) => ({
    family_id: family.id,
    child_id: child.id,
    payer_id: fx.selfPay.id,
    discipline: 'speech',
    child_age_months: 40,
    max_distance_km: 25,
    ...overrides,
  });

  await t('families: one per login, zip must be seeded (check 13)', async () => {
    fx.family = await insert(owner, 'families', familyRow(fx.familyUser.id));
    await expectFail(owner, '23505', () =>
      insert(owner, 'families', familyRow(fx.familyUser.id)),
    );
    fx.familyUser2 = await insert(owner, 'users', {
      email: uniqueEmail(),
      password_hash: 'x',
      role: 'family',
    });
    await expectFail(owner, '23503', () =>
      insert(owner, 'families', familyRow(fx.familyUser2.id, { zip: '99999' })),
    );
    fx.family2 = await insert(owner, 'families', familyRow(fx.familyUser2.id));
  });

  await t('children: identity is encrypted, no plaintext age or date of birth', async () => {
    fx.child = await insert(owner, 'children', childRow(fx.family.id));
    fx.child2 = await insert(owner, 'children', childRow(fx.family2.id));
    assert.ok(Buffer.isBuffer(fx.child.name_enc));
    const columns = await columnsOf(owner, 'children');
    for (const banned of ['name', 'dob', 'birth_month', 'age', 'date_of_birth']) {
      assert.ok(!columns.includes(banned), `children must not have a plaintext ${banned} column`);
    }
  });

  await t('intake_requests: defaults and constraints', async () => {
    fx.intake = await insert(owner, 'intake_requests', intakeRow(fx.family, fx.child));
    assert.equal(fx.intake.language, 'en');
    assert.deepEqual(fx.intake.preferred_windows, []);
    assert.equal(fx.intake.status, 'submitted');
    fx.intake2 = await insert(
      owner,
      'intake_requests',
      intakeRow(fx.family2, fx.child2, {
        preferred_windows: JSON.stringify([{ day: 1, start: '09:00', end: '12:00' }]),
      }),
    );
    await expectFail(owner, '23502', () =>
      insert(owner, 'intake_requests', intakeRow(fx.family, fx.child, { payer_id: null })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'intake_requests', intakeRow(fx.family, fx.child, { child_age_months: -1 })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'intake_requests', intakeRow(fx.family, fx.child, { max_distance_km: 0 })),
    );
    await expectFail(owner, '23514', () =>
      insert(
        owner,
        'intake_requests',
        intakeRow(fx.family, fx.child, { preferred_windows: JSON.stringify({}) }),
      ),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'intake_requests', intakeRow(fx.family, fx.child, { status: 'pending' })),
    );
  });

  await t("intake_requests: another family's child is rejected (check 12)", async () => {
    await expectFail(owner, '23503', () =>
      insert(owner, 'intake_requests', intakeRow(fx.family, fx.child2)),
    );
  });

  await t('intake_requests: has no clinic, urgency, notes or age band', async () => {
    const columns = await columnsOf(owner, 'intake_requests');
    for (const banned of ['clinic_id', 'urgency', 'urgency_level', 'notes_enc', 'age_band']) {
      assert.ok(!columns.includes(banned), `intake_requests must not have ${banned}`);
    }
  });
}
```

In `scripts/check-migrations.mjs`, add the import below the `coreChecks` import:

```js
import { intakeChecks } from './checks/intake.mjs';
```

and in `runChecks`, add the call after `await coreChecks(ctx);`:

```js
    await intakeChecks(ctx);
```

- [ ] **Step 2: Run the checks and watch them fail**

Run: `npm run check:migrations`
Expected: the five intake checks show `FAIL` with `relation "families" does not exist` or a similar error, and the summary is below 18/18.

- [ ] **Step 3: Write migration 2**

Create `apps/api/migrations/1758240000002_families-children-intake.sql`:

```sql
-- Up Migration

CREATE TABLE families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users (id),
  guardian_name_enc bytea NOT NULL,
  phone_enc bytea NOT NULL,
  zip text NOT NULL REFERENCES zip_centroids (zip),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  name_enc bytea NOT NULL,
  birth_month_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id)
);

CREATE INDEX children_family_id_idx ON children (family_id);

CREATE TABLE intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  child_id uuid NOT NULL,
  payer_id uuid NOT NULL REFERENCES payers (id),
  discipline text NOT NULL,
  child_age_months integer NOT NULL CHECK (child_age_months >= 0),
  language text NOT NULL DEFAULT 'en',
  preferred_windows jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(preferred_windows) = 'array'),
  max_distance_km integer NOT NULL CHECK (max_distance_km > 0),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'waitlisted', 'withdrawn', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (child_id, family_id) REFERENCES children (id, family_id)
);

CREATE INDEX intake_requests_family_id_idx ON intake_requests (family_id);
CREATE INDEX intake_requests_status_idx ON intake_requests (status);

-- Down Migration

DROP TABLE intake_requests;
DROP TABLE children;
DROP TABLE families;
```

- [ ] **Step 4: Run the checks and watch them pass**

Run: `npm run check:migrations`
Expected: 18/18 checks passed, exit code 0.

- [ ] **Step 5: Hand over the commit command**

```bash
git add scripts apps/api/migrations
git commit -m "feat(db): families, children and intake requests

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 3 (scoring config, waitlist, offers, bookings)

**Files:**
- Create: `scripts/checks/offers-bookings.mjs`, `apps/api/migrations/1758240000003_scoring-config-waitlist-offers-bookings.sql`
- Modify: `scripts/check-migrations.mjs`

**Interfaces:**
- Consumes: `fx.clinic`, `fx.clinic2`, `fx.slot`, `fx.slot2`, `fx.intake`, `fx.intake2` from earlier tasks, plus `insert` and `expectFail`.
- Produces: `offersBookingsChecks(ctx)`, and fixtures `fx.config`, `fx.entry`, `fx.entry2`, `fx.offer`, `fx.declined`, `fx.booking`.

- [ ] **Step 1: Write the failing checks**

Create `scripts/checks/offers-bookings.mjs`:

```js
import assert from 'node:assert/strict';
import { expectFail, insert } from '../lib/harness.mjs';

const MONDAY = '2026-09-21';
const NEXT_MONDAY = '2026-09-28';
const TUESDAY = '2026-09-22';

export async function offersBookingsChecks({ t, owner, fx }) {
  const weights = JSON.stringify({
    fit: { availability_overlap: 40 },
    priority: { reoffer_boost: 10 },
  });
  const configRow = (overrides) => ({
    clinic_id: fx.clinic.id,
    version: 1,
    weights,
    is_active: true,
    ...overrides,
  });
  const entryRow = (intake, overrides) => ({
    clinic_id: fx.clinic.id,
    intake_request_id: intake.id,
    ...overrides,
  });
  const offerRow = (entry, slot, week, overrides) => ({
    clinic_id: fx.clinic.id,
    slot_id: slot.id,
    week_start: week,
    waitlist_entry_id: entry.id,
    scoring_config_id: fx.config.id,
    fit_score: 72.5,
    priority_score: 31,
    score_breakdown: JSON.stringify({ fit: {}, priority: {} }),
    expires_at: '2030-01-01T00:00:00Z',
    ...overrides,
  });
  const bookingRow = (offer, week, overrides) => ({
    clinic_id: offer.clinic_id,
    slot_id: offer.slot_id,
    week_start: week,
    waitlist_entry_id: offer.waitlist_entry_id,
    offer_id: offer.id,
    ...overrides,
  });

  await t('scoring_config: versioned, one active version per clinic', async () => {
    fx.config = await insert(owner, 'scoring_config', configRow());
    await insert(owner, 'scoring_config', configRow({ version: 2, is_active: false }));
    await expectFail(owner, '23505', () => insert(owner, 'scoring_config', configRow()));
    await expectFail(owner, '23505', () =>
      insert(owner, 'scoring_config', configRow({ version: 3 })),
    );
    await expectFail(owner, '23514', () =>
      insert(
        owner,
        'scoring_config',
        configRow({ version: 4, is_active: false, weights: JSON.stringify([]) }),
      ),
    );
  });

  await t('waitlist_entries: defaults, urgency range, one live entry per request', async () => {
    fx.entry = await insert(owner, 'waitlist_entries', entryRow(fx.intake));
    assert.equal(fx.entry.urgency_level, 0);
    assert.equal(fx.entry.reoffer_boost, false);
    assert.equal(fx.entry.status, 'active');
    assert.equal(fx.entry.priority_score, null);
    fx.entry2 = await insert(owner, 'waitlist_entries', entryRow(fx.intake2));
    await expectFail(owner, '23505', () =>
      insert(owner, 'waitlist_entries', entryRow(fx.intake)),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'waitlist_entries', entryRow(fx.intake, { urgency_level: 4 })),
    );
  });

  await t('offers: one active offer per slot and week (checks 3 and 8)', async () => {
    fx.offer = await insert(owner, 'offers', offerRow(fx.entry, fx.slot, MONDAY));
    assert.equal(fx.offer.status, 'proposed');
    // Another live offer for the same slot and week is rejected.
    await expectFail(owner, '23505', () =>
      insert(owner, 'offers', offerRow(fx.entry2, fx.slot, MONDAY)),
    );
    // A declined offer for the same slot and week sits alongside the live one.
    fx.declined = await insert(
      owner,
      'offers',
      offerRow(fx.entry2, fx.slot, MONDAY, { status: 'declined' }),
    );
    // The same slot in another week is a different slot-week.
    await insert(owner, 'offers', offerRow(fx.entry2, fx.slot, NEXT_MONDAY));
    // One entry never holds two proposed offers.
    await expectFail(owner, '23505', () =>
      insert(owner, 'offers', offerRow(fx.entry, fx.slot2, MONDAY)),
    );
  });

  await t('offers: week_start must be a Monday and status is constrained (check 5)', async () => {
    await expectFail(owner, '23514', () =>
      insert(owner, 'offers', offerRow(fx.entry2, fx.slot2, TUESDAY, { status: 'declined' })),
    );
    await expectFail(owner, '23514', () =>
      insert(owner, 'offers', offerRow(fx.entry2, fx.slot2, NEXT_MONDAY, { status: 'bogus' })),
    );
  });

  await t('bookings: must agree with their offer (check 11)', async () => {
    await owner.query(`UPDATE offers SET status = 'accepted' WHERE id = $1`, [fx.offer.id]);
    await expectFail(owner, '23503', () =>
      insert(owner, 'bookings', bookingRow(fx.offer, MONDAY, { slot_id: fx.slot2.id })),
    );
    await expectFail(owner, '23503', () =>
      insert(owner, 'bookings', bookingRow(fx.offer, MONDAY, { week_start: NEXT_MONDAY })),
    );
    await expectFail(owner, '23503', () =>
      insert(owner, 'bookings', bookingRow(fx.offer, MONDAY, { waitlist_entry_id: fx.entry2.id })),
    );
    await expectFail(owner, '23503', () =>
      insert(owner, 'bookings', bookingRow(fx.offer, MONDAY, { clinic_id: fx.clinic2.id })),
    );
    fx.booking = await insert(owner, 'bookings', bookingRow(fx.offer, MONDAY));
    const { rows } = await owner.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'status'`,
    );
    assert.equal(rows.length, 0, 'bookings must not have a status column');
  });

  await t('bookings: one per slot and week, one per entry (check 4)', async () => {
    // entry2's declined offer is for the booked slot and week, and agrees with itself.
    await expectFail(owner, '23505', () =>
      insert(owner, 'bookings', bookingRow(fx.declined, MONDAY)),
    );
    // entry already has a booking, so a second one for it in another slot is rejected.
    const another = await insert(
      owner,
      'offers',
      offerRow(fx.entry, fx.slot2, NEXT_MONDAY, { status: 'declined' }),
    );
    await expectFail(owner, '23505', () =>
      insert(owner, 'bookings', bookingRow(another, NEXT_MONDAY)),
    );
  });

  await t('waitlist_entries: removing an entry lets its request join again', async () => {
    await owner.query(`UPDATE waitlist_entries SET status = 'removed' WHERE id = $1`, [
      fx.entry2.id,
    ]);
    await insert(owner, 'waitlist_entries', entryRow(fx.intake2));
  });
}
```

In `scripts/check-migrations.mjs`, add the import and the call:

```js
import { offersBookingsChecks } from './checks/offers-bookings.mjs';
```

```js
    await offersBookingsChecks(ctx);
```

(after `await intakeChecks(ctx);`)

- [ ] **Step 2: Run the checks and watch them fail**

Run: `npm run check:migrations`
Expected: the seven new checks show `FAIL` with `relation "scoring_config" does not exist` or `relation "waitlist_entries" does not exist`. The summary is below 25/25.

- [ ] **Step 3: Write migration 3**

Create `apps/api/migrations/1758240000003_scoring-config-waitlist-offers-bookings.sql`:

```sql
-- Up Migration

CREATE TABLE scoring_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  version integer NOT NULL CHECK (version > 0),
  weights jsonb NOT NULL CHECK (jsonb_typeof(weights) = 'object'),
  is_active boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, version)
);

CREATE UNIQUE INDEX scoring_config_one_active_per_clinic
  ON scoring_config (clinic_id) WHERE is_active;

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  intake_request_id uuid NOT NULL REFERENCES intake_requests (id),
  urgency_level smallint NOT NULL DEFAULT 0 CHECK (urgency_level BETWEEN 0 AND 3),
  joined_at timestamptz NOT NULL DEFAULT now(),
  priority_score numeric,
  score_breakdown jsonb,
  scored_at timestamptz,
  reoffer_boost boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'offered', 'booked', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX waitlist_entries_live_request_key
  ON waitlist_entries (clinic_id, intake_request_id) WHERE status <> 'removed';
CREATE INDEX waitlist_entries_queue_idx ON waitlist_entries (clinic_id, status, joined_at);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  slot_id uuid NOT NULL REFERENCES availability_slots (id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  waitlist_entry_id uuid NOT NULL REFERENCES waitlist_entries (id),
  scoring_config_id uuid NOT NULL REFERENCES scoring_config (id),
  fit_score numeric NOT NULL,
  priority_score numeric NOT NULL,
  score_breakdown jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'declined', 'expired', 'withdrawn')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, clinic_id, slot_id, week_start, waitlist_entry_id)
);

CREATE UNIQUE INDEX one_active_offer_per_slot
  ON offers (slot_id, week_start) WHERE status IN ('proposed', 'accepted');
CREATE UNIQUE INDEX one_proposed_offer_per_entry
  ON offers (waitlist_entry_id) WHERE status = 'proposed';
CREATE INDEX offers_expiry_idx ON offers (status, expires_at);
CREATE INDEX offers_waitlist_entry_id_idx ON offers (waitlist_entry_id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  waitlist_entry_id uuid NOT NULL,
  offer_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_slot_week_key UNIQUE (slot_id, week_start),
  CONSTRAINT bookings_waitlist_entry_key UNIQUE (waitlist_entry_id),
  CONSTRAINT bookings_match_offer
    FOREIGN KEY (offer_id, clinic_id, slot_id, week_start, waitlist_entry_id)
    REFERENCES offers (id, clinic_id, slot_id, week_start, waitlist_entry_id)
);

-- Down Migration

DROP TABLE bookings;
DROP TABLE offers;
DROP TABLE waitlist_entries;
DROP TABLE scoring_config;
```

- [ ] **Step 4: Run the checks and watch them pass**

Run: `npm run check:migrations`
Expected: 25/25 checks passed, exit code 0.

- [ ] **Step 5: Hand over the commit command**

```bash
git add scripts apps/api/migrations docs/design
git commit -m "feat(db): scoring config, waitlist, offers and bookings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Migration 4 (audit log and the REVOKE)

**Files:**
- Create: `scripts/checks/audit.mjs`, `apps/api/migrations/1758240000004_audit-log.sql`
- Modify: `scripts/check-migrations.mjs`

**Interfaces:**
- Consumes: `ctx.owner`, `ctx.app`, `insert`, `expectFail`.
- Produces: `auditChecks(ctx)`.

- [ ] **Step 1: Write the failing checks**

Create `scripts/checks/audit.mjs`:

```js
import assert from 'node:assert/strict';
import { expectFail, insert } from '../lib/harness.mjs';

export async function auditChecks({ t, owner, app }) {
  const auditRow = (overrides) => ({
    actor_type: 'system',
    action: 'check.ran',
    entity_type: 'check',
    ...overrides,
  });

  await t('audit_log: app_user can insert and read, ids increase (check 2)', async () => {
    const first = await insert(app, 'audit_log', auditRow());
    const second = await insert(app, 'audit_log', auditRow({ ip: '10.0.0.1' }));
    assert.ok(BigInt(second.id) > BigInt(first.id));
    assert.deepEqual(first.metadata, {});
    const { rows } = await app.query('SELECT count(*)::int AS n FROM audit_log');
    assert.equal(rows[0].n, 2);
  });

  await t('audit_log: app_user cannot update, delete or truncate (checks 2 and 6)', async () => {
    await expectFail(app, '42501', () => app.query(`UPDATE audit_log SET action = 'tampered'`));
    await expectFail(app, '42501', () => app.query('DELETE FROM audit_log'));
    await expectFail(app, '42501', () => app.query('TRUNCATE audit_log'));
    const { rows } = await owner.query(
      `SELECT has_table_privilege('app_user', 'audit_log', 'INSERT') AS i,
              has_table_privilege('app_user', 'audit_log', 'UPDATE') AS u,
              has_table_privilege('app_user', 'audit_log', 'DELETE') AS d,
              has_table_privilege('app_user', 'audit_log', 'TRUNCATE') AS tr`,
    );
    assert.deepEqual(rows[0], { i: true, u: false, d: false, tr: false });
  });

  await t('audit_log: has no foreign keys and constrains actor_type', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM pg_constraint
       WHERE contype = 'f'
         AND (conrelid = 'audit_log'::regclass OR confrelid = 'audit_log'::regclass)`,
    );
    assert.equal(rows[0].n, 0);
    await expectFail(owner, '23514', () =>
      insert(owner, 'audit_log', auditRow({ actor_type: 'robot' })),
    );
  });
}
```

In `scripts/check-migrations.mjs`, add the import and the call:

```js
import { auditChecks } from './checks/audit.mjs';
```

```js
    await auditChecks(ctx);
```

(after `await offersBookingsChecks(ctx);`)

- [ ] **Step 2: Run the checks and watch them fail**

Run: `npm run check:migrations`
Expected: the three audit checks show `FAIL` with `relation "audit_log" does not exist`. The summary is below 28/28.

- [ ] **Step 3: Write migration 4**

Create `apps/api/migrations/1758240000004_audit-log.sql`:

```sql
-- Up Migration

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id uuid,
  actor_user_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, id);
CREATE INDEX audit_log_clinic_idx ON audit_log (clinic_id, id);

REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- Down Migration

DROP TABLE audit_log;
```

- [ ] **Step 4: Run the checks and watch them pass**

Run: `npm run check:migrations`
Expected: 28/28 checks passed, exit code 0.

- [ ] **Step 5: Hand over the commit command**

```bash
git add scripts apps/api/migrations
git commit -m "feat(db): append-only audit log with revoked UPDATE and DELETE

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Checkpoint on the dev database, README, spec status

**Files:**
- Modify: `README.md`, `docs/design/schema-migrations.md`
- Create (git-ignored): `.env`

**Interfaces:**
- Consumes: everything above.
- Produces: the Phase 1 checkpoint result.

- [ ] **Step 1: Create the local `.env`**

Run: `cp -n .env.example .env`
Expected: `.env` exists. It is git-ignored. `ENC_KEY` and `JWT_SECRET` can stay blank for now, because migrations don't read them.

- [ ] **Step 2: Run the checkpoint on the dev database**

Run these in order and confirm each result:

```bash
npm run migrate:up
npm run migrate:down
npm run migrate:up
```

Expected: the first prints the four migrations as migrated and ends with `Migrations complete!`. The second reverts all four. The third applies all four again. The dev database `waitlist` is left migrated.

- [ ] **Step 3: Run the full check script one last time**

Run: `npm run check:migrations`
Expected: 28/28 checks passed, exit code 0, and the two throwaway databases are gone (`docker compose exec -T postgres psql -U waitlist -c "\l"` lists no `waitlist_migrate_*`).

- [ ] **Step 4: Document the commands**

Append to `README.md`:

```markdown

## Database

Requires Docker. Copy `.env.example` to `.env`, then:

```bash
npm run db:up            # Postgres 16 and Redis 7
npm run migrate:up       # apply all migrations as the owner role
npm run migrate:down     # revert all migrations
npm run check:migrations # up/down/up on throwaway databases, plus every constraint check
```

The API connects as `app_user`, which cannot update, delete or truncate `audit_log`.
Design: [docs/design/schema-migrations.md](docs/design/schema-migrations.md).
```

In `docs/design/schema-migrations.md`, change the line `Phase 1. Status: design approved, migrations not yet written.` to `Phase 1. Status: implemented and verified by npm run check:migrations.`

- [ ] **Step 5: Hand over the commit command**

```bash
git add README.md docs/design
git commit -m "docs: document migration commands and mark Phase 1 implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage.** Verification checks 1–13 from spec section 10 map to tasks as follows:

| Check | Where |
|-------|-------|
| 1 (up/down/up) and 10 (dump equality) | Task 1, `check-migrations.mjs` |
| 7 (grants held in a second database) | Task 1, `OTHER` database |
| 2, 6 (`app_user` privileges on `audit_log`) | Task 4 |
| 3, 8 (one live offer per slot-week and per entry) | Task 3 |
| 4 (second booking for a slot-week) | Task 3 |
| 5 (Monday and capacity checks) | Tasks 1 and 3 |
| 9 (role and clinic check) | Task 1 |
| 11 (booking disagrees with offer) | Task 3 |
| 12 (another family's child) | Task 2 |
| 13 (unseeded zip) | Tasks 1 and 2 |

Section 5 requirements each have a task: the `zip_centroids` `CHECK`, `UNIQUE (id, family_id)`, the `UNIQUE` target on `offers` for the booking foreign key, and `NOT NULL` on all five booking key columns.

**Spec change made while planning.** `scoring_config` moved from migration 4 to migration 3, because `offers.scoring_config_id` references it. The spec was updated to match.

**Not covered by SQL, as intended.** The API-enforced rules in spec section 9, and the `40P01` deadlock assertion, belong to the API and load-test phases.
