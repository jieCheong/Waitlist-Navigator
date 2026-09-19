# Schema and migrations design

Phase 1. Status: design approved, migrations not yet written.

## 1. Goals and non-goals

**Goals**

- A Postgres schema that makes the dangerous states unrepresentable: double-booked slots, two live offers for one child, and edits to the audit trail by the application.
- Encrypted-at-rest identifying fields, with just enough plaintext derived data for matching to run in SQL.
- Migrations that run `up`, `down`, `up` cleanly on a fresh database, verified by a script rather than by reading the SQL.

**Non-goals (MVP)**

- No ORM. The design depends on explicit `SELECT … FOR UPDATE`, partial unique indexes and revoked grants.
- No recurring booking series and no group sessions (see section 11).
- No free-text clinical notes, which keeps the data-minimisation claim honest.

## 2. Tooling

- `node-pg-migrate` and `pg` in `apps/api`. Migrations are raw `.sql` files in `apps/api/migrations/` using `-- Up Migration` / `-- Down Migration` markers.
- Root scripts `npm run migrate:up` and `npm run migrate:down`. `migrate:down` reverts every migration.
- `.env.example` gains `DATABASE_URL_MIGRATE` (owner role, `waitlist`). `DATABASE_URL` points at `app_user`.

| # | File | Contents |
|---|------|----------|
| 1 | `core-tables` | roles, `zip_centroids`, `clinics`, `payers`, `users`, `refresh_tokens`, `clinicians`, `clinician_payers`, `availability_slots` |
| 2 | `families-children-intake` | `families`, `children`, `intake_requests` |
| 3 | `waitlist-offers-bookings` | `waitlist_entries`, `offers`, `bookings` |
| 4 | `scoring-config-audit-log` | `scoring_config`, `audit_log`, the `REVOKE` |

## 3. Roles and privileges

Two roles. The migration runner connects as the owner role. The API connects as `app_user` only.

- Migration 1 creates `app_user` idempotently (`DO $$ … IF NOT EXISTS … CREATE ROLE app_user LOGIN PASSWORD …`). The password in the migration is a dev value. Production sets the real one with `ALTER ROLE`.
- Migration 1 sets `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user`, plus `GRANT USAGE ON SCHEMA public`. `TRUNCATE` is never granted.
- Migration 4 runs `REVOKE UPDATE, DELETE ON audit_log FROM app_user;`. Because of the default privileges above, this revokes something real.
- **Roles are cluster-wide, so the down migration never drops the role.** Migration 1's down runs only `DROP OWNED BY app_user`, which revokes its privileges in this database and leaves the role for any other database on the cluster. Verify at build time that this also clears the default-privilege entries.
- The migration runner's role must be allowed to run `DROP OWNED BY` and, for the verification script, `CREATEDB`. Locally the compose `waitlist` user is a superuser and has both.
- **Honest limit:** the owner role can still write to `audit_log`, and a superuser bypasses grants entirely. The guarantee is that the application's connection cannot alter the trail.

## 4. Conventions

- Primary keys are `uuid DEFAULT gen_random_uuid()`, with one exception: `audit_log` (section 6).
- `created_at timestamptz DEFAULT now()` on every table. Mutable tables also have `updated_at`, set by the application. There are no triggers.
- Status and role fields are `text` with `CHECK` constraints, not Postgres enums, so they are easy to change and to roll back.
- Encrypted columns are `bytea`, end in `_enc`, and hold AES-256-GCM ciphertext produced by the API using `ENC_KEY`.
- Multi-clinic: `clinic_id` is on tenant-owned tables. Slots reach it through `clinician_id`.
- Timezone: slot `start_time` is a wall-clock `time` in the owning clinic's `timezone` (IANA name).

## 5. Tables

### Migration 1: core tables

