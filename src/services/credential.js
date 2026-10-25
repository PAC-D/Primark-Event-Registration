import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'ER1.';
const FALLBACK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function credentialHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fallbackCode(bytes = randomBytes(8)) {
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += FALLBACK_ALPHABET[bytes[index] % FALLBACK_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normaliseFallbackCode(value) {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createCredential({ tokenBytes = randomBytes(24), fallbackBytes = randomBytes(8) } = {}) {
  const token = `${TOKEN_PREFIX}${Buffer.from(tokenBytes).toString('base64url')}`;
  const fallback = fallbackCode(Buffer.from(fallbackBytes));
  return {
    token,
    tokenHash: credentialHash(token),
    fallback,
    fallbackHash: credentialHash(normaliseFallbackCode(fallback)),
  };
}

export function scannedCredentialHash(value) {
  const input = String(value).trim();
  return credentialHash(input.toUpperCase().startsWith(TOKEN_PREFIX) ? input : normaliseFallbackCode(input));
}

function printKey(secret) {
  return createHash('sha256').update('PACD card print credential\0').update(secret).digest();
}

// The database keeps hashes for verification. This encrypted copy exists only so an authorised
// administrator can reprint the exact same QR/fallback value instead of rotating the credential.
export function sealCredential(credential, secret, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', printKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify({ token: credential.token, fallback: credential.fallback }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function openCredential(payload, secret) {
  const [version, iv, tag, encrypted] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Unsupported printable credential.');
  const decipher = createDecipheriv('aes-256-gcm', printKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
  const value = JSON.parse(plaintext.toString('utf8'));
  if (typeof value.token !== 'string' || typeof value.fallback !== 'string') throw new Error('Invalid printable credential.');
  return { token: value.token, fallback: value.fallback };
}

