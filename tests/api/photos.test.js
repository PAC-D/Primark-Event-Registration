import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(100)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(100)]);
const UPLOADED = [];

function appWithStorage() {
  const db = fakeDb();
  db.storage = {
    from: (bucket) => ({
      upload: (path, body, opts) => {
        UPLOADED.push({ bucket, path, size: body.length, contentType: opts.contentType });
        return Promise.resolve({ data: { path }, error: null });
      },
    }),
  };
  return createApp({ db, config: testConfig, loginDelayMs: 0 });
}

test('accepts a PNG under 1 MB and stores it in the private bucket', async () => {
  UPLOADED.length = 0;
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/png')
    .send(PNG);
  assert.equal(res.status, 201);
  assert.match(res.body.path, /\.png$/);
  assert.equal(UPLOADED.length, 1);
  assert.equal(UPLOADED[0].bucket, 'attendee-photos');
  assert.equal(UPLOADED[0].contentType, 'image/png');
});

test('rejects a content type outside JPEG/PNG', async () => {
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/gif')
    .send(Buffer.from([0x47, 0x49, 0x46, 0x38]));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('rejects a spoofed content type (JSON bytes labelled image/png)', async () => {
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/png')
    .send(Buffer.from('{"not":"an image"}'));
  assert.equal(res.status, 400);
  assert.equal(res.body.fields.photo.length > 0, true);
});

test('rejects a labelled-JPEG whose bytes are PNG (content type must match magic bytes)', async () => {
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/jpeg')
    .send(PNG);
  assert.equal(res.status, 400);
});

test('rejects a file over 1 MB even with valid magic bytes', async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]);
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/jpeg')
    .send(big);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('storage failures map to DB_UNAVAILABLE, not a crash', async () => {
  const db = fakeDb();
  db.storage = { from: () => ({ upload: () => Promise.resolve({ data: null, error: new Error('boom') }) }) };
  const res = await request(createApp({ db, config: testConfig, loginDelayMs: 0 }))
    .post('/api/photos')
    .set('Content-Type', 'image/png')
    .send(PNG);
  assert.equal(res.status, 503);
});

test('JPEG uploads land with a .jpg path', async () => {
  UPLOADED.length = 0;
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/jpeg')
    .send(JPEG);
  assert.equal(res.status, 201);
  assert.match(res.body.path, /\.jpg$/);
});
