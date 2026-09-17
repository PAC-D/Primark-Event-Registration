import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboard } from '../../src/services/dashboard.js';
import { check, other, payload, pick, register, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('loadDashboard against the test database', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
    });
  });

  test('loads participants with their organisations and separates pending ones', async () => {
    await check(register(db, payload({ orgs: [pick(o.padma, 'S-1'), pick(o.aspire, 'F-1'), other('factory', 'Rainbow Knit Ltd', 'R-1')] })));
    const d = await loadDashboard(db);
    assert.equal(d.summary.participants.total, 1);
    assert.deepEqual(d.participants[0].factories.map((f) => [f.name, f.code]), [
      ['Aspire Garments (24040)', 'F-1'],
      ['Rainbow Knit Ltd', 'R-1'],
    ]);
    assert.equal(d.organisations.length, 2);
    assert.equal(d.pending.length, 1);
    assert.equal(d.summary.factories.full, 0);
  });
});
