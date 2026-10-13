import crypto from 'node:crypto';
import { errors } from './errors.js';

export const COOKIE_NAME = 'admin_session';
export const SESSION_SECONDS = 12 * 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const hmac = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();

export function passwordMatches(given, expected) {
  if (typeof given !== 'string') return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

export function signSession(secret, now = nowSeconds()) {
  const expiry = String(now + SESSION_SECONDS);
  return `${expiry}.${hmac(expiry, secret)}`;
}

export function verifySession(value, secret, now = nowSeconds()) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !parts[1]) return false;
  const [expiry, signature] = parts;
  const expected = Buffer.from(hmac(expiry, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  return Number(expiry) > now;
}

export function clearCookieOptions(config) {
  return { httpOnly: true, sameSite: 'strict', path: '/', secure: config.isProduction };
}

export function cookieOptions(config) {
  return { ...clearCookieOptions(config), maxAge: SESSION_SECONDS * 1000 };
}

export function requireAdmin(config) {
  return (req, _res, next) => {
    if (verifySession(req.cookies?.[COOKIE_NAME], config.sessionSecret)) return next();
    return next(errors.unauthorised());
  };
}
