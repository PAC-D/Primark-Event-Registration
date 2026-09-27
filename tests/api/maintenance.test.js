import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const maintenanceApp = () => createApp({ db: fakeDb(), config: { ...testConfig, maintenanceMode: true } });
const normalApp = () => createApp({ db: fakeDb(), config: testConfig });

test('MAINTENANCE_MODE serves the maintenance page in place, without redirecting', async () => {
  for (const page of ['/', '/admin.html', '/primark-carton-nomination']) {
    const res = await request(maintenanceApp()).get(page);
    assert.equal(res.status, 503, `${page} should be 503 while under maintenance`);
    assert.equal(res.headers.location, undefined, `${page} must not redirect: behind a prefix-stripping proxy a Location header moves the browser to the wrong URL`);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Primark Carton Nomination Program/);
  }
});

test('MAINTENANCE_MODE leaves the maintenance page and its assets reachable', async () => {
  const app = maintenanceApp();
  for (const path of ['/maintenance', '/maintenance.html', '/brand/primark.png', '/favicon.ico']) {
    const res = await request(app).get(path);
    assert.notEqual(res.status, 302, `${path} must not redirect during maintenance`);
  }
});

test('MAINTENANCE_MODE returns a MAINTENANCE error for API calls', async () => {
  const res = await request(maintenanceApp()).get('/api/organisations');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'MAINTENANCE');
});

test('MAINTENANCE_MODE blocks registration posts with the same MAINTENANCE error', async () => {
  const res = await request(maintenanceApp()).post('/api/register').send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'MAINTENANCE');
});

test('pages and APIs work normally when maintenance mode is off', async () => {
  const page = await request(normalApp()).get('/');
  assert.equal(page.status, 200);
  const api = await request(normalApp()).get('/api/organisations');
  assert.equal(api.status, 200);
});