**`zip_centroids`**: `zip` (PK, `CHECK zip ~ '^\d{5}$'`), `lat`, `lng`. Schema only. Rows come from the seed script's zip loader, from a static file limited to the DFW zips in use (Census ZCTA gazetteer). Reference: `clinics.zip` and `families.zip` are foreign keys to it, so an unknown zip is rejected at write time.

**`clinics`**: `name`, `timezone`, `city`, `state`, `zip`.

**`payers`**: `name` (unique). The migration seeds one row named `Self-pay`, which makes every intake carry a payer.

**`users`**

- Columns: `email`, `password_hash`, `role`, `clinic_id` (nullable FK).
- `role` is one of `family`, `coordinator`, `clinician`, `admin`.
- `CHECK`: coordinator and clinician require `clinic_id`. Family and admin forbid it.
- Unique index on `lower(email)`.

**`refresh_tokens`**

- Columns: `user_id` (FK, cascade), `token_hash` (unique, SHA-256), `token_family_id`, `expires_at`, `revoked_at`.
- Rotation issues a new token in the same `token_family_id` and revokes the old one.
- Reuse detection: presenting an already-revoked token revokes every token in its `token_family_id`.
- `token_family_id` is named to avoid confusion with the `families` table.

**`clinicians`**

- Columns: `clinic_id`, `user_id`, `full_name`, `active`.
- Eligibility inputs: `disciplines text[]`, `languages text[]` (both non-empty), `age_min_months`, `age_max_months` (`CHECK age_max > age_min >= 0`), and `caseload_cap > 0`.
- `user_id` is nullable, with a partial unique index `WHERE user_id IS NOT NULL`, so one login maps to at most one clinician. Nullable is for seed and simulation convenience. Login-bearing clinicians reach `/clinicians/me/*`.

**`clinician_payers`**: primary key (`clinician_id`, `payer_id`). A clinician who accepts self-pay has a row for the Self-pay payer, so the insurance rule needs no special case.

**`availability_slots`**

- A weekly template, not a dated instance.
- Columns: `clinician_id`, `day_of_week` (1–7, ISO), `start_time`, `duration_minutes > 0`, `valid_from`, nullable `valid_to` (`CHECK valid_to >= valid_from`).
- `capacity smallint NOT NULL DEFAULT 1` with `CHECK (capacity = 1)`. See section 11.

### Migration 2: families, children, intake requests

**`families`**: `user_id` (unique), `guardian_name_enc`, `phone_enc`, `zip` (plaintext, because the distance filter runs on it).

**`children`**: `family_id`, `name_enc`, `birth_month_enc`. No full date of birth is stored. `UNIQUE (id, family_id)` supports the composite key below.

**`intake_requests`**

- Keys: `family_id`, `child_id`, `payer_id NOT NULL`. A composite foreign key (`child_id`, `family_id`) to `children(id, family_id)` guarantees the child belongs to the family.
- Eligibility inputs: `discipline`, `child_age_months >= 0` (snapshot at request time), `language text NOT NULL DEFAULT 'en'`.
- Preferences: `preferred_windows jsonb NOT NULL DEFAULT '[]'` (`CHECK` it is an array; the window shape is validated by a Zod schema in `@waitlist/shared`), `max_distance_km int NOT NULL CHECK (> 0)`.
- `status` is one of `submitted`, `waitlisted`, `withdrawn`, `closed`.
- No `clinic_id`: a request is matched across clinics, and the clinic belongs to the waitlist entry.
- No urgency and no notes column.
- Indexes: `family_id`, `status`.

### Migration 3: waitlist, offers, bookings

**`waitlist_entries`**

- Keys: `clinic_id`, `intake_request_id`.
- `urgency_level smallint NOT NULL DEFAULT 0 CHECK (0..3)`. Only coordinators set it (API rule, section 9).
- `joined_at`, the wait-time input.
- Score state (all nullable until first scoring): `priority_score numeric`, `score_breakdown jsonb`, `scored_at timestamptz`. `GET /waitlist/:id/explain` reads these.
- `reoffer_boost boolean NOT NULL DEFAULT false`. The worker sets it after a clinic-side cancellation, and it feeds the 10-point re-offer priority factor.
- `status`: `active`, `offered`, `booked`, `removed`.
- Partial unique index on (`clinic_id`, `intake_request_id`) `WHERE status <> 'removed'`. Index on (`clinic_id`, `status`, `joined_at`).

