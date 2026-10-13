import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboard } from '../../src/services/dashboard.js';
import { check, payload, pick, register, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

const PHOTO = '123e4567-e89b-42d3-a456-426614174000.jpg';

describe('loadDashboard against the test database', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd', code: '83760' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)', code: '24040' },
      rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee', code: 'RNB' },
    });
  });

  test('loads participants with their organisations, per-kind limits and the new fields', async () => {
    await check(register(db, payload({ orgs: [pick(o.padma), pick(o.aspire)], photo_path: PHOTO })));
    const d = await loadDashboard(db);
    assert.equal(d.summary.participants.total, 1);
    const participant = d.participants[0];
    assert.equal(participant.designation, 'Test Officer');
    assert.equal(participant.photo_path, PHOTO);
    assert.equal(participant.organisation_name, null);
    assert.deepEqual(participant.factories.map((f) => [f.name, f.code]), [
      ['Aspire Garments (24040)', '24040'],
    ]);
    // A factory with one seat is full at the factory limit of 1.
    assert.equal(d.organisations.find((x) => x.id === o.aspire.id).reg_status, 'full');
    // A supplier with one linked (non-seat) person is still only "registered".
    assert.equal(d.organisations.find((x) => x.id === o.padma.id).reg_status, 'registered');
  });

  test('loads "other" participants with their organisation name and no links', async () => {
    await check(register(db, payload({ from: 'other', orgs: [], organisation_name: 'Primark Limited' })));
    const d = await loadDashboard(db);
    assert.equal(d.summary.participants.other, 1);
    const participant = d.participants[0];
    assert.equal(participant.from_type, 'other');
    assert.equal(participant.organisation_name, 'Primark Limited');
    assert.deepEqual(participant.suppliers, []);
    assert.deepEqual(participant.factories, []);
  });

  test('separates pending organisations and counts pending approvals', async () => {
    await check(register(db, payload({ email: 'a@example.com', orgs: [pick(o.aspire)] })));
    const p = await check(register(db, payload({ from: 'supplier', email: 'b@example.com', orgs: [pick(o.padma)] })));
    // An admin edit links the supplier-side person to the pending organisation (p_allow_pending).
    await check(db.rpc('update_attendee', { p_id: p, p: payload({ from: 'supplier', email: 'b@example.com', orgs: [pick(o.padma), pick(o.rainbow)] }) }));
    const d = await loadDashboard(db);
    assert.equal(d.pending.length, 1);
    assert.equal(d.pending[0].name, 'Rainbow Knit Ltd');
    assert.equal(d.summary.factories.full, 1);
  });
});
