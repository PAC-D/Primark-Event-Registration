import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Runs the CLI without any .env file: it must fail with a short message, never a stack trace.
const runScript = (...args) => spawnSync(process.execPath, ['scripts/import-orgs.js', ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
});

test('import script exits 1 and prints a short error when env vars are missing', () => {
  const result = runScript();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Import failed: /);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('import script reports a missing data directory in one line and exits 1', () => {
  const result = runScript('does-not-exist');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Import failed: /);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