**`offers`**

- Keys: `clinic_id`, `slot_id`, `waitlist_entry_id`, `scoring_config_id`.
- `week_start date NOT NULL` with `CHECK (extract(isodow from week_start) = 1)`, so it is always a Monday.
- `fit_score`, `priority_score`, and `score_breakdown jsonb`: a snapshot, so every offer can be explained after the config changes. The two scores are different concepts and are stored separately.
- `expires_at`, `decided_at`.
- `status`: `proposed`, `accepted`, `declined`, `expired`, `withdrawn`.
- `one_active_offer_per_slot`: `UNIQUE (slot_id, week_start) WHERE status IN ('proposed','accepted')`.
- Partial unique on (`waitlist_entry_id`) `WHERE status = 'proposed'`, so one entry never holds two live offers.
- Index on (`status`, `expires_at`) for the expiry sweep.

**`bookings`**

- Keys: `clinic_id`, `slot_id`, `waitlist_entry_id`, `offer_id NOT NULL UNIQUE`.
- `week_start date NOT NULL`, same Monday `CHECK`.
- `UNIQUE (slot_id, week_start)`, unconditional.
- `UNIQUE (waitlist_entry_id)`. See section 11 for what this means.
- There is no status column. A cancellation deletes the row, writes an audit entry, and sets the offer to `withdrawn` in one transaction. A `cancelled` row would block the slot-week forever under an unconditional unique constraint, and the audit log keeps the history.

### Migration 4: scoring config and audit log

**`scoring_config`**

- Columns: `clinic_id NOT NULL`, `version`, `weights jsonb`, `is_active`, `created_by`.
- `weights` is an object with two required groups, `fit` and `priority`, validated by a Zod schema in `@waitlist/shared`. The database only checks that it is an object, because the factor list will change in Phase 4. Example values: availability overlap is worth 40 points, and the re-offer boost is worth 10.
- `UNIQUE (clinic_id, version)`, plus a partial unique index on (`clinic_id`) `WHERE is_active`.
- Configs are append-only in practice: a change is a new version, and offers point at the version that scored them.
- Every clinic gets a v1 row. Creating a clinic (API or seed) creates that row in the same transaction. `PUT /admin/scoring-config` takes a clinic.

**`audit_log`** (see section 6)

- Columns: `clinic_id` (nullable, since admin and auth events have none), `actor_user_id` (nullable), `actor_type` (`user` or `system`), `action`, `entity_type`, `entity_id`, `metadata jsonb`, `request_id`, `ip inet`.
- Indexes: (`entity_type`, `entity_id`, `id`) and (`clinic_id`, `id`).
- `REVOKE UPDATE, DELETE ON audit_log FROM app_user;`

## 6. The audit log

- **Append-only for the application.** `app_user` holds `SELECT` and `INSERT` only. Attempts to `UPDATE`, `DELETE` or `TRUNCATE` fail with SQLSTATE `42501`.
- **No foreign keys.** A cascading delete from `users` or `clinics` would execute with the owner's privileges and remove audit rows, bypassing the revoke. Audit rows should also outlive the things they describe.
- **Identity primary key.** `id` is `bigint GENERATED ALWAYS AS IDENTITY`, an exception to the UUID convention. Reasons: a strict insertion order for reading a trail, and cheap inserts. It is not tamper evidence, since rolled-back transactions consume identity values and gaps are normal. An identity column needs only `INSERT` on the table, so no sequence grant is required.
- `metadata` never holds plaintext PII. The API's audit helper enforces that.

