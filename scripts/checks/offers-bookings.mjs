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
    await expectFail(owner, '23505', () =>
      insert(owner, 'scoring_config', configRow({ is_active: false })),
    );
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
