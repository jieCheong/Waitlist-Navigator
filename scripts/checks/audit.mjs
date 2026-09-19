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