## 7. Concurrency

- **The unique constraints are the correctness guarantee.** Two concurrent offers for the same slot-week, or two bookings for the same slot-week, cannot both commit. The loser gets `23505`, which the API maps to "slot taken".
- **`SELECT … FOR UPDATE` covers state transitions and the caseload check.** Accepting an offer locks the offer, then the clinician row (so the count of the clinician's bookings cannot change underneath), then the slot.
- **Fixed lock order: offer, then clinician, then slot.** Every code path that takes more than one of these locks takes them in that order (a path that needs only some of them still follows it), so concurrent accepts cannot deadlock. The load test asserts zero `40P01` (deadlock detected) errors.
- `clinic_id` is denormalised onto offers and bookings for scoping. That it matches the slot's clinic and the waitlist entry's clinic is checked inside the offer transaction (section 9).

## 8. PII handling

| Stored | Form |
|--------|------|
| Guardian name, phone, child name, child birth month | Encrypted `bytea` (`_enc`) |
| Child age | `intake_requests.child_age_months`, plaintext snapshot |
| Zip codes | Plaintext (coarse, needed for the distance filter) |
| Email, password | Plaintext email (needed for login), password hash only |
| Audit metadata | No PII |

Encrypted columns cannot be searched or sorted in SQL. Matching uses the plaintext derived columns above.

## 9. Rules the API enforces (with tests)

The database cannot see who is calling or compare across tables here, so each of these gets a test in the RBAC matrix:

- A coordinator's or clinician's `clinic_id` matches the clinic of the clinician they act on.
- Only coordinators set `urgency_level`.
- An offer's `clinic_id` matches its slot's clinic and its waitlist entry's clinic.
- A booking's `slot_id`, `week_start` and `waitlist_entry_id` equal those of the offer it was created from. Bookings are only created inside the accept transaction, which copies the values from the locked offer.
- Caseload: a clinician's caseload is the count of bookings whose `week_start >= the current Monday` (in the clinic's timezone), reached through the slot join, and it may not exceed `caseload_cap`.

## 10. Verification

`scripts/check-migrations.mjs` runs against a throwaway database on the compose Postgres and asserts:

1. `up`, `down`, `up` all succeed on a fresh database.
2. As `app_user`, `UPDATE` and `DELETE` on `audit_log` fail with `42501`, and `INSERT` succeeds.
3. Two `proposed` offers on the same (slot, week) fail with `23505`. A `declined` offer alongside a `proposed` one is allowed.
4. A second booking for the same (slot, week) fails with `23505`.
5. A non-Monday `week_start` fails its `CHECK`, and `capacity = 2` fails its `CHECK`.
6. As `app_user`, `TRUNCATE audit_log` fails with `42501`.
7. `up`, `down`, `up` succeeds while a second database on the same cluster still has `app_user` grants. This catches a `DROP ROLE` in the down migration.
8. Two `proposed` offers for one waitlist entry fail with `23505`.
9. The `users` role / `clinic_id` check rejects a family user with a clinic and a coordinator without one.
10. `pg_dump --schema-only` output after the second `up` is identical to the output after the first.

Deploy note: the deployed demo database needs `zip_centroids` populated, so the deploy step runs the seed script's zip loader.

## 11. Out of scope, and what I would build next

- **Recurring series.** A booking is a one-week appointment, so the MVP models the first appointment only. `UNIQUE (waitlist_entry_id)` on bookings reflects that. A recurring series would be a `booking_series` table with materialised weekly rows.
- **Group sessions.** `capacity` is pinned to 1 so the schema cannot claim something it cannot enforce. Supporting groups would replace the two unique constraints with a count check under `FOR UPDATE`, and would cost the one-line double-booking guarantee.
- **Coordinator notes**, in their own table with their own retention rules.
- **A database trigger** blocking `UPDATE` and `DELETE` on `audit_log` for every role except a superuser, closing the owner-role gap from section 3.
