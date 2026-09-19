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
