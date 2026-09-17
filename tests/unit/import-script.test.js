import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Runs the CLI without any .env file: it must fail with a short message, never a stack trace.
const runScript = (...args) => spawnSync(process.execPath, ['scripts/import-orgs.js', ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
});

test('import script prints usage and exits 1 without a file argument', () => {
  const result = runScript();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: /);
});

test('import script reports a missing file in one line and exits 1', () => {
  const result = runScript('does-not-exist.xlsx');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Import failed: .*does-not-exist\.xlsx/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
