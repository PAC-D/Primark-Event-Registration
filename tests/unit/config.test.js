import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';

const valid = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_x',
  ADMIN_PASSWORD: 'pw',
  SESSION_SECRET: 'a'.repeat(32),
  EVENT_TITLE: ' Supplier Day ',
};

test('returns a config object when every variable is set', () => {
  const config = loadConfig(valid);
  assert.deepEqual(config, {
    supabaseUrl: 'https://example.supabase.co',
    supabaseSecretKey: 'sb_secret_x',
    adminPassword: 'pw',
    sessionSecret: 'a'.repeat(32),
    eventTitle: 'Supplier Day',
    powerAutomateWebhookUrl: '',
    isProduction: false,
    maintenanceMode: false,
  });
});

test('the Power Automate webhook URL is optional and trimmed', () => {
  assert.equal(loadConfig(valid).powerAutomateWebhookUrl, '');
  assert.equal(loadConfig({ ...valid, POWER_AUTOMATE_WEBHOOK_URL: ' https://flows.example/x ' }).powerAutomateWebhookUrl, 'https://flows.example/x');
});

test('lists every missing or blank variable', () => {
  assert.throws(
    () => loadConfig({ ...valid, ADMIN_PASSWORD: '  ', EVENT_TITLE: undefined }),
    /Missing environment variables: ADMIN_PASSWORD, EVENT_TITLE/,
  );
});

test('rejects a session secret shorter than 32 characters', () => {
  assert.throws(() => loadConfig({ ...valid, SESSION_SECRET: 'short' }), /at least 32 characters/);
});

test('treats Vercel and NODE_ENV=production as production', () => {
  assert.equal(loadConfig({ ...valid, VERCEL: '1' }).isProduction, true);
  assert.equal(loadConfig({ ...valid, NODE_ENV: 'production' }).isProduction, true);
});

test('parses MAINTENANCE_MODE as a boolean flag', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(loadConfig({ ...valid, MAINTENANCE_MODE: value }).maintenanceMode, true, `MAINTENANCE_MODE=${value}`);
  }
  for (const value of ['0', 'false', 'off', ' ', '', 'maybe']) {
    assert.equal(loadConfig({ ...valid, MAINTENANCE_MODE: value }).maintenanceMode, false, `MAINTENANCE_MODE=${value}`);
  }
  assert.equal(loadConfig(valid).maintenanceMode, false);
});
