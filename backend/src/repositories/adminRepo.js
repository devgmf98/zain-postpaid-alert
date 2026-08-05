'use strict';

const mysqlDb = require('../db/mysql');
const config = require('../config');
const logger = require('../logger');
const authService = require('../services/authService');

const T = mysqlDb.TABLES.admins;

async function findByUsername(username) {
  const rows = await mysqlDb.query(
    `SELECT id, username, password_hash, active, last_login_at
       FROM \`${T}\` WHERE username = ? LIMIT 1`,
    [String(username || '').trim()]
  );
  return rows[0] || null;
}

async function touchLogin(id) {
  await mysqlDb.query(`UPDATE \`${T}\` SET last_login_at = NOW() WHERE id = ?`, [id]);
}

async function list() {
  return mysqlDb.query(
    `SELECT id, username, active, last_login_at, created_at, updated_at
       FROM \`${T}\` ORDER BY username`
  );
}

async function create(username, password) {
  const hash = await authService.hashPassword(password);
  const result = await mysqlDb.query(
    `INSERT INTO \`${T}\` (username, password_hash) VALUES (?, ?)`,
    [String(username).trim(), hash]
  );
  return { id: result.insertId, username: String(username).trim() };
}

async function setPassword(username, password) {
  const hash = await authService.hashPassword(password);
  const result = await mysqlDb.query(
    `UPDATE \`${T}\` SET password_hash = ? WHERE username = ?`,
    [hash, String(username).trim()]
  );
  return result.affectedRows > 0;
}

/**
 * Creates the default admin the first time the table is empty.
 *
 * Only when empty, never as an upsert: re-applying it on every boot would undo a
 * rotated password the moment the service restarted, silently restoring a
 * credential that is written down in .env.example and therefore public.
 */
async function seedDefault() {
  const [{ n }] = await mysqlDb.query(`SELECT COUNT(*) AS n FROM \`${T}\``);
  if (Number(n) > 0) return null;

  const { defaultUsername, defaultPassword } = config.auth;
  await create(defaultUsername, defaultPassword);

  logger.warn(
    `${T} was empty - created the default admin "${defaultUsername}". ` +
      'Change this password before the service is reachable from anywhere untrusted: ' +
      'POST /api/admins/password with the current token.'
  );
  return defaultUsername;
}

module.exports = { findByUsername, touchLogin, list, create, setPassword, seedDefault };
