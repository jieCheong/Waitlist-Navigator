import assert from 'node:assert/strict';
import { expectFail, insert, uniqueEmail } from '../lib/harness.mjs';

const enc = (text) => Buffer.from(text);

async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  // A missing table has no columns, which would make every "column is absent" assertion pass.
  assert.ok(rows.length > 0, `table ${table} does not exist`);
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
