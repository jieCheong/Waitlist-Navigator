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
import { intakeChecks } from './checks/intake.mjs';
import { offersBookingsChecks } from './checks/offers-bookings.mjs';
import { auditChecks } from './checks/audit.mjs';

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
    await intakeChecks(ctx);
    await offersBookingsChecks(ctx);
    await auditChecks(ctx);
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
