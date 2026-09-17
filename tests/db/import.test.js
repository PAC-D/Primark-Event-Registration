import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { importOrganisations } from '../../src/services/import.js';
import { findOrgs, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('importOrganisations against the test database', { skip: skipReason }, () => {
  let db;
  before(() => { db = testDb(); });
  beforeEach(() => wipe(db));

  test('inserts list organisations once and is safe to re-run', async () => {
    const orgs = [
      { kind: 'supplier', name: 'PADMA TEXTILES LTD' },
      { kind: 'factory', name: 'Aspire Garments Ltd PJT (24040)' },
      { kind: 'supplier', name: 'Padma Textiles Limited' },
    ];
    assert.deepEqual(await importOrganisations(db, orgs), { read: 3, inserted: 2 });
    assert.deepEqual(await importOrganisations(db, orgs), { read: 3, inserted: 0 });
    const rows = await findOrgs(db, { source: 'list' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'approved'));
  });

  test('leaves an existing pending organisation with the same key untouched', async () => {
    await seedOrgs(db, { rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' } });
    assert.deepEqual(await importOrganisations(db, [{ kind: 'factory', name: 'RAINBOW KNIT LIMITED' }]), { read: 1, inserted: 0 });
    const [row] = await findOrgs(db, { match_key: 'rainbow knit' });
    assert.equal(row.status, 'pending');
    assert.equal(row.name, 'Rainbow Knit Ltd');
  });
});
