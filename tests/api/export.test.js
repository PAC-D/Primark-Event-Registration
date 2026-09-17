import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { COOKIE_NAME, signSession } from '../../src/auth.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';
import { fixtureAttendees, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

test('GET /api/admin/export requires a session', async () => {
  const res = await request(createApp({ db: fakeDb(), config: testConfig, loginDelayMs: 0 })).get('/api/admin/export');
  assert.equal(res.status, 401);
});

test('GET /api/admin/export downloads an xlsx built from the dashboard data', async () => {
  const db = fakeDb({
    tables: { org_status: { data: fixtureOrgs, error: null }, attendees: { data: fixtureAttendees, error: null } },
  });
  const res = await request(createApp({ db, config: testConfig, loginDelayMs: 0 }))
    .get('/api/admin/export')
    .set('Cookie', `${COOKIE_NAME}=${signSession(testConfig.sessionSecret)}`)
    .buffer(true)
    .parse(binary);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers['content-disposition'], /^attachment; filename="registrations-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx"$/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.equal(workbook.worksheets.length, 7);
  assert.equal(workbook.getWorksheet('Participants').rowCount, 4);
});
