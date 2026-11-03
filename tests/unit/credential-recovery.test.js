import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialHash } from '../../src/services/credential.js';
import {
  parseVerificationUrl, previewCredentialRecovery, restoreDistributedCredential,
} from '../../src/services/credential-recovery.js';
import { fakeDb } from '../helpers/fake-db.js';

const BASE_URL = 'https://registration.example.com';
const CURRENT = 'ER1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DISTRIBUTED = 'ER1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const currentUrl = `${BASE_URL}/verify.html#${CURRENT}`;
const distributedUrl = `${BASE_URL}/verify.html#${DISTRIBUTED}`;
const registrationId = '22222222-2222-4222-8222-222222222222';

function recoveryDb() {
  return fakeDb({
    tables: {
      registration_credentials: { data: [{
        id: 'credential-1', registration_id: registrationId, status: 'active',
      }], error: null },
      event_registrations: { data: [{
        id: registrationId,
        event_id: '11111111-1111-4111-8111-111111111111',
        attendee_id: 'attendee-1',
        status: 'confirmed',
      }], error: null },
      attendees: { data: [{
        id: 'attendee-1', name: 'Emergency User', email: 'user@example.com', phone: '1234567',
        designation: 'Manager', from_type: 'factory', organisation_name: null,
      }], error: null },
      events: { data: [{ id: '11111111-1111-4111-8111-111111111111', code: 'event', name: 'Event' }], error: null },
      registration_orgs: { data: [{ kind: 'factory', name: 'Factory One' }], error: null },
    },
    rpc: {
      restore_distributed_credential: () => ({ data: registrationId, error: null }),
    },
  });
}

test('verification URL parsing requires the configured full verify URL', () => {
  assert.equal(parseVerificationUrl(` ${currentUrl} `, BASE_URL).token, CURRENT);
  for (const value of [
    CURRENT,
    `http://registration.example.com/verify.html#${CURRENT}`,
    `${BASE_URL}/other.html#${CURRENT}`,
    `${BASE_URL}/verify.html?x=1#${CURRENT}`,
    `${BASE_URL}/verify.html#bad`,
  ]) {
    assert.throws(() => parseVerificationUrl(value, BASE_URL), (error) => error.code === 'VALIDATION');
  }
});

test('current QR preview returns the linked attendee details', async () => {
  const result = await previewCredentialRecovery(recoveryDb(), currentUrl, BASE_URL);
  assert.equal(result.attendee.name, 'Emergency User');
  assert.equal(result.registration_id, registrationId);
  assert.deepEqual(result.organisations, [{ kind: 'factory', name: 'Factory One' }]);
});

test('recovery sends exact current and distributed hashes to the guarded RPC', async () => {
  const db = recoveryDb();
  const result = await restoreDistributedCredential(db, {
    current_url: currentUrl,
    distributed_url: distributedUrl,
  }, BASE_URL);
  const rpc = db.calls.find((call) => call.fn === 'restore_distributed_credential');
  assert.deepEqual(rpc.args, {
    p_current_token_hash: credentialHash(CURRENT),
    p_distributed_token_hash: credentialHash(DISTRIBUTED),
    p_distributed_token: DISTRIBUTED,
  });
  assert.equal(result.attendee.name, 'Emergency User');
});

test('recovery rejects using the current URL as the distributed URL', async () => {
  await assert.rejects(
    restoreDistributedCredential(recoveryDb(), {
      current_url: currentUrl,
      distributed_url: currentUrl,
    }, BASE_URL),
    (error) => error.code === 'VALIDATION' && Boolean(error.extra.fields.distributed_url),
  );
});
