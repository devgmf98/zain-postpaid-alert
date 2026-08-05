'use strict';

const mysqlDb = require('../db/mysql');

const T = mysqlDb.TABLES.status;

/** MySQL DATETIME wants 'YYYY-MM-DD HH:MM:SS' in local time, not an ISO string. */
function toSqlDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function truncate(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Upserts the single row describing this service instance, so the automation's
 * health is visible from the database without calling the HTTP API.
 */
async function save(serviceName, s) {
  await mysqlDb.query(
    `INSERT INTO \`${T}\`
       (service_name, running, dry_run, account_code, wallet_id, period_ym,
        window_from, window_to, cap_gb, poll_interval_ms, cycles,
        subscribers_seen, sms_sent, sms_failed, last_cycle_at, last_cycle_ms,
        last_alert_at, last_error, last_error_at, consecutive_errors, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        running = VALUES(running),
        dry_run = VALUES(dry_run),
        account_code = VALUES(account_code),
        wallet_id = VALUES(wallet_id),
        period_ym = VALUES(period_ym),
        window_from = VALUES(window_from),
        window_to = VALUES(window_to),
        cap_gb = VALUES(cap_gb),
        poll_interval_ms = VALUES(poll_interval_ms),
        cycles = VALUES(cycles),
        subscribers_seen = VALUES(subscribers_seen),
        sms_sent = VALUES(sms_sent),
        sms_failed = VALUES(sms_failed),
        last_cycle_at = VALUES(last_cycle_at),
        last_cycle_ms = VALUES(last_cycle_ms),
        last_alert_at = VALUES(last_alert_at),
        last_error = VALUES(last_error),
        last_error_at = VALUES(last_error_at),
        consecutive_errors = VALUES(consecutive_errors),
        started_at = VALUES(started_at)`,
    [
      serviceName,
      s.running ? 1 : 0,
      s.dryRun ? 1 : 0,
      s.accountCode ?? null,
      s.walletId ?? null,
      s.periodYm ?? null,
      toSqlDateTime(s.windowFrom),
      toSqlDateTime(s.windowTo),
      s.capGb ?? null,
      s.pollIntervalMs ?? null,
      s.cycles ?? 0,
      s.subscribersSeen ?? 0,
      s.smsSent ?? 0,
      s.smsFailed ?? 0,
      toSqlDateTime(s.lastCycleAt),
      s.lastCycleMs ?? null,
      toSqlDateTime(s.lastAlertAt),
      truncate(s.lastError),
      toSqlDateTime(s.lastErrorAt),
      s.consecutiveErrors ?? 0,
      toSqlDateTime(s.startedAt),
    ]
  );
}

async function get(serviceName) {
  const rows = await mysqlDb.query(
    `SELECT * FROM \`${T}\` WHERE service_name = ? LIMIT 1`,
    [serviceName]
  );
  return rows[0] || null;
}

async function list() {
  return mysqlDb.query(`SELECT * FROM \`${T}\` ORDER BY service_name`);
}

/** Marks the service stopped on a clean shutdown. */
async function markStopped(serviceName) {
  await mysqlDb.query(
    `UPDATE \`${T}\` SET running = 0 WHERE service_name = ?`,
    [serviceName]
  );
}

module.exports = { save, get, list, markStopped };
