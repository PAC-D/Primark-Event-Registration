import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORPHAN_PHOTO_MAX_AGE_MS, PHOTO_SWEEP_INTERVAL_MS, selectOrphanPhotos, sweepOrphanPhotos,
} from '../../src/services/photo-cleanup.js';
import { fakeDb } from '../helpers/fake-db.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T12:00:00Z');

const object = (name, hoursOld) => ({
  name,
  created_at: new Date(NOW - hoursOld * HOUR).toISOString(),
});

test('the sweeper constants are two hours and fifteen minutes', () => {
  assert.equal(ORPHAN_PHOTO_MAX_AGE_MS, 2 * HOUR);
  assert.equal(PHOTO_SWEEP_INTERVAL_MS, 15 * 60 * 1000);
});

test('selectOrphanPhotos deletes only unreferenced photos that are at least 2 hours old', () => {
  const objects = [
    object('kept-old.jpg', 5),       // old but referenced
    object('kept-young.jpg', 0.5),   // unreferenced but fresh
    object('gone.jpg', 2),           // unreferenced and exactly 2 hours old
    object('gone2.png', 3),          // unreferenced and older
    { name: 'no-timestamp.jpg' },    // unparsable created_at: kept on the safe side
    null,
  ];
  assert.deepEqual(selectOrphanPhotos(objects, ['kept-old.jpg'], NOW), ['gone.jpg', 'gone2.png']);
});

function sweeperDb({ objects, attendees }) {
  const db = fakeDb({ tables: { attendees: { data: attendees, error: null } } });
  db.storage = {
    from: (bucket) => ({
      list: (_prefix, { limit }) => Promise.resolve({ data: objects.slice(0, limit), error: null }),
      remove: (paths) => {
        db.calls.push({ storage: bucket, op: 'remove', paths });
        return Promise.resolve({ data: [], error: null });
      },
    }),
  };
  return db;
}

test('sweepOrphanPhotos scans the bucket and removes only the aged orphans', async () => {
  const db = sweeperDb({
    objects: [object('registered.jpg', 6), object('abandoned.jpg', 6), object('fresh.jpg', 0.1)],
    attendees: [{ photo_path: 'registered.jpg' }],
  });
  const result = await sweepOrphanPhotos(db, { now: NOW });
  assert.deepEqual(result, { scanned: 3, deleted: 1 });
  assert.deepEqual(db.calls.find((c) => c.op === 'remove').paths, ['abandoned.jpg']);
});

test('sweepOrphanPhotos does nothing when there is nothing to remove', async () => {
  const db = sweeperDb({ objects: [object('fresh.jpg', 0.5)], attendees: [] });
  assert.deepEqual(await sweepOrphanPhotos(db, { now: NOW }), { scanned: 1, deleted: 0 });
  assert.equal(db.calls.some((c) => c.op === 'remove'), false);
});

test('sweepOrphanPhotos paginates through the bucket listing', async () => {
  const db = fakeDb({ tables: { attendees: { data: [], error: null } } });
  let pages = 0;
  db.storage = {
    from: () => ({
      list: (_prefix, { limit, offset }) => {
        pages += 1;
        // page 1: full page of fresh photos; page 2: empty
        const data = offset === 0 ? Array.from({ length: limit }, (_, i) => object(`p1-${i}.jpg`, 0.1)) : [];
        return Promise.resolve({ data, error: null });
      },
      remove: (paths) => Promise.resolve({ data: [], error: null }),
    }),
  };
  const result = await sweepOrphanPhotos(db, { now: NOW });
  assert.equal(pages, 2);
  assert.deepEqual(result, { scanned: 1000, deleted: 0 });
});

test('storage errors propagate to the caller (the scheduled tick logs them)', async () => {
  const db = fakeDb();
  db.storage = { from: () => ({ list: () => Promise.resolve({ data: null, error: new Error('bucket missing') }) }) };
  await assert.rejects(sweepOrphanPhotos(db), /bucket missing/);
});
