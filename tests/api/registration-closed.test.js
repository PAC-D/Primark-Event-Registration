import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const closedApp = () => createApp({ db: fakeDb(), config: { ...testConfig, registrationClosed: true } });

test('registration closed serves the closed page instead of the form', async () => {
  for (const path of ['/', '/index.html']) {
    const res = await request(closedApp()).get(path);
    assert.equal(res.status, 200, `${path} should answer 200`);
    assert.match(res.text, /Registration closed/i, `${path} should show the closed page`);
  }
});

test('registration closed rejects new signups with a stable error', async () => {
  const res = await request(closedApp()).post('/api/register').send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'REGISTRATION_CLOSED');
  assert.match(res.body.message, /closed/i);
});
