'use strict';

const config = require('../config');
const logger = require('../logger');
const authService = require('../services/authService');
const adminRepo = require('../repositories/adminRepo');

/**
 * Accepts either a bearer token from POST /api/auth/login or plain HTTP Basic.
 *
 * Basic is supported because it is one field in Postman and needs no login step
 * first, which is how these endpoints actually get used. It costs a scrypt
 * verification per request, so the token is the better choice for anything
 * automated - hence both.
 */
async function authenticate(req) {
  const header = req.get('authorization') || '';

  if (/^Bearer /i.test(header)) {
    const payload = authService.verifyToken(header.slice(7).trim());
    return payload ? { username: payload.sub, id: payload.id, via: 'token' } : null;
  }

  if (/^Basic /i.test(header)) {
    let decoded;
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return null;
    }
    // Only the first colon separates; a password may contain more.
    const at = decoded.indexOf(':');
    if (at === -1) return null;

    const username = decoded.slice(0, at);
    const password = decoded.slice(at + 1);

    const admin = await adminRepo.findByUsername(username);
    if (!admin || !admin.active) return null;
    if (!(await authService.verifyPassword(password, admin.password_hash))) return null;
    return { username: admin.username, id: admin.id, via: 'basic' };
  }

  return null;
}

function requireAuth(req, res, next) {
  if (!config.auth.enabled) {
    req.admin = { username: '(auth disabled)', via: 'disabled' };
    return next();
  }

  authenticate(req)
    .then((admin) => {
      if (!admin) {
        // WWW-Authenticate makes Postman and curl offer the credential prompt
        // rather than simply reporting an opaque 401.
        res.set('WWW-Authenticate', 'Bearer realm="zain-monitor", Basic realm="zain-monitor"');
        return res.status(401).json({
          error: 'Authentication required',
          how: 'POST /api/auth/login for a bearer token, or use HTTP Basic auth.',
        });
      }
      req.admin = admin;
      return next();
    })
    .catch((err) => {
      logger.error(`Authentication check failed: ${logger.describe(err)}`);
      res.status(500).json({ error: 'Authentication check failed' });
    });
}

module.exports = { requireAuth, authenticate };
