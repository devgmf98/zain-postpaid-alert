'use strict';

const mysqlDb = require('../db/mysql');
const config = require('../config');

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';
const T = mysqlDb.TABLES.activations;

/** MySQL DATETIME in local time - an ISO string would shift by the offset. */
function toSqlDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * The activation events already recorded for a day, keyed by CHRONO_NUM_V.
 *
 * Loaded once per cycle so the poller can tell new events from ones it has
 * already handled without a query per row - at one poll a second over a day that
 * accumulates thousands of events, per-row lookups would dominate the cycle.
 */
async function loadDayState(dayKey) {
  const rows = await mysqlDb.query(
    `SELECT chrono_num, status, attempts, retryable, updated_at
       FROM \`${T}\` WHERE event_day = ?`,
    [dayKey]
  );

  const state = new Map();
  for (const row of rows) {
    state.set(String(row.chrono_num), {
      status: row.status,
      attempts: Number(row.attempts),
      retryable: row.retryable === undefined ? true : Boolean(row.retryable),
      updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
    });
  }
  return state;
}

/**
 * Reserves the slot for one activation event before its SMS is sent.
 *
 * Same guarantee as the threshold alerts: the row is written first, so a crash
 * between claiming and sending cannot produce a second message. Returns the row
 * id, or null when another cycle already owns the event.
 */
async function claim({
  chronoNum,
  msisdn,
  tariffCode,
  attribute4,
  offerRaw,
  offerName,
  eventAt,
  dayKey,
  message,
  status = 'PENDING',
  errorMessage = null,
}) {
  try {
    const result = await mysqlDb.query(
      `INSERT INTO \`${T}\`
         (chrono_num, msisdn, tariff_code, attribute4, offer_raw, offer_name, event_at,
          event_day, message, status, attempts, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        String(chronoNum),
        msisdn,
        tariffCode || '',
        attribute4,
        offerRaw,
        offerName,
        toSqlDateTime(eventAt),
        dayKey,
        message,
        status,
        errorMessage,
      ]
    );
    return result.insertId;
  } catch (err) {
    if (err.code === DUPLICATE_ENTRY) return null;
    throw err;
  }
}

async function markSent(id, gatewayResponse) {
  await mysqlDb.query(
    `UPDATE \`${T}\`
        SET status = 'SENT', attempts = attempts + 1,
            gateway_response = ?, error_message = NULL, sent_at = NOW()
      WHERE id = ?`,
    [truncate(gatewayResponse), id]
  );
}

async function markFailed(id, errorMessage, retryable = true) {
  await mysqlDb.query(
    `UPDATE \`${T}\`
        SET status = 'FAILED', attempts = attempts + 1, retryable = ?, error_message = ?
      WHERE id = ?`,
    [retryable ? 1 : 0, truncate(errorMessage), id]
  );
}

/**
 * Activations claimed but never delivered, re-queued at startup. Bounded to the
 * current day: an activation notice is only meaningful on the day it happened.
 */
async function listPending(dayKey) {
  return mysqlDb.query(
    `SELECT id, chrono_num, msisdn, tariff_code, offer_name, event_at, message
       FROM \`${T}\`
      WHERE event_day = ? AND status = 'PENDING' AND attempts < ?
      ORDER BY id`,
    [dayKey, config.sms.maxRetryCycles]
  );
}

async function listByDay(dayKey, limit = 500) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  return mysqlDb.query(
    `SELECT id, chrono_num, msisdn, tariff_code, attribute4, offer_raw, offer_name, event_at,
            event_day, message, status, attempts, error_message, created_at, sent_at
       FROM \`${T}\`
      WHERE event_day = ?
      ORDER BY id DESC
      LIMIT ${safeLimit}`,
    [dayKey]
  );
}

async function summaryByDay(dayKey) {
  const rows = await mysqlDb.query(
    `SELECT status, COUNT(*) AS total FROM \`${T}\` WHERE event_day = ? GROUP BY status`,
    [dayKey]
  );
  return rows.map((r) => ({ status: r.status, total: Number(r.total) }));
}

function truncate(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

module.exports = {
  loadDayState,
  claim,
  markSent,
  markFailed,
  listPending,
  listByDay,
  summaryByDay,
};
