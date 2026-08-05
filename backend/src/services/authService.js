'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const config = require('../config');
const logger = require('../logger');

const scrypt = promisify(crypto.scrypt);

// Deliberately no jsonwebtoken/bcrypt dependency. Node ships both primitives
// this needs, and the box running this service is not always able to reach a
// registry - an install step is one more thing between a fix and production.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * The signing key for bearer tokens.
 *
 * A random key when AUTH_SECRET is unset keeps a fresh install working without
 * configuration, at the cost of invalidating every token on restart. That is the
 * safe default: the alternative - a hard-coded fallback - would make tokens from
 * one deployment valid on every other.
 */
const SECRET = config.auth.secret || crypto.randomBytes(48).toString('hex');
if (!config.auth.secret) {
  logger.warn(
    'AUTH_SECRET is not set - tokens are signed with a key generated at startup ' +
      'and every session ends when this process restarts. Set AUTH_SECRET to keep them valid.'
  );
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** `scrypt$N$r$p$salt$hash`, all base64url. */
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(plain), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(derived)}`;
}

/**
 * Compares a candidate against a stored hash in constant time.
 *
 * Any malformed or unknown-format hash is a failed verification rather than a
 * thrown error, so a corrupted row locks one account out instead of turning
 * every login into a 500.
 */
async function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');

    const derived = await scrypt(String(plain), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch (err) {
    logger.warn(`Password verification failed to run: ${err.message}`);
    return false;
  }
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}

/** `<payload>.<signature>`, both base64url. Expires per AUTH_TOKEN_TTL_MINUTES. */
function issueToken(admin) {
  const now = Date.now();
  const payload = {
    sub: admin.username,
    id: admin.id,
    iat: now,
    exp: now + config.auth.tokenTtlMinutes * 60 * 1000,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return {
    token: `${payloadB64}.${sign(payloadB64)}`,
    expiresAt: new Date(payload.exp).toISOString(),
    expiresInSeconds: config.auth.tokenTtlMinutes * 60,
  };
}

/**
 * Returns the payload of a valid token, or null.
 *
 * The signature is checked before the payload is parsed and compared in constant
 * time, so neither the contents nor the comparison timing tell an attacker
 * anything about the key.
 */
function verifyToken(token) {
  try {
    const [payloadB64, signature] = String(token || '').split('.');
    if (!payloadB64 || !signature) return null;

    const expected = Buffer.from(sign(payloadB64));
    const given = Buffer.from(signature);
    if (expected.length !== given.length) return null;
    if (!crypto.timingSafeEqual(expected, given)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken };
